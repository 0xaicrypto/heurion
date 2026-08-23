import dotenv from 'dotenv'
dotenv.config()

// #655/#441: env is read lazily, never frozen at import time. Values resolve
// on FIRST ACCESS and are cached for the process lifetime — importing this
// module has zero side effects on env parsing, and configuration injected
// after import (CI, tests via vi.stubEnv) is respected.
function lazyConfig<T extends Record<string, unknown>>(read: () => T): T {
  let resolved: T | null = null
  return new Proxy({} as T, {
    get(_target, prop) {
      if (!resolved) resolved = read()
      return resolved[prop as keyof T]
    },
  })
}

export const config = lazyConfig(() => ({
  port: parseInt(process.env.SERVER_PORT || '8001'),
  host: process.env.SERVER_HOST || '0.0.0.0',
  secret: process.env.SERVER_SECRET || 'dev-secret-key',
  environment: process.env.ENVIRONMENT || 'development',
  jwtAlgorithm: 'HS256' as const,
  jwtExpirationHours: parseInt(process.env.JWT_EXPIRATION_HOURS || '24'),
  databaseUrl: process.env.DATABASE_URL || 'file:./nexus_server.db',
  corsAllowOrigins: (process.env.CORS_ALLOW_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(','),
}))
