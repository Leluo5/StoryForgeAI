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

// 实体 → 契约映射
function toEntry(entity: KnowledgeEntryEntity): KnowledgeEntry {
  return {
    id: entity.id,
    author_id: entity.author_id,
    type: entity.type as KnowledgeType,
    title: entity.title,
    source: entity.source as KnowledgeEntry['source'],
    raw_content: entity.raw_content,
    structured: entity.structured as Record<string, unknown>,
    tags: entity.tags,
    links: entity.links,
    content_hash: entity.content_hash,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

function toListItem(entity: KnowledgeEntryEntity): KnowledgeEntryListItem {
  return {
    id: entity.id,
    type: entity.type as KnowledgeType,
    title: entity.title,
    tags: entity.tags,
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
      author_id: authorId,
      content_hash: contentHash
    });
    if (existing) {
      return {
        status: 'saved',
        id: existing.id,
        type: existing.type as KnowledgeType,
        title: existing.title,
        structured: existing.structured,
        tags: existing.tags
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
    const existing = await repo.findOneBy({ author_id: authorId, content_hash: contentHash });
    if (existing) return { id: existing.id, status: 'saved' };

    const entity = repo.create();
    entity.id = randomUUID();
    entity.author_id = authorId;
    entity.type = input.type;
    entity.title = input.title;
    entity.source = input.source;
    entity.raw_content = input.raw_content;
    entity.structured = input.structured;
    entity.tags = input.tags;
    entity.links = input.links;
    entity.content_hash = contentHash;
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
      if (input.title !== undefined) entity.title = input.title;
      if (input.structured !== undefined) entity.structured = input.structured;
      if (input.tags !== undefined) entity.tags = input.tags;
      if (input.links !== undefined) entity.links = input.links;
      await manager.save(entity);
      return toEntry(entity);
    });
  }

  async delete(authorId: string, entryId: string): Promise<{ ok: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.mustFindIn(manager, authorId, entryId);
      await manager.remove(entity);
      // 清理其他条目 links 中对被删条目的引用
      const repo = manager.getRepository(KnowledgeEntryEntity);
      const referencing = await repo
        .createQueryBuilder('k')
        .where('k.author_id = :authorId', { authorId })
        .andWhere('k.links @> :entryId::jsonb', { entryId: JSON.stringify([entryId]) })
        .getMany();
      for (const ref of referencing) {
        ref.links = ref.links.filter((l) => l !== entryId);
        await manager.save(ref);
      }
      return { ok: true };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 统一检索（四维过滤 + 分页）
  // ═══════════════════════════════════════════════════════════════════

  async searchEntries(authorId: string, query: SearchKnowledgeRequest): Promise<SearchKnowledgeResponse> {
    const qb = this.dataSource.getRepository(KnowledgeEntryEntity)
      .createQueryBuilder('k')
      .where('k.author_id = :authorId', { authorId });

    if (query.keyword) {
      qb.andWhere('(k.title ILIKE :kw OR k.raw_content ILIKE :kw OR k.structured::text ILIKE :kw)', {
        kw: `%${query.keyword}%`
      });
    }
    if (query.type) qb.andWhere('k.type = :type', { type: query.type });
    if (query.tag) qb.andWhere('k.tags @> :tag::jsonb', { tag: JSON.stringify([query.tag]) });
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
      const entity = await this.mustFindIn(manager, authorId, entryId);
      if (input.target_id === entryId) throw new BadRequestException('Cannot link to itself');
      const target = await manager.getRepository(KnowledgeEntryEntity)
        .findOneBy({ id: input.target_id, author_id: authorId });
      if (!target) throw new NotFoundException('Target knowledge entry not found');
      if (!entity.links.includes(input.target_id)) entity.links.push(input.target_id);
      await manager.save(entity);
      return { id: entity.id, links: entity.links };
    });
  }

  async removeLink(authorId: string, entryId: string, targetId: string): Promise<{ id: string; links: string[] }> {
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.mustFindIn(manager, authorId, entryId);
      entity.links = entity.links.filter((l) => l !== targetId);
      await manager.save(entity);
      return { id: entity.id, links: entity.links };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 内部辅助
  // ═══════════════════════════════════════════════════════════════════

  private async mustFind(authorId: string, entryId: string): Promise<KnowledgeEntryEntity> {
    const entity = await this.dataSource.getRepository(KnowledgeEntryEntity)
      .findOneBy({ id: entryId, author_id: authorId });
    if (!entity) throw new NotFoundException('Knowledge entry not found');
    return entity;
  }

  private async mustFindIn(manager: EntityManager, authorId: string, entryId: string): Promise<KnowledgeEntryEntity> {
    const entity = await manager.getRepository(KnowledgeEntryEntity)
      .findOneBy({ id: entryId, author_id: authorId });
    if (!entity) throw new NotFoundException('Knowledge entry not found');
    return entity;
  }
}
