import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

interface Client {
  app: INestApplication;
  dataSource: DataSource;
  sessionCookie: string;
  csrfCookie: string;
  csrfToken: string;
  authorId: string;
}

describe('model endpoints (real PostgreSQL)', () => {
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
      email: `model-author-${randomUUID()}@example.com`,
      display_name: 'Model Author',
      password_hash: passwordHash
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

    return { app, dataSource, sessionCookie, csrfCookie, csrfToken, authorId: author.id };
  }

  const post = (url: string, body: unknown) =>
    request(app.getHttpServer()).post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const patch = (url: string, body: unknown) =>
    request(app.getHttpServer()).patch(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const del = (url: string) =>
    request(app.getHttpServer()).delete(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token);
  const get = (url: string) =>
    request(app.getHttpServer()).get(url)
      .set('Cookie', [session.cookie, session.csrf]);

  const baseInput = {
    name: 'GPT-4o Mini',
    provider: 'openai',
    model_id: 'gpt-4o-mini',
    context_window: 128000,
    supports_tools: true,
    supports_vision: true,
    input_price: 0.15,
    output_price: 0.6,
    currency: 'USD',
    status: 'active',
    sort_order: 10
  };

  // ── 401/403 ──

  it('rejects unauthenticated (401) and missing CSRF (403) on create model', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ai-models')
      .send(baseInput)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/ai-models')
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', '')
      .send(baseInput)
      .expect(403);
  });

  // ── 422 校验失败 ──

  it('rejects invalid model body with 422 (validation)', async () => {
    await post('/api/v1/ai-models', { ...baseInput, name: '' }).expect(422);
    await post('/api/v1/ai-models', { ...baseInput, model_id: 'bad id!' }).expect(422);
    await post('/api/v1/ai-models', { ...baseInput, input_price: -1 }).expect(422);
    await post('/api/v1/ai-models', { ...baseInput, currency: 'usd' }).expect(422);
    await post('/api/v1/ai-models', { ...baseInput, status: 'archived' }).expect(422);
  });

  // ── 创建 + 列表 ──

  it('creates a model (201) and lists it with defaults', async () => {
    const created = await post('/api/v1/ai-models', {
      name: 'GPT-4o Mini',
      model_id: 'gpt-4o-mini'
    }).expect(201);
    const model = created.body.data as Record<string, unknown>;
    expect(model.name).toBe('GPT-4o Mini');
    expect(model.provider).toBe('other');
    expect(model.status).toBe('active');
    expect(model.context_window).toBe(0);
    expect(model.supports_tools).toBe(false);
    expect(model.input_price).toBe(0);
    expect(model.currency).toBe('USD');
    expect(model.sort_order).toBe(0);

    const listed = await get('/api/v1/ai-models').expect(200);
    expect(listed.body.data.total).toBe(1);
    expect(listed.body.data.models[0].id).toBe(model.id);
  });

  it('persists full fields with price as number', async () => {
    const created = await post('/api/v1/ai-models', baseInput).expect(201);
    const model = created.body.data as Record<string, unknown>;
    expect(model.input_price).toBe(0.15);
    expect(model.output_price).toBe(0.6);
    expect(model.context_window).toBe(128000);
    expect(model.supports_vision).toBe(true);
  });

  // ── keyword / status 过滤 + 排序 ──

  it('filters models by keyword/status and sorts by sort_order', async () => {
    const a = await post('/api/v1/ai-models', { ...baseInput, name: '主线模型', model_id: 'main-1', sort_order: 0 }).expect(201);
    const b = await post('/api/v1/ai-models', { ...baseInput, name: '支线模型', model_id: 'sub-1', status: 'disabled', sort_order: 100 }).expect(201);

    const byKeyword = await get('/api/v1/ai-models?keyword=主线').expect(200);
    expect(byKeyword.body.data.total).toBe(1);
    expect(byKeyword.body.data.models[0].id).toBe(a.body.data.id);

    const byStatus = await get('/api/v1/ai-models?status=disabled').expect(200);
    expect(byStatus.body.data.total).toBe(1);
    expect(byStatus.body.data.models[0].id).toBe(b.body.data.id);

    const all = await get('/api/v1/ai-models').expect(200);
    expect(all.body.data.models[0].id).toBe(a.body.data.id);
  });

  // ── 重名 409 ──

  it('rejects duplicate model_id with 409', async () => {
    await post('/api/v1/ai-models', { ...baseInput, model_id: 'gpt-4o' }).expect(201);
    await post('/api/v1/ai-models', { ...baseInput, model_id: 'gpt-4o', name: '另一个' }).expect(409);
  });

  // ── 更新 ──

  it('updates a model (200), rejects archived via update (422), 404 on missing', async () => {
    const created = await post('/api/v1/ai-models', baseInput).expect(201);
    const id = created.body.data.id as string;

    const updated = await patch(`/api/v1/ai-models/${id}`, { name: '新名字', input_price: 0.25, status: 'disabled' }).expect(200);
    expect(updated.body.data.name).toBe('新名字');
    expect(updated.body.data.input_price).toBe(0.25);
    expect(updated.body.data.status).toBe('disabled');
    // 未触及字段保留
    expect(updated.body.data.provider).toBe('openai');

    // status=archived 契约层拦截 → 422
    await patch(`/api/v1/ai-models/${id}`, { status: 'archived' }).expect(422);
    await patch(`/api/v1/ai-models/${randomUUID()}`, { name: 'x' }).expect(404);
  });

  it('rejects updating model_id to duplicate with 409', async () => {
    await post('/api/v1/ai-models', { ...baseInput, model_id: 'gpt-4o' }).expect(201);
    const b = await post('/api/v1/ai-models', { ...baseInput, model_id: 'claude-3' }).expect(201);
    await patch(`/api/v1/ai-models/${b.body.data.id}`, { model_id: 'gpt-4o' }).expect(409);
  });

  // ── 删除（直接硬删） ──

  it('hard-deletes a model directly (no force required); 404 missing', async () => {
    const created = await post('/api/v1/ai-models', baseInput).expect(201);
    const id = created.body.data.id as string;

    const deleted = await del(`/api/v1/ai-models/${id}`).expect(200);
    expect(deleted.body.data.deleted).toBe(true);
    expect(deleted.body.data.id).toBe(id);

    await get(`/api/v1/ai-models/${id}`).expect(404);
    await del(`/api/v1/ai-models/${randomUUID()}`).expect(404);
  });

  // ── 作者隔离 ──

  it('isolates models by author: cross-author reads 404', async () => {
    const created = await post('/api/v1/ai-models', baseInput).expect(201);
    const id = created.body.data.id as string;

    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const other = await dataSource.getRepository(AuthorEntity).save({
      email: `model-other-${randomUUID()}@example.com`,
      display_name: 'Other',
      password_hash: passwordHash
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: other.email, password: 'correct horse' })
      .expect(200);
    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const otherSession = cookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!;
    const otherCsrf = cookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!;
    const otherToken = login.body.data.csrf_token as string;

    await request(app.getHttpServer())
      .get(`/api/v1/ai-models/${id}`)
      .set('Cookie', [otherSession, otherCsrf])
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/ai-models/${id}`)
      .set('Cookie', [otherSession, otherCsrf])
      .set('x-csrf-token', otherToken)
      .expect(404);
  });
});
