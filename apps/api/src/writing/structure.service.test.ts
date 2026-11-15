import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { StructureService } from './structure.service';

let fixture: WritingFixture;
let service: StructureService;
let chapterBId: string;
let otherVolumeId: string;
let otherVolumeChapterId: string;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new StructureService(fixture.dataSource);
  chapterBId = (await service.createChapter(fixture.authorId, fixture.workId, fixture.volumeId, { title: '第二章' })).id;
  otherVolumeId = (await service.createVolume(fixture.authorId, fixture.workId, { title: '第二卷' })).id;
  otherVolumeChapterId = (await service.createChapter(fixture.authorId, fixture.workId, otherVolumeId, { title: '另一卷章节' })).id;
});
afterEach(() => destroyWritingFixture(fixture));

describe('StructureService', () => {
  it('rejects partial and cross-volume reorder lists', async () => {
    await expect(service.reorderChapters(fixture.authorId, fixture.workId, fixture.volumeId, [fixture.chapterId]))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.reorderChapters(
      fixture.authorId,
      fixture.workId,
      fixture.volumeId,
      [fixture.chapterId, chapterBId, otherVolumeChapterId]
    )).rejects.toMatchObject({ status: 404 });
  });

  it('returns a tree without document payloads and reorders a complete parent list', async () => {
    const reordered = await service.reorderChapters(
      fixture.authorId, fixture.workId, fixture.volumeId, [chapterBId, fixture.chapterId]
    );
    expect(reordered.map((chapter) => chapter.id)).toEqual([chapterBId, fixture.chapterId]);
    const tree = await service.tree(fixture.authorId, fixture.workId);
    expect(tree.chapters[0]).not.toHaveProperty('document');
    expect(tree.volumes.map((volume) => volume.id)).toContain(otherVolumeId);
  });

  it('renames only owned resources and returns a full chapter only on explicit read', async () => {
    const renamed = await service.renameChapter(fixture.authorId, fixture.workId, fixture.chapterId, { title: '新章名' });
    expect(renamed.title).toBe('新章名');
    const chapter = await service.getChapter(fixture.authorId, fixture.workId, fixture.chapterId);
    expect(chapter.document.type).toBe('doc');
    await expect(service.getChapter(fixture.otherAuthorId, fixture.workId, fixture.chapterId))
      .rejects.toMatchObject({ status: 404 });
  });
});
