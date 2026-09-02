/**
 * #809 — 文档一致性 lint（纯规则,不依赖 LLM）。
 * 三类检查:
 *  1. 缩写纪律 — `ABC` 首次出现时应伴随 `(ABC)` 定义;定义出现在使用之后 → 提示
 *  2. 图表编号 — 正文引用「图 N/表 N/Figure N/Table N」必须有对应的图注/表题,反之编号不能缺引用
 *  3. heading 跳级 — # 直接到 ###（H1→H3）这种层级断裂
 * 返回结构化 issue 列表(类型/位置/文案),供 API 与保存后提示消费。
 */

export interface DocLintIssue {
  type: 'abbreviation' | 'figure-ref' | 'heading-skip'
  /** 1-based 行号 */
  line: number
  message: string
}

interface Line { n: number; text: string }

const HEADING_LEVELS: Record<string, number> = { '#': 1, '##': 2, '###': 3, '####': 4 }

export function lintDocument(body: string): DocLintIssue[] {
  const issues: DocLintIssue[] = []
  if (!body || !body.trim()) return issues
  const lines: Line[] = body.split('\n').map((text, i) => ({ n: i + 1, text }))

  // ── 1. 缩写纪律 ──
  // 定义模式: 「全称（缩写）」或「全称 (ABC)」— 记录每个缩写的定义行。
  const definedAt = new Map<string, number>()
  for (const { n, text } of lines) {
    for (const m of text.matchAll(/[（(]([A-Z][A-Za-z0-9-]{1,10})[)）]/g)) {
      const abbr = m[1]
      // 过滤常见误报:纯英文句尾括号注记(如 (SD))其实正是定义形态,保留。
      if (!definedAt.has(abbr)) definedAt.set(abbr, n)
    }
  }
  // 使用模式: 独立大写词(≥2 个大写字母)。排除纯英文虚词(全大写形式罕见,
  // 仅防御性保留);医学缩写(PFS/EGFR 等)正是 lint 对象,不豁免。
  const COMMON = new Set(['THE', 'AND', 'FOR', 'BUT', 'NOT', 'WITH', 'FROM', 'ALSO', 'WHEN', 'THAT', 'THIS'])
  const firstUse = new Map<string, number>()
  for (const { n, text } of lines) {
    for (const m of text.matchAll(/\b([A-Z]{2,}[a-z0-9]*)\b/g)) {
      const abbr = m[1]
      if (COMMON.has(abbr) || firstUse.has(abbr)) continue
      firstUse.set(abbr, n)
    }
  }
  for (const [abbr, usedLine] of firstUse) {
    const defLine = definedAt.get(abbr)
    if (defLine === undefined) {
      // 从未定义——只提示在首个使用行
      issues.push({ type: 'abbreviation', line: usedLine, message: `缩写「${abbr}」首次出现（第 ${usedLine} 行）未给出定义——首次使用应写作「全称（${abbr}）」` })
    } else if (defLine > usedLine) {
      issues.push({ type: 'abbreviation', line: usedLine, message: `缩写「${abbr}」在第 ${usedLine} 行先于定义（定义在第 ${defLine} 行）——定义应前置` })
    }
  }

  // ── 2. 图表编号 ──
  // 实际存在的图表: 图注行「**图N：…**」或 markdown 图片 alt「![图N：…]」/ 表题「表N」。
  const presentFigures = new Set<string>()
  const presentTables = new Set<string>()
  for (const { text } of lines) {
    for (const m of text.matchAll(/!\[图\s*(\d+)/g)) presentFigures.add(m[1])
    for (const m of text.matchAll(/\*\*图\s*(\d+)/g)) presentFigures.add(m[1])
    for (const m of text.matchAll(/!\[表\s*(\d+)/g)) presentTables.add(m[1])
    for (const m of text.matchAll(/\*\*表\s*(\d+)/g)) presentTables.add(m[1])
  }
  const referenced: Array<{ kind: '图' | '表'; num: string; line: number }> = []
  for (const { n, text } of lines) {
    for (const m of text.matchAll(/如(图|表)\s*(\d+)/g)) referenced.push({ kind: m[1] as '图' | '表', num: m[2], line: n })
    for (const m of text.matchAll(/(Figure|Table)\s*(\d+)/gi)) referenced.push({ kind: m[1].toLowerCase() === 'figure' ? '图' : '表', num: m[2], line: n })
  }
  for (const ref of referenced) {
    const present = ref.kind === '图' ? presentFigures : presentTables
    if (!present.has(ref.num)) {
      issues.push({ type: 'figure-ref', line: ref.line, message: `正文引用了「${ref.kind}${ref.num}」，但文档中没有对应的${ref.kind}注/图题——请补充${ref.kind}${ref.num}或修正编号` })
    }
  }

  // ── 3. heading 跳级 ──
  let prevLevel = 0
  for (const { n, text } of lines) {
    const m = /^(#{1,4})\s+\S/.exec(text)
    if (!m) continue
    const level = HEADING_LEVELS[m[1]] ?? 0
    if (prevLevel > 0 && level > prevLevel + 1) {
      issues.push({ type: 'heading-skip', line: n, message: `heading 层级从 H${prevLevel} 跳到 H${level} — 检查是否缺少中间层级` })
    }
    prevLevel = level
  }

  return issues
}
