/**
 * #989 Phase 1 — 块级结构投影构建器（纯函数，无 IO）。
 *
 * 解析 markdown body → 块树：
 *   - section（H1/H2/H3 标题行，与 doc-sections HEADING_RE 同口径）：
 *     id = 标题规范化哈希 — 正文编辑不换节 ID（仅改标题才失效）；
 *     hash = 节内容规范化哈希（变更检测位）。
 *   - block：段落/表格/图片/列表/代码围栏，id = 块内容规范化哈希（内容变 → ID 变）。
 *   - span：body 中的字符区间 [start, end)，Phase 2 确定性替换的精确依据；
 *     走查不变量：body.slice(start, end) 还原该节/块原文。
 *
 * 设计取舍（与 issue 同步）：真相源仍为 markdown（无损往返在表格/数学/
 * 修订/脚注上尚不成立），本投影只解耦「AI 编辑需要结构」与「存储翻转为
 * JSON」两件事。ID 规范化对空白/markdown 强调标记不敏感 — 无关编辑
 * （换行/空格差异、其他段落的内容修改）不会使 ID 漂移。
 *
 * 已知边界：同名标题/相同内容块按出现序号消歧，前置同名内容被删除时
 * 序号会漂移（ID 变化）— 读侧/兜底路径按 ID 失效处理（Phase 2 覆盖）。
 */
import { createHash } from 'crypto'
import type { BlockProjection, BlockProjectionNode, BlockType } from '@heurion/contracts'

/** sha1 前 12 位 — 投影内哈希统一口径。 */
export function hash12(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12)
}

/**
 * ID 规范化 — 空白折叠 + 小写 + 去 markdown 强调标记。无关编辑（换行差异、
 * 空格数、加粗标记）不引起 ID 漂移。
 */
function normalizeForId(s: string): string {
  return s
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** H1-H3 标题行（与 doc-sections HEADING_RE 同口径 — 不识别 #### 及更深）。 */
const HEADING_RE = /^(#{1,3})\s+(.+)$/
const FENCE_RE = /^\s*(```|~~~)/
const TABLE_LINE_RE = /^\s*\|/
const IMAGE_LINE_RE = /^\s*!\[[^\]]*\]\([^)]+\)\s*$/
const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+/

/** 投影构建：确定性、同输入同输出（Phase 1 验证标准：与 body 强一致）。 */
export function buildBlockProjection(body: string): BlockProjection {
  const text = String(body ?? '')
  const lines = text.split('\n')

  // 行起始偏移（含换行宽度 — 原文索引可精确还原）。
  const lineOffsets: number[] = []
  let offset = 0
  for (const l of lines) {
    lineOffsets.push(offset)
    offset += l.length + 1
  }

  // 标题行收集（出现序即节序）。
  const headingLines: Array<{ line: number; title: string; level: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i])
    if (m) headingLines.push({ line: i, title: m[2].trim(), level: m[1].length })
  }

  const seen = new Map<string, number>()
  const idFor = (prefix: 's' | 'b', normalized: string): string => {
    const h = hash12(normalized)
    const n = (seen.get(prefix + h) ?? 0) + 1
    seen.set(prefix + h, n)
    return n === 1 ? `${prefix}_${h}` : `${prefix}_${h}_${n}`
  }

  // ── 先建 section 节点(id/hash/span) ──
  const sectionNodes: BlockProjectionNode[] = []
  for (let s = 0; s < headingLines.length; s++) {
    const { line, title, level } = headingLines[s]
    const endLine = s + 1 < headingLines.length ? headingLines[s + 1].line : lines.length
    const contentLines = lines.slice(line + 1, endLine)
    sectionNodes.push({
      id: idFor('s', normalizeForId(title)),
      kind: 'section',
      heading: title.slice(0, 300),
      level,
      hash: hash12(normalizeForId(contentLines.join('\n'))),
      start: lineOffsets[line],
      end: s + 1 < headingLines.length ? lineOffsets[endLine] : text.length,
      parent_id: null,
    })
  }

  // ── 块分组：节与节之间（含首标题之前），连续同类行一块 ──
  const blockNodes: BlockProjectionNode[] = []
  for (let s = 0; s <= headingLines.length; s++) {
    const regionStart = s === 0 ? 0 : headingLines[s - 1].line + 1
    const regionEnd = s < headingLines.length ? headingLines[s].line : lines.length
    // 首标题前的块无父节；region s 的块属于「开启该 region 的节」= sectionNodes[s-1]。
    const parentId = s === 0 ? null : sectionNodes[s - 1].id

    let i = regionStart
    while (i < regionEnd) {
      if (!lines[i].trim()) { i++; continue }
      // 代码围栏（成对消费；未闭合吞到节尾）。
      if (FENCE_RE.test(lines[i])) {
        const open = i
        let close = regionEnd - 1
        for (let k = i + 1; k < regionEnd; k++) {
          if (FENCE_RE.test(lines[k])) { close = k; break }
        }
        blockNodes.push(makeBlock('code', open, close, lines, lineOffsets, parentId, idFor))
        i = close + 1
        continue
      }
      // 表格：连续竖线行。
      if (TABLE_LINE_RE.test(lines[i])) {
        let j = i
        while (j < regionEnd && TABLE_LINE_RE.test(lines[j])) j++
        blockNodes.push(makeBlock('table', i, j - 1, lines, lineOffsets, parentId, idFor))
        i = j
        continue
      }
      // 图片行（独立成块或连续图片行）。
      if (IMAGE_LINE_RE.test(lines[i])) {
        let j = i
        while (j < regionEnd && IMAGE_LINE_RE.test(lines[j])) j++
        blockNodes.push(makeBlock('image', i, j - 1, lines, lineOffsets, parentId, idFor))
        i = j
        continue
      }
      // 列表：连续列表行（子列表缩进同级处理）。
      if (LIST_LINE_RE.test(lines[i])) {
        let j = i
        while (j < regionEnd && LIST_LINE_RE.test(lines[j])) j++
        blockNodes.push(makeBlock('list', i, j - 1, lines, lineOffsets, parentId, idFor))
        i = j
        continue
      }
      // 段落：连续非空、非表格/图片/列表行。
      let j = i
      while (j < regionEnd && lines[j].trim() && !TABLE_LINE_RE.test(lines[j]) && !IMAGE_LINE_RE.test(lines[j]) && !LIST_LINE_RE.test(lines[j]) && !FENCE_RE.test(lines[j])) j++
      blockNodes.push(makeBlock('paragraph', i, j - 1, lines, lineOffsets, parentId, idFor))
      i = j
    }
  }

  return {
    schema_version: 1,
    body_hash: hash12(text),
    nodes: [...sectionNodes, ...blockNodes],
  }
}

/** 块节点构建（span = [首行起始, 末行末字符)）。 */
function makeBlock(
  blockType: BlockType,
  firstLine: number,
  lastLine: number,
  lines: string[],
  lineOffsets: number[],
  parentId: string | null,
  idFor: (prefix: 's' | 'b', normalized: string) => string,
): BlockProjectionNode {
  const raw = lines.slice(firstLine, lastLine + 1).join('\n')
  return {
    id: idFor('b', normalizeForId(raw)),
    kind: 'block',
    block_type: blockType,
    hash: hash12(normalizeForId(raw)),
    start: lineOffsets[firstLine],
    end: lineOffsets[lastLine] + lines[lastLine].length,
    parent_id: parentId,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// #989 Phase 2 — 编辑引用模式：ID 挂标题行 + 确定性节编辑。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 上下文注入的标题行挂 ID：`## Introduction` → `## [sec:s_xxx] Introduction`。
 * 匹配按规范化标题文本顺序对齐（同名标题按出现序消费）——被截断注入
 * （fitTextToTokens）丢掉的标题自然拿不到 marker，模型对其用锚点模式。
 * ID marker 由 edit_document 侧剥离（old_text 复制含 marker 也安全）。
 */
export function withSectionIds(bodyText: string, projection: BlockProjection): string {
  const text = String(bodyText ?? '')
  if (!projection) return text
  const sections = projection.nodes.filter((n) => n.kind === 'section')
  if (sections.length === 0) return text
  // 顺序消费队列 — 同名标题依次取对应 section 节点。
  const queue = [...sections]
  return text
    .split('\n')
    .map((line) => {
      const m = HEADING_RE.exec(line)
      if (!m) return line
      const normalized = normalizeForId(m[2].trim())
      const idx = queue.findIndex((s) => normalizeForId(s.heading || '') === normalized)
      if (idx === -1) return line
      const [section] = queue.splice(idx, 1)
      return `${m[1]} [sec:${section.id}] ${m[2]}`
    })
    .join('\n')
}

/** 投影装载：读侧校验 body_hash，不符/缺失按重建（确定性纯函数，重建必一致）。 */
export function loadProjection(body: string, stored: unknown): BlockProjection {
  const text = String(body ?? '')
  if (typeof stored === 'string' && stored) {
    try {
      const parsed = JSON.parse(stored) as BlockProjection
      if (parsed?.schema_version === 1 && parsed.body_hash === hash12(text)) return parsed
    } catch { /* 损坏 → 重建 */ }
  }
  return buildBlockProjection(text)
}

export interface SectionEditResult {
  body: string
  location: string
}

/**
 * 确定性节编辑（Phase 2 核心操作）：按投影 span 精确改写一个 section 的
 * 内容区（标题行之后 → 下一标题之前），不再依赖原文模糊锚点。
 *  - replace: 整节内容替换
 *  - append:  节内容末尾追加
 *  - prepend: 标题行之后插入
 *  - delete:  整节移除（标题+内容；生产实例：模型要清理占位节却只能传
 *    空 content 被拒 → 空参退化，2026-09-12）
 * ID 失效（投影中无此节）→ error，调用方降级锚点模式兜底。
 * 内容与现状一致 → 返回原 body（无变化，调用方按 unchanged 处理）。
 */
export function applySectionEdit(
  body: string,
  projection: BlockProjection,
  sectionId: string,
  action: 'replace' | 'append' | 'prepend' | 'delete',
  content: string,
): SectionEditResult | { error: string } {
  const text = String(body ?? '')
  const section = projection.nodes.find((n) => n.kind === 'section' && n.id === sectionId)
  if (!section) {
    return { error: `section ${sectionId} 在当前文档投影中不存在（ID 已失效或文档已重构）— 请改用 old_text/new_text 锚点编辑，或重新读取文档获取最新节 ID` }
  }
  if (action === 'delete') {
    // 整节移除:[标题行起始, 下一标题起始) — span 恰好覆盖标题+内容+节尾空白。
    // 块边界卫生:前一内容与下一标题之间保留一个空行(标题前空行纪律)。
    const before = text.slice(0, section.start).replace(/\s+$/, '')
    const after = text.slice(section.end).replace(/^\s+/, '')
    const newBody = before ? `${before}\n\n${after}` : after
    if (newBody === text) return { error: '节已是文档末尾且无内容，没有变化' }
    return { body: newBody, location: `${section.heading || sectionId}（${sectionId}）` }
  }
  // 节内容区 = 标题行之后 → 节 span 末（下一标题起始 | EOF）。
  // 节 span.start 即标题行起始;标题行原文 = span 起始后的第一行。
  const headingLine = text.slice(section.start).split('\n')[0] || ''
  const contentStart = section.start + headingLine.length + 1
  const raw = text.slice(contentStart, section.end)
  // core = 内容区去首尾空白(append/prepend 重建用;replace 直接换掉整区)
  const core = raw.replace(/^\s+/, '').replace(/\s+$/, '')
  const before = text.slice(0, contentStart)
  const after = text.slice(section.end) // 下一标题行原文起（或 ''）
  const next = String(content ?? '').trim()
  if (!next) {
    return { error: 'content is empty — 要删除整节请用 section_action:"delete"（不需要 content）;要写入内容请在 content（或 new_text）提供' }
  }
  // before 以标题行的 '\n' 结尾 → 内容紧随标题;节间以空行分隔;
  // 节尾含到下一标题前的空白 — 由 core(去尾空白)+ 固定 '\n\n' 重建。
  const coreLead = core ? `${core}\n\n` : ''

  if (action === 'replace') {
    return { body: `${before}${next}\n\n${after}`, location: `${section.heading || sectionId}（${sectionId}）` }
  }
  if (action === 'append') {
    return { body: `${before}${coreLead}${next}\n\n${after}`, location: `${section.heading || sectionId}（${sectionId}）` }
  }
  // prepend
  return { body: `${before}${next}\n\n${coreLead}${after}`, location: `${section.heading || sectionId}（${sectionId}）` }
}
