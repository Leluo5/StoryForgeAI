import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

const PID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// M3c-2 T42 章节保存 pid 与哈希中立 e2e（真实 PostgreSQL）
describe('chapter pid and content hash (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };
  let authorId: string;
  let workId: string;
  let chapterId: string;

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
    const [{ AuthorEntity }, { PasswordService }, { WorkService }, { ChapterEntity }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service'),
      import('../src/writing/work.service'),
      import('../src/database/chapter.entity')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const author = await dataSource.getRepository(AuthorEntity).save({
      email: `pid-author-${randomUUID()}@example.com`,
      display_name: 'Pid Author',
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

    workId = (await new WorkService(dataSource).create(authorId, { title: 'PID 作品', description: '' })).work.id;
    const chapter = await dataSource.getRepository(ChapterEntity).findOneByOrFail({ work_id: workId });
    chapterId = chapter.id;
  }

  const get = (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', [session.cookie, session.csrf]);
  const post = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);

  function insertTextStep(text: string, from = 1): Record<string, unknown> {
    return {
      stepType: 'replace',
      from,
      to: from,
      slice: { content: [{ type: 'text', text }] }
    };
  }

  async function fetchDocument(): Promise<{ content: Array<{ attrs?: { pid?: string }; content?: unknown[] }> }> {
    const response = await get(`/api/v1/works/${workId}/chapters/${chapterId}`).expect(200);
    return response.body.data.document;
  }

  it('fills pids on save and hashes pid-neutral content', async () => {
    const saved = await post(`/api/v1/works/${workId}/chapters/${chapterId}/changes`, {
      change_id: randomUUID(),
      client_id: randomUUID(),
      sequence: 1,
      base_version: 0,
      operations: [insertTextStep('甲')]
    }).expect(200);

    expect(saved.body.data.server_version).toBe(1);
    const document = await fetchDocument();
    expect(document.content[0]?.attrs?.pid).toMatch(PID_PATTERN);

    const versions = await get(`/api/v1/works/${workId}/chapters/${chapterId}/versions`).expect(200);
    expect(versions.body.data.total).toBe(0);
  });

  it('keeps version and hash when a save only changes pid for identical text', async () => {
    await post(`/api/v1/works/${workId}/chapters/${chapterId}/changes`, {
      change_id: randomUUID(),
      client_id: randomUUID(),
      sequence: 1,
      base_version: 0,
      operations: [insertTextStep('甲')]
    }).expect(200);

    const stored = await dataSource
      .getRepository((await import('../src/database/chapter.entity')).ChapterEntity)
      .findOneByOrFail({ id: chapterId });
    const pid = (stored.document.content as Array<{ attrs?: { pid?: string } }>)[0]?.attrs?.pid;
    expect(pid).toMatch(PID_PATTERN);

    // 仅改写 pid 属性、文字不变：版本与哈希保持
    const second = await post(`/api/v1/works/${workId}/chapters/${chapterId}/changes`, {
      change_id: randomUUID(),
      client_id: randomUUID(),
      sequence: 1,
      base_version: 1,
      // 文字同内容替换：写入新的 pid 但正文文字不变
      operations: [{ stepType: 'replace', from: 1, to: 2, slice: { content: [{ type: 'text', text: '甲' }] } }]
    }).expect(200);

    expect(second.body.data.server_version).toBe(1);
    expect(second.body.data.content_hash).toBe(stored.content_hash);
    const after = await dataSource
      .getRepository((await import('../src/database/chapter.entity')).ChapterEntity)
      .findOneByOrFail({ id: chapterId });
    expect(after.version).toBe(1);
    expect(after.document).toEqual(stored.document);
  });

  it('rejects duplicated pids with duplicated_pids details', async () => {
    const pid = '11111111-1111-4111-8111-111111111111';
    const document = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { pid }, content: [{ type: 'text', text: '一' }] },
        { type: 'paragraph', attrs: { pid }, content: [{ type: 'text', text: '二' }] }
      ]
    };
    await dataSource.getRepository((await import('../src/database/chapter.entity')).ChapterEntity)
      .update({ id: chapterId }, { document });

    const response = await post(`/api/v1/works/${workId}/chapters/${chapterId}/changes`, {
      change_id: randomUUID(),
      client_id: randomUUID(),
      sequence: 1,
      base_version: 0,
      operations: [insertTextStep('x')]
    }).expect(422);

    expect(response.body.error.details.duplicated_pids).toEqual([pid]);
  });

  it('reads legacy snapshots without pids and restores pids on rollback', async () => {
    await post(`/api/v1/works/${workId}/chapters/${chapterId}/changes`, {
      change_id: randomUUID(),
      client_id: randomUUID(),
      sequence: 1,
      base_version: 0,
      operations: [insertTextStep('原始')]
    }).expect(200);

    const created = await post(`/api/v1/works/${workId}/chapters/${chapterId}/versions`, {}).expect(201);
    const versionNo = created.body.data.version_no as number;

    // 模拟旧快照：文档不带 pid
    const { VersionSnapshotEntity } = await import('../src/database/version-snapshot.entity');
    const snapshots = dataSource.getRepository(VersionSnapshotEntity);
    const snapshot = await snapshots.findOneByOrFail({ id: created.body.data.snapshot_id as string });
    await snapshots.update({ id: snapshot.id }, {
      document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '原始' }] }] }
    });

    const read = await get(`/api/v1/works/${workId}/chapters/${chapterId}/versions/${versionNo}`).expect(200);
    expect((read.body.data.snapshot.document.content as Array<{ attrs?: { pid?: string } }>)[0]?.attrs?.pid).toBeUndefined();

    const rollback = await post(
      `/api/v1/works/${workId}/chapters/${chapterId}/versions/${versionNo}/rollback`,
      {}
    ).expect(200);
    const confirmed = await post(
      `/api/v1/works/${workId}/revision-sets/${rollback.body.data.revision_set.id}/confirm-rollback`,
      {}
    ).expect(200);

    const document = confirmed.body.data.document as { content: Array<{ attrs?: { pid?: string }; content?: Array<{ text?: string }> }> };
    expect(document.content[0]?.attrs?.pid).toMatch(PID_PATTERN);
    expect(document.content[0]?.content?.[0]?.text).toBe('原始');
  });
});
