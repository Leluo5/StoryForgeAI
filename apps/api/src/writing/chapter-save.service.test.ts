import { randomUUID } from 'node:crypto';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { schema } from '@storyforge/editor-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { ChapterSaveService } from './chapter-save.service';

let fixture: WritingFixture;
let service: ChapterSaveService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new ChapterSaveService(fixture.dataSource);
});
afterEach(() => destroyWritingFixture(fixture));

function input(text: string, baseVersion = 0) {
  return {
    change_id: randomUUID(),
    client_id: fixture.clientId,
    sequence: 1,
    base_version: baseVersion,
    operations: [new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text(text)), 0, 0)).toJSON()]
  };
}

describe('ChapterSaveService', () => {
  it('acknowledges a duplicate change once and preserves version', async () => {
    const request = input('你');
    const first = await service.save(fixture.authorId, fixture.workId, fixture.chapterId, request);
    const second = await service.save(fixture.authorId, fixture.workId, fixture.chapterId, request);
    expect(second).toEqual(first);
    expect(await fixture.dataSource.getRepository(ChapterEntity).countBy({ id: fixture.chapterId, version: 1 })).toBe(1);
    expect(await fixture.dataSource.getRepository(ChapterChangeEntity).countBy({ change_id: request.change_id })).toBe(1);
  });

  it('serializes concurrent duplicate requests into one record', async () => {
    const request = input('并发');
    const responses = await Promise.all([
      service.save(fixture.authorId, fixture.workId, fixture.chapterId, request),
      service.save(fixture.authorId, fixture.workId, fixture.chapterId, request)
    ]);
    expect(responses[0]).toEqual(responses[1]);
    expect(await fixture.dataSource.getRepository(ChapterChangeEntity).countBy({ change_id: request.change_id })).toBe(1);
  });

  it('returns 409 with the current server document', async () => {
    await service.save(fixture.authorId, fixture.workId, fixture.chapterId, input('服务端'));
    await expect(service.save(fixture.authorId, fixture.workId, fixture.chapterId, input('本地')))
      .rejects.toMatchObject({ status: 409, response: { details: { server_version: 1 } } });
  });

  it('rolls back an invalid step without a document, version or change record', async () => {
    const request = { ...input('无效'), operations: [{ stepType: 'replace', from: 999, to: 1000 }] };
    await expect(service.save(fixture.authorId, fixture.workId, fixture.chapterId, request))
      .rejects.toMatchObject({ status: 422 });
    const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({ id: fixture.chapterId });
    expect(chapter.version).toBe(0);
    expect(chapter.document).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(await fixture.dataSource.getRepository(ChapterChangeEntity).countBy({ chapter_id: fixture.chapterId })).toBe(0);
  });

  it('rejects idempotency-key reuse with different content and cross-author access', async () => {
    const request = input('第一次');
    await service.save(fixture.authorId, fixture.workId, fixture.chapterId, request);
    await expect(service.save(fixture.authorId, fixture.workId, fixture.chapterId, {
      ...request, operations: input('不同').operations
    })).rejects.toMatchObject({ status: 409 });
    await expect(service.save(fixture.otherAuthorId, fixture.workId, fixture.chapterId, input('越权')))
      .rejects.toMatchObject({ status: 404 });
  });
});
