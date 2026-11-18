import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

describe('plot tree endpoints (real PostgreSQL)', () => {
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
      email: `plot-author-${randomUUID()}@example.com`,
      display_name: 'Plot Author',
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
    workId = (await workService.create(authorId, { title: '剧情作品', description: '' })).work.id;
  }

  const get = (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', [session.cookie, session.csrf]);
  const post = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const patch = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .patch(url)
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

  const treeUrl = (id = workId) => `/api/v1/works/${id}/plot-tree`;

  async function createTree(): Promise<void> {
    await post(treeUrl(), { title: '主线' }).expect(201);
  }

  async function createNode(title: string, parentId: string | null = null): Promise<{ id: string; version: number }> {
    const response = await post(`${treeUrl()}/nodes`, { title, parent_id: parentId, position: { x: 0, y: 0 } }).expect(201);
    return { id: response.body.data.node.id as string, version: response.body.data.version as number };
  }

  // ── 鉴权 ──

  it('rejects unauthenticated reads (401) and writes without CSRF (403)', async () => {
    await request(app.getHttpServer()).get(treeUrl()).expect(401);
    await request(app.getHttpServer()).post(treeUrl()).send({ title: 'x' }).expect(401);
    await post(treeUrl(), { title: 'x' })
      .set('x-csrf-token', '')
      .expect(403);
  });

  // ── 剧情树 ──

  it('returns an empty structure when the work has no tree, then creates one and rejects duplicates', async () => {
    const empty = await get(treeUrl()).expect(200);
    expect(empty.body.data.tree).toBeNull();
    expect(empty.body.data.nodes).toEqual([]);

    const created = await post(treeUrl(), { title: '主线' }).expect(201);
    expect(created.body.data.tree.title).toBe('主线');
    expect(created.body.data.tree.source).toBe('manual');
    expect(created.body.data.tree.version).toBe(1);

    await post(treeUrl(), { title: '重复' }).expect(409);
  });

  it('rejects a stale expected_version with 409 and enforces title validation', async () => {
    await createTree();
    await patch(treeUrl(), { title: '改名', expected_version: 1 }).expect(200);
    await patch(treeUrl(), { title: '再改', expected_version: 1 }).expect(409);
    await patch(treeUrl(), { title: '' }).expect(422);
  });

  // ── 节点 ──

  it('creates, updates, moves and deletes nodes with cycle and subtree guards', async () => {
    await createTree();
    const root = await createNode('根');
    const child = await createNode('子', root.id);

    await patch(`${treeUrl()}/nodes/${child.id}`, { title: '子改', expected_version: child.version }).expect(200);
    await patch(`${treeUrl()}/nodes/${child.id}`, { title: '过期', expected_version: child.version }).expect(409);

    // 把根挂到后代下 → 409
    await patch(`${treeUrl()}/nodes/${root.id}/parent`, { parent_id: child.id }).expect(409);
    // 缺失父节点 → 404
    await patch(`${treeUrl()}/nodes/${child.id}/parent`, { parent_id: randomUUID() }).expect(404);

    const deleted = await del(`${treeUrl()}/nodes/${root.id}`).expect(200);
    expect(deleted.body.data.deleted).toBe(2);
  });

  it('updates positions in bulk without bumping the structure version', async () => {
    await createTree();
    const node = await createNode('定位');
    const before = await get(treeUrl()).expect(200);
    const version = before.body.data.tree.version as number;

    const updated = await put(`${treeUrl()}/positions`, {
      positions: [{ node_id: node.id, x: 120, y: 80 }, { node_id: randomUUID(), x: 1, y: 1 }]
    }).expect(200);
    expect(updated.body.data.updated).toBe(1);

    const after = await get(treeUrl()).expect(200);
    expect(after.body.data.tree.version).toBe(version);
    expect(after.body.data.nodes[0].position).toEqual({ x: 120, y: 80 });
  });

  // ── 关联 ──

  it('creates links, rejects duplicates and self links, and detects linear cycles', async () => {
    await createTree();
    const a = await createNode('A');
    const b = await createNode('B');

    await post(`${treeUrl()}/links`, { source_id: a.id, target_id: b.id, type: 'linear' }).expect(201);
    await post(`${treeUrl()}/links`, { source_id: a.id, target_id: b.id, type: 'linear' }).expect(409);
    await post(`${treeUrl()}/links`, { source_id: b.id, target_id: a.id, type: 'linear' }).expect(409);
    // 契约层拒绝自指 → 422
    await post(`${treeUrl()}/links`, { source_id: a.id, target_id: a.id, type: 'non_linear' }).expect(422);
    // 非线性双向允许
    await post(`${treeUrl()}/links`, { source_id: b.id, target_id: a.id, type: 'non_linear' }).expect(201);
  });

  // ── 分组 ──

  it('creates groups, assigns nodes, and rejects duplicate names', async () => {
    await createTree();
    const node = await createNode('组内');
    const group = await post(`${treeUrl()}/groups`, { name: '侦探线', kind: 'swimlane' }).expect(201);
    const groupId = group.body.data.group.id as string;
    await post(`${treeUrl()}/groups`, { name: '侦探线', kind: 'group' }).expect(409);

    await patch(`${treeUrl()}/nodes/${node.id}/group`, { group_id: groupId }).expect(200);
    await del(`${treeUrl()}/groups/${groupId}`).expect(200);

    const after = await get(treeUrl()).expect(200);
    expect(after.body.data.groups).toEqual([]);
    expect(after.body.data.nodes).toHaveLength(1);
    expect(after.body.data.nodes[0].group_id).toBeNull();
  });

  // ── 导入导出 ──

  it('exports with a download header and rejects invalid imports with 422', async () => {
    await createTree();
    const root = await createNode('根');
    await createNode('子', root.id);

    const exported = await get(`${treeUrl()}/export`).expect(200);
    expect(exported.headers['content-disposition']).toContain('attachment');
    expect(exported.body.data.schema_version).toBe(1);
    expect(exported.body.data.nodes).toHaveLength(2);

    const duplicated = {
      schema_version: 1,
      tree: { title: '坏树' },
      nodes: [
        { id: randomUUID(), title: '重复', parent_id: null, position: { x: 0, y: 0 } },
        { id: randomUUID(), title: '重复2', parent_id: null, position: { x: 0, y: 0 } }
      ],
      links: [],
      groups: []
    };
    const firstId = duplicated.nodes[0]!.id;
    duplicated.nodes[1]!.id = firstId;
    await post(`${treeUrl()}/import`, duplicated).expect(422);

    // 合法导入覆盖现有树
    const okImport = await post(`${treeUrl()}/import`, exported.body.data).expect(200);
    expect(okImport.body.data.tree.source).toBe('import');
    expect(okImport.body.data.nodes).toHaveLength(2);
  });

  // ── 越权 ──

  it('hides another author work with 404', async () => {
    await createTree();
    const [{ AuthorEntity }] = await Promise.all([import('../src/database/author.entity')]);
    const other = await dataSource.getRepository(AuthorEntity).save({
      email: `plot-other-${randomUUID()}@example.com`,
      display_name: 'Other',
      password_hash: 'x'
    });
    const { WorkService } = await import('../src/writing/work.service');
    const otherWork = await new WorkService(dataSource).create(other.id, { title: '别人的作品', description: '' });
    await get(treeUrl(otherWork.work.id)).expect(404);
  });

  // ── 推衍 ──

  const derivationBody = (startNodeId: string) => ({
    start_node_id: startNodeId,
    place: '客栈',
    background: '主角被追杀',
    characters: [{ name: '林澈', description: '剑客' }],
    random_enabled: true,
    random_character_enabled: false
  });

  async function createSession(startNodeId: string): Promise<string> {
    const response = await post(`${treeUrl()}/derivations`, derivationBody(startNodeId)).expect(201);
    return response.body.data.session.id as string;
  }

  /** e2e 未启动队列 Worker，这里直接落一条推衍步骤，验证分支/候选/回写链路 */
  async function seedStep(sessionId: string): Promise<void> {
    const [{ DerivationStepEntity }] = await Promise.all([import('../src/database/derivation-step.entity')]);
    await dataSource.getRepository(DerivationStepEntity).save({
      id: randomUUID(),
      session_id: sessionId,
      step_no: 1,
      content: '主角推门而入',
      event: null,
      new_characters: [],
      branches: [
        { id: 'branch_a', label: '追查线索', description: '' },
        { id: 'branch_b', label: '正面冲突', description: '' }
      ],
      chosen_branch_id: null,
      task_id: null
    });
  }

  it('creates a derivation session, enqueues a step and rejects duplicates', async () => {
    await createTree();
    const start = await createNode('起点');
    const sessionId = await createSession(start.id);

    const started = await post(`${treeUrl()}/derivations/${sessionId}/steps`).expect(202);
    expect(started.body.data.task.scope).toBe('plot');
    expect(started.body.data.task.status).toBe('queued');
    expect(started.body.data.session.status).toBe('running');

    // 已有排队任务 → 409，避免重复生成
    await post(`${treeUrl()}/derivations/${sessionId}/steps`).expect(409);

    // 尚无步骤：改步骤 404、生成候选 422
    await patch(`${treeUrl()}/derivations/${sessionId}/steps/1`, { content: 'x' }).expect(404);
    await post(`${treeUrl()}/derivations/${sessionId}/candidates`, {
      split_by_step: false, placement: 'child'
    }).expect(422);

    // 契约校验：角色至少 1 个
    await post(`${treeUrl()}/derivations`, { ...derivationBody(start.id), characters: [] }).expect(422);
  });

  it('updates steps, confirms candidates into the tree and rejects without writes', async () => {
    await createTree();
    const start = await createNode('起点');
    const sessionId = await createSession(start.id);
    await seedStep(sessionId);

    const branches = await patch(`${treeUrl()}/derivations/${sessionId}/steps/1`, {
      content: '改写后的第一步',
      chosen_branch_id: 'branch_a'
    }).expect(200);
    expect(branches.body.data.step.content).toBe('改写后的第一步');
    expect(branches.body.data.step.chosen_branch_id).toBe('branch_a');
    await patch(`${treeUrl()}/derivations/${sessionId}/steps/1`, { chosen_branch_id: 'missing' }).expect(422);

    const candidateResponse = await post(`${treeUrl()}/derivations/${sessionId}/candidates`, {
      split_by_step: false, placement: 'child'
    }).expect(201);
    const candidateId = candidateResponse.body.data.candidate.id as string;
    expect(candidateResponse.body.data.candidate.status).toBe('pending');
    expect(candidateResponse.body.data.candidate.payload.nodes).toHaveLength(1);

    const before = await get(treeUrl()).expect(200);
    const version = before.body.data.tree.version as number;
    await post(`${treeUrl()}/derivations/${sessionId}/candidates/${candidateId}/confirm`, {
      expected_version: version + 1
    }).expect(409);

    const confirmed = await post(`${treeUrl()}/derivations/${sessionId}/candidates/${candidateId}/confirm`, {
      expected_version: version
    }).expect(200);
    const createdNodeId = confirmed.body.data.nodes[0].id as string;
    expect(confirmed.body.data.version).toBe(version + 1);

    const after = await get(treeUrl()).expect(200);
    expect(after.body.data.nodes).toHaveLength(2);
    expect(after.body.data.nodes.some((node: { id: string }) => node.id === createdNodeId)).toBe(true);

    // 重复确认幂等：返回同一批节点，不重复写树
    const again = await post(`${treeUrl()}/derivations/${sessionId}/candidates/${candidateId}/confirm`, {}).expect(200);
    expect(again.body.data.nodes.map((node: { id: string }) => node.id)).toEqual([createdNodeId]);

    // 拒绝不写树；拒绝后再确认返回 409
    const nextCandidate = await post(`${treeUrl()}/derivations/${sessionId}/candidates`, {
      split_by_step: false, placement: 'sibling'
    }).expect(201);
    const nextId = nextCandidate.body.data.candidate.id as string;
    const rejected = await post(`${treeUrl()}/derivations/${sessionId}/candidates/${nextId}/reject`).expect(200);
    expect(rejected.body.data.candidate.status).toBe('rejected');
    await post(`${treeUrl()}/derivations/${sessionId}/candidates/${nextId}/confirm`, {}).expect(409);

    const finalTree = await get(treeUrl()).expect(200);
    expect(finalTree.body.data.nodes).toHaveLength(2);
  });
});
