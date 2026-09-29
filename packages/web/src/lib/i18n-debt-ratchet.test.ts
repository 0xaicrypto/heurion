import { describe, test, expect } from 'vitest'

/**
 * #1147 — UI 硬编码中文守卫（"JSX 文本 lint" 的可执行版本）。
 *
 * 2026-09 审计：landing/security/memory 等页面大量硬编码中文；本守卫在此后
 * 的迁移后要求 **非白名单文件 0 硬编码**：
 *  - t('key', '中文回退') / t('key', { defaultValue }) / { key, def } 数据形态
 *    与注释（行注释、块注释、JSX 注释）均不计；
 *  - 白名单是**有意保留中文**的非 UI 文案（LLM prompt / 语言名 / 正则字面量），
 *    逐文件冻结上限，只允许下降。
 *
 * 计数口径与 /tmp 生成器一致，改口径需同步注释与白名单说明。
 */
const WHITELIST_CAPS: Record<string, number> = {
  // LLM 评论处理 prompt 模板（模型指令，非 UI 文案）。
  'routes/writing-editor/comments-ai.ts': 12,
  // 化验异常值正则字面量（偏高|偏低|…），非 UI。
  'routes/medical-records.tsx': 1,
  // 语言切换器按惯例显示语言本名：中文。
  'components/layout/AppShell.tsx': 1,
  'components/marketing/MarketingShell.tsx': 1,
  // POLISH_PRESETS 的 5 条润色指令是发给模型的 prompt；标签已迁 i18n。
  'routes/writing-editor/bubble.ts': 5,
}

function relPath(key: string): string {
  return key.replace(/^\.\.\//, '')
}

function hardcodedCount(src: string): number {
  let n = 0
  let inBlock = false
  for (const raw of src.split('\n')) {
    let line = raw
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    if (line.includes('/*') && !line.slice(line.indexOf('/*') + 2).includes('*/')) {
      inBlock = true
      continue
    }
    line = line.replace(/\/\*[\s\S]*?\*\//g, '')
    line = line.replace(/t\(\s*'[^']*'\s*,\s*'(?:[^'\\]|\\.)*'/g, "t('k'")
    line = line.replace(/t\(\s*"[^"]*"\s*,\s*"(?:[^"\\]|\\.)*"/g, 't("k"')
    line = line.replace(/defaultValue:\s*'(?:[^'\\]|\\.)*'/g, "defaultValue:''")
    line = line.replace(/(def|labelDef|hintDef):\s*'(?:[^'\\]|\\.)*'/g, "$1:''")
    const idx = line.indexOf('//')
    if (idx >= 0) {
      const before = line.slice(0, idx)
      if ((before.match(/'/g) || []).length % 2 === 0 && (before.match(/"/g) || []).length % 2 === 0) line = before
    }
    if (/[\u4e00-\u9fa5]/.test(line)) n++
  }
  return n
}

describe('#1147 i18n 硬编码中文守卫', () => {
  const RAW = import.meta.glob('../{routes,components}/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const entries = Object.entries(RAW).filter(([k]) => !/\.test\.(ts|tsx)$/.test(k))

  test('非白名单文件不得含硬编码中文；白名单文件不得超过冻结上限', () => {
    const offenders: string[] = []
    for (const [key, content] of entries) {
      const rel = relPath(key)
      const n = hardcodedCount(content)
      const cap = WHITELIST_CAPS[rel]
      if (cap !== undefined) {
        if (n > cap) offenders.push(`${rel}: ${n} > 白名单上限 ${cap}`)
      } else if (n > 0) {
        offenders.push(`${rel}: ${n} 行硬编码中文（请走 i18n t()，或加白名单并说明理由）`)
      }
    }
    expect(offenders, `i18n 债务增长:\n${offenders.join('\n')}`).toEqual([])
  })
})
