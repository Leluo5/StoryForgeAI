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
    // F2 尾巴：默认公开且无访问码
    expect(result.work.is_public).toBe(true);
    expect(result.work.access_code).toBe('');
    const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({
      id: result.first_chapter_id
    });
    expect(chapter.version).toBe(0);
    expect(chapter.content_hash).toBe(
      createHash('sha256').update(canonicalizeContent(createEmptyDocument())).digest('hex')
    );
  });

  it('persists is_public and access_code on create and update', async () => {
    const created = await service.create(fixture.authorId, {
      title: '访问码作品', description: '', is_public: false, access_code: 'SUN-2026'
    });
    expect(created.work.is_public).toBe(false);
    expect(created.work.access_code).toBe('SUN-2026');
    const updated = await service.update(fixture.authorId, created.work.id, {
      is_public: true, access_code: ''
    });
    expect(updated.is_public).toBe(true);
    expect(updated.access_code).toBe('');
  });

  it('lists only the current author and applies a parameterized title search', async () => {
    expect((await service.list(fixture.authorId, '夹具')).some((work) => work.id === fixture.workId)).toBe(true);
    expect((await service.list(fixture.authorId, '%')).some((work) => work.id === fixture.workId)).toBe(true);
    expect(await service.list(fixture.otherAuthorId, '夹具')).toEqual([]);
  });

  it('sums non-whitespace character counts across a work\'s chapters', async () => {
    const chapterRepo = fixture.dataSource.getRepository(ChapterEntity);
    const chapter = await chapterRepo.findOneByOrFail({ id: fixture.chapterId });
    // 首个章节 document 写入带空白的文本，验证字数统计去空白
    chapter.document = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: ' 山海 秘闻录 ' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '雾岛守夜' }] }
      ]
    };
    await chapterRepo.save(chapter);
    const works = await service.list(fixture.authorId, '');
    const target = works.find((work) => work.id === fixture.workId);
    // 非空白字符：山海秘闻录(5) + 雾岛守夜(4) = 9
    expect(target?.word_count).toBe(9);
  });

  it('returns 404 when updating another author\'s work', async () => {
    await expect(service.update(fixture.otherAuthorId, fixture.workId, { title: '越权' }))
      .rejects.toMatchObject({ status: 404 });
  });
});
