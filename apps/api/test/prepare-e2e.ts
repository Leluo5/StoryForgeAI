import { createDataSource } from '../src/database/data-source';
import { AuthorEntity } from '../src/database/author.entity';
import { PasswordService } from '../src/auth/password.service';
import { resetTestDatabase } from './test-database';
import { e2eEnvironment } from '../../../tests/e2e/e2e-env';

export async function prepareE2eDatabase(): Promise<void> {
  const config = e2eEnvironment();
  const dataSource = createDataSource(config.databaseUrl);

  try {
    await resetTestDatabase(dataSource);
    const passwordHash = await new PasswordService().hash(config.authorPassword);
    await dataSource.getRepository(AuthorEntity).save({
      email: config.authorEmail,
      display_name: config.authorDisplayName,
      password_hash: passwordHash
    });
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (require.main === module) {
  void prepareE2eDatabase().catch(() => {
    console.error('E2E database preparation failed; check TEST_DATABASE_URL and AUTHOR_* environment variables');
    process.exitCode = 1;
  });
}
