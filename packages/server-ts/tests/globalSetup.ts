import { execSync } from 'child_process'
import { unlinkSync, renameSync } from 'fs'

export function setup() {
  // Move .env aside so vitest env vars take priority
  try { renameSync('./.env', './.env.test-bak') } catch {}

  try { unlinkSync('./test.db') } catch {}
  try { unlinkSync('./test.db-journal') } catch {}
  execSync('DATABASE_URL=file:./test.db npx prisma db push --accept-data-loss --skip-generate 2>/dev/null', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
  })
}

export function teardown() {
  try { renameSync('./.env.test-bak', './.env') } catch {}
}
