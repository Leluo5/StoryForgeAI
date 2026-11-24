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

describe('site-config endpoints (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };

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
    session = await bootstrapClient();
  });

  afterAll(async () => {
    await app.close();
    await destroyTestDatabase(migrationDataSource);
  });

  async function bootstrapClient(): Promise<{ cookie: string; csrf: string; token: string }> {
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const author = await dataSource.getRepository(AuthorEntity).save({
      email: `site-author-${randomUUID()}@example.com`,
      display_name: 'Site Author',
      password_hash: passwordHash
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: author.email, password: 'correct horse' })
      .expect(200);
    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookie = cookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!;
    const csrf = cookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!;
    const token = login.body.data.csrf_token as string;
    return { cookie, csrf, token };
  }

  const put = (url: string, body: unknown) =>
    request(app.getHttpServer()).put(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const get = (url: string) =>
    request(app.getHttpServer()).get(url)
      .set('Cookie', [session.cookie, session.csrf]);

  // ── 401/403 ──

  it('rejects unauthenticated GET (401) and missing CSRF PUT (403)', async () => {
    await request(app.getHttpServer()).get('/api/v1/site-config').expect(401);
    await request(app.getHttpServer())
      .put('/api/v1/site-config')
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', '')
      .send({ site_name: 'x' })
      .expect(403);
  });

  // ── GET 默认值 ──

  it('returns defaults when no config exists', async () => {
    const res = await get('/api/v1/site-config').expect(200);
    expect(res.body.data.config.site_name).toBe('我的创作站');
    expect(res.body.data.config.theme).toBe('light');
    expect(res.body.data.config.llm_config).toEqual({});
    expect(res.body.data.config.platform_credentials).toEqual({});
  });

  // ── PUT 保存 + 回读（含 api_key/pat 完整） ──

  it('saves config and reads it back with sensitive keys intact', async () => {
    await put('/api/v1/site-config', {
      site_name: '我的站',
      site_description: '创作站',
      theme: 'dark',
      llm_config: { base_url: 'https://llm', api_key: 'sk-secret', model: 'gpt-4o' },
      platform_credentials: {
        coze: { base_url: 'https://api.coze.cn', pat: 'pat-secret' },
        flowise: { base_url: 'https://flowise', api_key: 'fk' },
        fastgpt: { base_url: 'https://fastgpt', api_key: 'fk2', dataset_id: 'ds1' },
        n8n: { webhook_url: 'https://n8n', token: 't1' }
      }
    }).expect(200);

    const res = await get('/api/v1/site-config').expect(200);
    expect(res.body.data.config.site_name).toBe('我的站');
    expect(res.body.data.config.theme).toBe('dark');
    expect(res.body.data.config.llm_config.api_key).toBe('sk-secret');
    expect(res.body.data.config.platform_credentials.coze.pat).toBe('pat-secret');
    expect(res.body.data.config.platform_credentials.n8n.token).toBe('t1');
  });

  // ── PUT 空 body 422 ──

  it('rejects empty PUT body with 422', async () => {
    await put('/api/v1/site-config', {}).expect(422);
  });

  // ── PUT 部分字段只更新传入字段 ──

  it('updates only provided fields, preserving others', async () => {
    await put('/api/v1/site-config', { site_name: '原名', site_description: '原描述' }).expect(200);
    await put('/api/v1/site-config', { site_name: '新名' }).expect(200);

    const res = await get('/api/v1/site-config').expect(200);
    expect(res.body.data.config.site_name).toBe('新名');
    expect(res.body.data.config.site_description).toBe('原描述');
  });
});
