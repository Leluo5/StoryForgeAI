import type { Chapter, ChapterSummary, TreeResponse, Volume } from '@storyforge/contracts';
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { canonicalizeDocument, createEmptyDocument } from '@storyforge/editor-schema';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { toWork } from './work.service';

function toVolume(volume: VolumeEntity): Volume {
  return { id: volume.id, work_id: volume.work_id, title: volume.title, position: volume.position };
}
function toChapterSummary(chapter: ChapterEntity): ChapterSummary {
  return {
    id: chapter.id,
    work_id: chapter.work_id,
    volume_id: chapter.volume_id,
    title: chapter.title,
    position: chapter.position,
    version: chapter.version,
    content_hash: chapter.content_hash
  };
}
async function assertOwnedWork(manager: EntityManager, workId: string, authorId: string, lock = false): Promise<WorkEntity> {
  const work = await manager.getRepository(WorkEntity).findOne({
    where: { id: workId, author_id: authorId },
    ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {})
  });
  if (!work) throw new NotFoundException('Work not found');
  return work;
}
async function ownedVolume(manager: EntityManager, workId: string, volumeId: string): Promise<VolumeEntity> {
  const volume = await manager.getRepository(VolumeEntity).findOneBy({ id: volumeId, work_id: workId });
  if (!volume) throw new NotFoundException('Volume not found');
  return volume;
}
async function ownedChapter(manager: EntityManager, workId: string, chapterId: string): Promise<ChapterEntity> {
  const chapter = await manager.getRepository(ChapterEntity).findOneBy({ id: chapterId, work_id: workId });
  if (!chapter) throw new NotFoundException('Chapter not found');
  return chapter;
}
function assertCompleteOrder<T extends { id: string }>(current: T[], orderedIds: string[]): void {
  const known = new Set(current.map((item) => item.id));
  if (orderedIds.some((id) => !known.has(id))) throw new NotFoundException('Order contains a foreign resource');
  if (orderedIds.length !== current.length || new Set(orderedIds).size !== current.length) {
    throw new UnprocessableEntityException({ message: 'Order must contain every sibling exactly once' });
  }
}

@Injectable()
export class StructureService {
  constructor(private readonly dataSource: DataSource) {}

  tree(authorId: string, workId: string): Promise<TreeResponse> {
    return this.dataSource.transaction(async (manager) => {
      const work = await assertOwnedWork(manager, workId, authorId);
      const volumes = await manager.getRepository(VolumeEntity).find({
        where: { work_id: workId }, order: { position: 'ASC' }
      });
      const chapters = await manager.getRepository(ChapterEntity).find({
        where: { work_id: workId }, order: { volume_id: 'ASC', position: 'ASC' }
      });
      return { work: toWork(work), volumes: volumes.map(toVolume), chapters: chapters.map(toChapterSummary) };
    });
  }

  createVolume(authorId: string, workId: string, input: { title: string }): Promise<Volume> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId, true);
      const siblings = await manager.getRepository(VolumeEntity).findBy({ work_id: workId });
      const position = siblings.reduce((maximum, item) => Math.max(maximum, item.position + 1), 0);
      const volume = await manager.getRepository(VolumeEntity).save(manager.getRepository(VolumeEntity).create({
        id: randomUUID(), work_id: workId, title: input.title, position
      }));
      return toVolume(volume);
    });
  }

  renameVolume(authorId: string, workId: string, volumeId: string, input: { title: string }): Promise<Volume> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId);
      const volume = await ownedVolume(manager, workId, volumeId);
      volume.title = input.title;
      return toVolume(await manager.save(volume));
    });
  }

  reorderVolumes(authorId: string, workId: string, orderedIds: string[]): Promise<Volume[]> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId, true);
      const repository = manager.getRepository(VolumeEntity);
      const volumes = await repository.find({ where: { work_id: workId }, order: { position: 'ASC' } });
      assertCompleteOrder(volumes, orderedIds);
      for (const [position, id] of orderedIds.entries()) await repository.update({ id, work_id: workId }, { position });
      return (await repository.find({ where: { work_id: workId }, order: { position: 'ASC' } })).map(toVolume);
    });
  }

  createChapter(authorId: string, workId: string, volumeId: string, input: { title: string }): Promise<Chapter> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId, true);
      await ownedVolume(manager, workId, volumeId);
      const siblings = await manager.getRepository(ChapterEntity).findBy({ volume_id: volumeId });
      const position = siblings.reduce((maximum, item) => Math.max(maximum, item.position + 1), 0);
      const document = createEmptyDocument();
      const contentHash = createHash('sha256').update(canonicalizeDocument(document)).digest('hex');
      const chapter = await manager.getRepository(ChapterEntity).save(manager.getRepository(ChapterEntity).create({
        id: randomUUID(),
        work_id: workId,
        volume_id: volumeId,
        title: input.title,
        position,
        document,
        version: 0,
        content_hash: contentHash
      }));
      return { ...toChapterSummary(chapter), document: chapter.document };
    });
  }

  renameChapter(authorId: string, workId: string, chapterId: string, input: { title: string }): Promise<ChapterSummary> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId);
      const chapter = await ownedChapter(manager, workId, chapterId);
      chapter.title = input.title;
      return toChapterSummary(await manager.save(chapter));
    });
  }

  reorderChapters(authorId: string, workId: string, volumeId: string, orderedIds: string[]): Promise<ChapterSummary[]> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId, true);
      await ownedVolume(manager, workId, volumeId);
      const repository = manager.getRepository(ChapterEntity);
      const chapters = await repository.find({ where: { volume_id: volumeId, work_id: workId }, order: { position: 'ASC' } });
      assertCompleteOrder(chapters, orderedIds);
      for (const [position, id] of orderedIds.entries()) {
        await repository.update({ id, work_id: workId, volume_id: volumeId }, { position });
      }
      return (await repository.find({ where: { volume_id: volumeId, work_id: workId }, order: { position: 'ASC' } }))
        .map(toChapterSummary);
    });
  }

  getChapter(authorId: string, workId: string, chapterId: string): Promise<Chapter> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId);
      const chapter = await ownedChapter(manager, workId, chapterId);
      return { ...toChapterSummary(chapter), document: chapter.document };
    });
  }
}
