import { execSync } from 'child_process'
import { unlinkSync, renameSync, rmSync } from 'fs'

export function setup() {
  // #1146-followup: 测试用户 twins 目录每轮清空 — 历史累积曾达 15 万文件/
  // 782MB,把整套测试拖到 25 分钟以上(每文件 fs 创建/扫描爆炸)。
  try { rmSync('./.nexus/test-twins', { recursive: true, force: true }) } catch { /* best-effort */ }

  // Move .env aside so vitest env vars take priority
  try { renameSync('./.env', './.env.test-bak') } catch {}

  // Prisma resolves `file:./test.db` relative to the schema directory, so the
  // actual database lives at prisma/test.db. Delete it there to guarantee a
  // fresh DB (first registered user must be admin).
  try { unlinkSync('./prisma/test.db') } catch {}
  try { unlinkSync('./prisma/test.db-journal') } catch {}
  execSync('DATABASE_URL=file:./test.db npx prisma db push --accept-data-loss --skip-generate 2>/dev/null', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
  })
}

export function teardown() {
  try { renameSync('./.env.test-bak', './.env') } catch {}
}
