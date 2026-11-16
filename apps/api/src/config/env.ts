import { resolve } from 'node:path';
import { config } from 'dotenv';
import { z } from 'zod';

config({ path: resolve(__dirname, '../../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  DATABASE_URL: z.string().url().startsWith('postgresql://').default('postgresql://storyforge:storyforge@127.0.0.1:5433/storyforge'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(2_592_000).default(604_800)
});

export const env = envSchema.parse(process.env);
