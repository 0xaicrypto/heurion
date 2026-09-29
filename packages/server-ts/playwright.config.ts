/**
 * Playwright configuration for Heurion E2E tests
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 30000,
  expect: { timeout: 10000 },
  retries: 1,
  use: {
    // 本地实例同时服务 web UI + API（@fastify/static SPA fallback）。
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8001',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
