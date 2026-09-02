import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * #679 回归锁:ARCHITECTURE.md「分层规则」的机器可执行版。
 *
 * modules/X 不得 import modules/Y(peer 跨模块),例外表 peerEdges 是当前
 * 已接受的 feature 级编排依赖(chat → knowledge/plugins/evolution/…)。
 * 新增跨模块边必须先更新本表 + ARCHITECTURE.md 核查声明,否则测试失败 —
 * 防止「15+ 条 undocumented 边」再次静默累积。
 *
 * shared/ 是被 8+ 模块引用的事实共享层(user-context / chat-context /
 * chat.dto / chat-orchestrator),所有模块可直接引用;shared 自身不进
 * peer 校验(它只允许依赖 core/common/memory/knowledge service)。
 */

const MODULES_DIR = path.resolve(__dirname, '../../src/modules')

/** 已接受的跨模块边(from → 允许的 to 列表)。 */
const peerEdges: Record<string, string[]> = {
  chat: ['knowledge', 'plugins', 'evolution', 'patients', 'execution'],
  evolution: ['memorization', 'practitioner', 'chat'],
  files: ['ingestion', 'knowledge', 'execution'],
  ingestion: ['medical-records'],
  'medical-records': ['approvals'],
  research: ['knowledge'],
  calendar: ['research'],
  external: ['plugins', 'execution'],
  plugins: ['chat', 'execution'],
  memorization: ['chat'],
  patients: ['chat'],
  documents: ['chat'],
  skills: ['chat'],
  auth: ['chat'],
}

function listModuleFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  }
  walk(MODULES_DIR)
  return out
}

/** 静态 import 源里的跨模块目标(排除 shared 与相对同层)。 */
function crossModuleImports(src: string): Array<{ mod: string; target: string }> {
  const re = /from\s+['"]\.\.\/([a-z-]+)\/[a-z_.-]+\.js['"]/g
  const hits: Array<{ mod: string; target: string }> = []
  for (const m of src.matchAll(re)) hits.push({ mod: m[1], target: m[1] })
  return hits
}

describe('#679 模块分层规则', () => {
  test('peer 跨模块 import 必须在 peerEdges 例外表内', () => {
    const offenders: string[] = []
    for (const file of listModuleFiles()) {
      const rel = path.relative(MODULES_DIR, file)
      const from = rel.split(path.sep)[0]
      if (from === 'shared') continue
      const src = fs.readFileSync(file, 'utf-8')
      const targets = new Set<string>()
      for (const m of src.matchAll(/from\s+['"]\.\.\/([a-z-]+)\//g)) {
        const to = m[1]
        if (to === 'shared') continue
        if (to === from) continue
        targets.add(to)
      }
      for (const to of targets) {
        if (!(peerEdges[from] || []).includes(to)) {
          offenders.push(`${from} -> ${to} (${rel})`)
        }
      }
    }
    expect(offenders, `未声明的跨模块边(更新 tests/unit/arch-layers.test.ts peerEdges + ARCHITECTURE.md):\n${offenders.join('\n')}`).toEqual([])
  })

  test('shared 层不依赖 chat/evolution 等上层模块(仅 core/common/memory/knowledge 服务)', () => {
    const sharedDir = path.join(MODULES_DIR, 'shared')
    const allowed = new Set(['knowledge', 'approvals'])
    const offenders: string[] = []
    for (const f of fs.readdirSync(sharedDir)) {
      if (!f.endsWith('.ts')) continue
      const src = fs.readFileSync(path.join(sharedDir, f), 'utf-8')
      for (const m of src.matchAll(/from\s+['"]\.\.\/([a-z-]+)\//g)) {
        if (!allowed.has(m[1])) offenders.push(`shared/${f} -> ${m[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('事实共享层四个文件存在于 modules/shared', () => {
    for (const f of ['user-context.ts', 'chat-context.ts', 'chat.dto.ts', 'chat-orchestrator.ts']) {
      expect(fs.existsSync(path.join(MODULES_DIR, 'shared', f)), `shared/${f} 缺失 — #679 上提被回退?`).toBe(true)
    }
  })
})
