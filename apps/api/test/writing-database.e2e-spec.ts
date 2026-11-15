import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataSource } from '../src/database/data-source';
import { destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

let testDataSource: DataSource;

describe('writing schema', () => {
  beforeAll(async () => {
    testDataSource = createDataSource(testDatabaseUrl());
    await resetTestDatabase(testDataSource);
  });
  afterAll(async () => {
    await destroyTestDatabase(testDataSource);
  });

  it('creates all writing tables, checks and idempotency indexes', async () => {
    const rows = await testDataSource.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('works','volumes','chapters','chapter_changes') ORDER BY table_name"
    );
    expect(rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'chapter_changes', 'chapters', 'volumes', 'works'
    ]);
    const indexes = await testDataSource.query(
      "SELECT indexname FROM pg_indexes WHERE tablename='chapter_changes' AND indexname IN ('uq_chapter_client_sequence','uq_chapter_change_id') ORDER BY indexname"
    );
    expect(indexes.map((row: { indexname: string }) => row.indexname)).toEqual([
      'uq_chapter_change_id', 'uq_chapter_client_sequence'
    ]);
    expect(testDataSource.options.synchronize).toBe(false);
    expect(testDatabaseUrl()).toMatch(/\/[^/]+_test(?:\?|$)/);
  });
});
