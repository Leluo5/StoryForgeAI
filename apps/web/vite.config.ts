import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // FastGPT 占用 127.0.0.1:3001，API 服务改到 3002
      '/api': { target: 'http://127.0.0.1:3002', changeOrigin: true }
    }
  },
  optimizeDeps: {
    // 工作区契约包是 CommonJS 产物且经 pnpm 链接解析到 node_modules 之外，
    // 必须显式预构建，否则浏览器会按 ESM 直接加载 dist 而丢失具名导出。
    include: ['@storyforge/contracts']
  },
  build: {
    // 工作区契约包以 CommonJS 产物发布，pnpm 隔离布局下其真实路径不在 node_modules 内，
    // 需显式纳入 CommonJS 转换，Rollup 才能识别其具名导出。
    commonjsOptions: { include: [/node_modules/, /packages[\\/]contracts/] },
    rollupOptions: {
      output: {
        // 手动拆包：体积稳定、变更频率低的第三方库单独成块，
        // 既缩小首屏主包，也让业务代码变更不会让整包缓存失效。
        manualChunks(id: string) {
          const path = id.replace(/\\/g, '/');
          if (path.includes('prosemirror') || path.includes('packages/editor-schema')) return 'vendor-editor';
          if (/\/(?:react|react-dom|react-router|react-router-dom|scheduler)\//.test(path)) return 'vendor-react';
          if (path.includes('/zod/') || path.includes('packages/contracts')) return 'vendor-contracts';
          return undefined;
        }
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    // fake-indexeddb 用 setImmediate 推进事务，若被假定时器接管会导致租约测试死锁
    fakeTimers: { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }
  }
});
