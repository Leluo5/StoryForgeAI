import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

// M3c-2 T27 锚点与扫描 e2e（真实 PostgreSQL）
describe('character anchors (real PostgreSQL)', () => {
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
      email: `anchor-author-${randomUUID()}@example.com`,
      display_name: 'Anchor Author',
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
    workId = (await workService.create(authorId, { title: '锚点作品', description: '' })).work.id;
    const chapter = await dataSource
      .getRepository(ChapterEntity)
      .findOneByOrFail({ work_id: workId });
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

  async function createCharacter(name: string, status: 'active' | 'archived' = 'active'): Promise<string> {
    const { CharacterEntity } = await import('../src/database/character.entity');
    const repo = dataSource.getRepository(CharacterEntity);
    const saved = await repo.save(
      repo.create({
        id: randomUUID(),
        work_id: workId,
        name,
        name_key: name.toLowerCase(),
        identity: null,
        age: 20,
        gender: '男',
        personality: '',
        experience: '',
        country_region: null,
        faith: null,
        faction: null,
        race: null,
        occupation: null,
        age_band: 'young',
        attributes: [],
        avatar_asset_id: null,
        status,
        merged_into_id: null,
        archived_at: status === 'archived' ? new Date() : null,
        archived_by: status === 'archived' ? authorId : null,
        origin: 'manual',
        version: status === 'archived' ? 2 : 1
      })
    );
    return saved.id;
  }

  async function setChapterParagraph(pid: string, text: string): Promise<string> {
    const { ChapterEntity } = await import('../src/database/chapter.entity');
    const document = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { pid }, content: [{ type: 'text', text }] }
      ]
    };
    await dataSource
      .getRepository(ChapterEntity)
      .update({ id: chapterId }, { document: document as never });
    return createHash('sha256').update(text).digest('hex').slice(0, 64);
  }

  async function createAnchor(input: {
    characterId: string;
    paragraphPid: string;
    excerpt: string;
    excerptHash: string;
    status?: 'active' | 'invalid';
    invalidReason?: 'pid_missing' | 'text_changed' | null;
  }): Promise<string> {
    const [{ CharacterTextAnchorEntity }, { CharacterArchiveScanEntity }] = await Promise.all([
      import('../src/database/character-text-anchor.entity'),
      import('../src/database/character-archive-scan.entity')
    ]);
    const scanRepo = dataSource.getRepository(CharacterArchiveScanEntity);
    let scan = await scanRepo.findOne({ where: { character_id: input.characterId } });
    if (!scan) {
      scan = await scanRepo.save(
        scanRepo.create({
          id: randomUUID(),
          work_id: workId,
          character_id: input.characterId,
          requested_by: authorId,
          status: 'succeeded',
          total_chapters: 0,
          scanned_chapters: 0,
          matched_paragraphs: 0,
          error: null,
          started_at: new Date(),
          finished_at: new Date()
        })
      );
    }
    const repo = dataSource.getRepository(CharacterTextAnchorEntity);
    const saved = await repo.save(
      repo.create({
        id: randomUUID(),
        work_id: workId,
        character_id: input.characterId,
        chapter_id: chapterId,
        scan_id: scan.id,
        paragraph_pid: input.paragraphPid,
        matched_name: '林昭',
        excerpt: input.excerpt,
        excerpt_hash: input.excerptHash,
        status: input.status ?? 'active',
        invalid_reason: input.invalidReason ?? null,
        dismissed_at: null,
        dismissed_by: null
      })
    );
    return saved.id;
  }

  async function waitForScans(): Promise<void> {
    const { CharacterArchiveScanEntity } = await import('../src/database/character-archive-scan.entity');
    const repo = dataSource.getRepository(CharacterArchiveScanEntity);
    for (let i = 0; i < 40; i += 1) {
      const pending = await repo.count({ where: { work_id: workId, status: 'pending' } });
      const running = await repo.count({ where: { work_id: workId, status: 'running' } });
      if (pending + running === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('requires session for role marks (401)', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/works/${workId}/chapters/${chapterId}/role-marks`)
      .expect(401);
  });

  it('returns active paragraph marks and invalid chapter marks', async () => {
    const pid = randomUUID();
    const text = '他在雨中站了很久。';
    const hash = await setChapterParagraph(pid, text);
    const archivedChar = await createCharacter('林昭', 'archived');
    await createAnchor({ characterId: archivedChar, paragraphPid: pid, excerpt: text, excerptHash: hash });
    const missingPid = randomUUID();
    await createAnchor({
      characterId: archivedChar,
      paragraphPid: missingPid,
      excerpt: '已删除段落',
      excerptHash: 'x'.repeat(64)
    });

    const response = await get(
      `/api/v1/works/${workId}/chapters/${chapterId}/role-marks`
    ).expect(200);
    const data = response.body.data;
    expect(data.paragraph_marks).toHaveLength(1);
    expect(data.paragraph_marks[0]).toMatchObject({
      paragraph_pid: pid,
      character_id: archivedChar,
      character_name: '林昭',
      status: 'active'
    });
    expect(data.paragraph_marks[0].excerpt_hash).toBeUndefined();
    expect(data.chapter_marks).toHaveLength(1);
    expect(data.chapter_marks[0]).toMatchObject({
      character_id: archivedChar,
      reason: 'pid_missing'
    });
    expect(data.scan.status).toBe('succeeded');
  });

  it('dismisses active anchors and rejects invalid ones with 409', async () => {
    const pid = randomUUID();
    const text = '风停了。';
    const hash = await setChapterParagraph(pid, text);
    const character = await createCharacter('林昭', 'archived');
    const activeId = await createAnchor({ characterId: character, paragraphPid: pid, excerpt: text, excerptHash: hash });
    const invalidId = await createAnchor({
      characterId: character,
      paragraphPid: randomUUID(),
      excerpt: '失效',
      excerptHash: 'y'.repeat(64),
      status: 'invalid',
      invalidReason: 'pid_missing'
    });
    const base = `/api/v1/works/${workId}/chapters/${chapterId}/role-marks`;

    const dismissed = await post(`${base}/dismiss-batch`, { anchor_ids: [activeId] }).expect(200);
    expect(dismissed.body.data).toEqual({ dismissed: 1, skipped: 0 });
    const again = await post(`${base}/dismiss-batch`, { anchor_ids: [activeId] }).expect(200);
    expect(again.body.data).toEqual({ dismissed: 0, skipped: 1 });
    await post(`${base}/dismiss-batch`, { anchor_ids: [invalidId] }).expect(409);

    const single = await post(`${base}/${activeId}/dismiss`, {}).expect(200);
    expect(single.body.data.dismissed).toBe(true);

    await post(`/api/v1/works/${randomUUID()}/chapters/${chapterId}/role-marks/dismiss-batch`, {
      anchor_ids: [activeId]
    }).expect(404);
  });

  it('rescans only archived characters (409 otherwise, 202 when archived)', async () => {
    const active = await createCharacter('活跃角色');
    await post(`/api/v1/works/${workId}/characters/${active}/archive-scans`).expect(409);

    const archived = await createCharacter('已归档角色', 'archived');
    const accepted = await post(`/api/v1/works/${workId}/characters/${archived}/archive-scans`).expect(202);
    expect(accepted.body.data.scan.status).toBe('pending');
    expect(accepted.body.data.scan.character_id).toBe(archived);
    await waitForScans();
  });
});
