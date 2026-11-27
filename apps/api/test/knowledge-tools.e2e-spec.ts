// M4-T9 知识库旧端点迁移 e2e：detect-type / similar / markdown-render
// 依据：docs/04-功能交付档案/M4-迁移切换/11-迁移切换技术方案.md §4.3~§4.5
// 覆盖：401 未登录 / 403 缺 CSRF / 422 校验 / 404 越权隐藏 / 200 正常。
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

describe('knowledge tools endpoints (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };
  let authorId: string;

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
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const author = await dataSource.getRepository(AuthorEntity).save({
      email: `ktools-author-${randomUUID()}@example.com`,
      display_name: 'KTools Author',
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

  const get = (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', [session.cookie, session.csrf]);
  const post = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);

  async function createEntry(text: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await post('/api/v1/knowledge/entries', { scope: 'global', text, ...extra }).expect(201);
    return r.body.data.id as string;
  }

  async function addEmbedding(entryId: string, vector: number[]): Promise<void> {
    const repo = dataSource.getRepository('KnowledgeEntryEmbeddingEntity');
    const full = [...vector];
    while (full.length < 1024) full.push(0);
    await repo.save(repo.create({
      entry_id: entryId,
      owner_id: authorId,
      model: 'test-embed',
      dim: 1024,
      embedding: `[${full.map((x) => Number(x.toFixed(8))).join(',')}]`,
      source_hash: randomUUID().replace(/-/g, '')
    }));
  }

  const detectUrl = '/api/v1/knowledge/detect-type';
  const renderUrl = '/api/v1/knowledge/markdown/render';
  const similarUrl = (id: string) => `/api/v1/knowledge/entries/${id}/similar`;

  // ── 401/403 ──

  it('rejects unauthenticated (401) and missing CSRF (403) on detect-type / markdown-render', async () => {
    await request(app.getHttpServer()).post(detectUrl).send({ raw_content: 'x' }).expect(401);
    await request(app.getHttpServer())
      .post(detectUrl)
      .set('Cookie', [session.cookie, session.csrf])
      .send({ raw_content: 'x' })
      .expect(403);
    await request(app.getHttpServer()).post(renderUrl).send({ text: '# x' }).expect(401);
    await request(app.getHttpServer()).get(similarUrl(randomUUID())).expect(401);
  });

  // ── 422 校验 ──

  it('validates payloads (422) on all three endpoints', async () => {
    await post(detectUrl, { raw_content: '' }).expect(422);
    await post(detectUrl, { raw_content: 'x', manual: 'unknown_type' }).expect(422);
    await post(renderUrl, { text: 123 }).expect(422);
    await get(`${similarUrl(randomUUID())}?limit=999`).expect(422);
  });

  // ── detect-type ──

  it('detect-type: rules classify paper and manual setting wins', async () => {
    const paper = await post(detectUrl, { raw_content: '摘要：研究知识库。\n关键词：库\n参考文献：[1] 甲。' }).expect(200);
    expect(paper.body.data.type).toBe('paper');

    const manual = await post(detectUrl, { raw_content: '世界背景', manual: 'setting' }).expect(200);
    expect(manual.body.data.type).toBe('setting');
    expect(manual.body.data.confidence).toBe('high');
  });

  // ── similar ──

  it('similar: 200 with empty items when target has no embedding', async () => {
    const id = await createEntry('目标条目，无向量。');
    const r = await get(similarUrl(id)).expect(200);
    expect(r.body.data.items).toEqual([]);
  });

  it('similar: returns cosine top-N with title/type/excerpt', async () => {
    const target = await createEntry('目标，向量 [1,0,0]。');
    await addEmbedding(target, [1, 0, 0]);
    const close = await createEntry('相近条目，正文足够长用于截取摘要，这里补充更多内容。');
    await addEmbedding(close, [0.99, 0.01, 0]);

    const r = await get(similarUrl(target)).expect(200);
    expect(r.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(r.body.data.items[0].entry_id).toBe(close);
    expect(r.body.data.items[0].title).toBeTruthy();
    expect(r.body.data.items[0].entry_type).toBeTruthy();
    expect(r.body.data.items[0].score).toBeGreaterThan(0.9);
  });

  it('similar: 404 for unknown entry', async () => {
    await get(similarUrl(randomUUID())).expect(404);
  });

  // ── markdown-render ──

  it('markdown-render: converts markdown to HTML (title/strong)', async () => {
    const r = await post(renderUrl, { text: '# 标题\n\n**加粗**' }).expect(200);
    expect(r.body.data.html).toContain('<h1>标题</h1>');
    expect(r.body.data.html).toContain('<strong>加粗</strong>');
  });

  it('markdown-render: strips raw inline HTML (html:false safety)', async () => {
    const r = await post(renderUrl, { text: '<script>alert(1)</script>\n\n正文' }).expect(200);
    expect(r.body.data.html).not.toContain('<script>');
  });
});
