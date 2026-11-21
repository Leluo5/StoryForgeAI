import { resolve } from 'node:path';
import { config } from 'dotenv';
import { z } from 'zod';

config({ path: resolve(__dirname, '../../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  DATABASE_URL: z.string().url().startsWith('postgresql://').default('postgresql://storyforge:storyforge@127.0.0.1:5433/storyforge'),
  REDIS_URL: z.string().url().startsWith('redis://').default('redis://127.0.0.1:6380'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(2_592_000).default(604_800),
  ARKCLAW_A2A_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional()
  ),
  // ── F11 多平台 Agent 协同（全部 optional：未配置即对应能力 configured=false） ──
  FLOWISE_BASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  FLOWISE_API_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  FASTGPT_BASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  FASTGPT_API_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  FASTGPT_DATASET_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  FASTGPT_SEARCH_PATH: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).default('/api/core/dataset/searchTest')),
  COZE_API_BASE: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  COZE_PAT: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  COZE_BOT_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  N8N_ARCHIVE_WEBHOOK_URL: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  N8N_ARCHIVE_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  COLLAB_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  COLLAB_MAX_CITATIONS: z.coerce.number().int().positive().default(8),
  COLLAB_ARCHIVE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5)
});

export const env = envSchema.parse(process.env);
