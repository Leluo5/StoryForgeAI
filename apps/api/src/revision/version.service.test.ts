import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChapterEntity } from '../database/chapter.entity';
import { VersionSnapshotEntity } from '../database/version-snapshot.entity';
import { RevisionSetEntity } from '../database/revision-set.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { VersionService } from './version.service';
import { AuditService } from './audit.service';

let fixture: WritingFixture;
let service: VersionService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new VersionService(fixture.dataSource, new AuditService(fixture.dataSource));
});
afterEach(() => destroyWritingFixture(fixture));

async function saveText(text: string): Promise<void> {
  const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({ id: fixture.chapterId });
  await fixture.dataSource.getRepository(ChapterEntity).update(
    { id: chapter.id, version: chapter.version },
    { document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, version: chapter.version + 1 }
  );
}

describe('VersionService', () => {
  it('creates a manual snapshot of the current version and returns its id', async () => {
    const created = await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, { note: '首发' });
    expect(created).toMatchObject({ version_no: 0 });
    expect(created.snapshot_id).toBeTruthy();
    const snapshot = await fixture.dataSource.getRepository(VersionSnapshotEntity).findOneByOrFail({ id: created.snapshot_id });
    expect(snapshot.change_type).toBe('manual');
    expect(snapshot.note).toBe('首发');
    expect(snapshot.revision_set_id).toBeNull();
  });

  it('is idempotent when a snapshot already exists for the current version', async () => {
    const first = await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    const second = await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, { note: '重复' });
    expect(second).toEqual(first);
    expect(await fixture.dataSource.getRepository(VersionSnapshotEntity).countBy({ chapter_id: fixture.chapterId })).toBe(1);
  });

  it('lists version history newest first with pagination', async () => {
    await saveText('一');
    await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    await saveText('二');
    await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    const list = await service.listVersions(fixture.authorId, fixture.workId, fixture.chapterId, {});
    expect(list.total).toBe(2);
    expect(list.versions.map((item) => item.version_no)).toEqual([2, 1]);
  });

  it('returns a single snapshot with its document', async () => {
    await saveText('内容');
    await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    const { snapshot } = await service.getVersion(fixture.authorId, fixture.workId, fixture.chapterId, 1);
    expect(snapshot.version_no).toBe(1);
    expect(snapshot.document).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '内容' }] }] });
    expect(snapshot.content_hash).toHaveLength(64);
  });

  it('hashes snapshots pid-neutrally and reports no diff when only pids differ', async () => {
    const pid = '11111111-1111-4111-8111-111111111111';
    const chapters = fixture.dataSource.getRepository(ChapterEntity);
    await chapters.update({ id: fixture.chapterId }, {
      document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '同一段' }] }] },
      version: 1
    });
    const first = await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    await chapters.update({ id: fixture.chapterId }, {
      document: { type: 'doc', content: [{ type: 'paragraph', attrs: { pid }, content: [{ type: 'text', text: '同一段' }] }] },
      version: 2
    });
    const second = await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});

    const snapshots = fixture.dataSource.getRepository(VersionSnapshotEntity);
    const left = await snapshots.findOneByOrFail({ id: first.snapshot_id });
    const right = await snapshots.findOneByOrFail({ id: second.snapshot_id });
    expect(right.content_hash).toBe(left.content_hash);

    const compared = await service.compareVersions(fixture.authorId, fixture.workId, fixture.chapterId, {
      from_version_no: 1,
      to_version_no: 2
    });
    expect(compared.node_changes).toEqual([]);
    expect(compared.text_diff.every((part) => part.kind === 'equal')).toBe(true);
  });

  it('throws 404 for a missing version snapshot', async () => {
    await expect(service.getVersion(fixture.authorId, fixture.workId, fixture.chapterId, 99))
      .rejects.toMatchObject({ status: 404 });
  });

  it('compares two versions with node changes and text diff', async () => {
    await saveText('第一段\n第二段');
    await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    await saveText('第一段\n改动后');
    await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    const result = await service.compareVersions(fixture.authorId, fixture.workId, fixture.chapterId, {
      from_version_no: 1,
      to_version_no: 2
    });
    expect(result.from_version_no).toBe(1);
    expect(result.to_version_no).toBe(2);
    expect(result.text_diff.some((part) => part.kind === 'delete' && part.text.includes('第二段'))).toBe(true);
    expect(result.text_diff.some((part) => part.kind === 'insert' && part.text.includes('改动后'))).toBe(true);
  });

  it('throws 404 when a compared version does not exist', async () => {
    await expect(service.compareVersions(fixture.authorId, fixture.workId, fixture.chapterId, {
      from_version_no: 1,
      to_version_no: 2
    })).rejects.toMatchObject({ status: 404 });
  });

  it('creates a rollback revision set against the target snapshot and auto-snapshots first', async () => {
    await saveText('原始');
    await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, { note: 'v1 原始' });
    await saveText('当前');
    const { revision_set, preview } = await service.rollback(fixture.authorId, fixture.workId, fixture.chapterId, 1);
    expect(revision_set.actor_type).toBe('rollback');
    expect(revision_set.status).toBe('pending');
    expect(revision_set.base_version).toBe(2);
    expect(preview).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '原始' }] }] });
    // 回滚前自动快照当前版本 2
    const snapshots = await fixture.dataSource.getRepository(VersionSnapshotEntity).findBy({ chapter_id: fixture.chapterId });
    expect(snapshots.some((item) => item.version_no === 2 && item.change_type === 'auto')).toBe(true);
  });

  it('confirms a rollback, applies the document, bumps version and writes chapter_change', async () => {
    await saveText('原始');
    await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    await saveText('当前');
    const { revision_set } = await service.rollback(fixture.authorId, fixture.workId, fixture.chapterId, 1);
    const confirmed = await service.confirmRollback(fixture.authorId, fixture.workId, revision_set.id);
    expect(confirmed.version_no).toBe(3);
    const doc = confirmed.document as { content: Array<{ content?: Array<{ text?: string }> }> };
    expect(doc.content?.[0]?.content?.[0]?.text).toBe('原始');
    const change = await fixture.dataSource.getRepository(ChapterChangeEntity).findOneByOrFail({ chapter_id: fixture.chapterId });
    expect(change.base_version).toBe(2);
    expect(change.server_version).toBe(3);
  });

  it('rejects confirm when there are unsaved changes (version mismatch) with 409', async () => {
    await saveText('原始');
    await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    const { revision_set } = await service.rollback(fixture.authorId, fixture.workId, fixture.chapterId, 1);
    // 模拟未保存变更：服务端版本又前进了（但未写 chapter_change）
    await saveText('未保存的改动');
    await expect(service.confirmRollback(fixture.authorId, fixture.workId, revision_set.id))
      .rejects.toMatchObject({ status: 409 });
  });

  it('is idempotent on confirm rollback', async () => {
    await saveText('原始');
    await service.createVersion(fixture.authorId, fixture.workId, fixture.chapterId, {});
    await saveText('当前');
    const { revision_set } = await service.rollback(fixture.authorId, fixture.workId, fixture.chapterId, 1);
    const first = await service.confirmRollback(fixture.authorId, fixture.workId, revision_set.id);
    const second = await service.confirmRollback(fixture.authorId, fixture.workId, revision_set.id);
    expect(second).toEqual(first);
  });
});
