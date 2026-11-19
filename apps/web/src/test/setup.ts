import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Node 22 的 localStorage 是实验性特性，vitest jsdom 环境可能未挂到 global
// 兜底：如果 jsdom 和 Node 内置都没有，就用一个内存 Storage 实现
function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.has(key) ? store.get(key)! : null; },
    key(index: number) { return [...store.keys()][index] ?? null; },
    removeItem(key: string) { store.delete(key); },
    setItem(key: string, value: string) { store.set(key, value); },
  };
}

// vitest 用 jsdom 环境，localStorage 应在 jsdom 的 window 上
const g = globalThis as unknown as Record<string, unknown>;
const win = g.window as { localStorage?: Storage; sessionStorage?: Storage } | undefined;

if (!g.localStorage) {
  g.localStorage = win?.localStorage ?? makeStorage();
}
if (!g.sessionStorage) {
  g.sessionStorage = win?.sessionStorage ?? makeStorage();
}

afterEach(() => {
  cleanup();
});
