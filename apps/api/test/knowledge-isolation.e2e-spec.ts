// M3c-3 T40 知识库权限与边界回归 —— 作品间 / 作者间数据隔离（真实 PostgreSQL）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §7、§12.1；03-任务规划.md T40（D28/D29/D30）
// 覆盖（D30）：
//   - 作者 B 不能读 / 改 / 删 / 关联作者 A 的条目（越权一律 404 隐藏，不泄露存在性）
//   - 作者 B 列举作品 A 的作品库 → 404（作品归属校验）
//   - global 与 work 数据互不串扰：跨作者不互见；同作者 global 列表不含其 work 条目，反之亦然
// D28（无 OCR）、D29（无 Agent 工具）由代码审计 + git grep 取证，见 03-任务规划.md T40 执行状态。
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

interface Session {
  cookie: string;
  csrf: string;
  token: string;
}
interface Principal {
  session: Session;
  authorId: string;
  workId: string;
}

describe('knowledge isolation (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let A: Principal;
  let B: Principal;

  const entriesUrl = '/api/v1/knowledge/entries';
  const linksUrl = '/api/v1/knowledge/links';

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
    A = await bootstrap('a');
    B = await bootstrap('b');
  });

  afterAll(async () => {
    await app.close();
    await destroyTestDatabase(migrationDataSource);
  });

  async function bootstrap(label: string): Promise<Principal> {
    const [{ AuthorEntity }, { PasswordService }, { WorkService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service'),
      import('../src/writing/work.service')
    ]);
    const author = await dataSource.getRepository(AuthorEntity).save({
      email: `kb-iso-${label}-${randomUUID()}@example.com`,
      display_name: `Iso ${label}`,
      password_hash: await new PasswordService().hash('correct horse')
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: author.email, password: 'correct horse' })
      .expect(200);
    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const session: Session = {
      cookie: cookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!,
      csrf: cookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!,
      token: login.body.data.csrf_token as string
    };
    const work = await new WorkService(dataSource).create(author.id, {
      title: `隔离作品 ${label}`,
      description: ''
    });
    return { session, authorId: author.id, workId: work.work.id };
  }

  function withSession(p: Principal) {
    const get = (url: string) =>
      request(app.getHttpServer()).get(url).set('Cookie', [p.session.cookie, p.session.csrf]);
    const post = (url: string, body: unknown = {}) =>
      request(app.getHttpServer())
        .post(url)
        .set('Cookie', [p.session.cookie, p.session.csrf])
        .set('x-csrf-token', p.session.token)
        .send(body as object);
    const put = (url: string, body: unknown = {}) =>
      request(app.getHttpServer())
        .put(url)
        .set('Cookie', [p.session.cookie, p.session.csrf])
        .set('x-csrf-token', p.session.token)
        .send(body as object);
    const del = (url: string) =>
      request(app.getHttpServer())
        .delete(url)
        .set('Cookie', [p.session.cookie, p.session.csrf])
        .set('x-csrf-token', p.session.token);
    return { get, post, put, del };
  }

  async function createEntry(p: Principal, scope: 'global' | 'work', text: string): Promise<string> {
    const { post } = withSession(p);
    const body: Record<string, unknown> = { scope, text };
    if (scope === 'work') body.work_id = p.workId;
    const r = await post(entriesUrl, body).expect(201);
    return r.body.data.id as string;
  }

  it('hides cross-author entries from detail / update / delete (404, no existence leak)', async () => {
    const aGlobal = await createEntry(A, 'global', 'A 的全局条目');
    const aWork = await createEntry(A, 'work', 'A 的作品条目');
    const b = withSession(B);

    // 读：越权一律 404（不区分 403，避免泄露存在性）
    await b.get(`${entriesUrl}/${aGlobal}`).expect(404);
    await b.get(`${entriesUrl}/${aWork}`).expect(404);
    // 改 / 删：越权 404
    await b.put(`${entriesUrl}/${aGlobal}`, { text: '篡改' }).expect(404);
    await b.del(`${entriesUrl}/${aWork}`).expect(404);

    // A 自己仍可正常读到（证明条目确实存在，只是对 B 隐藏）
    const a = withSession(A);
    await a.get(`${entriesUrl}/${aGlobal}`).expect(200);
    await a.get(`${entriesUrl}/${aWork}?work_id=${A.workId}`).expect(200);
  });

  it('rejects listing another author’s work library (404) and excludes cross-author global entries', async () => {
    await createEntry(A, 'global', 'A 全局唯一');
    await createEntry(A, 'work', 'A 作品唯一');
    const b = withSession(B);

    // 列举 A 的作品库：作品不归 B → 404
    await b.get(`${entriesUrl}?scope=work&work_id=${A.workId}`).expect(404);
    // B 的全局库：不含 A 的全局条目（跨作者不串扰）
    const bGlobal = await b.get(`${entriesUrl}?scope=global`).expect(200);
    const bTexts: string[] = (bGlobal.body.data?.items ?? []).map((it: { excerpt?: string }) => it.excerpt ?? '');
    expect(bTexts).not.toContain('A 全局唯一');
  });

  it('rejects cross-author linking (reference) with 404', async () => {
    const aGlobal = await createEntry(A, 'global', 'A 关联源');
    const aTarget = await createEntry(A, 'global', 'A 关联目标');
    const b = withSession(B);
    // B 试图把自己的条目关联到 A 的条目，或把 A 的条目作为源 → 越权 404
    await b.post(linksUrl, { source_entry_id: aGlobal, target_entry_id: aTarget }).expect(404);
  });

  it('does not crosstalk global vs work within the same owner', async () => {
    await createEntry(A, 'global', '仅全局');
    await createEntry(A, 'work', '仅作品');
    const a = withSession(A);

    const globalList = await a.get(`${entriesUrl}?scope=global`).expect(200);
    const globalTexts: string[] = (globalList.body.data?.items ?? []).map((it: { excerpt?: string }) => it.excerpt ?? '');
    expect(globalTexts).toContain('仅全局');
    expect(globalTexts).not.toContain('仅作品');

    const workList = await a.get(`${entriesUrl}?scope=work&work_id=${A.workId}`).expect(200);
    const workTexts: string[] = (workList.body.data?.items ?? []).map((it: { excerpt?: string }) => it.excerpt ?? '');
    expect(workTexts).toContain('仅作品');
    expect(workTexts).not.toContain('仅全局');
  });
});
