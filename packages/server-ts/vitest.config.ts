import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    env: {
      DATABASE_URL: 'file:./test.db',
      TWIN_BASE_DIR: '.nexus/test-twins',
      DEEPSEEK_API_KEY: 'test-key',
      SERVER_SECRET: 'test-secret',
      CORS_ALLOW_ORIGINS: '*',
      SERVER_PORT: '8001',
    },
  },
})
