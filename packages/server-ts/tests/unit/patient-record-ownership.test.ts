import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * #936 — patientRecord 跨用户越权（IDOR）防复发。
 * 体检第七轮：report-pdf.service.ts 按 hash 查询漏 userId 过滤，
 * 是全库 15 处同类查询里唯一一处（路由仅 authGuard 登录校验）。
 * 规则：src 下所有 patientRecord 读写语句必须满足其一——
 *   a) 语句内直接带 userId 过滤（findFirst/findMany/extendedWhereUnique 等）；
 *   b) 归属守卫模式：同一函数内先经 findFirst({ where: { hash, userId } })
 *      + falsy 即返回，随后才允许 where 仅含主键 hash 的 update（hash 为 @id，
 *      update 的 where 无法再带 userId）。
 * 注：schema 中 hash 为全局唯一主键，update 只能按主键定位；
 *    extendedWhereUnique（Prisma 4.5+）允许 unique where 附带 userId。
 */
const QUERY_RE = /\bpatientRecord\s*\.\s*(findFirst|findUnique|findMany|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\s*\(/g
const GUARDED_RE = /findFirst\s*\(\s*\{\s*where:\s*\{\s*hash:\s*patientHash,\s*userId[\s\S]{0,80}if\s*\(\s*!patient\s*\)\s*return/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('#936 patientRecord 查询归属校验防复发', () => {
  test('src 下所有 patientRecord 读写语句均带 userId 过滤（或归属守卫）', () => {
    const files = walk(path.resolve(__dirname, '../../src'))
    const offenders: string[] = []
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8')
      for (const m of s.matchAll(QUERY_RE)) {
        const start = m.index!
        const stmt = s.slice(start, start + 1200)
        const guarded = GUARDED_RE.test(s.slice(Math.max(0, start - 2000), start + 200))
        if (!/userId/.test(stmt) && !guarded) {
          offenders.push(`${path.relative(path.resolve(__dirname, '../..'), f)}: ${m[0]}…`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('report 模块归属路径回归：查询使用 findFirst + userId', () => {
    const service = fs.readFileSync(
      path.resolve(__dirname, '../../src/modules/report/report-pdf.service.ts'),
      'utf8',
    )
    expect(service).toMatch(/patientRecord\s*\.\s*findFirst\(\{\s*where:\s*\{\s*hash:[^}]*userId/)
    expect(service).not.toMatch(/patientRecord\s*\.\s*findUnique/)
  })
})
