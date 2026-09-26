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
  ingestion: ['medical-records', 'research'], // #1104: research 为 protocol.analyzer 复用 protocol-extractor(analyzers/ 子目录 ../../ 边,regex 修复后浮出)
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
 *
 * #1104 — 嵌套深度盲区:此前只匹配一级 `../X/`,子目录文件(如
 * ingestion/analyzers/protocol.analyzer.ts)的 `../../X/` 全部漏检。
 * `(?:\.\.\/)+` 覆盖任意级数;捕获组 1 = `../` 前缀、组 2 = 最后一段模块
 * 名,落点用真实路径解析(见 resolveImportedSegment):
 *   - modules/X/ 子文件 `../../research/` → modules/research(✓ peer)
 *   - `../../evolution/stores`(shared 文件)→ src/evolution(顶层,非 peer)
 *   - `from '../..'`(父父目录自身,无模块段)不命中 — 需要 `[a-z-]+/` 段
 */
export const STATIC_FROM_RE = /from\s+['"]((?:\.\.\/)+)([a-z-]+)\//g
export const DYNAMIC_IMPORT_RE = /import\(\s*['"]((?:\.\.\/)+)([a-z-]+)\//g

/** src/ 根(leafScan 判 src 级目录用)。 */
const SRC_DIR = path.resolve(MODULES_DIR, '..')

/**
 * 解析 regex 命中的 (前缀+模块段) → import 真实落点相对 root 的首段目录。
 * 落点不在 root 下(如顶层 common/、src/evolution/)返回 null。
 * modules peer 扫描用 root=MODULES_DIR;leaf 反向依赖扫描用 root=SRC_DIR。
 */
function resolveImportedSegment(file: string, m: RegExpMatchArray, root: string): string | null {
  const targetDir = path.resolve(path.dirname(file), `${m[1]}${m[2]}`)
  const rel = path.relative(root, targetDir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep)[0]
}

function crossModuleImports(file: string, src: string): string[] {
  const hits: string[] = []
  for (const re of [STATIC_FROM_RE, DYNAMIC_IMPORT_RE]) {
    for (const m of src.matchAll(re)) {
      const mod = resolveImportedSegment(file, m, MODULES_DIR)
      if (mod) hits.push(mod)
    }
  }
  return hits
}

/** 主体扫描用:单文件全部跨模块目标(静态+动态,排除 shared/同层)。 */
function crossModuleTargets(file: string, src: string, from: string): Set<string> {
  const targets = new Set<string>()
  for (const mod of crossModuleImports(file, src)) {
    if (mod === 'shared' || mod === from) continue
    targets.add(mod)
  }
  return targets
}

describe('#679 模块分层规则', () => {
  test('#913 动态 import 检出:import(../X/) 与 from ../X/ 同等可见(盲区回归锁)', () => {
    // #1104: 样例以 modules/chat/sample.ts 的位置解析(../../research → modules/research)。
    const sampleFile = path.join(MODULES_DIR, 'chat', 'sample.ts')
    const sample = [
      "import { x } from '../knowledge/citation-audit.js'",
      "const { recordFollowThrough } = await import('../skills/follow-through.js')",
      "void import( '../research/auto-screen.service.js' )",
      "import y from '../shared/user-context.js'", // shared 不计入
      "import z from './sibling.js'", // 同层不计入
      // #1104: 一级以上 ../ 前缀(analyzers/ 子目录 → 兄弟模块)同样检出
      "import { extractRulesFromProtocol } from '../../research/protocol-extractor.js'",
      "import w from '../..'", // 无模块段(父父目录自身)不命中
    ].join('\n')
    const targets = crossModuleTargets(sampleFile, sample, 'chat')
    expect(targets.has('knowledge')).toBe(true)
    expect(targets.has('skills')).toBe(true)
    expect(targets.has('research')).toBe(true)
    expect(targets.has('shared')).toBe(false)
    expect(targets.size).toBe(3)
    // regex 常量本身可独立复用(ARCHITECTURE.md 同步登记的机器可执行版)
    // 组 1 = ../ 前缀、组 2 = 最后一段模块名。
    expect([...sample.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[2])).toEqual(['skills', 'research'])
    expect([...sample.matchAll(STATIC_FROM_RE)].map((m) => m[2])).toEqual(['knowledge', 'shared', 'research'])
  })

  test('#1104 落点解析:../../ 前缀按文件真实目录解析(顶层目录不误报为 peer)', () => {
    // depth-1 文件:../evolution → modules/evolution(peer);../../evolution → src/evolution(顶层,非 peer)
    const chatFile = path.join(MODULES_DIR, 'chat', 'sample.ts')
    const hits1 = [...'from \'../evolution/stores.js\''.matchAll(STATIC_FROM_RE)].map((m) => resolveImportedSegment(chatFile, m, MODULES_DIR))
    expect(hits1).toEqual(['evolution'])
    const hits2 = [...'import(\'../../evolution/trajectory.js\')'.matchAll(DYNAMIC_IMPORT_RE)].map((m) => resolveImportedSegment(chatFile, m, MODULES_DIR))
    expect(hits2).toEqual([null]) // src/evolution 顶层 — 不计 peer
    // depth-2 文件(analyzers/):../../research → modules/research(peer,此前盲区)
    const nestedFile = path.join(MODULES_DIR, 'ingestion', 'analyzers', 'sample.ts')
    const hits3 = [...'from \'../../research/protocol-extractor.js\''.matchAll(STATIC_FROM_RE)].map((m) => resolveImportedSegment(nestedFile, m, MODULES_DIR))
    expect(hits3).toEqual(['research'])
    // 子目录文件 ../sibling → 本模块内,不计跨模块
    const hits4 = [...'from \'../ingestion.service.js\''.matchAll(STATIC_FROM_RE)]
    expect(hits4).toEqual([]) // 无目录段 — regex 不命中
  })

  test('peer 跨模块 import 必须在 peerEdges 例外表内(静态+动态,#913)', () => {
    const offenders: string[] = []
    for (const file of listModuleFiles()) {
      const rel = path.relative(MODULES_DIR, file)
      const from = rel.split(path.sep)[0]
      if (from === 'shared') continue
      const src = fs.readFileSync(file, 'utf-8')
      for (const to of crossModuleTargets(file, src, from)) {
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
      const file = path.join(sharedDir, f)
      const src = fs.readFileSync(file, 'utf-8')
      // #913: shared 同样覆盖动态 import 盲区;#1104: 落点真实解析 —
      // `../../evolution/stores`(src 顶层)不计为 peer。
      for (const re of [STATIC_FROM_RE, DYNAMIC_IMPORT_RE]) {
        for (const m of src.matchAll(re)) {
          const mod = resolveImportedSegment(file, m, MODULES_DIR)
          if (mod && !allowed.has(mod)) offenders.push(`shared/${f} -> ${mod}`)
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
          // #1104: 落点真实解析 — 嵌套文件的 ../../modules/ 也会被检出,
          // 顶层 common/memory 等目录不误报。
          for (const re of [STATIC_FROM_RE, DYNAMIC_IMPORT_RE]) {
            for (const m of src.matchAll(re)) {
              const seg = resolveImportedSegment(p, m, SRC_DIR)
              if (seg && forbidden.has(seg)) out.push(`${rel} -> ${m[2]}/`)
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

  /**
   * P2 — lib/ 纳入分层规则（报告 🟡: lib 未在分层内,已出现 lib ↔ tools 循环）。
   * 规则: lib 零 modules 依赖;lib→tools 依赖冻结在存量文件白名单(只减不增),
   * tools→lib 是允许方向(21 处调用方不动)。清掉一个文件即从白名单移除。
   */
  test('#P2 lib 零 modules 依赖 + tools 依赖冻结白名单', () => {
    const libDir = path.join(MODULES_DIR, '..', 'lib')
    const LIB_TOOLS_FROZEN = new Set(['citation-migration.ts', 'deck-bytes.ts'])
    const moduleOffenders = leafScan(libDir, new Set(['modules']))
    expect(moduleOffenders, `lib 依赖 modules/*(下移或端口注入):\n${moduleOffenders.join('\n')}`).toEqual([])

    const toolsOffenders: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!e.name.endsWith('.ts')) continue
        const src = fs.readFileSync(p, 'utf-8')
        const rel = path.relative(libDir, p)
        for (const re of [STATIC_FROM_RE, DYNAMIC_IMPORT_RE]) {
          for (const m of src.matchAll(re)) {
            const seg = resolveImportedSegment(p, m, SRC_DIR)
            if (seg === 'tools' && !LIB_TOOLS_FROZEN.has(rel)) toolsOffenders.push(`lib/${rel} -> ${m[2]}/`)
          }
        }
      }
    }
    walk(libDir)
    expect(toolsOffenders, `新增 lib→tools 依赖(白名单只减不增;新代码走 common/ 或端口注入):\n${toolsOffenders.join('\n')}`).toEqual([])
  })
})
