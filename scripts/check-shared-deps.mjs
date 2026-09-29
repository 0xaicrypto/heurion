#!/usr/bin/env node
/**
 * #1157（兜底门禁）— 共享依赖版本一致性。
 * 全仓尚未迁到 pnpm workspace/catalog（需与 CI pnpm10/本地 pnpm12 的
 * settings 差异一起处理），先用本脚本防止已对齐的共享依赖再次漂移：
 * 任一共享依赖在各包中声明的 specifier 不一致即失败。
 *
 * 用法: node scripts/check-shared-deps.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = [
  'packages/server-ts',
  'packages/web',
  'packages/worker',
  'packages/contracts',
  'packages/ssrf-guard',
  'packages/embedding-server',
  'packages/cf-browser-agent',
  'packages/llm-markdown-fix',
]
const SHARED = ['typescript', 'vitest', 'eslint', 'zod', '@types/node', 'typescript-lint']

/** name → specifier → [packages] */
const table = new Map()
for (const rel of PACKAGES) {
  const pkgPath = path.join(root, rel, 'package.json')
  if (!fs.existsSync(pkgPath)) continue
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  for (const name of SHARED) {
    if (!deps[name]) continue
    if (!table.has(name)) table.set(name, new Map())
    const bySpec = table.get(name)
    if (!bySpec.has(deps[name])) bySpec.set(deps[name], [])
    bySpec.get(deps[name]).push(rel.replace('packages/', ''))
  }
}

let failed = false
for (const [name, bySpec] of [...table.entries()].sort()) {
  if (bySpec.size <= 1) {
    const [[spec, pkgs]] = [...bySpec.entries()]
    console.log(`  ✓ ${name.padEnd(16)} ${spec.padEnd(28)} (${pkgs.length} 包)`)
    continue
  }
  failed = true
  console.error(`  ✗ ${name} 版本漂移:`)
  for (const [spec, pkgs] of bySpec.entries()) {
    console.error(`      ${spec.padEnd(28)} ← ${pkgs.join(', ')}`)
  }
}
if (failed) {
  console.error('\n[shared-deps] 共享依赖版本不一致 — 请统一到单一声明后再提交。')
  process.exit(1)
}
console.log('\n[shared-deps] 共享依赖版本一致')
