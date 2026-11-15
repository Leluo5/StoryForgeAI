import '../config/env';
import { z } from 'zod';
import { createDataSource } from '../database/data-source';
import { AuthorEntity } from '../database/author.entity';
import { PasswordService } from './password.service';

const bootstrapEnvSchema = z.object({
  AUTHOR_EMAIL: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
  AUTHOR_DISPLAY_NAME: z.string().trim().min(1).max(80),
  AUTHOR_PASSWORD: z.string().min(8).max(128)
});

export async function bootstrapAuthor(): Promise<void> {
  const input = bootstrapEnvSchema.parse(process.env);
  const dataSource = createDataSource();

  try {
    await dataSource.initialize();
    const passwordHash = await new PasswordService().hash(input.AUTHOR_PASSWORD);
    await dataSource.getRepository(AuthorEntity).createQueryBuilder()
      .insert()
      .values({
        email: input.AUTHOR_EMAIL,
        display_name: input.AUTHOR_DISPLAY_NAME,
        password_hash: passwordHash
      })
      .orUpdate(['display_name', 'password_hash'], ['email'])
      .execute();
    console.info(`bootstrap complete: ${input.AUTHOR_EMAIL}`);
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (require.main === module) {
  void bootstrapAuthor().catch(() => {
    console.error('bootstrap failed; check DATABASE_URL and AUTHOR_* environment variables');
    process.exitCode = 1;
  });
}
