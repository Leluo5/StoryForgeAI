import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

// 测试用正文 document（ProseMirror 最小文档）
const doc = (text: string) => ({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
});
const hash = (document: unknown): string =>
  createHash('sha256').update(JSON.stringify(document)).digest('hex');

interface Client {
  app: INestApplication;
  dataSource: DataSource;
  sessionCookie: string;
  csrfCookie: string;
  csrfToken: string;
  workId: string;
  chapterId: string;
  authorId: string;
}

describe('ai task endpoints (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };
  let ctx: Client;

  beforeAll(async () => {
    const [{ AppModule }, { configureApp }, { createDataSource }] = await Promise.all([
      import('../src/app.module'),
      import('../src/app.setup'),
      import('../src/database/data-source')
    ]);
    migrationDataSource = createDataSource(databaseUrl);
    await resetTestDatabase(migrationDataSource);

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    // SSE 端点用原生 http 直连，需先绑定随机端口才能取到 address().port
    await app.listen(0);
    dataSource = module.get(DataSource);
  });

  beforeEach(async () => {
    await clearAuthTables(dataSource);
    ctx = await bootstrapClient();
  });

  afterAll(async () => {
    await app.close();
    await destroyTestDatabase(migrationDataSource);
  });

  async function bootstrapClient(): Promise<Client> {
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const author = await dataSource.getRepository(AuthorEntity).save({
      email: `author-${randomUUID()}@example.com`, display_name: 'M3a Author', password_hash: passwordHash
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: author.email, password: 'correct horse' })
      .expect(200);
    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const sessionCookie = cookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!;
    const csrfCookie = cookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!;
    const csrfToken = login.body.data.csrf_token as string;
    session = { cookie: sessionCookie, csrf: csrfCookie, token: csrfToken };

    const workRes = await request(app.getHttpServer())
      .post('/api/v1/works')
      .set('Cookie', [sessionCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .send({ title: 'M3a 作品', description: '' })
      .expect(201);
    const workId = workRes.body.data.work.id as string;
    const volumeRes = await request(app.getHttpServer())
      .post(`/api/v1/works/${workId}/volumes`)
      .set('Cookie', [sessionCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .send({ title: '卷一' })
      .expect(201);
    const volumeId = volumeRes.body.data.id as string;
    const chapterRes = await request(app.getHttpServer())
      .post(`/api/v1/works/${workId}/volumes/${volumeId}/chapters`)
      .set('Cookie', [sessionCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .send({ title: '第一章' })
      .expect(201);
    const chapterId = chapterRes.body.data.id as string;

    return {
      app, dataSource, sessionCookie, csrfCookie, csrfToken,
      workId, chapterId, authorId: author.id
    };
  }

  const post = (url: string, body: unknown) =>
    request(app.getHttpServer()).post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const get = (url: string) =>
    request(app.getHttpServer()).get(url)
      .set('Cookie', [session.cookie, session.csrf]);

  // ── 401/403 ──

  it('rejects unauthenticated (401) and missing CSRF (403) on create', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`)
      .send({ tool: 'continue', idempotency_key: randomUUID() })
      .expect(401);
    await request(app.getHttpServer())
      .post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', '')
      .send({ tool: 'continue', idempotency_key: randomUUID() })
      .expect(403);
  });

  // ── 422 校验失败 ──

  it('rejects invalid body with 422 (validation)', async () => {
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'unknown-tool', idempotency_key: ''
    }).expect(422);
  });

  // ── 发起任务（201） ──

  it('creates a task (201), lists it, and reads detail (200)', async () => {
    const idem = randomUUID();
    const created = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem, input_summary: { cursor: 'start' }
    }).expect(201);
    const task = created.body.data.task as Record<string, unknown>;
    expect(task.status).toBe('queued');
    expect(task.work_id).toBe(ctx.workId);
    expect(task.chapter_id).toBe(ctx.chapterId);
    expect(task.tool).toBe('continue');

    const listed = await get(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`).expect(200);
    expect(listed.body.data.total).toBe(1);
    expect(listed.body.data.tasks[0].id).toBe(task.id);

    const detail = await get(`/api/v1/works/${ctx.workId}/ai-tasks/${task.id}`).expect(200);
    expect(detail.body.data.task.id).toBe(task.id);
    expect(detail.body.data.task.status).toBe('queued');
  });

  // ── 幂等（同 idempotency_key 命中，无重复执行） ──

  it('idempotent create: same key returns existing task (200) without duplicate', async () => {
    const idem = randomUUID();
    const first = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(201);
    const taskId = first.body.data.task.id as string;

    // service 设计：仅 succeeded 且已有结果修订集才幂等返回 200；queued 同 key 重发为 409。
    // 先构造真实 revision_set（ai_set=true）+ succeeded 状态，再验证幂等返回原任务且不重复执行。
    const [{ AiTaskEntity }, { RevisionSetEntity }] = await Promise.all([
      import('../src/database/ai-task.entity'),
      import('../src/database/revision-set.entity')
    ]);
    const revisionSet = await dataSource.getRepository(RevisionSetEntity).save({
      id: randomUUID(), chapter_id: ctx.chapterId, base_version: 0, actor_type: 'ai',
      actor_id: null, operations: [], status: 'pending', ai_set: true
    });
    await dataSource.getRepository(AiTaskEntity).update(
      { id: taskId }, { status: 'succeeded', result_revision_set_id: revisionSet.id }
    );
    const second = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(200);
    expect(second.body.data.task.id).toBe(taskId);
    const listed = await get(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`).expect(200);
    expect(listed.body.data.total).toBe(1);
  });

  // ── 404 越权/不存在 ──

  it('returns 404 for task in another work', async () => {
    const idem = randomUUID();
    const created = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(201);
    const taskId = created.body.data.task.id as string;
    await get(`/api/v1/works/${randomUUID()}/ai-tasks/${taskId}`).expect(404);
    await get(`/api/v1/works/${ctx.workId}/ai-tasks/${randomUUID()}`).expect(404);
  });

  // ── 409 进行中冲突 ──

  it('returns 409 when retrying an in-progress task with same key', async () => {
    const idem = randomUUID();
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(201);
    // 新任务默认 queued，同 key 重发应 409（进行中冲突）
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(409);
    // 直接改状态为 running，验证再次发起同 key 报 409
    const [{ AiTaskEntity }] = await Promise.all([import('../src/database/ai-task.entity')]);
    await dataSource.getRepository(AiTaskEntity).update(
      { idempotency_key: idem }, { status: 'running' }
    );
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(409);
  });

  // ── 422 取消不可取消任务 / 重试不可重试任务 ──

  it('returns 422 for cancel of succeeded task and retry of queued task', async () => {
    const idem = randomUUID();
    const created = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(201);
    const taskId = created.body.data.task.id as string;

    // queued 不可重试
    await post(`/api/v1/works/${ctx.workId}/ai-tasks/${taskId}/retry`, {}).expect(422);
    // 置 succeeded 后不可取消
    const [{ AiTaskEntity }] = await Promise.all([import('../src/database/ai-task.entity')]);
    await dataSource.getRepository(AiTaskEntity).update({ id: taskId }, { status: 'succeeded' });
    await post(`/api/v1/works/${ctx.workId}/ai-tasks/${taskId}/cancel`, {}).expect(422);
  });

  // ── 取消（queued → cancelled，200 幂等） ──

  it('cancels a queued task (200) and is idempotent on repeat', async () => {
    const idem = randomUUID();
    const created = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(201);
    const taskId = created.body.data.task.id as string;

    const cancelled = await post(`/api/v1/works/${ctx.workId}/ai-tasks/${taskId}/cancel`, {}).expect(200);
    expect(cancelled.body.data.task.status).toBe('cancelled');
    await post(`/api/v1/works/${ctx.workId}/ai-tasks/${taskId}/cancel`, {}).expect(200);
  });

  // ── 重试（failed → queued，200） ──

  it('retries a failed task (200)', async () => {
    const idem = randomUUID();
    const created = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(201);
    const taskId = created.body.data.task.id as string;

    const [{ AiTaskEntity }] = await Promise.all([import('../src/database/ai-task.entity')]);
    await dataSource.getRepository(AiTaskEntity).update(
      { id: taskId }, { status: 'failed', error: { message: 'boom' } }
    );
    const retried = await post(`/api/v1/works/${ctx.workId}/ai-tasks/${taskId}/retry`, {}).expect(200);
    expect(retried.body.data.task.status).toBe('queued');
    expect(retried.body.data.task.error).toBeNull();
  });

  // ── SSE 端点 ──

  it('streams SSE events for a task (snapshot + persisted)', async () => {
    const idem = randomUUID();
    const created = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/ai-tasks`, {
      tool: 'continue', idempotency_key: idem
    }).expect(201);
    const taskId = created.body.data.task.id as string;

    // 通过原生 http 发起 SSE 请求，读到首帧后主动销毁连接（SSE 不会自然结束）
    const server = app.getHttpServer();
    const addr = server.address() as { port: number };
    const url = `/api/v1/works/${ctx.workId}/ai-tasks/${taskId}/events`;
    const chunk = await new Promise<string>((resolve, reject) => {
      const req = httpGet({ host: '127.0.0.1', port: addr.port, path: url,
        headers: { Cookie: [session.cookie, session.csrf].join('; ') } }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (d: string) => {
          data += d;
          if (data.includes('\n\n')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    expect(chunk).toContain('event: snapshot');
    expect(chunk).toMatch(/event: snapshot[\s\S]*?data: .*"status":"queued"/);
  });
});
