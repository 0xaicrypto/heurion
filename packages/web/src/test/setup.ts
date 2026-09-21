import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// 复审轮 5（CI 部署批次）: waitFor 默认 1s 在 CI（全量套件并行、机器慢）
// 时序敏感用例会超时抖动（#1095 集成场景 B 的回复经 accept→队列重放→
// attach 链路，微任务+渲染链在慢机可超 1s）。全库统一放宽到 5s — 真实
// 挂死的用例仍会被 20s testTimeout 兜底，等待上限不影响断言语义。
configure({ asyncUtilTimeout: 5000 });

// jsdom does not implement matchMedia; the theme store calls it at module
// load time (AppShell import), so provide a no-op implementation globally.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// zustand persist (auth store) needs a working localStorage in jsdom.
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.setItem !== 'function') {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    },
  });
}
