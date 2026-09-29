import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * #1146 — 运行时循环依赖守卫。
 * 审计时 madge 报告 26 个环（tools/tool-registry 家族、ai-provider、
 * extractor、citation、ingestion…）；重构后共享类型/常量/工具函数下沉
 * 叶子模块，全仓 src 静态 + 动态相对导入图应为 0 环。
 * 该检测按与审计同口径（含 type-only 与 import()）建图。
 */
const SRC = path.resolve(__dirname, '../../src')

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectFiles(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

function buildGraph(files: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  const importRe = /import\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8')
    const deps = new Set<string>()
    for (const m of src.matchAll(importRe)) {
      const spec = m[1] ?? m[2]
      if (!spec || !spec.startsWith('.')) continue
      const resolved = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts')
      if (fs.existsSync(resolved)) deps.add(resolved)
      else {
        const idx = resolved.replace(/\.ts$/, '/index.ts')
        if (fs.existsSync(idx)) deps.add(idx)
      }
    }
    graph.set(file, [...deps])
  }
  return graph
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = []
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const dfs = (n: string) => {
    state.set(n, 1)
    stack.push(n)
    for (const d of graph.get(n) ?? []) {
      if (state.get(d) === 1) {
        cycles.push(stack.slice(stack.indexOf(d)).map((f) => path.relative(SRC, f)))
      } else if (!state.has(d)) dfs(d)
    }
    stack.pop()
    state.set(n, 2)
  }
  for (const f of graph.keys()) if (!state.has(f)) dfs(f)
  const seen = new Set<string>()
  return cycles.filter((c) => {
    const key = [...c].sort().join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

describe('#1146 循环依赖守卫', () => {
  test('src 静态+动态相对导入图无环（审计时 26 环）', () => {
    const files = collectFiles(SRC)
    expect(files.length).toBeGreaterThan(200)
    const cycles = findCycles(buildGraph(files))
    expect(cycles, `环:\n${cycles.map((c) => '- ' + c.join(' -> ')).join('\n')}`).toEqual([])
  })
})
