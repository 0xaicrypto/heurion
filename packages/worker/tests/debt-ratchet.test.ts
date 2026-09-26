import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * P2 技术债棘轮 (worker) — 冻结当前吞错水位,只允许下降。
 * worker 执行面目前无 >500 行源文件;新增大文件同样失败。
 */
const SRC = path.resolve(__dirname, '../src')
const MAX_EMPTY_CATCH = 5
const MAX_FILE_LINES = 500

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

function lineCount(content: string): number {
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length
}

describe('P2 债务棘轮 (worker src)', () => {
  const files = walk(SRC)

  test('无 >500 行源文件(新增大文件先拆分)', () => {
    const offenders = files
      .map((f) => ({ rel: path.relative(SRC, f), lines: lineCount(fs.readFileSync(f, 'utf-8')) }))
      .filter((x) => x.lines > MAX_FILE_LINES)
      .map((x) => `${x.rel}: ${x.lines}`)
    expect(offenders, `大文件:\n${offenders.join('\n')}`).toEqual([])
  })

  test('吞错 `.catch(() => {})` 计数不增长', () => {
    let count = 0
    for (const file of files) {
      count += (fs.readFileSync(file, 'utf-8').match(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []).length
    }
    expect(count).toBeLessThanOrEqual(MAX_EMPTY_CATCH)
  })
})
