import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * P2 技术债棘轮 — 冻结当前债务水位,只允许下降:
 *  - >500 行源文件的精确体积上限(增长或新增超限文件即失败;拆分后同步下调);
 *  - `.catch(() => {})` 吞错计数上限;
 *  - any 存量白名单文件数上限(白名单在 scripts/any-baseline.json,新文件禁 any)。
 * 这不是风格洁癖:报告里"上下文压缩失败被吞掉→界面卡死在压缩中"就是吞错家族。
 */
const SRC = path.resolve(__dirname, '../../src')

// 现状水位(生成自 2026-09 wc -l)。改动这些文件后如体积变化,请先拆分/缩减再同步此表。
const LARGE_FILE_CAPS: Record<string, number> = {
  'modules/chat/tool-loop.ts': 931,
  'lib/document-extractor.ts': 888,
  'modules/documents/documents.router.ts': 833,
  'lib/pptx-extractor.ts': 733,
  'tools/edit-document-tool.ts': 732,
  'modules/shared/chat-context.ts': 673,
  'modules/approvals/approval.service.ts': 658,
  'modules/documents/markdown-export.ts': 648,
  'modules/chat/conversation-turn.ts': 642,
  'modules/research/research.router.ts': 597,
  'lib/deck-bytes.ts': 553,
  'modules/comments/comments.router.ts': 551,
  'tools/tool-registry.ts': 534,
  'modules/files/files.router.ts': 518,
  'modules/chat/chat-handler.ts': 514,
  'modules/knowledge/knowledge.router.ts': 506,
  'tools/medical-web-tools.ts': 504,
}
const MAX_EMPTY_CATCH = 48
const MAX_ANY_BASELINE_FILES = 139

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

describe('P2 债务棘轮 (server-ts src)', () => {
  const files = walk(SRC)

  test('>500 行源文件不得超过冻结体积,且不得新增超限文件', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = path.relative(SRC, file)
      const lines = lineCount(fs.readFileSync(file, 'utf-8'))
      const cap = LARGE_FILE_CAPS[rel]
      if (cap !== undefined) {
        if (lines > cap) offenders.push(`${rel}: ${lines} > cap ${cap}(需拆分后再同步基线)`)
      } else if (lines > 500) {
        offenders.push(`${rel}: ${lines} 行(新增大文件 — 请拆分或补基线并说明)`)
      }
    }
    expect(offenders, `大文件债务增长:\n${offenders.join('\n')}`).toEqual([])
  })

  test('吞错 `.catch(() => {})` 计数不增长', () => {
    let count = 0
    for (const file of files) {
      count += (fs.readFileSync(file, 'utf-8').match(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []).length
    }
    expect(count, '空 catch 吞错新增 — 至少写日志/注释说明为何安全').toBeLessThanOrEqual(MAX_EMPTY_CATCH)
  })

  test('any 存量白名单只减不增(新文件由 eslint no-explicit-any 拦截)', () => {
    const baseline = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../scripts/any-baseline.json'), 'utf-8')) as { files: string[] }
    expect(baseline.files.length).toBeLessThanOrEqual(MAX_ANY_BASELINE_FILES)
    // 白名单里的文件不允许伪造(路径必须在 src 下)
    for (const f of baseline.files) expect(f.startsWith('src/')).toBe(true)
  })
})
