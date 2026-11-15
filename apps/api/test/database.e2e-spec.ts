import type { DataSource } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import { AuthorEntity } from '../src/database/author.entity';
import { SessionEntity } from '../src/database/session.entity';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

describe('database migrations', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await resetTestDatabase(dataSource);
  });

  afterEach(async () => {
    await clearAuthTables(dataSource);
  });

  afterAll(async () => {
    await destroyTestDatabase(dataSource);
  });

  it('creates both tables, stays explicit and enforces unique token hashes', async () => {
    const result: Array<{ table_name: string }> = await dataSource.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('authors','sessions') ORDER BY table_name"
    );
    expect(result.map((row) => row.table_name)).toEqual(['authors', 'sessions']);
    expect(dataSource.options.synchronize).toBe(false);
    expect(await dataSource.showMigrations()).toBe(false);

    const author = await dataSource.getRepository(AuthorEntity).save({
      email: 'schema@example.com', display_name: 'Schema', password_hash: 'test-only-hash'
    });
    const sessions = dataSource.getRepository(SessionEntity);
    await sessions.save({
      author_id: author.id, token_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 60_000)
    });
    await expect(sessions.save({
      author_id: author.id, token_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 60_000)
    })).rejects.toThrow();
  });
});
