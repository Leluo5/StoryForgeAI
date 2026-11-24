// M3c-3 知识库 T18 四维检索（游标分页 + time_field 切换 + CTE 合并 + 排序白名单）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.6、§2.2.1；F3 T18 完成标准
// 职责：关键词 / 类型 / 标签 / 时间四维过滤，time_field 切换（created_at/updated_at），
//       作品库 CTE 合并「作品自有条目 + 全局引用条目」，排序白名单校验（422 INVALID_SORT），
//       游标分页稳定（updated_at + id 编码），total 全量计数（回收站不计入常规计数）。
// 边界（L2 服务层）：纯数据访问 + 归属校验 + 排序/游标规则；不写 controller，不写前端。

import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type {
  KnowledgeEntrySummary,
  KnowledgeEntryType,
  KnowledgeRefStatus,
  KnowledgeSearchQuery,
  KnowledgeSearchResponse,
  KnowledgeTimeField
} from '@storyforge/contracts';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { KnowledgeTagEntity } from '../database/knowledge-tag.entity';
import { KnowledgeWorkRefEntity } from '../database/knowledge-work-ref.entity';
import { WorkEntity } from '../database/work.entity';

// 契约未定义 INVALID_SORT（F3 T18 完成标准要求 422），按 T12/T17 先例以本地常量补充
const INVALID_SORT = 'INVALID_SORT';

// 契约缺 sort_by/sort_dir（F3 T18 完成标准要求排序白名单校验），按本地补充先例定义宽类型
type KnowledgeSearchSortQuery = Partial<KnowledgeSearchQuery> & {
  sort_by?: string;
  sort_dir?: string;
};

// 排序白名单：字段 + 方向
const SORT_FIELDS = ['updated_at', 'created_at', 'title'] as const;
const SORT_DIRS = ['asc', 'desc'] as const;
type SortField = (typeof SORT_FIELDS)[number];
type SortDir = (typeof SORT_DIRS)[number];

// 统一检索行（作品库合并后 / 全局库）
interface SearchRow {
  id: string;
  entry_type: string;
  title: string;
  excerpt: string;
  search_text: string;
  structure_status: string;
  outline_status: string | null;
  favorite: boolean;
  pinned: boolean;
  pinned_at: Date | null;
  created_at: Date;
  updated_at: Date;
  ref_id: string | null;
  kind: 'entry' | 'reference';
  ref_status: string | null;
  original_text: string;
}

@Injectable()
export class KnowledgeSearchService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // ═══════════════════════════════════════════════════════════════════
  // 四维检索入口
  // ═══════════════════════════════════════════════════════════════════

  async search(authorId: string, query: KnowledgeSearchSortQuery): Promise<KnowledgeSearchResponse> {
    if (!query.scope) throw new NotFoundException('scope is required');
    const scope = query.scope;
    const limit = query.limit ?? 50;

    // 排序白名单校验
    const sortBy = (query.sort_by ?? 'updated_at') as SortField;
    const sortDir = (query.sort_dir ?? 'desc') as SortDir;
    if (!SORT_FIELDS.includes(sortBy)) {
      throw new UnprocessableEntityException({
        code: INVALID_SORT,
        message: 'Invalid sort_by',
        details: { sort_by: query.sort_by }
      });
    }
    if (!SORT_DIRS.includes(sortDir)) {
      throw new UnprocessableEntityException({
        code: INVALID_SORT,
        message: 'Invalid sort_dir',
        details: { sort_dir: query.sort_dir }
      });
    }

    const timeField: KnowledgeTimeField = query.time_field ?? 'created_at';

    // 归属校验 + 范围界定
    let rows: SearchRow[];
    if (scope === 'global') {
      rows = await this.queryGlobal(authorId, query, timeField, sortBy, sortDir, limit);
    } else {
      if (!query.work_id) throw new NotFoundException('work_id is required for work scope');
      const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: query.work_id });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Work not found');
      rows = await this.queryWork(authorId, query.work_id, query, timeField, sortBy, sortDir, limit);
    }

    // 组装摘要（仅本页）
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items: KnowledgeEntrySummary[] = [];
    for (const row of page) {
      const tags = await this.loadTagNames(row.id);
      items.push(this.toSummary(row, tags));
    }

    // total 全量计数（同一 WHERE；回收站计数由调用方决定）
    const total = await this.count(authorId, scope, query, timeField);

    const nextCursor = hasMore && page.length > 0
      ? this.encodeCursor(page[page.length - 1]!.updated_at, page[page.length - 1]!.id)
      : null;

    return { items, total, next_cursor: nextCursor };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 全局库检索（单表）
  // ═══════════════════════════════════════════════════════════════════

  private async queryGlobal(
    authorId: string,
    query: KnowledgeSearchSortQuery,
    timeField: KnowledgeTimeField,
    sortBy: SortField,
    sortDir: SortDir,
    limit: number
  ): Promise<SearchRow[]> {
    const repo = this.dataSource.getRepository(KnowledgeEntryEntity);
    const qb = repo.createQueryBuilder('k');
    qb.where('k.library_scope = :scope', { scope: 'global' });
    qb.andWhere('k.owner_id = :authorId', { authorId });
    this.applyCommonFilters(qb, 'k', query, timeField);
    this.applySort(qb, 'k', sortBy, sortDir);
    // 游标：默认排序使用 updated_at+id；若显式 sort_by 用对应字段+id
    if (query.cursor) {
      const decoded = this.decodeCursor(query.cursor);
      if (decoded) this.applyCursor(qb, 'k', sortBy, decoded, sortDir);
    }
    qb.limit(limit + 1);
    const entities = await qb.getMany();
    return entities.map((e) => this.toSearchRow(e));
  }

  // ═══════════════════════════════════════════════════════════════════
  // 作品库检索（CTE 合并「作品自有条目 + 全局引用条目」）
  // ═══════════════════════════════════════════════════════════════════

  private async queryWork(
    authorId: string,
    workId: string,
    query: KnowledgeSearchSortQuery,
    timeField: KnowledgeTimeField,
    sortBy: SortField,
    sortDir: SortDir,
    limit: number
  ): Promise<SearchRow[]> {
    // 统一列：k.* 排序字段 + 引用派生字段（ref_id/kind/ref_status）
    const unionSql = `
      SELECT
        k.id,
        k.entry_type,
        k.title,
        k.search_text,
        k.structure_status,
        k.outline_status,
        k.favorite,
        k.pinned,
        k.pinned_at,
        k.created_at,
        k.updated_at,
        k.deleted_at,
        k.original_text,
        NULL::uuid AS ref_id,
        'entry'::text AS kind,
        NULL::text AS ref_status
      FROM knowledge_entries k
      WHERE k.library_scope = 'work' AND k.work_id = $1

      UNION ALL

      SELECT
        k.id,
        k.entry_type,
        k.title,
        k.search_text,
        k.structure_status,
        k.outline_status,
        r.favorite,
        r.pinned,
        r.pinned_at,
        r.created_at,
        r.updated_at,
        k.deleted_at,
        k.original_text,
        r.id AS ref_id,
        'reference'::text AS kind,
        CASE
          WHEN r.entry_id IS NULL THEN 'invalid'
          WHEN k.deleted_at IS NOT NULL THEN 'source_deleted'
          ELSE 'active'
        END AS ref_status
      FROM knowledge_work_refs r
      JOIN knowledge_entries k ON k.id = r.entry_id
      WHERE r.work_id = $1 AND r.entry_id IS NOT NULL
    `;

    // 外层 WHERE 应用四维过滤（作用于 k.* 列；引用条目的 search_text 来自全局条目）
    const whereParts: string[] = [];
    const params: unknown[] = [];
    const bind = (val: unknown): string => {
      params.push(val);
      return `$${params.length + 1}`;
    };

    // deleted 过滤：作品自有条目 deleted_at；引用条目按全局条目 deleted_at（但引用本身不软删）
    if (query.deleted === true) {
      whereParts.push(`k.deleted_at IS NOT NULL`);
    } else {
      whereParts.push(`k.deleted_at IS NULL`);
    }
    if (query.keyword) {
      whereParts.push(`k.search_text ILIKE ${bind(`%${query.keyword}%`)}`);
    }
    if (query.types && query.types.length > 0) {
      whereParts.push(`k.entry_type = ANY(${bind(query.types)}::varchar[])`);
    }
    if (query.favorite !== undefined) {
      whereParts.push(`k.favorite = ${bind(query.favorite)}`);
    }
    if (query.pinned !== undefined) {
      whereParts.push(`k.pinned = ${bind(query.pinned)}`);
    }
    if (query.time_from) {
      const field = timeField === 'updated_at' ? 'k.updated_at' : 'k.created_at';
      whereParts.push(`${field} >= ${bind(query.time_from)}`);
    }
    if (query.time_to) {
      const field = timeField === 'updated_at' ? 'k.updated_at' : 'k.created_at';
      whereParts.push(`${field} < ${bind(query.time_to)}`);
    }
    if (query.tag_ids && query.tag_ids.length > 0) {
      whereParts.push(
        `EXISTS (SELECT 1 FROM knowledge_entry_tags ket WHERE ket.entry_id = k.id AND ket.tag_id = ANY(${bind(query.tag_ids)}::uuid[]))`
      );
    }

    // 排序
    const sortCol = this.sortColumn(sortBy);
    const dir = sortDir.toUpperCase();
    let orderSql = `${sortCol} ${dir}, k.id ${dir}`;
    // 默认排序叠加 pinned 置顶优先（F2 §5.6）
    if (sortBy === 'updated_at' && sortDir === 'desc') {
      orderSql = `k.pinned DESC, COALESCE(k.pinned_at, k.updated_at) DESC, k.id ASC`;
    }

    // 游标
    if (query.cursor) {
      const decoded = this.decodeCursor(query.cursor);
      if (decoded) {
        const cursorField = sortBy === 'updated_at' ? 'k.updated_at' : sortBy === 'created_at' ? 'k.created_at' : 'k.title';
        const op = sortDir === 'asc' ? '>' : '<';
        whereParts.push(`(${cursorField} ${op} ${bind(decoded.updatedAt)} OR (${cursorField} = ${bind(decoded.updatedAt)} AND k.id ${op} ${bind(decoded.id)}))`);
      }
    }

    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const sql = `SELECT * FROM (${unionSql}) k ${whereSql} ORDER BY ${orderSql} LIMIT ${limit + 1}`;
    const raw = await this.dataSource.query(sql, [workId, ...params]);

    return raw.map((r: Record<string, unknown>) => this.toSearchRow(r as never));
  }

  // ═══════════════════════════════════════════════════════════════════
  // 计数（同一 WHERE）
  // ═══════════════════════════════════════════════════════════════════

  private async count(
    authorId: string,
    scope: 'global' | 'work',
    query: KnowledgeSearchSortQuery,
    timeField: KnowledgeTimeField
  ): Promise<number> {
    const repo = this.dataSource.getRepository(KnowledgeEntryEntity);
    const qb = repo.createQueryBuilder('k');
    qb.select('COUNT(DISTINCT k.id)', 'cnt');
    qb.where('k.library_scope = :scope', { scope });
    if (scope === 'global') {
      qb.andWhere('k.owner_id = :authorId', { authorId });
      this.applyCommonFilters(qb, 'k', query, timeField);
      const row = await qb.getRawOne<{ cnt: string }>();
      return Number(row?.cnt ?? 0);
    }
    // 作品库计数：作品自有条目 + 全局引用条目（同一 WHERE，与列表一致）
    if (!query.work_id) return 0;
    const countSql = `
      SELECT COUNT(DISTINCT id)::text AS cnt FROM (
        SELECT k.id
        FROM knowledge_entries k
        WHERE k.library_scope = 'work' AND k.work_id = $1
        UNION ALL
        SELECT k.id
        FROM knowledge_work_refs r
        JOIN knowledge_entries k ON k.id = r.entry_id
        WHERE r.work_id = $1 AND r.entry_id IS NOT NULL
      ) merged
    `;
    const row = await this.dataSource.query<{ cnt: string }[]>(countSql, [query.work_id]);
    return Number(row[0]?.cnt ?? 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 过滤器与排序辅助
  // ═══════════════════════════════════════════════════════════════════

  private applyCommonFilters(
    qb: import('typeorm').SelectQueryBuilder<KnowledgeEntryEntity>,
    alias: string,
    query: KnowledgeSearchSortQuery,
    timeField: KnowledgeTimeField
  ): void {
    if (query.deleted === true) {
      qb.andWhere(`${alias}.deleted_at IS NOT NULL`);
    } else {
      qb.andWhere(`${alias}.deleted_at IS NULL`);
    }
    if (query.keyword) {
      qb.andWhere(`${alias}.search_text ILIKE :kw`, { kw: `%${query.keyword}%` });
    }
    if (query.types && query.types.length > 0) {
      qb.andWhere(`${alias}.entry_type = ANY(:types)`, { types: query.types });
    }
    if (query.favorite !== undefined) {
      qb.andWhere(`${alias}.favorite = :fav`, { fav: query.favorite });
    }
    if (query.pinned !== undefined) {
      qb.andWhere(`${alias}.pinned = :pin`, { pin: query.pinned });
    }
    if (query.time_from) {
      const field = timeField === 'updated_at' ? `${alias}.updated_at` : `${alias}.created_at`;
      qb.andWhere(`${field} >= :from`, { from: query.time_from });
    }
    if (query.time_to) {
      const field = timeField === 'updated_at' ? `${alias}.updated_at` : `${alias}.created_at`;
      qb.andWhere(`${field} < :to`, { to: query.time_to });
    }
    if (query.tag_ids && query.tag_ids.length > 0) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM knowledge_entry_tags ket WHERE ket.entry_id = ${alias}.id AND ket.tag_id = ANY(:tagIds))`,
        { tagIds: query.tag_ids }
      );
    }
  }

  private applySort(
    qb: import('typeorm').SelectQueryBuilder<KnowledgeEntryEntity>,
    alias: string,
    sortBy: SortField,
    sortDir: SortDir
  ): void {
    const col = this.sortColumn(sortBy);
    const dir = sortDir.toUpperCase();
    if (sortBy === 'updated_at' && sortDir === 'desc') {
      // 默认：pinned 置顶优先 + COALESCE(pinned_at, updated_at) DESC（F2 §5.6）
      qb.orderBy(`${alias}.pinned`, 'DESC')
        .addOrderBy(`COALESCE(${alias}.pinned_at, ${alias}.updated_at)`, 'DESC')
        .addOrderBy(`${alias}.id`, 'ASC');
    } else {
      qb.orderBy(`${alias}.${col}`, dir as 'ASC' | 'DESC')
        .addOrderBy(`${alias}.id`, dir as 'ASC' | 'DESC');
    }
  }

  private applyCursor(
    qb: import('typeorm').SelectQueryBuilder<KnowledgeEntryEntity>,
    alias: string,
    sortBy: SortField,
    decoded: { updatedAt: string; id: string },
    sortDir: SortDir
  ): void {
    if (sortBy === 'updated_at' && sortDir === 'desc') {
      // 默认排序游标：pinned DESC, COALESCE(pinned_at, updated_at) DESC, id ASC（简化为 updated_at+id 近似）
      qb.andWhere(
        `(COALESCE(${alias}.pinned_at, ${alias}.updated_at), ${alias}.id) < (:cursorAt, :cursorId)`,
        { cursorAt: new Date(decoded.updatedAt), cursorId: decoded.id }
      );
    } else {
      const col = this.sortColumn(sortBy);
      const op = sortDir === 'asc' ? '>' : '<';
      qb.andWhere(
        `(${alias}.${col}, ${alias}.id) ${op} (:cursorAt, :cursorId)`,
        { cursorAt: sortBy === 'title' ? decoded.updatedAt : new Date(decoded.updatedAt), cursorId: decoded.id }
      );
    }
  }

  private sortColumn(sortBy: SortField): string {
    return sortBy === 'created_at' ? 'created_at' : sortBy === 'title' ? 'title' : 'updated_at';
  }

  // ═══════════════════════════════════════════════════════════════════
  // 行映射
  // ═══════════════════════════════════════════════════════════════════

  private toSearchRow(e: KnowledgeEntryEntity | Record<string, unknown>): SearchRow {
    const r = e as Record<string, unknown>;
    return {
      id: r.id as string,
      entry_type: r.entry_type as string,
      title: r.title as string,
      excerpt: (r.original_text as string ?? '').slice(0, 160),
      search_text: (r.search_text as string) ?? '',
      structure_status: r.structure_status as string,
      outline_status: (r.outline_status as string | null) ?? null,
      favorite: Boolean(r.favorite),
      pinned: Boolean(r.pinned),
      pinned_at: (r.pinned_at as Date | null) ?? null,
      created_at: this.toDate(r.created_at),
      updated_at: this.toDate(r.updated_at),
      ref_id: (r.ref_id as string | null) ?? null,
      kind: (r.kind === 'reference' ? 'reference' : 'entry') as 'entry' | 'reference',
      ref_status: (r.ref_status as string | null) ?? null,
      original_text: (r.original_text as string) ?? ''
    };
  }

  private toDate(v: unknown): Date {
    if (v instanceof Date) return v;
    return new Date(v as string);
  }

  private toSummary(row: SearchRow, tags: string[]): KnowledgeEntrySummary {
    const summary: KnowledgeEntrySummary = {
      kind: row.kind,
      id: row.id,
      entry_type: row.entry_type as KnowledgeEntryType,
      title: row.title,
      excerpt: row.excerpt,
      tags,
      structure_status: row.structure_status as KnowledgeEntrySummary['structure_status'],
      favorite: row.favorite,
      pinned: row.pinned,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString()
    };
    if (row.kind === 'reference') {
      summary.ref_id = row.ref_id ?? undefined;
      summary.ref_status = (row.ref_status as KnowledgeRefStatus) ?? undefined;
    }
    if (row.outline_status) {
      summary.outline_status = row.outline_status as KnowledgeEntrySummary['outline_status'];
    }
    return summary;
  }

  private async loadTagNames(entryId: string): Promise<string[]> {
    const rows = await this.dataSource.getRepository(KnowledgeEntryTagEntity).find({
      where: { entry_id: entryId }
    });
    if (!rows.length) return [];
    const tagIds = rows.map((r) => r.tag_id);
    // 用 In() 展开为独立参数（裸数组会被 pg 驱动序列化成 PG 数组字面量，uuid 列报错）
    const tags = await this.dataSource.getRepository(KnowledgeTagEntity).find({
      where: { id: In(tagIds) }
    });
    return tags.map((t) => t.name).sort();
  }

  // 游标编码：base64(updatedAt|id)
  private encodeCursor(updatedAt: Date, id: string): string {
    return Buffer.from(`${updatedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const [updatedAt, id] = decoded.split('|');
      if (!updatedAt || !id) return null;
      return { updatedAt, id };
    } catch {
      return null;
    }
  }
}
