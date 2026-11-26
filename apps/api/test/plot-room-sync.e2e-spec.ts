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
 * M4-T3 剧情树 ↔ 聊天室房间双向联动（sync-room）E2E。
 * 真实 PG 测试库：push 注入上下文 / pull 回写新节点 / origin 全标记去重 / 非法 action / 归属校验。
 */
describe('plot sync-room endpoints (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };
  let authorId: string;
  let workId: string;
  let roomId: string;

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
      email: `sync-author-${randomUUID()}@example.com`,
      display_name: 'Sync Author',
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
    workId = (await workService.create(authorId, { title: '联动作品', description: '' })).work.id;
  }

  const get = (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', [session.cookie, session.csrf]);
  const post = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);

  const treeUrl = () => `/api/v1/works/${workId}/plot-tree`;
  const syncUrl = () => `/api/v1/works/${workId}/plot-tree/sync-room/${roomId}`;
  const roomUrl = () => `/api/v1/works/${workId}/chat-rooms`;

  /** 建树 + 建房间 + 造 N 个剧情节点，返回节点 id 列表 */
  async function seedTreeAndRoom(nodeTitles: string[]): Promise<string[]> {
    await post(treeUrl(), { title: '联动主线' }).expect(201);
    const ids: string[] = [];
    for (const title of nodeTitles) {
      const created = await post(`${treeUrl()}/nodes`, { title, parent_id: null, position: { x: 0, y: 0 } }).expect(201);
      ids.push(created.body.data.node.id as string);
    }
    const room = await post(roomUrl(), {
      name: '联动房',
      room_key: `sync-${randomUUID()}`,
      roles: [],
      random_seed: 42
    }).expect(200);
    roomId = room.body.data.room.id as string;
    return ids;
  }

  // ── push：树 → 房间上下文注入 ──

  it('push injects context nodes and updates room context', async () => {
    const [a, b] = await seedTreeAndRoom(['节点A', '节点B']);

    const result = await post(syncUrl(), { action: 'push', context_node_ids: [a, b] }).expect(200);
    expect(result.body.data.injected).toBe(2);
    expect(result.body.data.context_nodes).toHaveLength(2);
    expect(result.body.data.context_nodes.map((n: { id: string }) => n.id).sort()).toEqual([a, b].sort());

    const room = await get(`${roomUrl()}/${roomId}`).expect(200);
    expect((room.body.data.room.context as { context_node_ids?: string[] }).context_node_ids).toEqual([a, b]);
  });

  it('push rejects missing context node with 409 and does not inject', async () => {
    const [a] = await seedTreeAndRoom(['节点A']);
    await post(syncUrl(), { action: 'push', context_node_ids: [a, randomUUID()] }).expect(409);
    const room = await get(`${roomUrl()}/${roomId}`).expect(200);
    expect((room.body.data.room.context as Record<string, unknown>).context_node_ids).toBeUndefined();
  });

  // ── pull：房间推衍步骤 → 剧情树节点回写 ──

  it('pull writes back history steps as new nodes with sync_room_origin marker', async () => {
    await seedTreeAndRoom([]);
    // 直接向房间 history 写两步（绕过 LLM，模拟已提交推衍步骤）
    await dataSource.query(
      `UPDATE chat_rooms SET history = $1::jsonb, step_index = 2, status = 'paused' WHERE id = $2`,
      [
        JSON.stringify([
          { step_no: 1, content: '第一步内容', speaker: 'narrator' },
          { step_no: 2, content: '第二步内容', speaker: 'narrator' }
        ]),
        roomId
      ]
    );

    const result = await post(syncUrl(), { action: 'pull' }).expect(200);
    expect(result.body.data.added).toBe(2);
    expect(result.body.data.skipped).toEqual([]);
    expect(result.body.data.new_nodes).toHaveLength(2);

    const tree = await get(treeUrl()).expect(200);
    const origins = tree.body.data.nodes.map((n: { attributes: Record<string, unknown> }) => n.attributes.sync_room_origin);
    expect(origins).toContain(`sync-room:${roomId}:1`);
    expect(origins).toContain(`sync-room:${roomId}:2`);
  });

  it('pull dedupes by sync_room_origin and does not recreate on repeat', async () => {
    await seedTreeAndRoom([]);
    await dataSource.query(
      `UPDATE chat_rooms SET history = $1::jsonb, step_index = 1, status = 'paused' WHERE id = $2`,
      [JSON.stringify([{ step_no: 1, content: '唯一内容', speaker: 'narrator' }]), roomId]
    );

    const first = await post(syncUrl(), { action: 'pull' }).expect(200);
    expect(first.body.data.added).toBe(1);

    const second = await post(syncUrl(), { action: 'pull' }).expect(200);
    expect(second.body.data.added).toBe(0);
    expect(second.body.data.skipped).toHaveLength(1);
    expect(second.body.data.skipped[0]).toBe(`sync-room:${roomId}:1`);

    const tree = await get(treeUrl()).expect(200);
    expect(tree.body.data.nodes).toHaveLength(1);
  });

  // ── 非法 / 归属 ──

  it('rejects an illegal action with 400', async () => {
    await seedTreeAndRoom([]);
    await post(syncUrl(), { action: 'explode' }).expect(400);
  });

  it('hides another author work with 404', async () => {
    await seedTreeAndRoom([]);
    const [{ AuthorEntity }] = await Promise.all([import('../src/database/author.entity')]);
    const other = await dataSource.getRepository(AuthorEntity).save({
      email: `sync-other-${randomUUID()}@example.com`,
      display_name: 'Other',
      password_hash: 'x'
    });
    const { WorkService } = await import('../src/writing/work.service');
    const otherWork = await new WorkService(dataSource).create(other.id, { title: '别人的作品', description: '' });
    await post(`/api/v1/works/${otherWork.work.id}/plot-tree/sync-room/${roomId}`, { action: 'push', context_node_ids: [randomUUID()] }).expect(404);
  });

  it('rejects unauthenticated reads (401) and writes without CSRF (403)', async () => {
    await request(app.getHttpServer()).get(treeUrl()).expect(401);
    await post(syncUrl(), { action: 'push' }).set('x-csrf-token', '').expect(403);
  });
});
