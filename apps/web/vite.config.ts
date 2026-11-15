import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true }
    }
  },
  build: {
    // 工作区契约包以 CommonJS 产物发布，pnpm 隔离布局下其真实路径不在 node_modules 内，
    // 需显式纳入 CommonJS 转换，Rollup 才能识别其具名导出。
    commonjsOptions: { include: [/node_modules/, /packages[\\/]contracts/] }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true
  }
});
