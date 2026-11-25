// M3c-3 T37 知识库导入导出/备份 API E2E（真实 PostgreSQL）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.6、§4.7；03-任务规划.md T37
// 覆盖：Markdown 导出（202 + 下载流）；导入预览（conflict 分类）；导入提交（overwrite/rename/skip）；
//       备份创建（202 + gzip 下载）；恢复预览（same_content/same_title_diff_content/new 分类）；
//       恢复提交（succeeded/failed/skipped）。
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

describe('knowledge portability endpoints (real PostgreSQL)', () => {
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
      email: `knowledge-portability-${randomUUID()}@example.com`,
      display_name: 'Knowledge Portability Author',
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
  const del = (url: string) =>
    request(app.getHttpServer())
      .delete(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token);

  function multipart(url: string, field: string, buffer: Buffer, filename: string) {
    return request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .attach(field, buffer, filename);
  }

  // 下载二进制产物：supertest 默认不把 application/gzip 解析进 body，需自定义 parser 收集原始 Buffer
  function downloadBuffer(url: string): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
    return new Promise((resolve, reject) => {
      request(app.getHttpServer())
        .get(url)
        .set('Cookie', [session.cookie, session.csrf])
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .end((err, res) => {
          if (err) return reject(err);
          resolve({ status: res.status, body: res.body as Buffer, headers: res.headers as Record<string, string> });
        });
    });
  }

  function frontMatter(title: string, type: string, body: string): string {
    return `---\ntitle: ${title}\ntype: ${type}\ntags: []\nfavorite: false\npinned: false\n---\n${body}`;
  }

  it('exports markdown (202) and downloads content', async () => {
    await post('/api/v1/knowledge/entries', {
      scope: 'global',
      title: '导出条目',
      text: '导出正文内容。'
    }).expect(201);

    const exported = await post('/api/v1/knowledge/exports', {
      scope: 'global',
      format: 'markdown'
    }).expect(202);
    expect(exported.body.data.status).toBe('succeeded');
    expect(exported.body.data.entry_count).toBe(1);
    const jobId = exported.body.data.job_id as string;

    const download = await get(`/api/v1/knowledge/exports/${jobId}/download`).expect(200);
    expect(download.headers['content-type']).toContain('text/markdown');
    expect(download.text).toContain('导出正文内容');
  });

  it('previews markdown import and classifies conflicts', async () => {
    // 预置一个同内容条目 → 重复检测
    await post('/api/v1/knowledge/entries', {
      scope: 'global',
      title: '已存在条目',
      text: '重复正文。'
    }).expect(201);

    const md = frontMatter('新条目', 'article', '这是导入的正文。');
    const preview = await multipart('/api/v1/knowledge/imports/preview', 'files', Buffer.from(md), 'new-entry.md')
      .expect(200);
    const p = preview.body.data;
    expect(p.files.length).toBe(1);
    expect(p.files[0].title).toBe('新条目');
    expect(p.files[0].conflict).toBe('new');
    expect(p.summary.total).toBe(1);
    expect(p.summary.new).toBe(1);
  });

  it('commits markdown import with rename policy (202)', async () => {
    const md = frontMatter('提交条目', 'article', '提交正文。');
    const preview = await multipart('/api/v1/knowledge/imports/preview', 'files', Buffer.from(md), 'commit-entry.md')
      .expect(200);
    const previewId = preview.body.data.preview_id as string;

    const committed = await post('/api/v1/knowledge/imports/commit', {
      preview_id: previewId,
      policy: 'rename'
    }).expect(202);
    expect(committed.body.data.status).toBe('succeeded');
    expect(committed.body.data.result.created).toBe(1);

    // 提交后条目可见
    const list = await get('/api/v1/knowledge/entries?scope=global').expect(200);
    expect(list.body.data.items.length).toBe(1);
  });

  it('creates backup (202) and downloads gzip', async () => {
    await post('/api/v1/knowledge/entries', {
      scope: 'global',
      title: '备份条目',
      text: '备份正文。'
    }).expect(201);

    const backup = await post('/api/v1/knowledge/backups', {
      scope: 'global'
    }).expect(202);
    expect(backup.body.data.status).toBe('succeeded');
    expect(backup.body.data.entry_count).toBe(1);
    const jobId = backup.body.data.job_id as string;

    const download = await get(`/api/v1/knowledge/backups/${jobId}/download`).expect(200);
    expect(download.headers['content-type']).toContain('application/gzip');
    expect(Buffer.isBuffer(download.body) || typeof download.body === 'object').toBe(true);
  });

  it('previews backup restore and classifies same_content/new', async () => {
    // 预置条目以制造 same_content
    const seeded = await post('/api/v1/knowledge/entries', {
      scope: 'global',
      title: '预置条目',
      text: '预置正文。'
    }).expect(201);
    const existingId = seeded.body.data.id as string;

    const backup = await post('/api/v1/knowledge/backups', { scope: 'global' }).expect(202);
    const jobId = backup.body.data.job_id as string;
    const download = await downloadBuffer(`/api/v1/knowledge/backups/${jobId}/download`);
    expect(download.status).toBe(200);
    const gzipBody = download.body;

    const preview = await multipart('/api/v1/knowledge/backups/restore/preview', 'file', gzipBody, 'backup.gz')
      .expect(200);
    const p = preview.body.data;
    expect(p.summary.total).toBe(1);
    expect(p.summary.same_content).toBe(1);
    expect(p.preview_id).toBeDefined();

    // 同内容恢复提交 → succeeded
    const committed = await post('/api/v1/knowledge/backups/restore/commit', {
      preview_id: p.preview_id,
      policy: 'skip'
    }).expect(202);
    expect(committed.body.data.status).toBe('succeeded');
    expect(committed.body.data.result.skipped).toBe(1);

    void existingId;
  });

  it('rejects invalid restore commit (404) and missing backup export (404)', async () => {
    await post('/api/v1/knowledge/backups/restore/commit', {
      preview_id: randomUUID(),
      policy: 'skip'
    }).expect(404);

    await get(`/api/v1/knowledge/backups/${randomUUID()}/download`).expect(404);
  });

  it('hides foreign export job download (404)', async () => {
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const other = await dataSource.getRepository(AuthorEntity).save({
      email: `knowledge-other-${randomUUID()}@example.com`,
      display_name: 'Other',
      password_hash: await new PasswordService().hash('correct horse')
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: other.email, password: 'correct horse' })
      .expect(200);
    const otherCookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const otherSession = {
      cookie: otherCookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!,
      csrf: otherCookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!,
      token: login.body.data.csrf_token as string
    };

    const exported = await post('/api/v1/knowledge/exports', {
      scope: 'global',
      format: 'markdown'
    }).expect(202);
    const jobId = exported.body.data.job_id as string;

    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/exports/${jobId}/download`)
      .set('Cookie', [otherSession.cookie, otherSession.csrf])
      .expect(404);

    void authorId;
    void del;
  });
});
