import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * #701 — (prisma as any) 类型债防复发。
 * 生成的 PrismaClient 已含全部模型类型(node_modules/.prisma/client),
 * `as any` 只会掩盖字段改名/模型删除(本测试捕获的 4 个真实潜伏 bug:
 * null 解引用/medicAction 不存在/status 字段不存在/memoryGraphNode 已删)。
 * 规则:src 下禁止 `prisma as any` / `prisma as unknown`。
 */
const FORBIDDEN_RE = /\bprisma\s+as\s+(any|unknown)\b/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('#701 prisma 类型债防复发', () => {
  test('src 下无 (prisma as any) / (prisma as unknown)', () => {
    const files = walk(path.resolve(__dirname, '../../src'))
    const offenders: string[] = []
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8')
      if (FORBIDDEN_RE.test(s)) offenders.push(path.relative(path.resolve(__dirname, '../..'), f))
    }
    expect(offenders).toEqual([])
  })
})
