import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CommitKnowledgeEntryRequest,
  KnowledgeEntry,
  KnowledgeEntryListItem,
  KnowledgeType,
  LinkKnowledgeRequest,
  SearchKnowledgeRequest,
  SearchKnowledgeResponse,
  UpdateKnowledgeEntryRequest
} from '@storyforge/contracts';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';

// 内容哈希：sha256(原文) 十六进制，用于同作者查重
export function hashContent(rawContent: string): string {
  return createHash('sha256').update(rawContent, 'utf8').digest('hex');
}

// 标题归一化（title_key，F2 §2.2.1）：NFKC → trim → 小写 → 去空白与间隔符。
// 与 character-candidate.normalize 的 normalizeName 规则一致；此处内联避免跨模块耦合。
export function normalizeTitleKey(input: string): string {
  return input.normalize('NFKC').trim().toLowerCase().replace(/[\s_\-\.．＿－]+/g, '');
}

// 旧一代录入来源 → 新 origin（F2 §2.2.1 五类）。
// 旧契约 knowledgeSourceSchema = ['paste','manual','upload','ocr','import']；
// 新 origin CHECK = ['manual','upload','markdown_import','backup','ref_copy']。
// 中间态（L1）：旧 service 仍接收旧 source，需映射到合法 origin 才能通过新 CHECK。
export function mapLegacySourceToOrigin(source: string): KnowledgeEntryEntity['origin'] {
  switch (source) {
    case 'upload':
      return 'upload';
    case 'import':
      return 'markdown_import';
    // paste / manual / ocr：新方案无独立 paste/ocr 来源，统一按手工录入（manual）
    case 'paste':
    case 'manual':
    case 'ocr':
    default:
      return 'manual';
  }
}

// 新 origin → 旧一代契约 source（KnowledgeSource 枚举）。
// 新 origin 的 markdown_import/backup/ref_copy 不在旧枚举内，映射回旧契约允许的最接近值，
// 保证旧只读返回路径类型安全（中间态，T11 重写后由新契约取代）。
function mapOriginToLegacySource(origin: KnowledgeEntryEntity['origin']): KnowledgeEntry['source'] {
  switch (origin) {
    case 'upload':
      return 'upload';
    case 'markdown_import':
      return 'import';
    // manual / backup / ref_copy：旧枚举无对应值，按 manual 返回
    case 'manual':
    case 'backup':
    case 'ref_copy':
    default:
      return 'manual';
  }
}

// 实体 → 契约映射
// 中间态（L1）：旧单表 service 在新实体字段下做最小编译适配；tags/links 已迁移为多表关系，
// 此处退化为空数组占位，真实实现由 T11 entries.service.ts 重写（旧逻辑不再复用，F3 §4）。
function toEntry(entity: KnowledgeEntryEntity): KnowledgeEntry {
  return {
    id: entity.id,
    author_id: entity.owner_id,
    type: entity.entry_type as KnowledgeType,
    title: entity.title,
    source: mapOriginToLegacySource(entity.origin),
    raw_content: entity.original_text,
    structured: (entity.structured ?? {}) as Record<string, unknown>,
    tags: [],
    links: [],
    content_hash: entity.content_hash,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

function toListItem(entity: KnowledgeEntryEntity): KnowledgeEntryListItem {
  return {
    id: entity.id,
    type: entity.entry_type as KnowledgeType,
    title: entity.title,
    tags: [],
    created_at: entity.created_at.toISOString()
  };
}

@Injectable()
export class KnowledgeService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // ═══════════════════════════════════════════════════════════════════
  // 统一录入（生成预览，不落库）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 录入入口：生成 preview（临时，不落库）。
   * 去重：同 author + content_hash 已存在 → 直接返回已有条目（status: saved）。
   * 返回 { status, id?, type, structured, tags, title }。
   */
  async createPreview(
    authorId: string,
    input: { source: string; type: 'auto' | KnowledgeType; title?: string; raw_content: string }
  ): Promise<{
    status: 'preview' | 'saved';
    id?: string;
    type: KnowledgeType;
    title: string;
    structured: Record<string, unknown>;
    tags: string[];
  }> {
    const contentHash = hashContent(input.raw_content);

    // 去重：同作者同内容 → 返回已有（防重复条目）
    const existing = await this.dataSource.getRepository(KnowledgeEntryEntity).findOneBy({
      owner_id: authorId,
      content_hash: contentHash
    });
    if (existing) {
      return {
        status: 'saved',
        id: existing.id,
        type: existing.entry_type as KnowledgeType,
        title: existing.title,
        structured: (existing.structured ?? {}) as Record<string, unknown>,
        tags: []
      };
    }

    // 未入库：生成 preview 结构化（由 parser 引擎在 controller 层先行填充 structured）
    // 此处仅返回空 structured 骨架，实际结构化由 KnowledgeParserService 在 controller 组装。
    const type = input.type === 'auto' ? 'article' : input.type; // auto 由 parser 判定后覆盖
    return {
      status: 'preview',
      type,
      title: input.title ?? '',
      structured: {},
      tags: []
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 确认入库（preview 编辑后提交结构化结果）
  // ═══════════════════════════════════════════════════════════════════

  async commit(
    authorId: string,
    input: CommitKnowledgeEntryRequest
  ): Promise<{ id: string; status: 'saved' }> {
    // 幂等入库：请求体含完整条目字段（type/title/source/raw_content/structured/tags/links）。
    // 去重：同 author + content_hash 已存在 → 返回已有（不新建）。
    const contentHash = hashContent(input.raw_content);
    const repo = this.dataSource.getRepository(KnowledgeEntryEntity);
    const existing = await repo.findOneBy({ owner_id: authorId, content_hash: contentHash });
    if (existing) return { id: existing.id, status: 'saved' };

    const entity = repo.create();
    entity.id = randomUUID();
    entity.owner_id = authorId;
    entity.entry_type = input.type;
    entity.title = input.title;
    entity.title_key = normalizeTitleKey(input.title);
    entity.origin = mapLegacySourceToOrigin(input.source);
    entity.original_text = input.raw_content;
    entity.structured = input.structured;
    entity.content_hash = contentHash;
    entity.search_text = input.raw_content.slice(0, 2000);
    entity.library_scope = 'global';
    await repo.save(entity).catch((err: { code?: string }) => {
      if (err?.code === '23505') {
        throw new ConflictException({ message: 'Duplicate knowledge entry', details: { content_hash: contentHash } });
      }
      throw err;
    });
    return { id: entity.id, status: 'saved' };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 详情 / 更新 / 删除
  // ═══════════════════════════════════════════════════════════════════

  async getById(authorId: string, entryId: string): Promise<KnowledgeEntry> {
    const entity = await this.mustFind(authorId, entryId);
    return toEntry(entity);
  }

  async update(
    authorId: string,
    entryId: string,
    input: UpdateKnowledgeEntryRequest
  ): Promise<KnowledgeEntry> {
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.mustFindIn(manager, authorId, entryId);
      if (input.title !== undefined) {
        entity.title = input.title;
        entity.title_key = normalizeTitleKey(input.title);
      }
      if (input.structured !== undefined) entity.structured = input.structured;
      // 中间态：tags/links 已迁移为多表关系，旧 update 不再更新（T11 重写）
      await manager.save(entity);
      return toEntry(entity);
    });
  }

  async delete(authorId: string, entryId: string): Promise<{ ok: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.mustFindIn(manager, authorId, entryId);
      await manager.remove(entity);
      return { ok: true };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 统一检索（四维过滤 + 分页）
  // ═══════════════════════════════════════════════════════════════════

  async searchEntries(authorId: string, query: SearchKnowledgeRequest): Promise<SearchKnowledgeResponse> {
    const qb = this.dataSource.getRepository(KnowledgeEntryEntity)
      .createQueryBuilder('k')
      .where('k.owner_id = :authorId', { authorId });

    if (query.keyword) {
      qb.andWhere('(k.title ILIKE :kw OR k.original_text ILIKE :kw OR k.structured::text ILIKE :kw)', {
        kw: `%${query.keyword}%`
      });
    }
    if (query.type) qb.andWhere('k.entry_type = :type', { type: query.type });
    if (query.start_time) qb.andWhere('k.created_at >= :start', { start: query.start_time });
    if (query.end_time) qb.andWhere('k.created_at <= :end', { end: query.end_time });

    const [items, total] = await qb
      .orderBy('k.created_at', 'DESC')
      .skip(((query.page ?? 1) - 1) * (query.page_size ?? 20))
      .take(query.page_size ?? 20)
      .getManyAndCount();

    return { total, items: items.map(toListItem) };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 关联
  // ═══════════════════════════════════════════════════════════════════

  async addLink(authorId: string, entryId: string, input: LinkKnowledgeRequest): Promise<{ id: string; links: string[] }> {
    return this.dataSource.transaction(async (manager) => {
      await this.mustFindIn(manager, authorId, entryId);
      const target = await manager.getRepository(KnowledgeEntryEntity)
        .findOneBy({ id: input.target_id, owner_id: authorId });
      if (!target) throw new NotFoundException('Target knowledge entry not found');
      // 中间态：关联已迁移为独立表 knowledge_entry_links，旧 addLink 不再写 jsonb（T15 重写）
      return { id: entryId, links: [] };
    });
  }

  async removeLink(authorId: string, entryId: string, targetId: string): Promise<{ id: string; links: string[] }> {
    return this.dataSource.transaction(async (manager) => {
      await this.mustFindIn(manager, authorId, entryId);
      // 中间态：关联已迁移为独立表，旧 removeLink 不再写 jsonb（T15 重写）
      return { id: entryId, links: [] };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 内部辅助
  // ═══════════════════════════════════════════════════════════════════

  private async mustFind(authorId: string, entryId: string): Promise<KnowledgeEntryEntity> {
    const entity = await this.dataSource.getRepository(KnowledgeEntryEntity)
      .findOneBy({ id: entryId, owner_id: authorId });
    if (!entity) throw new NotFoundException('Knowledge entry not found');
    return entity;
  }

  private async mustFindIn(manager: EntityManager, authorId: string, entryId: string): Promise<KnowledgeEntryEntity> {
    const entity = await manager.getRepository(KnowledgeEntryEntity)
      .findOneBy({ id: entryId, owner_id: authorId });
    if (!entity) throw new NotFoundException('Knowledge entry not found');
    return entity;
  }
}
