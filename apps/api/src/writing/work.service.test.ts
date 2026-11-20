import { createHash } from 'node:crypto';
import { canonicalizeContent, createEmptyDocument } from '@storyforge/editor-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChapterEntity } from '../database/chapter.entity';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { WorkService } from './work.service';

let fixture: WritingFixture;
let service: WorkService;

beforeAll(async () => {
  fixture = await createWritingFixture();
  service = new WorkService(fixture.dataSource);
});
afterAll(() => destroyWritingFixture(fixture));

describe('WorkService', () => {
  it('creates a work, default volume and empty first chapter atomically', async () => {
    const result = await service.create(fixture.authorId, { title: '新书', description: '' });
    expect(result.work.title).toBe('新书');
    const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({
      id: result.first_chapter_id
    });
    expect(chapter.version).toBe(0);
    expect(chapter.content_hash).toBe(
      createHash('sha256').update(canonicalizeContent(createEmptyDocument())).digest('hex')
    );
  });

  it('lists only the current author and applies a parameterized title search', async () => {
    expect((await service.list(fixture.authorId, '夹具')).some((work) => work.id === fixture.workId)).toBe(true);
    expect((await service.list(fixture.authorId, '%')).some((work) => work.id === fixture.workId)).toBe(true);
    expect(await service.list(fixture.otherAuthorId, '夹具')).toEqual([]);
  });

  it('returns 404 when updating another author\'s work', async () => {
    await expect(service.update(fixture.otherAuthorId, fixture.workId, { title: '越权' }))
      .rejects.toMatchObject({ status: 404 });
  });
});
