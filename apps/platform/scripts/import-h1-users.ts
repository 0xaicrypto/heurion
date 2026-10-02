/**
 * 导入 1.0 的用户账户（见 src/auth/import-h1.ts）。默认只预演，加 --apply 才写入。
 *   pnpm --filter @heurion2/platform import-h1-users <1.0 的 SQLite 路径> [--apply]
 * 例：…/heurion/packages/server-ts/prisma/nexus_server.db
 */
import { importH1Users } from '../src/auth/import-h1.ts'
import { config } from '../src/config.ts'
import { Store } from '../src/store/db.ts'

const [path, flag] = process.argv.slice(2)
if (!path) {
  console.error('用法：import-h1-users <1.0 的 SQLite 路径> [--apply]')
  process.exit(2)
}
const apply = flag === '--apply'
const report = importH1Users(path, new Store(config.dbPath), apply)
console.log(`${apply ? '已导入' : '将导入（预演，加 --apply 写入）'} ${report.imported.length} 个账户`)
for (const u of report.imported) console.log(`  + ${u.username}（${u.role === 'admin' ? '管理员' : '普通用户'}${u.status === 'disabled' ? '，已停用' : ''}）`)
if (report.already.length) console.log(`之前已导入 ${report.already.length} 个：${report.already.join('、')}`)
if (report.conflicts.length) console.log(`用户名冲突（平台里已有同名用户，未覆盖）${report.conflicts.length} 个：${report.conflicts.join('、')}`)
for (const s of report.skipped) console.log(`  - 跳过 ${s.username}：${s.reason}`)
