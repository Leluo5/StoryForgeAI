import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { requestIdSchema } from '@storyforge/contracts';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers['set-cookie'] as string[] | string | undefined;
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function requiredCookie(cookies: string[], name: string): string {
  const value = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  expect(value).toBeDefined();
  return value!;
}

describe('author session flow', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;

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
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    await dataSource.getRepository(AuthorEntity).save({
      email: 'author@example.com', display_name: 'M0 Author', password_hash: passwordHash
    });
  });

  afterAll(async () => {
    await app.close();
    await destroyTestDatabase(migrationDataSource);
  });

  it('rejects invalid input and credentials before creating a session', async () => {
    const invalid = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'bad', password: 'short' })
      .expect(422);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(invalid.body.error.details.fields.email).toBeDefined();
    expect(requestIdSchema.safeParse(invalid.body.request_id).success).toBe(true);

    const wrong = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'author@example.com', password: 'wrong password' })
      .expect(401);
    expect(wrong.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    expect(setCookies(wrong)).toEqual([]);

    const anonymous = await request(app.getHttpServer()).get('/api/v1/auth/session').expect(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');
  });

  it('logs in, restores, enforces CSRF, revokes and never stores the raw token', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'author@example.com', password: 'correct horse' })
      .expect(200);
    const cookies = setCookies(login);
    const sessionSetCookie = requiredCookie(cookies, 'storyforge_session');
    const csrfSetCookie = requiredCookie(cookies, 'storyforge_csrf');
    const sessionCookie = sessionSetCookie.split(';')[0]!;
    const csrfCookie = csrfSetCookie.split(';')[0]!;
    const rawToken = decodeURIComponent(sessionCookie.split('=')[1]!);
    const csrfToken = login.body.data.csrf_token as string;

    expect(login.body.data.author).toEqual({
      id: expect.any(String), email: 'author@example.com', display_name: 'M0 Author'
    });
    expect(JSON.stringify(login.body)).not.toContain(rawToken);
    expect(sessionSetCookie).toContain('HttpOnly');
    expect(sessionSetCookie).toContain('SameSite=Lax');
    expect(sessionSetCookie).toContain('Path=/');
    expect(csrfSetCookie).not.toContain('HttpOnly');
    expect(csrfSetCookie).toContain('SameSite=Lax');

    const { SessionEntity } = await import('../src/database/session.entity');
    const sessions = dataSource.getRepository(SessionEntity);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const stored = await sessions.findOneByOrFail({ token_hash: tokenHash });
    expect(stored.token_hash).not.toBe(rawToken);
    expect(stored.revoked_at).toBeNull();

    const restored = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', [sessionCookie, csrfCookie])
      .expect(200);
    expect(restored.body.data).toEqual({ author: login.body.data.author, csrf_token: csrfToken });

    const forbidden = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', [sessionCookie, csrfCookie])
      .expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    const logout = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', [sessionCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(logout.body.data).toEqual({ logged_out: true });
    expect(requiredCookie(setCookies(logout), 'storyforge_session')).toContain('Expires=Thu, 01 Jan 1970');
    expect(requiredCookie(setCookies(logout), 'storyforge_csrf')).toContain('Expires=Thu, 01 Jan 1970');

    const revoked = await sessions.findOneByOrFail({ token_hash: tokenHash });
    expect(revoked.revoked_at).toBeInstanceOf(Date);
    const { AuthService } = await import('../src/auth/auth.service');
    await expect(app.get(AuthService).logout(rawToken)).resolves.toBeUndefined();

    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', [sessionCookie, csrfCookie])
      .expect(401);
  });
});
