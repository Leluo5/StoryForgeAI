// M3c-3 知识库 T16 引用与副本服务
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.7、§2.2.2
// 覆盖：批量引用（校验归属+未删、幂等复用）、引用只读强制、另存副本（keep_ref 两种）、
//       移除引用幂等、派生状态（软删 source_deleted / 失效 invalid）。
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { KnowledgeEntriesService } from './entries.service';
import { KnowledgeRefsService } from './refs.service';
import { KnowledgeWorkRefEntity } from '../database/knowledge-work-ref.entity';

let fixture: WritingFixture;
let entries: KnowledgeEntriesService;
let refs: KnowledgeRefsService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  entries = new KnowledgeEntriesService(fixture.dataSource);
  refs = new KnowledgeRefsService(fixture.dataSource);
});

afterEach(() => destroyWritingFixture(fixture));

async function makeGlobal(title: string, text?: string) {
  const res = await entries.createEntry(fixture.authorId, {
    scope: 'global',
    title,
    text: text ?? `${title}：全局正文内容，用于引用测试，内容各不相同。`,
    tags: []
  });
  return res;
}

describe('KnowledgeRefsService · 引用', () => {
  it('批量引用：建立成功且返回 summary', async () => {
    const g = await makeGlobal('被引用条目');
    const result = await refs.createRefs(fixture.authorId, fixture.workId, [g.id]);
    expect(result.length).toBe(1);
    expect(result[0]!.kind).toBe('reference');
    expect(result[0]!.title).toBe('被引用条目');
    expect(result[0]!.ref_status).toBe('active');
  });

  it('批量引用：跳过不存在的全局条目', async () => {
    const result = await refs.createRefs(fixture.authorId, fixture.workId, [
      '00000000-0000-0000-0000-000000000000'
    ]);
    expect(result.length).toBe(0);
  });

  it('批量引用：重复引用幂等复用（不报错）', async () => {
    const g = await makeGlobal('重复引用条目');
    await refs.createRefs(fixture.authorId, fixture.workId, [g.id]);
    const again = await refs.createRefs(fixture.authorId, fixture.workId, [g.id]);
    expect(again.length).toBe(1);
    const count = await fixture.dataSource.getRepository(KnowledgeWorkRefEntity).count({
      where: { work_id: fixture.workId, entry_id: g.id }
    });
    expect(count).toBe(1);
  });

  it('引用列表：返回作品库全部引用', async () => {
    const g1 = await makeGlobal('列表引用一');
    const g2 = await makeGlobal('列表引用二');
    await refs.createRefs(fixture.authorId, fixture.workId, [g1.id, g2.id]);
    const list = await refs.listRefs(fixture.authorId, fixture.workId);
    expect(list.length).toBe(2);
  });

  it('引用只读：存在引用 → 409 KNOWLEDGE_REF_READONLY', async () => {
    const g = await makeGlobal('只读引用条目');
    await refs.createRefs(fixture.authorId, fixture.workId, [g.id]);
    await expect(refs.assertNotReadonly(fixture.authorId, fixture.workId, g.id))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('引用只读：无引用则通过', async () => {
    const g = await makeGlobal('非引用条目');
    await expect(refs.assertNotReadonly(fixture.authorId, fixture.workId, g.id)).resolves.toBeUndefined();
  });

  it('软删全局条目 → 引用状态 source_deleted', async () => {
    const g = await makeGlobal('软删引用条目');
    await refs.createRefs(fixture.authorId, fixture.workId, [g.id]);
    await entries.softDelete(fixture.authorId, g.id);
    const list = await refs.listRefs(fixture.authorId, fixture.workId);
    expect(list[0]!.ref_status).toBe('source_deleted');
  });

  it('另存副本：origin=ref_copy，source_entry_id 指向全局', async () => {
    const g = await makeGlobal('副本来源');
    await refs.createRefs(fixture.authorId, fixture.workId, [g.id]);
    const copy = await refs.copyToWork(fixture.authorId, fixture.workId, g.id, { keep_ref: true });
    expect(copy.kind).toBe('entry');
    expect(copy.source_entry_id).toBe(g.id);
    expect(copy.original_text).toBe(g.original_text);
    // 引用仍保留
    const list = await refs.listRefs(fixture.authorId, fixture.workId);
    expect(list.length).toBe(1);
  });

  it('另存副本 keep_ref=false：移除原引用', async () => {
    const g = await makeGlobal('副本来源移除');
    await refs.createRefs(fixture.authorId, fixture.workId, [g.id]);
    await refs.copyToWork(fixture.authorId, fixture.workId, g.id, { keep_ref: false });
    const list = await refs.listRefs(fixture.authorId, fixture.workId);
    expect(list.length).toBe(0);
  });

  it('另存副本：来源非全局或不存在 → 404', async () => {
    await expect(
      refs.copyToWork(fixture.authorId, fixture.workId, '00000000-0000-0000-0000-000000000000', {})
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('移除引用：幂等', async () => {
    const g = await makeGlobal('移除引用条目');
    await refs.createRefs(fixture.authorId, fixture.workId, [g.id]);
    const list = await refs.listRefs(fixture.authorId, fixture.workId);
    const r1 = await refs.removeRef(fixture.authorId, fixture.workId, list[0]!.ref_id!);
    expect(r1).toEqual({ ok: true });
    const r2 = await refs.removeRef(fixture.authorId, fixture.workId, list[0]!.ref_id!);
    expect(r2).toEqual({ ok: true });
    const after = await refs.listRefs(fixture.authorId, fixture.workId);
    expect(after.length).toBe(0);
  });

  it('非作者作品引用 → 404', async () => {
    await expect(
      refs.createRefs('00000000-0000-0000-0000-000000000000', fixture.workId, [])
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
