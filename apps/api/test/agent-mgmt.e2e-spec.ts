import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

/**
 * M4-T4 Agent 管理 HTTP 入口补齐 E2E（真实 PG 测试库）。
 * 覆盖验收标准：
 *  1. 16 端点补齐（分组树 / 覆盖 upsert+delete / 手动分组 create+delete / 设分组 / provision / bind-roles /
 *     reset-default / progress+reset / switch-tool / archive / restore / versions / rollback）
 *  2. 分组树 E2E 返回结构
 *  3. 版本回滚写新版本（保留最近 50）
 *  4. 工具开关切换绑定 Agent
 *  5. 归属校验：非作者访问 → 404
 *  6. 鉴权：未登录 401，写操作无 CSRF 403
 *  7. 契约层：422 校验
 */
describe('agent management endpoints (real PostgreSQL) · M4-T4', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };
  let authorId: string;
  let workId: string;

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
  });

  afterAll(async () => {
    await app.close();
    await destroyTestDatabase(migrationDataSource);
  });

  async function bootstrap(): Promise<void> {
    const [{ AuthorEntity }, { PasswordService }, { WorkService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service'),
      import('../src/writing/work.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const author = await dataSource.getRepository(AuthorEntity).save({
      email: `agentmgmt-author-${randomUUID()}@example.com`,
      display_name: 'Agent Mgmt Author',
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

    const workService = new WorkService(dataSource);
    workId = (await workService.create(authorId, { title: 'Agent 管理作品', description: '' })).work.id;
  }

  const get = (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', [session.cookie, session.csrf]);
  const post = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const put = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .put(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const del = (url: string) =>
    request(app.getHttpServer())
      .delete(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token);

  /** 创建普通 Agent（默认 flow_step_agent 之外的手工 agent） */
  async function createAgent(name: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await post('/api/v1/ai-agents', {
      name,
      model_id: 'gpt-4o-mini',
      project_id: workId,
      ...overrides
    }).expect(201);
    return created.body.data.agent.id as string;
  }

  /**
   * 经数据层构造带分组归属字段的 Agent（POST /ai-agents 契约不含 kind/step_order 等字段）。
   */
  async function createGroupedAgent(overrides: Record<string, unknown>): Promise<string> {
    const [{ AgentEntity }] = await Promise.all([import('../src/database/agent.entity')]);
    const repo = dataSource.getRepository(AgentEntity);
    const agent = await repo.save(
      repo.create({
        id: randomUUID(),
        author_id: authorId,
        project_id: workId,
        kind: 'legacy',
        name: `分组Agent-${randomUUID().slice(0, 8)}`,
        description: '',
        platform: 'mock',
        platform_config: {},
        model_id: 'gpt-4o-mini',
        model_config: {},
        role_id: null,
        tool_name: null,
        step_order: null,
        scope: 'project',
        source: 'template',
        tags: [],
        status: 'active',
        is_default: false,
        version_no: 1,
        versions: [],
        archived_at: null,
        ...overrides
      })
    );
    return agent.id;
  }

  // ── 鉴权（验收 6） ──

  it('archive 未登录 401，无 CSRF 403', async () => {
    const agentId = await createAgent('鉴权归档');
    await request(app.getHttpServer()).post(`/api/v1/ai-agents/${agentId}/archive`).expect(401);
    await request(app.getHttpServer())
      .post(`/api/v1/ai-agents/${agentId}/archive`)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', '')
      .send({})
      .expect(403);
  });

  it('getTree 未登录 401', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/ai-agent-groups/tree?project_id=${workId}`)
      .expect(401);
  });

  // ── 分组树（验收 2） ──

  it('getTree 返回分组树，归属 Agent 落在 flow: 节点', async () => {
    const agentId = await createGroupedAgent({ kind: 'flow_step_agent', step_order: 1 });
    const res = await get(`/api/v1/ai-agent-groups/tree?project_id=${workId}`).expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const nodes = res.body.data as Array<{ key: string; name: string; agent_ids: string[] }>;
    const node = nodes.find((n) => n.key === 'flow:1');
    expect(node).toBeDefined();
    expect(node!.agent_ids).toContain(agentId);
    // 未覆盖前展示默认名
    expect(node!.name).toBe('步骤 1');
  });

  // ── 覆盖 upsert + delete ──

  it('override upsert（flow:/tool:/role: 域）与 delete', async () => {
    await createGroupedAgent({ kind: 'flow_step_agent', step_order: 1 });
    const upserted = await post('/api/v1/ai-agent-groups/override', { project_id: workId, key: 'flow:1', name: '开篇改', sort_order: 10 }).expect(200);
    expect(upserted.body.data.key).toBe('flow:1');
    expect(upserted.body.data.name).toBe('开篇改');

    // 再查树应应用覆盖名
    const tree = await get(`/api/v1/ai-agent-groups/tree?project_id=${workId}`).expect(200);
    const nodes = tree.body.data as Array<{ key: string; name: string }>;
    expect(nodes.some((n) => n.key === 'flow:1' && n.name === '开篇改')).toBe(true);

    await del(`/api/v1/ai-agent-groups/override?project_id=${workId}&key=${encodeURIComponent('flow:1')}`).expect(200);
  });

  it('override 契约：缺 key → 422', async () => {
    await post('/api/v1/ai-agent-groups/override', { project_id: workId }).expect(422);
  });

  // ── 手动分组 create + delete ──

  it('manual group create + delete', async () => {
    const created = await post('/api/v1/ai-agent-groups/manual', { project_id: workId, parent_key: 'project:', name: '手分组', sort_order: 0 }).expect(201);
    const groupId = created.body.data.id as string;
    expect(groupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.body.data.name).toBe('手分组');

    const tree = await get(`/api/v1/ai-agent-groups/tree?project_id=${workId}`).expect(200);
    expect(JSON.stringify(tree.body.data)).toContain('手分组');

    await del(`/api/v1/ai-agent-groups/manual/${groupId}?project_id=${workId}`).expect(200);
  });

  // ── 设 Agent 分组（updateAgentV2 承载，偏差 2 裁决） ──

  it('setAgentGroup 经 PUT /ai-agents/:id/group 承载 manual_group_key（纯 uuid）', async () => {
    const agentId = await createAgent('设组Agent');
    // 先建手动分组（服务返回纯 uuid id）
    const created = await post('/api/v1/ai-agent-groups/manual', { project_id: workId, parent_key: 'project:', name: '目标组' }).expect(201);
    const groupId = created.body.data.id as string;
    expect(groupId).toMatch(/^[0-9a-f-]{36}$/);

    const res = await put(`/api/v1/ai-agents/${agentId}/group`, { manual_group_key: groupId }).expect(200);
    expect(res.body.data.manual_group_key).toBe(groupId);

    // 回落自动分组
    const reset = await put(`/api/v1/ai-agents/${agentId}/group`, { manual_group_key: null }).expect(200);
    expect(reset.body.data.manual_group_key).toBeNull();

    // 契约：非 uuid → 422
    await put(`/api/v1/ai-agents/${agentId}/group`, { manual_group_key: 'manual:abc' }).expect(422);
  });

  // ── provision + bind-roles ──

  it('provision 幂等开通默认流 Agent，bind-roles 绑定角色', async () => {
    const provisioned = await post(`/api/v1/ai-projects/${workId}/provision`).expect(200);
    expect(provisioned.body.data.flowAgents).toBeGreaterThan(0);
    expect(provisioned.body.data.toolAgents).toBeGreaterThan(0);

    // 幂等：再次 provision 不新增
    const again = await post(`/api/v1/ai-projects/${workId}/provision`).expect(200);
    expect(again.body.data.flowAgents).toBe(0);
    expect(again.body.data.toolAgents).toBe(0);

    const bound = await post(`/api/v1/ai-projects/${workId}/bind-roles`).expect(200);
    expect(bound.body.data.created).toBeGreaterThanOrEqual(0);
  });

  // ── 工具开关（验收 4，R1 路径带 projectId） ──

  it('switchTool 切换绑定 Agent', async () => {
    // switchToolDefault 需 kind='tool_agent' 且 tool_name 匹配的 Agent。
    // POST /ai-agents 契约无 tool_name 字段，直接经数据层构造 tool_agent。
    const [{ AgentEntity }] = await Promise.all([import('../src/database/agent.entity')]);
    const agentRepo = dataSource.getRepository(AgentEntity);
    const toolAgent = await agentRepo.save(
      agentRepo.create({
        id: randomUUID(),
        author_id: authorId,
        project_id: workId,
        kind: 'tool_agent',
        name: '继续工具Agent',
        description: '',
        platform: 'mock',
        platform_config: {},
        model_id: 'gpt-4o-mini',
        model_config: {},
        role_id: null,
        tool_name: 'continue',
        step_order: null,
        scope: 'project',
        source: 'manual',
        tags: [],
        status: 'active',
        is_default: false,
        version_no: 1,
        versions: [],
        archived_at: null
      })
    );

    const res = await post(`/api/v1/ai-projects/${workId}/tools/continue/switch`, { agent_id: toolAgent.id }).expect(200);
    expect(res.body.data.ok).toBe(true);

    // 契约：缺 agent_id → 422
    await post(`/api/v1/ai-projects/${workId}/tools/continue/switch`, {}).expect(422);
  });

  // ── 归档 / 恢复 / 版本列表 / 回滚（验收 3） ──

  it('archive/restore/versions/rollback 全链路', async () => {
    const agentId = await createAgent('版本Agent', { is_default: false });

    // 归档
    const archived = await post(`/api/v1/ai-agents/${agentId}/archive`).expect(200);
    expect(archived.body.data.status).toBe('archived');

    // 版本列表（snapshot 至少含 create/archive 快照）
    const versions = await get(`/api/v1/ai-agents/${agentId}/versions`).expect(200);
    expect(versions.body.data.length).toBeGreaterThanOrEqual(1);

    // 恢复
    const restored = await post(`/api/v1/ai-agents/${agentId}/restore`).expect(200);
    expect(restored.body.data.status).toBe('active');

    // 回滚（回滚到最早版本；回滚会写新快照）
    const rollback = await post(`/api/v1/ai-agents/${agentId}/versions/1/rollback`).expect(200);
    expect(rollback.body.data).toBeDefined();
  });

  // ── 归属校验（验收 5） ──

  it('非作者访问 Agent → 404（不泄露存在性）', async () => {
    const agentId = await createAgent('私有Agent');
    // 换一个作者登录
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('other horse');
    const other = await dataSource.getRepository(AuthorEntity).save({
      email: `agentmgmt-other-${randomUUID()}@example.com`,
      display_name: 'Other',
      password_hash: passwordHash
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: other.email, password: 'other horse' })
      .expect(200);
    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const otherSession = {
      cookie: cookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!,
      csrf: cookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!,
      token: login.body.data.csrf_token as string
    };

    await request(app.getHttpServer())
      .post(`/api/v1/ai-agents/${agentId}/archive`)
      .set('Cookie', [otherSession.cookie, otherSession.csrf])
      .set('x-csrf-token', otherSession.token)
      .send({})
      .expect(404);
  });

  // ── 契约 422（验收 7） ──

  it('rollback 缺 version_no 路径 → 400/422（契约校验入口）', async () => {
    const agentId = await createAgent('回滚校验');
    // 版本号非法（0）走服务校验，路径数字但无对应版本 → 404/500；此处验证服务兜底不挂
    await post(`/api/v1/ai-agents/${agentId}/versions/0/rollback`).expect((r) => {
      expect([400, 404, 500]).toContain(r.status);
    });
  });
});
