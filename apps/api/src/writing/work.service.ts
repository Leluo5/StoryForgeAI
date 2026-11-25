import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { canonicalizeContent, createEmptyDocument } from '@storyforge/editor-schema';
import type { CreateWorkRequest, CreateWorkResponse, UpdateWorkRequest, Work } from '@storyforge/contracts';
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { seedCharacterRelationTypes } from '../database/character-relation-type.seed';

export function toWork(work: WorkEntity, wordCount = 0): Work {
  return {
    id: work.id,
    author_id: work.author_id,
    title: work.title,
    description: work.description,
    status: work.status,
    word_count: wordCount,
    is_public: work.is_public,
    access_code: work.access_code,
    created_at: work.created_at.toISOString(),
    updated_at: work.updated_at.toISOString()
  };
}

/** 递归统计 ProseMirror 文档中 text 节点的非空白字数。 */
export function countDocumentCharacters(node: unknown): number {
  if (node == null || typeof node !== 'object') return 0;
  const record = node as Record<string, unknown>;
  let count = 0;
  if (typeof record.text === 'string') {
    count += record.text.replace(/\s/g, '').length;
  }
  if (Array.isArray(record.content)) {
    for (const child of record.content) count += countDocumentCharacters(child);
  }
  return count;
}

@Injectable()
export class WorkService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async create(authorId: string, input: CreateWorkRequest): Promise<CreateWorkResponse> {
    return this.dataSource.transaction(async (manager) => {
      const work = await manager.getRepository(WorkEntity).save(manager.getRepository(WorkEntity).create({
        id: randomUUID(),
        author_id: authorId,
        title: input.title,
        description: input.description,
        status: 'active',
        is_public: input.is_public ?? true,
        access_code: input.access_code ?? ''
      }));
      // M3c-2：作品创建时同事务写入 5 组 23 类默认关系类型（Q2 / A2）
      await seedCharacterRelationTypes(manager, work.id);
      const volume = await manager.getRepository(VolumeEntity).save(manager.getRepository(VolumeEntity).create({
        id: randomUUID(), work_id: work.id, title: '第一卷', position: 0
      }));
      const document = createEmptyDocument();
      const contentHash = createHash('sha256').update(canonicalizeContent(document)).digest('hex');
      const chapter = await manager.getRepository(ChapterEntity).save(manager.getRepository(ChapterEntity).create({
        id: randomUUID(),
        work_id: work.id,
        volume_id: volume.id,
        title: '第一章',
        position: 0,
        document,
        version: 0,
        content_hash: contentHash
      }));
      return { work: toWork(work), first_chapter_id: chapter.id };
    });
  }

  async list(authorId: string, query = ''): Promise<Work[]> {
    const builder = this.dataSource.getRepository(WorkEntity).createQueryBuilder('work')
      .where('work.author_id = :authorId', { authorId });
    if (query.trim()) builder.andWhere('work.title ILIKE :query', { query: `%${query.trim()}%` });
    const works = await builder.orderBy('work.updated_at', 'DESC').getMany();
    if (works.length === 0) return [];
    // 批量取当前作者所有章节的 document，按 work_id 汇总非空白字数
    const rows = await this.dataSource.getRepository(ChapterEntity)
      .createQueryBuilder('chapter')
      .select('chapter.work_id', 'work_id')
      .addSelect('chapter.document', 'document')
      .where('chapter.work_id IN (:...ids)', { ids: works.map((work) => work.id) })
      .getRawMany<{ work_id: string; document: unknown }>();
    const totals = new Map<string, number>();
    for (const row of rows) {
      totals.set(row.work_id, (totals.get(row.work_id) ?? 0) + countDocumentCharacters(row.document));
    }
    return works.map((work) => toWork(work, totals.get(work.id) ?? 0));
  }

  async update(authorId: string, workId: string, input: UpdateWorkRequest): Promise<Work> {
    const repository = this.dataSource.getRepository(WorkEntity);
    const work = await repository.findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('Work not found');
    if (input.title !== undefined) work.title = input.title;
    if (input.description !== undefined) work.description = input.description;
    if (input.status !== undefined) work.status = input.status;
    if (input.is_public !== undefined) work.is_public = input.is_public;
    if (input.access_code !== undefined) work.access_code = input.access_code;
    return toWork(await repository.save(work));
  }
}
