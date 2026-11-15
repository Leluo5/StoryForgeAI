import { resolve } from 'node:path';
import { config } from 'dotenv';
import type { DataSource } from 'typeorm';

config({ path: resolve(__dirname, '../../../.env') });

export const DEFAULT_TEST_DATABASE_URL = 'postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test';

export function assertTestDatabaseUrl(value: string): void {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, '');
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !database.endsWith('_test')) {
    throw new Error('Test database URL must use PostgreSQL and a database name ending in _test');
  }
}

export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  assertTestDatabaseUrl(value);
  return value;
}

function assertTestDataSource(dataSource: DataSource): void {
  const url = (dataSource.options as { url?: string }).url;
  if (!url) throw new Error('Test data source must be created from a PostgreSQL URL');
  assertTestDatabaseUrl(url);
}

async function dropAllTables(dataSource: DataSource): Promise<void> {
  assertTestDataSource(dataSource);
  await dataSource.query('DROP TABLE IF EXISTS chapter_changes CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS chapters CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS volumes CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS works CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS sessions CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS authors CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS migrations CASCADE');
}

export async function resetTestDatabase(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) await dataSource.initialize();
  await dropAllTables(dataSource);
  await dataSource.runMigrations();
}

export async function clearAuthTables(dataSource: DataSource): Promise<void> {
  assertTestDataSource(dataSource);
  await dataSource.query('TRUNCATE TABLE sessions, authors RESTART IDENTITY CASCADE');
}

export async function destroyTestDatabase(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) return;
  await dropAllTables(dataSource);
  await dataSource.destroy();
}
