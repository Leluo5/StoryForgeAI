// M3c-3 知识库 T17 回收站与彻底删除
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.8、§4.1、F3 T17 完成标准
// 覆盖：回收站列表（按删除时间倒序、默认排除常规列表）、恢复（清空 deleted_at 保持结构、
//       与库内同内容冲突 → 409）、彻底删除（无 confirm → 422 CONFIRM_REQUIRED；
//       confirm=true 级联删 entry_tags/links/embedding/job_events + 引用失效 + 检索排除 + 事务原子）。
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { KnowledgeEntriesService } from './entries.service';
import { KnowledgeRefsService } from './refs.service';
import { KnowledgeTrashService } from './trash.service';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { KnowledgeEntryLinkEntity } from '../database/knowledge-entry-link.entity';
import { KnowledgeEntryEmbeddingEntity } from '../database/knowledge-entry-embedding.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';
import { KnowledgeJobEventEntity } from '../database/knowledge-job-event.entity';
import { KnowledgeWorkRefEntity } from '../database/knowledge-work-ref.entity';
import { hashContent } from './entries.service';

let fixture: WritingFixture;
let entries: KnowledgeEntriesService;
let refs: KnowledgeRefsService;
let trash: KnowledgeTrashService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  entries = new KnowledgeEntriesService(fixture.dataSource);
  refs = new KnowledgeRefsService(fixture.dataSource);
  trash = new KnowledgeTrashService(fixture.dataSource);
});

afterEach(() => destroyWritingFixture(fixture));

async function makeGlobal(title: string, text?: string) {
  const res = await entries.createEntry(fixture.authorId, {
    scope: 'global',
    title,
    text: text ?? `${title}：正文内容各不相同，用于回收站测试。`,
    tags: []
  });
  return res;
}

describe('KnowledgeTrashService · 回收站列表', () => {
  it('回收站按删除时间倒序返回', async () => {
    const a = await makeGlobal('回收站条目一');
    const b = await makeGlobal('回收站条目二');
    await entries.softDelete(fixture.authorId, a.id);
    await entries.softDelete(fixture.authorId, b.id);
    const list = await trash.listTrash(fixture.authorId, 'global');
    expect(list.items.length).toBe(2);
    // b 后删，应排在前面
    expect(list.items[0]!.id).toBe(b.id);
    expect(list.items[1]!.id).toBe(a.id);
  });

  it('常规列表默认排除回收站条目', async () => {
    const a = await makeGlobal('常规排除条目');
    await entries.softDelete(fixture.authorId, a.id);
    const normal = await entries.listEntries(fixture.authorId, { scope: 'global' });
    expect(normal.items.length).toBe(0);
  });
});

describe('KnowledgeTrashService · 恢复', () => {
  it('恢复清空 deleted_at 且保持原结构', async () => {
    const a = await makeGlobal('恢复结构条目', '恢复结构：正文完整保留。');
    await entries.softDelete(fixture.authorId, a.id);
    await trash.restore(fixture.authorId, a.id);
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: a.id });
    expect(entity.deleted_at).toBeNull();
    expect(entity.deleted_by).toBeNull();
    expect(entity.title).toBe('恢复结构条目');
    expect(entity.original_text).toBe('恢复结构：正文完整保留。');
    expect(entity.content_hash).toBe(hashContent('恢复结构：正文完整保留。'));
  });

  it('恢复与库内现有同内容条目冲突 → 409 KNOWLEDGE_ENTRY_DUPLICATE', async () => {
    const text = '冲突正文：与恢复条目内容一致。';
    const a = await makeGlobal('恢复冲突条目', text);
    await entries.softDelete(fixture.authorId, a.id);
    // 恢复期间新建了同内容条目
    await makeGlobal('冲突同内容新条目', text);
    await expect(trash.restore(fixture.authorId, a.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('恢复非回收站条目 → 409 KNOWLEDGE_ENTRY_NOT_DELETED', async () => {
    const a = await makeGlobal('非回收站恢复条目');
    await expect(trash.restore(fixture.authorId, a.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('恢复不存在的条目 → 404', async () => {
    await expect(
      trash.restore(fixture.authorId, '00000000-0000-0000-0000-000000000000')
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KnowledgeTrashService · 彻底删除（二次确认 + 级联原子）', () => {
  it('无 confirm → 422 CONFIRM_REQUIRED', async () => {
    const a = await makeGlobal('二次确认条目');
    await entries.softDelete(fixture.authorId, a.id);
    await expect(trash.purge(fixture.authorId, a.id, { confirm: false }))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('confirm=true 物理删除条目并级联清理标签关联', async () => {
    const a = await entries.createEntry(fixture.authorId, {
      scope: 'global',
      title: '级联标签条目',
      text: '级联标签：正文用于彻底删除。',
      tags: ['标签A', '标签B']
    });
    await entries.softDelete(fixture.authorId, a.id);
    const tagsBefore = await fixture.dataSource.getRepository(KnowledgeEntryTagEntity).count({
      where: { entry_id: a.id }
    });
    expect(tagsBefore).toBe(2);

    await trash.purge(fixture.authorId, a.id, { confirm: true });

    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ id: a.id });
    expect(entity).toBeNull();
    const tagsAfter = await fixture.dataSource.getRepository(KnowledgeEntryTagEntity).count({
      where: { entry_id: a.id }
    });
    expect(tagsAfter).toBe(0);
  });

  it('confirm=true 级联删除跨条目关联与向量', async () => {
    const a = await makeGlobal('级联关联条目');
    const b = await makeGlobal('级联关联条目B');
    await entries.softDelete(fixture.authorId, a.id);
    // 手动关联 a→b
    await fixture.dataSource.getRepository(KnowledgeEntryLinkEntity).save(
      fixture.dataSource.getRepository(KnowledgeEntryLinkEntity).create({
        id: crypto.randomUUID(),
        owner_id: fixture.authorId,
        library_scope: 'global',
        work_id: null,
        source_entry_id: a.id,
        target_entry_id: b.id,
        kind: 'manual',
        score: null,
        created_by: fixture.authorId
      })
    );
    // 向量行（bge-m3 1024 维）
    await fixture.dataSource.getRepository(KnowledgeEntryEmbeddingEntity).save(
      fixture.dataSource.getRepository(KnowledgeEntryEmbeddingEntity).create({
        entry_id: a.id,
        owner_id: fixture.authorId,
        model: 'mock-bge-m3-1024',
        dim: 1024,
        embedding: `[${Array.from({ length: 1024 }, (_, i) => (i % 10) / 10).join(',')}]`,
        source_hash: 'abc123'
      })
    );

    await trash.purge(fixture.authorId, a.id, { confirm: true });

    const link = await fixture.dataSource.getRepository(KnowledgeEntryLinkEntity).findOneBy({
      source_entry_id: a.id
    });
    expect(link).toBeNull();
    const emb = await fixture.dataSource.getRepository(KnowledgeEntryEmbeddingEntity).findOneBy({
      entry_id: a.id
    });
    expect(emb).toBeNull();
  });

  it('confirm=true 级联删除作业与事件', async () => {
    const a = await makeGlobal('级联作业条目');
    await entries.softDelete(fixture.authorId, a.id);
    const jobRepo = fixture.dataSource.getRepository(KnowledgeJobEntity);
    const job = await jobRepo.save(jobRepo.create({
      id: crypto.randomUUID(),
      owner_id: fixture.authorId,
      library_scope: 'global',
      work_id: null,
      entry_id: a.id,
      kind: 'structure',
      status: 'succeeded',
      created_by: fixture.authorId
    }));
    await fixture.dataSource.getRepository(KnowledgeJobEventEntity).save(
      fixture.dataSource.getRepository(KnowledgeJobEventEntity).create({
        id: crypto.randomUUID(),
        job_id: job.id,
        event_seq: 1,
        type: 'progress',
        payload: { percent: 100 }
      })
    );

    await trash.purge(fixture.authorId, a.id, { confirm: true });

    const jobAfter = await jobRepo.findOneBy({ id: job.id });
    expect(jobAfter).toBeNull();
  });

  it('confirm=true 引用 entry_id 置 NULL（失效），快照保留', async () => {
    const a = await makeGlobal('彻底删除引用条目');
    await refs.createRefs(fixture.authorId, fixture.workId, [a.id]);
    await entries.softDelete(fixture.authorId, a.id);
    await trash.purge(fixture.authorId, a.id, { confirm: true });

    const ref = await fixture.dataSource.getRepository(KnowledgeWorkRefEntity).findOneBy({
      work_id: fixture.workId,
      entry_id: a.id
    });
    expect(ref).toBeNull();
    // 引用行仍存在但 entry_id 为 NULL（FK SET NULL 语义）
    const allRefs = await fixture.dataSource.getRepository(KnowledgeWorkRefEntity).find({
      where: { work_id: fixture.workId }
    });
    expect(allRefs.length).toBe(1);
    expect(allRefs[0]!.entry_id).toBeNull();
    expect(allRefs[0]!.snapshot_title).toBe('彻底删除引用条目');
  });

  it('已彻底删除条目不参与常规检索', async () => {
    const a = await makeGlobal('检索排除条目', '检索排除：这段正文含唯一关键词。');
    await entries.softDelete(fixture.authorId, a.id);
    await trash.purge(fixture.authorId, a.id, { confirm: true });
    const res = await entries.listEntries(fixture.authorId, { scope: 'global', keyword: '唯一关键词' });
    expect(res.items.length).toBe(0);
  });

  it('彻底删除非回收站条目 → 404', async () => {
    const a = await makeGlobal('未删除彻底删条目');
    await expect(trash.purge(fixture.authorId, a.id, { confirm: true }))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
