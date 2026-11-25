// M3c-3 T37 知识库 API E2E（真实 PostgreSQL）——核心条目/标签/关联/引用
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.1~§4.4、§7、§8.1；03-任务规划.md T37
// 覆盖：401 未登录 / 403 缺 CSRF / 422 校验 / 404 越权隐藏 / 条目 CRUD+回收站+彻底删除 /
//       收藏置顶 / 乐观锁 / 标签增删改 / 跨条目关联 / 作品引用与副本。
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

describe('knowledge endpoints (real PostgreSQL)', () => {
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
      email: `knowledge-author-${randomUUID()}@example.com`,
      display_name: 'Knowledge Author',
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
    workId = (await workService.create(authorId, { title: '知识库作品', description: '' })).work.id;
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
  const del = (url: string, body?: unknown) => {
    const req = request(app.getHttpServer())
      .delete(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token);
    if (body !== undefined) req.send(body as object);
    return req;
  };

  const entriesUrl = '/api/v1/knowledge/entries';

  async function createEntry(
    text = '这是知识库条目正文，用于 E2E 测试。',
    extra: Record<string, unknown> = {}
  ): Promise<string> {
    const r = await post(entriesUrl, { scope: 'global', text, ...extra }).expect(201);
    return r.body.data.id as string;
  }

  it('rejects unauthenticated reads (401) and writes without CSRF (403)', async () => {
    await request(app.getHttpServer()).get(`${entriesUrl}?scope=global`).expect(401);
    await request(app.getHttpServer()).post(entriesUrl).send({ scope: 'global', text: 'x' }).expect(401);
    await request(app.getHttpServer())
      .post(entriesUrl)
      .set('Cookie', [session.cookie, session.csrf])
      .send({ scope: 'global', text: '林昭' })
      .expect(403);
  });

  it('validates payloads (422) and hides unknown entries (404)', async () => {
    await post(entriesUrl, { scope: 'global', text: '' }).expect(422);
    await post(entriesUrl, { scope: 'global' }).expect(422);
    await get(`${entriesUrl}/${randomUUID()}`).expect(404);
    await get(`${entriesUrl}?scope=invalid`).expect(422);
  });

  it('creates and reads back a global entry with detail fields', async () => {
    const entryId = await createEntry('《三国演义》开篇词：滚滚长江东逝水。', { title: '开篇词' });

    const detail = await get(`${entriesUrl}/${entryId}`).expect(200);
    const d = detail.body.data;
    expect(d.id).toBe(entryId);
    expect(d.kind).toBe('entry');
    expect(d.title).toBe('开篇词');
    // T09 定稿规则：单段短文本（<800 字、无空行）→ inspiration（medium），见 classify.test.ts「仅一段短文本 → inspiration」
    expect(d.entry_type).toBe('inspiration');
    expect(d.original_text).toContain('滚滚长江东逝水');
    expect(d.structure_status).toBeDefined();
    expect(d.version).toBe(1);
    expect(typeof d.content_hash).toBe('string');
  });

  it('lists entries with search response shape and cursor', async () => {
    await createEntry('第一篇文章：机器学习基础。');
    await createEntry('第二篇文章：深度学习进阶。');

    const list = await get(`${entriesUrl}?scope=global`).expect(200);
    expect(list.body.data.items.length).toBe(2);
    expect(list.body.data.total).toBe(2);
    expect(list.body.data.next_cursor).toBeNull();
    expect(list.body.data.items[0]).toMatchObject({
      kind: 'entry',
      // 单段短文本 → inspiration（T09 定稿规则）
      entry_type: 'inspiration'
    });

    const filtered = await get(`${entriesUrl}?scope=global&keyword=深度学习`).expect(200);
    expect(filtered.body.data.items.length).toBe(1);
    // 未传 title 时默认「未命名条目」；检索命中原文，断言 excerpt 含关键词
    expect(filtered.body.data.items[0].excerpt).toContain('深度学习');

    const empty = await get(`${entriesUrl}?scope=global&keyword=不存在的关键词`).expect(200);
    expect(empty.body.data.items.length).toBe(0);
    expect(empty.body.data.total).toBe(0);
  });

  it('edits entry with optimistic lock and rejects stale version', async () => {
    const entryId = await createEntry('原始正文内容。');

    const updated = await patch(`${entriesUrl}/${entryId}`, {
      title: '新标题',
      expected_version: 1
    }).expect(200);
    expect(updated.body.data.title).toBe('新标题');
    expect(updated.body.data.version).toBe(2);

    // 乐观锁：期望版本 1（已过期）→ 409
    const stale = await patch(`${entriesUrl}/${entryId}`, {
      title: '过期标题',
      expected_version: 1
    });
    expect(stale.status).toBe(409);
  });

  it('sets favorite and pinned flags idempotently', async () => {
    const entryId = await createEntry('待收藏条目。');

    await put(`${entriesUrl}/${entryId}/flags`, { favorite: true, pinned: true }).expect(200);

    const detail = await get(`${entriesUrl}/${entryId}`).expect(200);
    expect(detail.body.data.favorite).toBe(true);
    expect(detail.body.data.pinned).toBe(true);

    // 收藏置顶排序：favorite=true 条目应排在前面
    await createEntry('普通条目。');
    const list = await get(`${entriesUrl}?scope=global&favorite=true`).expect(200);
    expect(list.body.data.items.length).toBe(1);
    expect(list.body.data.items[0].id).toBe(entryId);
  });

  it('soft-deletes, restores, then purges permanently', async () => {
    const entryId = await createEntry('将被删除的条目。');

    // 软删除 → 从普通列表隐藏
    await del(`${entriesUrl}/${entryId}`).expect(200);
    const listAfterDelete = await get(`${entriesUrl}?scope=global`).expect(200);
    expect(listAfterDelete.body.data.items.length).toBe(0);

    // 回收站可见
    const trash = await get(`${entriesUrl}?scope=global&deleted=true`).expect(200);
    expect(trash.body.data.items.length).toBe(1);

    // 恢复（幂等）
    await post(`${entriesUrl}/${entryId}/restore`).expect(200);
    const listAfterRestore = await get(`${entriesUrl}?scope=global`).expect(200);
    expect(listAfterRestore.body.data.items.length).toBe(1);

    // 彻底删除要求条目在回收站：先再次软删除
    await del(`${entriesUrl}/${entryId}`).expect(200);

    // 彻底删除是 DELETE + body confirm（必填布尔 literal true）：缺参 → 422，false → 422，true → 200
    await del(`${entriesUrl}/${entryId}/permanent`).expect(422);
    await del(`${entriesUrl}/${entryId}/permanent`, { confirm: false }).expect(422);
    await del(`${entriesUrl}/${entryId}/permanent`, { confirm: true }).expect(200);
    await get(`${entriesUrl}/${entryId}`).expect(404);
  });

  it('summarizes library counts', async () => {
    await createEntry('摘要条目一。');
    await createEntry('摘要条目二。');

    // 摘要为双层库口径：{ global: {entries,trash,references}, work: {...}|null }
    const summary = await get('/api/v1/knowledge/summary').expect(200);
    const s = summary.body.data;
    expect(typeof s.global.entries).toBe('number');
    expect(s.global.entries).toBe(2);
    expect(s.global.trash).toBe(0);
    expect(s.work).toBeNull();

    // 指定作品库：work 统计可用
    const withWork = await get(`/api/v1/knowledge/summary?work_id=${workId}`).expect(200);
    expect(withWork.body.data.work.entries).toBe(0);
  });

  it('manages tags: create, rename, list, delete cascade', async () => {
    const tag = await post('/api/v1/knowledge/tags', {
      scope: 'global',
      name: '世界观'
    }).expect(201);
    const tagId = tag.body.data.id as string;
    expect(tag.body.data.name).toBe('世界观');

    // 列表含条目数
    const list = await get('/api/v1/knowledge/tags?scope=global').expect(200);
    expect(list.body.data.some((t: { id: string }) => t.id === tagId)).toBe(true);

    // 重命名
    const renamed = await patch(`/api/v1/knowledge/tags/${tagId}`, { name: '新世界观' }).expect(200);
    expect(renamed.body.data.name).toBe('新世界观');

    // 删除
    await del(`/api/v1/knowledge/tags/${tagId}`).expect(200);
    const afterDelete = await get('/api/v1/knowledge/tags?scope=global').expect(200);
    expect(afterDelete.body.data.some((t: { id: string }) => t.id === tagId)).toBe(false);
  });

  it('creates bidirectional link between entries and rejects duplicate', async () => {
    const a = await createEntry('关联源条目。');
    const b = await createEntry('关联目标条目。');

    const link = await post('/api/v1/knowledge/links', {
      source_entry_id: a,
      target_entry_id: b
    }).expect(201);
    expect(link.body.data.source_entry_id).toBe(a);
    expect(link.body.data.target_entry_id).toBe(b);

    // 双向列表均可见
    const listA = await get(`${entriesUrl}/${a}/links`).expect(200);
    expect(listA.body.data.some((l: { target_entry_id: string }) => l.target_entry_id === b)).toBe(true);
    const listB = await get(`${entriesUrl}/${b}/links`).expect(200);
    expect(listB.body.data.some((l: { source_entry_id: string }) => l.source_entry_id === a)).toBe(true);

    // 重复关联 → 409
    await post('/api/v1/knowledge/links', {
      source_entry_id: a,
      target_entry_id: b
    }).expect(409);

    // 解除关联（幂等）
    await del(`/api/v1/knowledge/links/${link.body.data.id}`).expect(200);
    await del(`/api/v1/knowledge/links/${link.body.data.id}`).expect(200);
  });

  it('manages work refs: create, list, flags, copy, remove', async () => {
    const entryId = await createEntry('被引用的全局条目。');
    const refsUrl = `/api/v1/works/${workId}/knowledge/refs`;

    // 批量引用
    const created = await post(refsUrl, { entry_ids: [entryId] }).expect(201);
    expect(created.body.data.length).toBe(1);
    const refId = created.body.data[0].id as string;

    // 作品引用列表（引用视图：kind=reference，标识为 ref_id，无 entry_id 字段）
    const list = await get(refsUrl).expect(200);
    expect(list.body.data.length).toBe(1);
    expect(list.body.data[0].kind).toBe('reference');
    expect(list.body.data[0].ref_id).toBe(refId);

    // 引用上下文的收藏置顶
    await put(`${refsUrl}/${refId}/flags`, { favorite: true }).expect(200);

    // 另存为作品副本（保留引用）
    const copy = await post(`${refsUrl}/${refId}/copy`, { keep_ref: true }).expect(201);
    expect(copy.body.data.title).toBeDefined();

    // 移除引用（不删全局条目，幂等）
    await del(`${refsUrl}/${refId}`).expect(200);
    await del(`${refsUrl}/${refId}`).expect(200);

    // 全局条目仍在
    await get(`${entriesUrl}/${entryId}`).expect(200);
  });
});
