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

describe('workflow endpoints (real PostgreSQL)', () => {
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
      email: `wf-author-${randomUUID()}@example.com`,
      display_name: 'Workflow Author',
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

  // ── 401/403 ──

  it('rejects unauthenticated (401) and missing CSRF (403) on create workflow', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ai-workflows')
      .send({ name: 'A', llm_config: { model: 'm' } })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/ai-workflows')
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', '')
      .send({ name: 'A', llm_config: { model: 'm' } })
      .expect(403);
  });

  // ── 422 校验失败 ──

  it('rejects invalid workflow body with 422 (validation)', async () => {
    await post('/api/v1/ai-workflows', { name: '', llm_config: { model: '' } }).expect(422);
    await post('/api/v1/ai-workflows', { name: 'A', llm_config: { model: 'm', base_url: 'http://evil' } }).expect(422);
    await post('/api/v1/ai-workflows', { name: 'A', llm_config: { model: 'm' }, platform_config: { evil: true } }).expect(422);
  });

  // ── 创建工作流 + 列表 ──

  it('creates a workflow (201) and lists it', async () => {
    const created = await post('/api/v1/ai-workflows', {
      name: '主线创作',
      description: '主线剧情生成',
      llm_config: { model: 'gpt-4o-mini' }
    }).expect(201);
    const wf = created.body.data as Record<string, unknown>;
    expect(wf.name).toBe('主线创作');
    expect(wf.platform).toBe('coze');
    expect(wf.status).toBe('active');
    expect(wf.version_no).toBe(2);

    const listed = await get('/api/v1/ai-workflows').expect(200);
    expect(listed.body.data.total).toBe(1);
    expect(listed.body.data.workflows[0].id).toBe(wf.id);
    // 列表项不暴露 versions
    expect(listed.body.data.workflows[0].versions).toBeUndefined();
  });

  // ── keyword / status 过滤 ──

  it('filters workflows by keyword and status', async () => {
    const a = await post('/api/v1/ai-workflows', {
      name: '奇幻主线', llm_config: { model: 'm' }
    }).expect(201);
    const b = await post('/api/v1/ai-workflows', {
      name: '科幻支线', llm_config: { model: 'm' }
    }).expect(201);
    const bId = b.body.data.id as string;

    const byKeyword = await get('/api/v1/ai-workflows?keyword=主线').expect(200);
    expect(byKeyword.body.data.total).toBe(1);
    expect(byKeyword.body.data.workflows[0].id).toBe(a.body.data.id);

    await post(`/api/v1/ai-workflows/${bId}/archive`, { note: '归档' }).expect(201);
    const byStatus = await get('/api/v1/ai-workflows?status=archived').expect(200);
    expect(byStatus.body.data.total).toBe(1);
    expect(byStatus.body.data.workflows[0].id).toBe(bId);
  });

  // ── 重名 409 ──

  it('rejects duplicate workflow name with 409', async () => {
    await post('/api/v1/ai-workflows', { name: '同名牌', llm_config: { model: 'm' } }).expect(201);
    await post('/api/v1/ai-workflows', { name: '同名牌', llm_config: { model: 'm' } }).expect(409);
  });

  // ── 更新 ──

  it('updates a workflow (200), forbids archived via update, and 404 on missing', async () => {
    const created = await post('/api/v1/ai-workflows', {
      name: '默认', llm_config: { model: 'm' }
    }).expect(201);
    const id = created.body.data.id as string;

    const updated = await patch(`/api/v1/ai-workflows/${id}`, { name: '默认改名' }).expect(200);
    expect(updated.body.data.name).toBe('默认改名');
    expect(updated.body.data.version_no).toBe(3);

    // 通过普通更新设 archived → 422（契约层拦截）
    await patch(`/api/v1/ai-workflows/${id}`, { status: 'archived' }).expect(422);
    await patch(`/api/v1/ai-workflows/${randomUUID()}`, { name: 'x' }).expect(404);
  });

  // ── 归档 / 恢复 ──

  it('archives then restores a workflow; double-archive 409; restore non-archived 409', async () => {
    const created = await post('/api/v1/ai-workflows', {
      name: '可归档', llm_config: { model: 'm' }
    }).expect(201);
    const id = created.body.data.id as string;

    const archived = await post(`/api/v1/ai-workflows/${id}/archive`, { note: '归档' }).expect(201);
    expect(archived.body.data.status).toBe('archived');
    expect(archived.body.data.archived_at).not.toBeNull();

    await post(`/api/v1/ai-workflows/${id}/archive`, {}).expect(409);

    const restored = await post(`/api/v1/ai-workflows/${id}/restore`, {}).expect(201);
    expect(restored.body.data.status).toBe('active');
    expect(restored.body.data.archived_at).toBeNull();

    await post(`/api/v1/ai-workflows/${id}/restore`, {}).expect(409);
  });

  // ── 删除 ──

  it('hard-deletes archived workflow; requires force for non-archived; 404 missing', async () => {
    const created = await post('/api/v1/ai-workflows', {
      name: '可删除', llm_config: { model: 'm' }
    }).expect(201);
    const id = created.body.data.id as string;

    // 未归档删除需 force → 409
    await del(`/api/v1/ai-workflows/${id}`).expect(409);
    // force=true 删除未归档 → 200
    await del(`/api/v1/ai-workflows/${id}?force=true`).expect(200);

    await del(`/api/v1/ai-workflows/${randomUUID()}`).expect(404);
  });

  // ── 版本历史 + 回滚 ──

  it('lists version history and rolls back to a target version', async () => {
    const created = await post('/api/v1/ai-workflows', {
      name: '原始名', llm_config: { model: 'm' }
    }).expect(201);
    const id = created.body.data.id as string;

    await patch(`/api/v1/ai-workflows/${id}`, { name: '改名后' }).expect(200);

    const versions = await get(`/api/v1/ai-workflows/${id}/versions`).expect(200);
    expect(versions.body.data.length).toBe(2);
    expect(versions.body.data[0].version_no).toBe(2);
    expect(versions.body.data[0]).not.toHaveProperty('snapshot');

    // 回滚到 v1
    const rolled = await post(`/api/v1/ai-workflows/${id}/versions/1/rollback`, {}).expect(201);
    expect(rolled.body.data.name).toBe('原始名');
    expect(rolled.body.data.version_no).toBe(4);

    // 回滚到不存在的版本 → 409
    await post(`/api/v1/ai-workflows/${id}/versions/999/rollback`, {}).expect(409);
  });

  // ── 作者隔离 ──

  it('isolates workflows by author: cross-author reads 404', async () => {
    const created = await post('/api/v1/ai-workflows', {
      name: '私有', llm_config: { model: 'm' }
    }).expect(201);
    const id = created.body.data.id as string;

    // 另一作者登录
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const other = await dataSource.getRepository(AuthorEntity).save({
      email: `wf-other-${randomUUID()}@example.com`,
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
      .get(`/api/v1/ai-workflows/${id}`)
      .set('Cookie', [otherSession, otherCsrf])
      .expect(404);
    // 另一作者删除也 404
    await request(app.getHttpServer())
      .delete(`/api/v1/ai-workflows/${id}?force=true`)
      .set('Cookie', [otherSession, otherCsrf])
      .set('x-csrf-token', otherToken)
      .expect(404);
  });
});
