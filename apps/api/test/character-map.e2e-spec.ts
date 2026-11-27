import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

// M4-T8 AI 建图 e2e（真实 PostgreSQL）：发起建图 → 入队 scope=character_map → 查询任务状态
describe('character map (real PostgreSQL)', () => {
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
      email: `cmap-author-${randomUUID()}@example.com`,
      display_name: 'Map Author',
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
    workId = (await workService.create(authorId, { title: '建图作品', description: '' })).work.id;
  }

  const get = (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', [session.cookie, session.csrf]);
  const post = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);

  async function createCharacter(name: string): Promise<string> {
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
        status: 'active',
        merged_into_id: null,
        archived_at: null,
        archived_by: null,
        origin: 'manual',
        version: 1
      })
    );
    return saved.id;
  }

  it('requires session for generate (401)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/works/${workId}/character-map/generate`)
      .expect(401);
  });

  it('发起建图：202 返回 scope=character_map 任务，查询可见', async () => {
    await createCharacter('甲');
    await createCharacter('乙');

    const accepted = await post(`/api/v1/works/${workId}/character-map/generate`).expect(202);
    const aiTaskId = accepted.body.data.aiTaskId as string;
    expect(aiTaskId).toBeTruthy();

    const fetched = await get(`/api/v1/works/${workId}/character-map/tasks/${aiTaskId}`).expect(200);
    expect(fetched.body.data.id).toBe(aiTaskId);
    expect(fetched.body.data.scope).toBe('character_map');
  });

  it('作品不存在 → 404', async () => {
    await post(`/api/v1/works/${randomUUID()}/character-map/generate`).expect(404);
  });

  it('重复发起同作品：返回同一任务（幂等）', async () => {
    await createCharacter('甲');
    await createCharacter('乙');
    const first = await post(`/api/v1/works/${workId}/character-map/generate`).expect(202);
    const second = await post(`/api/v1/works/${workId}/character-map/generate`).expect(202);
    expect(second.body.data.aiTaskId).toBe(first.body.data.aiTaskId);
  });
});
