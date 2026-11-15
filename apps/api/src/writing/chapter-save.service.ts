import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyOperations, canonicalizeDocument } from '@storyforge/editor-schema';
import type { SaveChangeRequest, SaveChangeResponse } from '@storyforge/contracts';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';

@Injectable()
export class ChapterSaveService {
  constructor(private readonly dataSource: DataSource) {}

  save(authorId: string, workId: string, chapterId: string, input: SaveChangeRequest): Promise<SaveChangeResponse> {
    return this.dataSource.transaction(async (manager) => {
      const chapter = await manager.getRepository(ChapterEntity).createQueryBuilder('chapter')
        .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
        .where('chapter.id = :chapterId', { chapterId })
        .andWhere('chapter.work_id = :workId', { workId })
        .andWhere('work.author_id = :authorId', { authorId })
        .setLock('pessimistic_write')
        .getOne();
      if (!chapter) throw new NotFoundException('Chapter not found');

      const changes = manager.getRepository(ChapterChangeEntity);
      const existing = await changes.findOneBy({ change_id: input.change_id });
      if (existing) {
        const same = existing.chapter_id === chapterId
          && existing.author_id === authorId
          && existing.client_id === input.client_id
          && existing.sequence === input.sequence
          && existing.base_version === input.base_version
          && isDeepStrictEqual(existing.operations, input.operations);
        if (!same) throw new ConflictException({ message: 'Idempotency key reused with different content' });
        return {
          change_id: existing.change_id,
          server_version: existing.server_version,
          content_hash: existing.content_hash
        };
      }
      if (chapter.version !== input.base_version) {
        throw new ConflictException({
          message: 'Chapter version conflict',
          details: {
            server_version: chapter.version,
            server_document: chapter.document,
            server_content_hash: chapter.content_hash
          }
        });
      }

      let document;
      try {
        document = applyOperations(chapter.document, input.operations);
      } catch (error) {
        throw new UnprocessableEntityException({
          message: 'Invalid document change',
          details: { reason: error instanceof Error ? error.message : 'Invalid step' }
        });
      }
      const contentHash = createHash('sha256').update(canonicalizeDocument(document.toJSON())).digest('hex');
      const serverVersion = chapter.version + 1;
      const updated = await manager.update(ChapterEntity, { id: chapter.id, version: chapter.version }, {
        document: document.toJSON(), version: serverVersion, content_hash: contentHash
      });
      if (updated.affected !== 1) throw new ConflictException({ message: 'Chapter version conflict' });
      const change = changes.create();
      change.id = randomUUID();
      change.chapter_id = chapterId;
      change.author_id = authorId;
      change.change_id = input.change_id;
      change.client_id = input.client_id;
      change.sequence = input.sequence;
      change.base_version = input.base_version;
      change.server_version = serverVersion;
      change.operations = input.operations;
      change.content_hash = contentHash;
      await changes.save(change);
      return { change_id: input.change_id, server_version: serverVersion, content_hash: contentHash };
    });
  }
}
