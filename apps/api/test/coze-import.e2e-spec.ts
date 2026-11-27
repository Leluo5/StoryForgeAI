// M4-T10 · Coze 工作流导入迁移 E2E（真实 PostgreSQL + mock Coze 上游 fetch）
// 依据：docs/04-功能交付档案/M4-迁移切换/01-迁移切换任务规划.md §2.10
// 覆盖：401 未登录 / 403 缺 CSRF / 422 校验 / /admin/coze/workflows 拉取 /
//       /admin/coze/import-workflow 导入（幂等 duplicate / not_found / 成功落库 WorkflowEntity）。
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { vi, beforeEach, afterEach } from 'vitest';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

// Coze 上游 mock：返回带 code=0 的 V1 响应
function okJson(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: 'success', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('coze import workflow endpoints (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };
  let authorId: string;
  let fetchMock: ReturnType<typeof vi.fn>;

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
    dataSource = module.get(DataSource);
  });

  beforeEach(async () => {
    await clearAuthTables(dataSource);
    await bootstrap();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await app.close();
    await destroyTestDatabase(migrationDataSource);
  });

  async function bootstrap(): Promise<void> {
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const author = await dataSource.getRepository(AuthorEntity).save({
      email: `coze-import-author-${randomUUID()}@example.com`,
      display_name: 'Coze Import Author',
      password_hash: passwordHash
    });
    authorId = author.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: author.email, password: 'correct horse' })
      .expect(200);
    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    session = {
      cookie: cookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!,
      csrf: cookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!,
      token: login.body.data.csrf_token as string
    };
  }

  const post = (url: string, body: unknown) =>
    request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);

  // ── 401 / 403 ──

  it('rejects unauthenticated (401) and missing CSRF (403)', async () => {
    await request(app.getHttpServer()).post('/api/v1/admin/coze/workflows').send({}).expect(401);
    await request(app.getHttpServer()).post('/api/v1/admin/coze/import-workflow').send({}).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/admin/coze/workflows')
      .set('Cookie', [session.cookie, session.csrf])
      .send({ pat_token: 'pat' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/admin/coze/import-workflow')
      .set('Cookie', [session.cookie, session.csrf])
      .send({ pat_token: 'pat', items: [{ id: 'w1', type: 'workflow' }] })
      .expect(403);
  });

  // ── 422 ──

  it('validates payloads (422)', async () => {
    // workflows：pat_token 必填
    await post('/api/v1/admin/coze/workflows', {}).expect(422);
    // import-workflow：items 必填、type 必须是合法枚举
    await post('/api/v1/admin/coze/import-workflow', { pat_token: 'pat' }).expect(422);
    await post('/api/v1/admin/coze/import-workflow', {
      pat_token: 'pat',
      items: [{ id: 'w1', type: 'invalid_type' }]
    }).expect(422);
  });

  // ── workflows 拉取 ──

  it('lists only workflow resources from GET /v1/workflows', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        has_more: false,
        items: [
          { workflow_id: 'w1', workflow_name: '主线生成', description: '生成主线' },
          { workflow_id: 'w2', workflow_name: '支线生成' }
        ]
      })
    );
    const res = await post('/api/v1/admin/coze/workflows', { pat_token: 'pat' }).expect(201);
    const resources = res.body.data.resources as Array<Record<string, unknown>>;
    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({ id: 'w1', name: '主线生成', type: 'workflow' });
    expect(resources[1]).toMatchObject({ id: 'w2', name: '支线生成', type: 'workflow' });
    // 只调用了 /v1/workflows 一次（bot/dataset 未调用）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/workflows');
  });

  // ── import-workflow 导入 ──

  it('imports selected workflows into WorkflowEntity (platform=coze)', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        has_more: false,
        items: [{ workflow_id: 'w1', workflow_name: '主线生成', description: '生成主线', icon_url: 'https://i' }]
      })
    );
    const res = await post('/api/v1/admin/coze/import-workflow', {
      pat_token: 'pat',
      items: [{ id: 'w1', type: 'workflow' }]
    }).expect(201);
    expect(res.body.data.imported).toBe(1);
    expect(res.body.data.results[0]).toMatchObject({ success: true, id: 'w1', name: '主线生成', type: 'workflow' });

    const { WorkflowEntity } = await import('../src/database/workflow.entity');
    const entity = await dataSource.getRepository(WorkflowEntity).findOneBy({ author_id: authorId });
    expect(entity?.platform).toBe('coze');
    expect(entity?.source).toBe('coze_import');
    expect(entity?.name).toBe('主线生成');
    expect(entity?.platform_config).toMatchObject({ workflow_id: 'w1', icon_url: 'https://i' });
  });

  it('is idempotent: re-importing same workflow_id → duplicate, no second row', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ has_more: false, items: [{ workflow_id: 'w1', workflow_name: '主线生成' }] })
    );
    await post('/api/v1/admin/coze/import-workflow', {
      pat_token: 'pat',
      items: [{ id: 'w1', type: 'workflow' }]
    }).expect(201);

    fetchMock.mockResolvedValueOnce(
      okJson({ has_more: false, items: [{ workflow_id: 'w1', workflow_name: '主线生成' }] })
    );
    const res = await post('/api/v1/admin/coze/import-workflow', {
      pat_token: 'pat',
      items: [{ id: 'w1', type: 'workflow' }]
    }).expect(201);
    expect(res.body.data.results[0]).toMatchObject({ success: false, error: 'duplicate' });

    const { WorkflowEntity } = await import('../src/database/workflow.entity');
    const count = await dataSource.getRepository(WorkflowEntity).countBy({ author_id: authorId });
    expect(count).toBe(1);
  });

  it('returns not_found for unknown workflow_id', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ has_more: false, items: [] }));
    const res = await post('/api/v1/admin/coze/import-workflow', {
      pat_token: 'pat',
      items: [{ id: 'nope', type: 'workflow' }]
    }).expect(201);
    expect(res.body.data.results[0]).toMatchObject({ success: false, error: 'not_found' });
  });

  it('ignores non-workflow items in import-workflow payload', async () => {
    // 只应处理 workflow 项；bot 项被过滤，不调用 getBotInfo
    fetchMock.mockResolvedValueOnce(
      okJson({ has_more: false, items: [{ workflow_id: 'w1', workflow_name: '主线生成' }] })
    );
    const res = await post('/api/v1/admin/coze/import-workflow', {
      pat_token: 'pat',
      items: [
        { id: 'w1', type: 'workflow' },
        { id: 'b1', type: 'bot' }
      ]
    }).expect(201);
    expect(res.body.data.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/workflows');
  });
});
