import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { CollabArchiveService } from './collab-archive.service';

// T16 归档投递服务单测：真实 DB fixture，直接 new 服务（不经 DI）。
// 只测投递与状态更新，不触碰任务与写回单；失败抛 CollabUpstreamError。

let fixture: WritingFixture;
let service: CollabArchiveService;

// n8n 替身：记录收到的请求头与载荷，可编程响应
let n8nFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await createWritingFixture();
  n8nFetch = vi.fn();
  // 注入替身 env + 替身 fetch
  service = new CollabArchiveService(fixture.dataSource, {
    N8N_ARCHIVE_WEBHOOK_URL: 'https://n8n.example/webhook/archive',
    N8N_ARCHIVE_TOKEN: 'token-abc',
    COLLAB_HTTP_TIMEOUT_MS: 1000
  });
});

afterEach(() => destroyWritingFixture(fixture));

// 让服务使用替身 fetch（避免真实网络）；在调用前 patch globalThis.fetch
function useFetchStub() {
  vi.stubGlobal('fetch', n8nFetch);
}

async function seedTask(workId: string, authorId: string): Promise<string> {
  const repo = fixture.dataSource.getRepository(AiTaskEntity);
  const t = await repo.save(repo.create({
    id: randomUUID(),
    idempotency_key: randomUUID(),
    work_id: workId,
    chapter_id: null,
    scope: 'role_profile',
    channel: 'flowise',
    tool: 'role_profile',
    agent_id: null,
    input_summary: { character_id: randomUUID(), fields: ['identity', 'personality'], instruction: '补充角色' },
    base_version: 0,
    status: 'succeeded',
    created_by: authorId
  }));
  return t.id;
}

async function seedOutbox(taskId: string, opts: { status?: string; attempts?: number; externalId?: string | null } = {}): Promise<string> {
  const repo = fixture.dataSource.getRepository(AgentArchiveOutboxEntity);
  const row = await repo.save(repo.create({
    id: randomUUID(),
    task_id: taskId,
    status: opts.status ?? 'pending',
    attempts: opts.attempts ?? 0,
    external_id: opts.externalId ?? null,
    payload: {
      work_id: fixture.workId,
      character_id: randomUUID(),
      channel: 'flowise',
      result_text: '结果文本',
      fields: { identity: '边城少年·新' },
      citations: [{ source_id: 'doc-1', title: '资料一', snippet: '摘录' }],
      applied_version: 2
    }
  }));
  return row.id;
}

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('CollabArchiveService (T16 归档投递)', () => {
  it('成功投递：POST 带 Idempotency-Key + 鉴权头，置 delivered + external_id + delivered_at', async () => {
    useFetchStub();
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    await seedOutbox(taskId);
    n8nFetch.mockResolvedValueOnce(okResponse({ executionId: 'exec-42' }));

    const result = await service.deliver(taskId);

    expect(result.status).toBe('delivered');
    expect(result.externalId).toBe('exec-42');
    expect(result.attempts).toBe(1);

    // 断言请求：URL、方法、幂等键、鉴权头、载荷为 outbox.payload
    const call = n8nFetch.mock.calls[0]!;
    const url = String(call[0]);
    const init = call[1] as RequestInit;
    expect(url).toBe('https://n8n.example/webhook/archive');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('Idempotency-Key')).toBe(`storyforge-archive-${taskId}`);
    expect(headers.get('Authorization')).toBe('Bearer token-abc');
    const body = JSON.parse(String(init.body));
    expect(body.work_id).toBe(fixture.workId);
    expect(body.channel).toBe('flowise');
    // 载荷不含凭据/作者邮箱/其他角色/正文
    expect(JSON.stringify(body)).not.toContain('token');
    expect(JSON.stringify(body)).not.toContain('email');

    const row = await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).findOneByOrFail({ task_id: taskId });
    expect(row.status).toBe('delivered');
    expect(row.external_id).toBe('exec-42');
    expect(row.delivered_at).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('已 delivered 幂等返回，不再次发起请求', async () => {
    useFetchStub();
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    await seedOutbox(taskId, { status: 'delivered', attempts: 3, externalId: 'exec-old' });

    const result = await service.deliver(taskId);

    expect(result.status).toBe('delivered');
    expect(result.externalId).toBe('exec-old');
    expect(result.attempts).toBe(3);
    expect(n8nFetch).not.toHaveBeenCalled();
  });

  it('Webhook 未配置 → COLLAB_CHANNEL_NOT_CONFIGURED', async () => {
    useFetchStub();
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    await seedOutbox(taskId);
    const bare = new CollabArchiveService(fixture.dataSource, {});
    await expect(bare.deliver(taskId)).rejects.toMatchObject({ code: 'COLLAB_CHANNEL_NOT_CONFIGURED' });
    expect(n8nFetch).not.toHaveBeenCalled();
  });

  it('上游返回非 2xx → 抛 COLLAB_UPSTREAM_FAILED，attempts+1 + last_error，状态仍 pending', async () => {
    useFetchStub();
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    await seedOutbox(taskId);
    n8nFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }));

    await expect(service.deliver(taskId)).rejects.toMatchObject({ code: 'COLLAB_UPSTREAM_FAILED' });

    const row = await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).findOneByOrFail({ task_id: taskId });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBeTruthy();
    expect(row.external_id).toBeNull();
  });

  it('网络失败 → 抛 COLLAB_UPSTREAM_FAILED，attempts+1，状态仍 pending', async () => {
    useFetchStub();
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    await seedOutbox(taskId);
    n8nFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(service.deliver(taskId)).rejects.toMatchObject({ code: 'COLLAB_UPSTREAM_FAILED' });

    const row = await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).findOneByOrFail({ task_id: taskId });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
  });

  it('归档记录不存在 → COLLAB_CHANNEL_NOT_CONFIGURED', async () => {
    useFetchStub();
    await expect(service.deliver(randomUUID())).rejects.toMatchObject({ code: 'COLLAB_CHANNEL_NOT_CONFIGURED' });
  });
});
