import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup-cleanup.ts'],
    testTimeout: 10000,
    // #859: node:sqlite(Node 22+ 内置)— vite 5 的 builtin 清单没收录,
    // 会剥掉 node: 前缀当 npm 包解析而失败;显式声明 external 交给 node
    // 原生解析。
    server: { deps: { external: ['node:sqlite'] } },
    // #835: Prisma query-engine(原生模块)在 threads 池下的卸载竞态会
    // 随机 abort 整个 vitest 进程("failed to delete napi ref"/SIGABRT,
    // CI 偶发 exit 1) — Vitest 官方文档记载的已知问题,官方解法是 forks
    // 池(进程隔离,一个 fork 的 panic 不再炸掉全部文件)。fileParallelism
    // 已经是 false,串行下 forks 几乎无性能损失。
    pool: 'forks',
    // Tests share one SQLite file (file:./test.db). Run files sequentially so
    // globalSetup's DB reset and the "first registered user is admin" invariant
    // stay deterministic.
    fileParallelism: false,
    env: {
      DATABASE_URL: 'file:./test.db',
      // #859: 全部测试用 :memory:(CI 无 /data/db 写权限,显式注入消除
      // EACCES 噪音与打开路径差异)
      URL_CACHE_DB_PATH: ':memory:',
      TWIN_BASE_DIR: '.nexus/test-twins',
      SERVER_SECRET: 'test-secret',
      CORS_ALLOW_ORIGINS: '*',
      SERVER_PORT: '8001',
    },
  },
})
// TDD: test cases must be written before implementation
