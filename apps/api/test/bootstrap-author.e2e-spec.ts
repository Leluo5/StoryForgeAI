import type { DataSource } from 'typeorm';
import type { PasswordService } from '../src/auth/password.service';
import { assertTestDatabaseUrl, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const BOOTSTRAP_EMAIL = 'bootstrap-author@example.com';
const BOOTSTRAP_PASSWORD = 'bootstrap-password';
const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  AUTHOR_EMAIL: process.env.AUTHOR_EMAIL,
  AUTHOR_DISPLAY_NAME: process.env.AUTHOR_DISPLAY_NAME,
  AUTHOR_PASSWORD: process.env.AUTHOR_PASSWORD
};

type AuthorRow = { email: string; display_name: string; password_hash: string };

describe('bootstrap author command', () => {
  let dataSource: DataSource;
  let bootstrapAuthor: typeof import('../src/auth/bootstrap-author').bootstrapAuthor;
  let passwordService: PasswordService;

  beforeAll(async () => {
    // 必须在加载 config/env 之前覆盖，确保引导命令连接 _test 库而不是开发库。
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.AUTHOR_EMAIL = BOOTSTRAP_EMAIL;
    process.env.AUTHOR_DISPLAY_NAME = 'Bootstrap Author';
    process.env.AUTHOR_PASSWORD = BOOTSTRAP_PASSWORD;

    const [{ bootstrapAuthor: author }, passwordModule, { env }, { createDataSource }] = await Promise.all([
      import('../src/auth/bootstrap-author'),
      import('../src/auth/password.service'),
      import('../src/config/env'),
      import('../src/database/data-source')
    ]);
    assertTestDatabaseUrl(env.DATABASE_URL);

    bootstrapAuthor = author;
    passwordService = new passwordModule.PasswordService();

    dataSource = createDataSource(testDatabaseUrl());
    await resetTestDatabase(dataSource);
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.AUTHOR_EMAIL = originalEnv.AUTHOR_EMAIL;
    process.env.AUTHOR_DISPLAY_NAME = originalEnv.AUTHOR_DISPLAY_NAME;
    process.env.AUTHOR_PASSWORD = originalEnv.AUTHOR_PASSWORD;
    await destroyTestDatabase(dataSource);
  });

  it('creates one Argon2id author and stays idempotent on re-run', async () => {
    await bootstrapAuthor();
    await bootstrapAuthor();

    const rows: AuthorRow[] = await dataSource.query(
      'SELECT email, display_name, password_hash FROM authors WHERE email = $1',
      [BOOTSTRAP_EMAIL]
    );

    expect(rows).toHaveLength(1);
    const [author] = rows;
    expect(author?.email).toBe(BOOTSTRAP_EMAIL);
    expect(author?.display_name).toBe('Bootstrap Author');
    expect(author?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(author?.password_hash).not.toContain(BOOTSTRAP_PASSWORD);
    expect(author === undefined ? false : await passwordService.verify(author.password_hash, BOOTSTRAP_PASSWORD)).toBe(true);
  });

  it('rejects a password shorter than 8 characters without touching the database', async () => {
    const before: AuthorRow[] = await dataSource.query('SELECT email, password_hash FROM authors ORDER BY email');
    process.env.AUTHOR_PASSWORD = 'short';

    await expect(bootstrapAuthor()).rejects.toThrow();
    const after: AuthorRow[] = await dataSource.query('SELECT email, password_hash FROM authors ORDER BY email');
    expect(after).toEqual(before);
  });
});
