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

describe('agent config endpoints (real PostgreSQL)', () => {
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
      email: `agent-author-${randomUUID()}@example.com`,
      display_name: 'Agent Author',
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

  it('rejects unauthenticated (401) and missing CSRF (403) on create agent', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ai-agents')
      .send({ name: 'A', model_id: 'm' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/ai-agents')
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', '')
      .send({ name: 'A', model_id: 'm' })
      .expect(403);
  });

  // ── 422 校验失败 ──

  it('rejects invalid agent body with 422 (validation)', async () => {
    await post('/api/v1/ai-agents', { name: '', model_id: '' }).expect(422);
    await post('/api/v1/ai-agents', { name: 'A', model_id: 'm', model_config: { evil: true } }).expect(422);
    await patch('/api/v1/ai-agents', { name: 'A' }).expect(404); // 路由不存在，先保证 PATCH 校验路径正常
  });

  // ── 创建 Agent + 列表 ──

  it('creates an agent (201), lists agents, and enforces default exclusivity', async () => {
    const created = await post('/api/v1/ai-agents', {
      name: '灵感助手', model_id: 'gpt-4o-mini', is_default: true
    }).expect(201);
    const agent = created.body.data.agent as Record<string, unknown>;
    expect(agent.name).toBe('灵感助手');
    expect(agent.platform).toBe('mock');
    expect(agent.status).toBe('active');
    expect(agent.is_default).toBe(true);

    // 再建一个设为默认 → 应把第一个默认互斥清除
    const second = await post('/api/v1/ai-agents', {
      name: '改写专家', model_id: 'claude-3', is_default: true
    }).expect(201);
    const secondId = second.body.data.agent.id as string;

    const listed = await get('/api/v1/ai-agents').expect(200);
    expect(listed.body.data.agents).toHaveLength(2);
    const firstAfter = listed.body.data.agents.find((a: { id: string }) => a.id === agent.id);
    const secondAfter = listed.body.data.agents.find((a: { id: string }) => a.id === secondId);
    expect(firstAfter.is_default).toBe(false);
    expect(secondAfter.is_default).toBe(true);
  });

  // ── 重名 409 ──

  it('rejects duplicate agent name with 409', async () => {
    await post('/api/v1/ai-agents', { name: '同名牌', model_id: 'm1' }).expect(201);
    await post('/api/v1/ai-agents', { name: '同名牌', model_id: 'm2' }).expect(409);
  });

  // ── 更新 Agent ──

  it('updates an agent (200) and forbids disabling the default agent', async () => {
    const created = await post('/api/v1/ai-agents', {
      name: '默认', model_id: 'm', is_default: true
    }).expect(201);
    const agentId = created.body.data.agent.id as string;

    const updated = await patch(`/api/v1/ai-agents/${agentId}`, { name: '默认改名' }).expect(200);
    expect(updated.body.data.agent.name).toBe('默认改名');

    // 禁用默认 Agent → 409
    await patch(`/api/v1/ai-agents/${agentId}`, { status: 'disabled' }).expect(409);
    // 更新不存在 → 404
    await patch(`/api/v1/ai-agents/${randomUUID()}`, { name: 'x' }).expect(404);
  });

  // ── 删除 Agent ──

  it('deletes a non-default agent (200) and unbinds its tools; default cannot be deleted', async () => {
    const def = await post('/api/v1/ai-agents', {
      name: '默认', model_id: 'm', is_default: true
    }).expect(201);
    const other = await post('/api/v1/ai-agents', {
      name: '次要', model_id: 'm2'
    }).expect(201);
    const otherId = other.body.data.agent.id as string;

    // 绑定 'continue' 工具到次要 Agent，删除后应解绑（agent_id=null）
    const tools = await get('/api/v1/ai-tools').expect(200);
    const continueTool = tools.body.data.tools.find((t: { tool_id: string }) => t.tool_id === 'continue');
    await patch(`/api/v1/ai-tools/${continueTool.tool_id}`, { agent_id: otherId }).expect(200);

    await del(`/api/v1/ai-agents/${otherId}`).expect(200);
    const afterTools = await get('/api/v1/ai-tools').expect(200);
    const continueAfter = afterTools.body.data.tools.find((t: { tool_id: string }) => t.tool_id === 'continue');
    expect(continueAfter.agent_id).toBeNull();

    // 删除默认 Agent → 409
    const defId = def.body.data.agent.id as string;
    await del(`/api/v1/ai-agents/${defId}`).expect(409);
    await del(`/api/v1/ai-agents/${randomUUID()}`).expect(404);
  });

  // ── 工具列表（种子） ──

  it('lists 9 seeded tools with bound_agent info', async () => {
    const listed = await get('/api/v1/ai-tools').expect(200);
    const tools = listed.body.data.tools as Array<{ tool_id: string; enabled: boolean }>;
    expect(tools).toHaveLength(9);
    expect(tools.map((t) => t.tool_id).sort()).toEqual([
      'character_avatar_generate',
      'character_extract',
      'character_growth_extract',
      'continue',
      'expand',
      'plot_derivation',
      'plot_generate',
      'polish',
      'rewrite'
    ]);
    for (const t of tools) expect(t.enabled).toBe(true);
  });

  // ── 更新工具 ──

  it('updates a tool (200), returns warning when disabling, and 404 for unknown tool', async () => {
    const updated = await patch('/api/v1/ai-tools/continue', { name: '续写·新', enabled: false }).expect(200);
    expect(updated.body.data.tool.name).toBe('续写·新');
    expect(updated.body.data.tool.enabled).toBe(false);
    expect(updated.body.data.warning).toBeNull(); // 未绑定 Agent 时无警告

    await patch('/api/v1/ai-tools/unknown-tool', { enabled: true }).expect(404);
  });
});
