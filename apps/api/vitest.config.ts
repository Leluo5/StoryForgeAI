import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // e2e 共用同一个真实 PostgreSQL：必须串行执行，避免并发 reset/truncate 互相破坏
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } }
  }
});
