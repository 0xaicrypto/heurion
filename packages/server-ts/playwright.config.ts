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
    // Staging serves web UI + API on port 8002 (via @fastify/static SPA fallback).
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8002',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
