import 'dotenv/config';

const DEFAULT_TEST_DATABASE_URL = 'postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test';

function required(name: 'AUTHOR_EMAIL' | 'AUTHOR_DISPLAY_NAME' | 'AUTHOR_PASSWORD'): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required E2E environment variable: ${name}`);
  return value;
}

export function e2eEnvironment() {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must use a database name ending in _test');
  }

  const authorEmail = required('AUTHOR_EMAIL').trim().toLowerCase();
  const authorDisplayName = required('AUTHOR_DISPLAY_NAME').trim();
  const authorPassword = required('AUTHOR_PASSWORD');
  if (!authorEmail || !authorDisplayName) throw new Error('E2E author email and display name must not be blank');
  if (authorPassword.length < 8 || authorPassword.length > 128) {
    throw new Error('AUTHOR_PASSWORD must contain 8-128 characters');
  }

  return { databaseUrl, authorDisplayName, authorEmail, authorPassword };
}
