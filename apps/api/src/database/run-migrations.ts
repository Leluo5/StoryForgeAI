import { createDataSource } from './data-source';

export async function runMigrations(): Promise<void> {
  const dataSource = createDataSource();

  try {
    await dataSource.initialize();
    const executed = await dataSource.runMigrations();
    console.info(
      executed.length === 0
        ? 'No migrations are pending'
        : `migrations complete: ${executed.map((migration) => migration.name).join(', ')}`
    );
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (require.main === module) {
  void runMigrations().catch(() => {
    console.error('migration run failed; check DATABASE_URL');
    process.exitCode = 1;
  });
}
