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
 *
 * #913 — 检测升级:正则同时覆盖静态 `from '../X/'` 与动态
 * `import('../X/')`(此前动态编排边全部漏报),并把实查出的 5 条未申报
 * 边补进 peerEdges + ARCHITECTURE.md(chat→skills、documents→figures、
 * files→patients、medical-records→research、patients→research)。
 */

const MODULES_DIR = path.resolve(__dirname, '../../src/modules')

/** 已接受的跨模块边(from → 允许的 to 列表)。 */
const peerEdges: Record<string, string[]> = {
  chat: ['knowledge', 'plugins', 'evolution', 'patients', 'execution', 'skills', 'figures'], // #913: skills 为会话内技能激活/遵循度/捕捉建议(动态 import);#939: figures 为 figure 渲染管线 port 注入(动态 import)
  evolution: ['memorization', 'practitioner', 'chat'],
  files: ['ingestion', 'knowledge', 'execution', 'patients'], // #913: patients 为 DICOM 快扫(动态 import)
  ingestion: ['medical-records'],
  'medical-records': ['approvals', 'research'], // #913: research 为病历入库自动筛查入队(动态 import)
  research: ['knowledge'],
  calendar: ['research'],
  external: ['plugins', 'execution'],
  plugins: ['chat', 'execution'],
  figures: ['execution'], // #820: figure.service 编排执行面 render_figure
  memorization: ['chat'],
  patients: ['chat', 'research'], // #913: research 为患者入库自动筛查入队(动态 import)
  documents: ['chat', 'figures'], // #913: figures 为文档图片扫描/渲染回填(动态 import)
  skills: ['chat', 'knowledge'], // #841 环⑤: follow-through 复用 telemetry.service(knowledge 服务层)
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

/**
 * #913 — 跨模块 import 提取:静态 `from '../X/'` 与动态 `import('../X/')`
 * 同时覆盖(此前正则只匹配静态形式,post-turn-pipeline 等动态编排边全部
 * 漏报)。两个 regex 导出供断言样例直接验证行为。
 */
export const STATIC_FROM_RE = /from\s+['"]\.\.\/([a-z-]+)\//g
export const DYNAMIC_IMPORT_RE = /import\(\s*['"]\.\.\/([a-z-]+)\//g

function crossModuleImports(src: string): Array<{ mod: string; target: string }> {
  const hits: Array<{ mod: string; target: string }> = []
  for (const re of [STATIC_FROM_RE, DYNAMIC_IMPORT_RE]) {
    for (const m of src.matchAll(re)) hits.push({ mod: m[1], target: m[1] })
  }
  return hits
}

/** 主体扫描用:单文件全部跨模块目标(静态+动态,排除 shared/同层)。 */
function crossModuleTargets(src: string, from: string): Set<string> {
  const targets = new Set<string>()
  for (const { mod } of crossModuleImports(src)) {
    if (mod === 'shared' || mod === from) continue
    targets.add(mod)
  }
  return targets
}

describe('#679 模块分层规则', () => {
  test('#913 动态 import 检出:import(../X/) 与 from ../X/ 同等可见(盲区回归锁)', () => {
    const sample = [
      "import { x } from '../knowledge/citation-audit.js'",
      "const { recordFollowThrough } = await import('../skills/follow-through.js')",
      "void import( '../research/auto-screen.service.js' )",
      "import y from '../shared/user-context.js'", // shared 不计入
      "import z from './sibling.js'", // 同层不计入
    ].join('\n')
    const targets = crossModuleTargets(sample, 'chat')
    expect(targets.has('knowledge')).toBe(true)
    expect(targets.has('skills')).toBe(true)
    expect(targets.has('research')).toBe(true)
    expect(targets.has('shared')).toBe(false)
    expect(targets.size).toBe(3)
    // regex 常量本身可独立复用(ARCHITECTURE.md 同步登记的机器可执行版)
    expect([...sample.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1])).toEqual(['skills', 'research'])
    expect([...sample.matchAll(STATIC_FROM_RE)].map((m) => m[1])).toEqual(['knowledge', 'shared'])
  })

  test('peer 跨模块 import 必须在 peerEdges 例外表内(静态+动态,#913)', () => {
    const offenders: string[] = []
    for (const file of listModuleFiles()) {
      const rel = path.relative(MODULES_DIR, file)
      const from = rel.split(path.sep)[0]
      if (from === 'shared') continue
      const src = fs.readFileSync(file, 'utf-8')
      for (const to of crossModuleTargets(src, from)) {
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
      // #913: shared 同样覆盖动态 import 盲区。
      for (const re of [STATIC_FROM_RE, DYNAMIC_IMPORT_RE]) {
        for (const m of src.matchAll(re)) {
          if (!allowed.has(m[1])) offenders.push(`shared/${f} -> ${m[1]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('事实共享层四个文件存在于 modules/shared', () => {
    for (const f of ['user-context.ts', 'chat-context.ts', 'chat.dto.ts', 'chat-orchestrator.ts']) {
      expect(fs.existsSync(path.join(MODULES_DIR, 'shared', f)), `shared/${f} 缺失 — #679 上提被回退?`).toBe(true)
    }
  })

  /**
   * #940 — leaf 层反向依赖检测（对应根 ARCHITECTURE.md #672 分层图）：
   *   common/core       不得 import memory/retrieval/tools/modules/*
   *   memory/retrieval  不得 import modules/*
   *   tools             不得 import modules/*
   * evolution/store 类型 import 为已登记债务（leaf 规则未列 evolution），
   * 不在拦截范围。此前只守 modules 横向边,4 处反向依赖（含 persona↔memory
   * 真实循环）全部漏报 — #939 修复后本锁防复发。
   */
  const COMMON_FORBIDDEN = new Set(['memory', 'retrieval', 'tools', 'modules'])
  const MODULES_FORBIDDEN = new Set(['modules'])

  function leafScan(dir: string, forbidden: Set<string>): string[] {
    const out: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) {
          const src = fs.readFileSync(p, 'utf-8')
          const rel = path.relative(path.resolve(__dirname, '../../src'), p)
          for (const re of [STATIC_FROM_RE, DYNAMIC_IMPORT_RE]) {
            for (const m of src.matchAll(re)) {
              if (forbidden.has(m[1])) out.push(`${rel} -> ${m[1]}/`)
            }
          }
        }
      }
    }
    walk(dir)
    return out
  }

  test('#940 common/core 零反向依赖（memory/retrieval/tools/modules 全禁）', () => {
    const offenders = [
      ...leafScan(path.join(MODULES_DIR, '..', 'common'), COMMON_FORBIDDEN),
      ...leafScan(path.join(MODULES_DIR, '..', 'core'), COMMON_FORBIDDEN),
    ]
    expect(offenders, `common/core 反向依赖(更新代码而非例外表 — 分层 #672):\n${offenders.join('\n')}`).toEqual([])
  })

  test('#940 memory/retrieval/tools 零 modules 依赖', () => {
    const offenders = ['memory', 'retrieval', 'tools'].flatMap((d) =>
      leafScan(path.join(MODULES_DIR, '..', d), MODULES_FORBIDDEN),
    )
    expect(offenders, `leaf 层依赖 modules/*(port 注入或下移,分层 #672):\n${offenders.join('\n')}`).toEqual([])
  })
})
