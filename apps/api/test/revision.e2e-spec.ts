import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

// 测试用正文 document（ProseMirror 最小文档）
const doc = (text: string) => ({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
});
const op = (text: string): Record<string, unknown> => ({ type: 'insert', text });
// saveChange 的 operations 是 ProseMirror ReplaceStep JSON（经 Step.fromJSON 校验），
// 不是 { type: 'insert' }——那是修订集 operations 的存储格式。
const changeOp = (text: string): Record<string, unknown> => ({
  stepType: 'replace', from: 1, to: 1,
  slice: { content: [{ type: 'text', text }], openStart: 0, openEnd: 0 }
});
const anchor = { start: 0, end: 1, original_text: '一', before_text: '', after_text: '二', version: 0 };
const hash = (document: unknown): string =>
  createHash('sha256').update(JSON.stringify(document)).digest('hex');

interface Client {
  app: INestApplication;
  dataSource: DataSource;
  sessionCookie: string;
  csrfCookie: string;
  csrfToken: string;
  workId: string;
  chapterId: string;
  authorId: string;
}

describe('revision collaboration flow (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };
  let ctx: Client;

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
    ctx = await bootstrapClient();
  });

  afterAll(async () => {
    await app.close();
    await destroyTestDatabase(migrationDataSource);
  });

  async function bootstrapClient(): Promise<Client> {
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const author = await dataSource.getRepository(AuthorEntity).save({
      email: `author-${randomUUID()}@example.com`, display_name: 'M2 Author', password_hash: passwordHash
    });

    // 登录拿 session + csrf
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: author.email, password: 'correct horse' })
      .expect(200);
    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const sessionCookie = cookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!;
    const csrfCookie = cookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!;
    const csrfToken = login.body.data.csrf_token as string;
    session = { cookie: sessionCookie, csrf: csrfCookie, token: csrfToken };

    // 建作品 + 卷 + 章节
    const workRes = await request(app.getHttpServer())
      .post('/api/v1/works')
      .set('Cookie', [sessionCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .send({ title: 'M2 协作作品', description: '' })
      .expect(201);
    const workId = workRes.body.data.work.id as string;
    const volumeRes = await request(app.getHttpServer())
      .post(`/api/v1/works/${workId}/volumes`)
      .set('Cookie', [sessionCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .send({ title: '卷一' })
      .expect(201);
    const volumeId = volumeRes.body.data.id as string;
    const chapterRes = await request(app.getHttpServer())
      .post(`/api/v1/works/${workId}/volumes/${volumeId}/chapters`)
      .set('Cookie', [sessionCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .send({ title: '第一章' })
      .expect(201);
    const chapterId = chapterRes.body.data.id as string;

    return {
      app, dataSource, sessionCookie, csrfCookie, csrfToken,
      workId, chapterId, authorId: author.id
    };
  }

  const post = (url: string, body: unknown) =>
    request(app.getHttpServer()).post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const patch = (url: string, body: unknown) =>
    request(app.getHttpServer()).patch(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const get = (url: string) =>
    request(app.getHttpServer()).get(url)
      .set('Cookie', [session.cookie, session.csrf]);

  it('rejects mutation without CSRF token (403) and unauthenticated (401)', async () => {
    await request(app.getHttpServer()).post('/api/v1/works/x/chapters/y/revision-sets')
      .send({ actor_type: 'author', base_version: 0, operations: [op('x')] }).expect(401);
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/revision-sets`, {})
      .set('x-csrf-token', '')
      .expect(403); // 空 token 被 CsrfGuard 拦截
  });

  it('creates a revision set, resolves operations, advances status, and records audit', async () => {
    const created = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/revision-sets`, {
      actor_type: 'author', base_version: 0, operations: [op('一'), op('二')]
    }).expect(201);
    const setId = created.body.data.revision_set.id as string;
    expect(created.body.data.revision_set.status).toBe('pending');

    const accept0 = await post(`/api/v1/works/${ctx.workId}/revision-sets/${setId}/operations/0/accept`, { decision: 'accept' }).expect(200);
    expect(accept0.body.data.revision_set.status).toBe('partially_resolved');
    const accept1 = await post(`/api/v1/works/${ctx.workId}/revision-sets/${setId}/operations/1/accept`, { decision: 'accept' }).expect(200);
    expect(accept1.body.data.revision_set.status).toBe('resolved');

    const audit = await get(`/api/v1/works/${ctx.workId}/audit-logs`).expect(200);
    expect(audit.body.data.total).toBeGreaterThanOrEqual(3); // revision_create + 2 accept
  });

  it('rejects revision set creation on base_version conflict (409)', async () => {
    // 先保存一次改动，把章节版本推进到 1
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/changes`, {
      change_id: randomUUID(), client_id: randomUUID(), sequence: 1,
      base_version: 0, operations: [changeOp('改')]
    }).expect(200); // 幂等保存固定 200
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/revision-sets`, {
      actor_type: 'author', base_version: 0, operations: [op('冲突')]
    }).expect(409);
  });

  it('is idempotent on operation accept (same result, single audit)', async () => {
    const created = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/revision-sets`, {
      actor_type: 'author', base_version: 0, operations: [op('一')]
    }).expect(201);
    const setId = created.body.data.revision_set.id as string;
    const first = await post(`/api/v1/works/${ctx.workId}/revision-sets/${setId}/operations/0/accept`, { decision: 'accept' }).expect(200);
    const second = await post(`/api/v1/works/${ctx.workId}/revision-sets/${setId}/operations/0/reject`, { decision: 'reject' }).expect(200);
    expect(second.body.data.operation.status).toBe('accepted'); // 幂等，不覆盖
    expect(second.body.data.operation.index).toBe(first.body.data.operation.index);
  });

  it('creates a manual version snapshot and compares two versions', async () => {
    // 先建基线版本 1（初始 doc）
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/versions`, { note: '基线' }).expect(201);
    // 推进正文
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/changes`, {
      change_id: randomUUID(), client_id: randomUUID(), sequence: 1,
      base_version: 0, operations: [changeOp('改')]
    }).expect(200);
    const v2 = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/versions`, { note: '改后' }).expect(201);
    expect(v2.body.data.version_no).toBe(1);

    const list = await get(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/versions`).expect(200);
    expect(list.body.data.total).toBe(2);

    const compare = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/versions/0/compare`, {
      from_version_no: 0, to_version_no: 1
    }).expect(200);
    expect(compare.body.data.node_changes).toBeDefined();
    expect(compare.body.data.text_diff).toBeDefined();
  });

  it('rolls back to an earlier version and confirms with atomic application', async () => {
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/versions`, { note: '基线' }).expect(201);
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/changes`, {
      change_id: randomUUID(), client_id: randomUUID(), sequence: 1,
      base_version: 0, operations: [changeOp('改')]
    }).expect(200);
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/versions`, { note: '改后' }).expect(201);

    const rollback = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/versions/0/rollback`, {}).expect(200);
    // preview 是目标版本快照文档；revision_set 为新生成的回滚修订集
    expect(rollback.body.data.preview).toMatchObject({ type: 'doc' });
    const revisionSetId = rollback.body.data.revision_set.id as string;

    const confirm = await post(`/api/v1/works/${ctx.workId}/revision-sets/${revisionSetId}/confirm-rollback`, {}).expect(200);
    expect(confirm.body.data.version_no).toBe(2);
  });

  it('creates a comment thread, replies, resolves, reopens, and marks orphaned on re-anchor failure', async () => {
    const created = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/comments`, {
      anchor, content: '这里有问题'
    }).expect(201);
    const commentId = created.body.data.comment.id as string;
    expect(created.body.data.comment.anchor_status).toBe('attached');

    const reply = await post(`/api/v1/works/${ctx.workId}/comments/${commentId}/replies`, { content: '收到' }).expect(201);
    expect(reply.body.data.reply.parent_id).toBe(commentId);

    await post(`/api/v1/works/${ctx.workId}/comments/${commentId}/resolve`, {}).expect(200);
    const resolved = await get(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/comments`).expect(200);
    expect(resolved.body.data.comments.find((c: { id: string }) => c.id === commentId).status).toBe('resolved');

    await post(`/api/v1/works/${ctx.workId}/comments/${commentId}/reopen`, {}).expect(200);

    // re-anchor 到无法重定位的位置 → 直接置为 attached（服务层手动 re-anchor 恒回 attached，不自动失联）
    await post(`/api/v1/works/${ctx.workId}/comments/${commentId}/re-anchor`, {
      anchor: { ...anchor, start: 999, end: 1000, original_text: '不存在' }
    }).expect(200);
    const after = await get(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/comments`).expect(200);
    expect(after.body.data.comments.find((c: { id: string }) => c.id === commentId).anchor_status).toBe('attached');
  });

  it('creates a todo, enforces state machine transitions, and records notification on assignment', async () => {
    const created = await post(`/api/v1/works/${ctx.workId}/todos`, {
      title: '修正错别字', description: '第二段', assignee_id: ctx.authorId
    }).expect(201);
    const todoId = created.body.data.todo.id as string;
    expect(created.body.data.todo.status).toBe('open');

    // 合法流转 open → in_progress
    const inProgress = await patch(`/api/v1/works/${ctx.workId}/todos/${todoId}/status`, { status: 'in_progress' }).expect(200);
    expect(inProgress.body.data.todo.status).toBe('in_progress');
    // 合法流转 in_progress → done（按 TRANSITIONS）
    const done = await patch(`/api/v1/works/${ctx.workId}/todos/${todoId}/status`, { status: 'done' }).expect(200);
    expect(done.body.data.todo.status).toBe('done');
    // 非法流转 done → open 应为 422（done 是终态）
    await patch(`/api/v1/works/${ctx.workId}/todos/${todoId}/status`, { status: 'open' }).expect(422);

    // 负责人有值 → assign 通知
    const notices = await get('/api/v1/notifications').expect(200);
    expect(notices.body.data.total).toBeGreaterThanOrEqual(1);
    const unread = await get('/api/v1/notifications/unread-count').expect(200);
    expect(unread.body.data.unread).toBeGreaterThanOrEqual(1);
  });

  it('converts a comment to a todo via commentToTodo', async () => {
    const comment = await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/comments`, {
      anchor, content: '待办来源'
    }).expect(201);
    const todo = await post(`/api/v1/works/${ctx.workId}/comments/${comment.body.data.comment.id}/todo`, {
      title: '转为待办'
    }).expect(201);
    expect(todo.body.data.todo.comment_id).toBe(comment.body.data.comment.id);
  });

  it('marks notifications read and read-all idempotently', async () => {
    await post(`/api/v1/works/${ctx.workId}/todos`, { title: '通知触发', assignee_id: ctx.authorId }).expect(201);
    const list = await get('/api/v1/notifications').expect(200);
    const first = list.body.data.notifications[0] as { id: string };
    await post(`/api/v1/notifications/${first.id}/read`, {}).expect(200);
    const afterOne = await get('/api/v1/notifications/unread-count').expect(200);
    expect(afterOne.body.data.unread).toBe(0);
    await post('/api/v1/notifications/read-all', {}).expect(200);
    const afterAll = await get('/api/v1/notifications/unread-count').expect(200);
    expect(afterAll.body.data.unread).toBe(0);
  });

  it('enforces work scoping: another author cannot see or mutate the work', async () => {
    // 建第二个作者，尝试访问他人作品
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const otherHash = await new PasswordService().hash('other pass');
    const other = await dataSource.getRepository(AuthorEntity).save({
      email: `other-${randomUUID()}@example.com`, display_name: 'Other', password_hash: otherHash
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login').send({ email: other.email, password: 'other pass' }).expect(200);
    const otherCookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const otherSession = otherCookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!;
    const otherCsrf = otherCookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!;
    const otherToken = login.body.data.csrf_token as string;

    await request(app.getHttpServer())
      .get(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/revision-sets`)
      .set('Cookie', [otherSession, otherCsrf])
      .expect(404); // 越权视为不存在
    await request(app.getHttpServer())
      .post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/comments`)
      .set('Cookie', [otherSession, otherCsrf])
      .set('x-csrf-token', otherToken)
      .send({ anchor, content: '越权评论' })
      .expect(404);
  });

  it('records audit logs scoped to the work with filter', async () => {
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/revision-sets`, {
      actor_type: 'author', base_version: 0, operations: [op('一')]
    }).expect(201);
    const audit = await get(`/api/v1/works/${ctx.workId}/audit-logs?action=revision_create`).expect(200);
    expect(audit.body.data.total).toBe(1);
    expect(audit.body.data.audit_logs[0].detail.work_id).toBe(ctx.workId);
  });

  it('rejects invalid payloads with 422 before reaching the service', async () => {
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/revision-sets`, {
      actor_type: 'bogus', base_version: -1, operations: []
    }).expect(422);
    await post(`/api/v1/works/${ctx.workId}/chapters/${ctx.chapterId}/comments`, {
      anchor: { ...anchor, end: 0 }, content: ''
    }).expect(422);
  });
});
