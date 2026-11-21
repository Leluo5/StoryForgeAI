import { Client } from 'pg';
import { TEST_DATABASE_ADVISORY_LOCK_KEY, testDatabaseUrl } from './test-database';

export default async function setup(): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [...TEST_DATABASE_ADVISORY_LOCK_KEY]);
  } catch (error) {
    await client.end();
    throw error;
  }

  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [...TEST_DATABASE_ADVISORY_LOCK_KEY]);
    } finally {
      await client.end();
    }
  };
}
