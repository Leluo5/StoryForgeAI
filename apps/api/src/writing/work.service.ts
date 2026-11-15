import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { canonicalizeDocument, createEmptyDocument } from '@storyforge/editor-schema';
import type { CreateWorkRequest, CreateWorkResponse, UpdateWorkRequest, Work } from '@storyforge/contracts';
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';

export function toWork(work: WorkEntity): Work {
  return {
    id: work.id,
    author_id: work.author_id,
    title: work.title,
    description: work.description,
    status: work.status,
    created_at: work.created_at.toISOString(),
    updated_at: work.updated_at.toISOString()
  };
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
        status: 'active'
      }));
      const volume = await manager.getRepository(VolumeEntity).save(manager.getRepository(VolumeEntity).create({
        id: randomUUID(), work_id: work.id, title: '第一卷', position: 0
      }));
      const document = createEmptyDocument();
      const contentHash = createHash('sha256').update(canonicalizeDocument(document)).digest('hex');
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
    return works.map(toWork);
  }

  async update(authorId: string, workId: string, input: UpdateWorkRequest): Promise<Work> {
    const repository = this.dataSource.getRepository(WorkEntity);
    const work = await repository.findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('Work not found');
    if (input.title !== undefined) work.title = input.title;
    if (input.description !== undefined) work.description = input.description;
    if (input.status !== undefined) work.status = input.status;
    return toWork(await repository.save(work));
  }
}
