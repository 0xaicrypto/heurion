/**
 * #518-followup — 用户指南同步校验脚本。
 *
 * 扫描 App.tsx 中实际注册的路由,与 src/docs/features.ts 功能清单对照:
 * - 输出"清单未收录"的新路由(提示补入清单)
 * - 输出"App.tsx 已移除"的失效条目
 * 文档页面(/docs)由 features.ts 渲染——本脚本保证二者不漂移。
 *
 * 用法: node scripts/gen-feature-inventory.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appTsx = path.join(__dirname, '../src/App.tsx')
const featuresTs = path.join(__dirname, '../src/docs/features.ts')

const src = fs.readFileSync(appTsx, 'utf-8')

/** 提取 App.tsx 中全部路由路径(含嵌套/相对路径)。 */
const rawPaths = [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1])
const appPaths = new Set(rawPaths)

/** features.ts 中登记的路径。 */
const featuresSrc = fs.readFileSync(featuresTs, 'utf-8')
const registeredPaths = new Set(
  [...featuresSrc.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]),
)

/** 营销/登录入口不属于应用功能清单。 */
const EXCLUDED = new Set(['*', '/', '/app', '/login', '/memory', '/sidecar', '/knowledge', '/security', '/docs'])
const missing = [...appPaths]
  .filter((p) => !registeredPaths.has(p) && !EXCLUDED.has(p))
  .sort()
const stale = [...registeredPaths].filter((p) => !appPaths.has(p)).sort()

console.log(`App.tsx routes: ${appPaths.size} | features.ts entries: ${registeredPaths.size}`)
if (missing.length) {
  console.log(`\n⚠ 清单未收录的新路由(请补入 src/docs/features.ts):\n  ${missing.join('\n  ')}`)
}
if (stale.length) {
  console.log(`\n⚠ features.ts 中已在 App.tsx 移除的路径(请删除):\n  ${stale.join('\n  ')}`)
}
if (!missing.length && !stale.length) {
  console.log('✓ 功能清单与路由表完全同步')
}
