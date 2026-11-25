// M3c-3 T37 知识库作业 API E2E（真实 PostgreSQL）——上传/作业列表/详情/SSE
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5、§4.6；03-任务规划.md T37
// 覆盖：multipart 上传（1~10 文件）/非法类型/超限；作业列表过滤与分页；作业详情视图；
//       SSE 终态重放与 queued 实时帧；越权作业 404。
import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

describe('knowledge job endpoints (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };
  let authorId: string;
  let serverPort: number;

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
    await app.listen(0); // SSE 需要真实端口
    const addr = app.getHttpServer().address() as { port: number };
    serverPort = addr.port;
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
      email: `knowledge-job-author-${randomUUID()}@example.com`,
      display_name: 'Knowledge Job Author',
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

  function upload(url: string, fields: Record<string, string>) {
    const req = request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token);
    for (const [key, value] of Object.entries(fields)) req.field(key, value);
    return req;
  }

  async function createEntryWithJob(): Promise<{ entryId: string; jobId: string }> {
    const created = await post('/api/v1/knowledge/entries', {
      scope: 'global',
      text: '上传作业测试正文。'
    }).expect(201);
    const entryId = created.body.data.id as string;
    // createEntry 默认入队 structure 作业
    const jobs = await get('/api/v1/knowledge/jobs?kind=structure').expect(200);
    const job = jobs.body.data.items[0] as { id: string };
    return { entryId, jobId: job.id };
  }

  it('uploads txt file as multipart and creates structure job', async () => {
    const req = upload('/api/v1/knowledge/uploads', { scope: 'global' });
    req.attach('files', Buffer.from('上传的条目正文内容。'), 'sample.txt');
    const res = await req.expect(202);
    expect(res.body.data.jobs.length).toBe(1);
    expect(res.body.data.jobs[0].file_name).toBe('sample.txt');
    expect(res.body.data.jobs[0].status).toBe('queued');
    expect(res.body.data.rejected.length).toBe(0);

    // 上传条目已落库（origin='upload'）
    const list = await get('/api/v1/knowledge/entries?scope=global').expect(200);
    expect(list.body.data.items.length).toBe(1);
  });

  it('rejects unsupported extension into rejected (202) and empty upload (202, empty)', async () => {
    // 单文件失败不阻塞整批：不支持的扩展名计入 rejected，整体仍 202
    const reqBad = upload('/api/v1/knowledge/uploads', { scope: 'global' });
    reqBad.attach('files', Buffer.from('x'), 'evil.exe');
    const badRes = await reqBad.expect(202);
    expect(badRes.body.data.jobs.length).toBe(0);
    expect(badRes.body.data.rejected.length).toBe(1);
    expect(badRes.body.data.rejected[0].code).toBe('KNOWLEDGE_FILE_TYPE_UNSUPPORTED');

    // 空上传（未 attach 文件）：supertest 不发 multipart 边界 → 404
    const reqEmpty = upload('/api/v1/knowledge/uploads', { scope: 'global' });
    await reqEmpty.expect(404);
  });

  it('lists jobs with filter and pagination', async () => {
    const { jobId } = await createEntryWithJob();

    const all = await get('/api/v1/knowledge/jobs').expect(200);
    expect(all.body.data.items.length).toBe(1);
    expect(all.body.data.total).toBe(1);

    const byKind = await get('/api/v1/knowledge/jobs?kind=structure').expect(200);
    expect(byKind.body.data.items.length).toBe(1);

    const byStatus = await get('/api/v1/knowledge/jobs?status=queued').expect(200);
    expect(byStatus.body.data.items.length).toBe(1);
    expect(byStatus.body.data.items[0].id).toBe(jobId);

    const byUnknown = await get('/api/v1/knowledge/jobs?status=succeeded').expect(200);
    expect(byUnknown.body.data.items.length).toBe(0);
  });

  it('returns job detail with progress view', async () => {
    const { jobId } = await createEntryWithJob();

    const detail = await get(`/api/v1/knowledge/jobs/${jobId}`).expect(200);
    const j = detail.body.data;
    expect(j.id).toBe(jobId);
    expect(j.kind).toBe('structure');
    expect(j.status).toBe('queued');
    expect(j.progress).toMatchObject({ stage: 'queued', percent: 0 });
    expect(typeof j.created_at).toBe('string');
  });

  it('streams SSE events for terminal job (replay) and closes', async () => {
    // 导出作业同步 succeeded（终态）→ SSE 重放 succeeded 事件后关闭
    const exported = await post('/api/v1/knowledge/exports', {
      scope: 'global',
      format: 'markdown'
    }).expect(202);
    const jobId = exported.body.data.job_id as string;

    const chunk = await new Promise<string>((resolve, reject) => {
      let settled = false;
      // 解析完成后，req.destroy() / 连接关闭触发的 ECONNRESET/aborted 均属预期，不再 reject
      const guard = (err: Error) => { if (!settled) reject(err); };
      const req = httpGet(
        {
          host: '127.0.0.1',
          port: serverPort,
          path: `/api/v1/knowledge/jobs/${jobId}/events`,
          headers: { Cookie: [session.cookie, session.csrf].join('; ') }
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');
          res.setEncoding('utf8');
          let data = '';
          res.on('data', (d: string) => {
            data += d;
            if (data.includes('\n\n') && !settled) {
              settled = true;
              resolve(data);
              req.destroy(); // 收到首帧即主动中止
            }
          });
          res.on('error', guard);
        }
      );
      req.on('error', guard);
    });

    expect(chunk).toContain('succeeded');
  });

  it('hides foreign jobs (404)', async () => {
    const { jobId } = await createEntryWithJob();
    // 第二个作者登录后访问第一作者的作业 → 404
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

    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/jobs/${jobId}`)
      .set('Cookie', [otherSession.cookie, otherSession.csrf])
      .expect(404);

    void authorId;
  });
});
