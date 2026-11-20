import { defineConfig } from '@playwright/test';
import { e2eEnvironment } from './tests/e2e/e2e-env';

const e2e = e2eEnvironment();

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/playwright',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }]
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'pnpm --filter @storyforge/api start',
      url: 'http://127.0.0.1:3001/api/v1/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: e2e.databaseUrl,
        REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
        PORT: '3001',
        WEB_ORIGIN: 'http://127.0.0.1:5173',
        SESSION_TTL_SECONDS: '604800'
      }
    },
    {
      command: 'pnpm --filter @storyforge/web dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
