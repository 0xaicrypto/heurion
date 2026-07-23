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
    baseURL: process.env.BASE_URL || 'http://localhost:8002',
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
