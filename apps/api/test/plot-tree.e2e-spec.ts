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
});
