import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

// M3c-2 T21~T24 接口层 e2e：真实 PostgreSQL
describe('character endpoints (real PostgreSQL)', () => {
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
      email: `character-author-${randomUUID()}@example.com`,
      display_name: 'Character Author',
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
    workId = (await workService.create(authorId, { title: '角色作品', description: '' })).work.id;
  }

  const get = (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', [session.cookie, session.csrf]);
  const post = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const del = (url: string) =>
    request(app.getHttpServer())
      .delete(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token);

  const charactersUrl = (id = workId) => `/api/v1/works/${id}/characters`;

  async function createCharacter(name: string): Promise<string> {
    const response = await post(charactersUrl(), { name }).expect(201);
    return response.body.data.id as string;
  }

  async function waitForScans(): Promise<void> {
    const { CharacterArchiveScanEntity } = await import(
      '../src/database/character-archive-scan.entity'
    );
    const repo = dataSource.getRepository(CharacterArchiveScanEntity);
    for (let i = 0; i < 40; i += 1) {
      const pending = await repo.count({ where: { work_id: workId, status: 'pending' } });
      const running = await repo.count({ where: { work_id: workId, status: 'running' } });
      if (pending + running === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('rejects unauthenticated reads (401) and writes without CSRF (403)', async () => {
    await request(app.getHttpServer()).get(charactersUrl()).expect(401);
    await request(app.getHttpServer()).post(charactersUrl()).send({ name: 'x' }).expect(401);
    await request(app.getHttpServer())
      .post(charactersUrl())
      .set('Cookie', [session.cookie, session.csrf])
      .send({ name: '林昭' })
      .expect(403);
  });

  it('validates payloads (422) and hides unknown works (404)', async () => {
    await post(charactersUrl(), { name: '' }).expect(422);
    await get(charactersUrl(randomUUID())).expect(404);
    await post(charactersUrl(randomUUID()), { name: '林昭' }).expect(404);
  });

  it('keeps duplicates and random static routes ahead of :characterId', async () => {
    const duplicates = await get(`${charactersUrl()}/duplicates`).expect(200);
    expect(duplicates.body.data.groups).toEqual([]);

    const random = await post(`${charactersUrl()}/random`, {}).expect(200);
    expect(typeof random.body.data.seed).toBe('string');
    expect(typeof random.body.data.dossier.name).toBe('string');
  });

  it('returns detail with relation summary and growth event count', async () => {
    const characterId = await createCharacter('林昭');
    const detail = await get(`${charactersUrl()}/${characterId}`).expect(200);
    expect(detail.body.data.character.id).toBe(characterId);
    expect(detail.body.data.relation_summary).toEqual({ total: 0 });
    expect(detail.body.data.growth_event_count).toBe(0);
  });

  it('archives with impact + pending scan and is idempotent on repeat', async () => {
    const characterId = await createCharacter('沈砚');
    const first = await post(`${charactersUrl()}/${characterId}/archive`, {}).expect(200);
    expect(first.body.data.character.status).toBe('archived');
    expect(first.body.data.version).toBe(2);
    expect(first.body.data.impact).toEqual({
      relations: 0,
      growth_events: 0,
      chapters: 1,
      exclusive_plot_nodes: 0
    });
    expect(first.body.data.scan.status).toBe('pending');
    expect(first.body.data.scan.total_chapters).toBe(1);

    const scanId = first.body.data.scan.id as string;
    const second = await post(`${charactersUrl()}/${characterId}/archive`, {}).expect(200);
    expect(second.body.data.changed).toBe(false);
    expect(second.body.data.scan.id).toBe(scanId);
    expect(second.body.data.version).toBe(2);
    await waitForScans();
  });

  it('restores an archived character and returns duplicate candidates', async () => {
    const first = await createCharacter('林昭');
    const second = await createCharacter('林昭');
    await post(`${charactersUrl()}/${first}/archive`, {}).expect(200);

    const restored = await post(`${charactersUrl()}/${first}/restore`, {}).expect(200);
    expect(restored.body.data.character.status).toBe('active');
    expect(restored.body.data.changed).toBe(true);
    const candidates = restored.body.data.duplicate_candidates as Array<{
      character_id: string;
      name: string;
      matched_on: string;
    }>;
    expect(candidates.some((c) => c.character_id === second && c.matched_on === 'name')).toBe(true);
    await waitForScans();
  });

  it('does not expose a purge/delete character route', async () => {
    const characterId = await createCharacter('无删除');
    await del(`${charactersUrl()}/${characterId}`).expect(404);
  });

  it('registers exactly 50 character-domain endpoints (9+8+8+4+4+7+4+4+2)', () => {
    const routes = registeredRoutes();
    const expected = [
      // T21 角色（9）
      'GET /api/v1/works/:workId/characters/duplicates',
      'POST /api/v1/works/:workId/characters/random',
      'GET /api/v1/works/:workId/characters',
      'POST /api/v1/works/:workId/characters',
      'GET /api/v1/works/:workId/characters/:characterId',
      'PATCH /api/v1/works/:workId/characters/:characterId',
      'POST /api/v1/works/:workId/characters/:characterId/archive',
      'POST /api/v1/works/:workId/characters/:characterId/restore',
      'POST /api/v1/works/:workId/characters/:characterId/merge',
      // T22 关系（8）
      'GET /api/v1/works/:workId/character-relation-types',
      'POST /api/v1/works/:workId/character-relation-types',
      'PATCH /api/v1/works/:workId/character-relation-types/:typeId',
      'DELETE /api/v1/works/:workId/character-relation-types/:typeId',
      'GET /api/v1/works/:workId/character-relations',
      'POST /api/v1/works/:workId/character-relations',
      'PATCH /api/v1/works/:workId/character-relations/:relationId',
      'DELETE /api/v1/works/:workId/character-relations/:relationId',
      // T23 视图（8）
      'GET /api/v1/works/:workId/character-views',
      'POST /api/v1/works/:workId/character-views',
      'PATCH /api/v1/works/:workId/character-views/:viewId',
      'DELETE /api/v1/works/:workId/character-views/:viewId',
      'GET /api/v1/works/:workId/character-views/:viewId/board',
      'POST /api/v1/works/:workId/character-views/:viewId/members',
      'DELETE /api/v1/works/:workId/character-views/:viewId/members/:characterId',
      'PUT /api/v1/works/:workId/character-views/:viewId/layout',
      // T24 成长线（4）
      'GET /api/v1/works/:workId/characters/:characterId/growth-events',
      'POST /api/v1/works/:workId/characters/:characterId/growth-events',
      'PATCH /api/v1/works/:workId/characters/:characterId/growth-events/:eventId',
      'DELETE /api/v1/works/:workId/characters/:characterId/growth-events/:eventId',
      // T25 头像（4）
      'POST /api/v1/works/:workId/characters/:characterId/avatar/generations',
      'GET /api/v1/works/:workId/characters/:characterId/avatar',
      'GET /api/v1/works/:workId/characters/:characterId/avatar/content',
      'POST /api/v1/works/:workId/characters/:characterId/avatar/adopt',
      // T26 AI 候选（7）
      'POST /api/v1/works/:workId/character-ai/drafts',
      'GET /api/v1/works/:workId/character-ai/drafts',
      'GET /api/v1/works/:workId/character-ai/drafts/:draftId',
      'POST /api/v1/works/:workId/character-ai/drafts/:draftId/items/:itemId/confirm',
      'POST /api/v1/works/:workId/character-ai/drafts/:draftId/items/:itemId/reject',
      'POST /api/v1/works/:workId/character-ai/drafts/:draftId/confirm-batch',
      'POST /api/v1/works/:workId/character-ai/drafts/:draftId/discard',
      // T27 锚点（4）
      'GET /api/v1/works/:workId/chapters/:chapterId/role-marks',
      'POST /api/v1/works/:workId/chapters/:chapterId/role-marks/:anchorId/dismiss',
      'POST /api/v1/works/:workId/chapters/:chapterId/role-marks/dismiss-batch',
      'POST /api/v1/works/:workId/characters/:characterId/archive-scans',
      // T28 导入导出（4）
      'GET /api/v1/works/:workId/character-portability/export',
      'POST /api/v1/works/:workId/character-portability/import/preview',
      'POST /api/v1/works/:workId/character-portability/import/commit',
      'GET /api/v1/works/:workId/character-portability/jobs/:jobId',
      // T29 剧情归属（2）
      'PUT /api/v1/works/:workId/plot-tree/nodes/:nodeId/owners',
      'DELETE /api/v1/works/:workId/plot-tree/nodes/:nodeId/owners/:characterId'
    ];
    expect(expected).toHaveLength(50);
    const missing = expected.filter((route) => !routes.has(route));
    expect(missing).toEqual([]);
    const characterRoutes = [...routes].filter(
      (route) => route.includes('/characters') || route.includes('/character-')
    );
    expect(characterRoutes.some((route) => route.toLowerCase().includes('purge'))).toBe(false);
    expect(routes.has('DELETE /api/v1/works/:workId/characters/:characterId')).toBe(false);
    expect([...routes].some((route) => /agent-persona|impersonat/.test(route))).toBe(false);
  });

  function registeredRoutes(): Set<string> {
    type Layer = {
      route?: { path: string; methods: Record<string, boolean> };
    };
    type RouterLike = { stack: Layer[] };
    const instance = app.getHttpAdapter().getInstance() as unknown as {
      router?: RouterLike;
      _router?: RouterLike;
    };
    const router = instance.router ?? instance._router;
    expect(router).toBeTruthy();
    const set = new Set<string>();
    for (const layer of router!.stack) {
      if (!layer.route) continue;
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (!enabled) continue;
        set.add(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
    return set;
  }
});
