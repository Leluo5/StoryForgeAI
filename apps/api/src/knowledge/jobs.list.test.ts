// M3c-3 知识库 L3 · KnowledgeJobService.listJobs 测试（TDD RED→GREEN）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5、§3.4；契约 knowledgeJobListQuerySchema
// 覆盖：作者隔离、scope/workId/kind/status 过滤、created_at DESC 排序、limit 上限 100、游标分页。
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { KnowledgeJobService } from './jobs.processor';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';

let fixture: WritingFixture;
let service: KnowledgeJobService;
let queueAdds: string[];

const fakeQueue = {
  async add(jobId: string): Promise<void> {
    queueAdds.push(jobId);
  },
  async close(): Promise<void> {}
};

beforeEach(async () => {
  fixture = await createWritingFixture();
  queueAdds = [];
  service = new KnowledgeJobService(fixture.dataSource, fakeQueue);
});

afterEach(() => destroyWritingFixture(fixture));

async function createJob(partial: Partial<KnowledgeJobEntity> = {}): Promise<KnowledgeJobEntity> {
  const repo = fixture.dataSource.getRepository(KnowledgeJobEntity);
  const job = repo.create({
    id: partial.id ?? crypto.randomUUID(),
    owner_id: partial.owner_id ?? fixture.authorId,
    library_scope: partial.library_scope ?? 'global',
    work_id: partial.work_id ?? null,
    entry_id: partial.entry_id ?? null,
    kind: partial.kind ?? 'structure',
    status: partial.status ?? 'queued',
    progress: partial.progress ?? {},
    input: partial.input ?? {},
    result: partial.result ?? {},
    error: partial.error ?? null,
    staging_path: partial.staging_path ?? null,
    artifact_path: partial.artifact_path ?? null,
    artifact_size: partial.artifact_size ?? null,
    artifact_hash: partial.artifact_hash ?? null,
    idempotency_key: partial.idempotency_key ?? null,
    event_seq: partial.event_seq ?? 0,
    created_by: partial.created_by ?? fixture.authorId,
    started_at: partial.started_at ?? null,
    finished_at: partial.finished_at ?? null,
    created_at: partial.created_at ?? new Date()
  } as unknown as KnowledgeJobEntity);
  return repo.save(job);
}

describe('KnowledgeJobService · listJobs', () => {
  it('按作者隔离：只返回该作者的作业，不含他人', async () => {
    await createJob({ kind: 'structure' });
    await createJob({ kind: 'ingest', owner_id: fixture.otherAuthorId });
    const result = await service.listJobs(fixture.authorId, {});
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.kind).toBe('structure');
  });

  it('按 scope / workId / kind / status 过滤', async () => {
    await createJob({ kind: 'structure', library_scope: 'global' });
    await createJob({ kind: 'ingest', library_scope: 'work', work_id: fixture.workId, status: 'succeeded' });
    await createJob({ kind: 'export_markdown', library_scope: 'work', work_id: fixture.workId, status: 'succeeded' });

    const byScope = await service.listJobs(fixture.authorId, { scope: 'work' });
    expect(byScope.total).toBe(2);

    const byWork = await service.listJobs(fixture.authorId, { work_id: fixture.workId });
    expect(byWork.total).toBe(2);

    const byKind = await service.listJobs(fixture.authorId, { kind: 'ingest' });
    expect(byKind.total).toBe(1);

    const byStatus = await service.listJobs(fixture.authorId, { status: 'succeeded' });
    expect(byStatus.total).toBe(2);
  });

  it('created_at DESC 排序：最新在前', async () => {
    const base = Date.now();
    await createJob({ kind: 'structure', created_at: new Date(base - 3000) });
    await createJob({ kind: 'ingest', created_at: new Date(base - 1000) });
    await createJob({ kind: 'export_markdown', created_at: new Date(base) });
    const result = await service.listJobs(fixture.authorId, {});
    expect(result.items.map((j) => j.kind)).toEqual(['export_markdown', 'ingest', 'structure']);
  });

  it('limit 默认 20，上限 100，返回 next_cursor 分页', async () => {
    for (let i = 0; i < 25; i++) {
      await createJob({ kind: 'structure', created_at: new Date(Date.now() + i) });
    }
    const page1 = await service.listJobs(fixture.authorId, {});
    expect(page1.items).toHaveLength(20);
    expect(page1.total).toBe(25);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await service.listJobs(fixture.authorId, { limit: 100, cursor: page1.next_cursor! });
    expect(page2.items.length).toBe(5);
    expect(page2.next_cursor).toBeNull();
  });

  it('游标非法时回退到首页（不抛错）', async () => {
    await createJob({ kind: 'structure' });
    const result = await service.listJobs(fixture.authorId, { cursor: 'not-a-valid-cursor' });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
  });
});
