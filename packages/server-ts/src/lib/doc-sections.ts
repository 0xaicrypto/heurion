/**
 * #fix: 长文档分步润色的分段器(混合策略)。
 *
 * - heading 模式:按 markdown 标题(#/##/###)切分 — 论文/规范文档天然按
 *   章节组织,块边界是语义的,进度可预期("第 2/8 段「方法」")。
 * - length 模式:无标题的连续长文按段落 + token 长度兜底 — 空行分段,
 *   贪婪合并到 targetTokens;单个超大段落按句子边界硬切。
 *
 * 配套 resolveDocumentFocus:从用户消息解析"当前要编辑哪一段",支持
 * "第 N 段/节/部分"、章节标题匹配、"继续"(接上一条助手消息提到的段)。
 */
import { estimateTokens } from '../common/token-estimate.js'

export interface DocSection {
  index: number
  title: string
  content: string
}

export interface DocSections {
  mode: 'heading' | 'length'
  sections: DocSection[]
}

const HEADING_RE = /^(#{1,3})\s+(.+)$/
/**
 * 段落引用解析(#833: 支持中文数字 + 「章」)。
 *  - 阿拉伯数字:「第 3 段」「第 2/5 节」(i/N 为模型进度播报写法)
 *  - 中文数字:「第三章」「第十二节」「廿一」不常见,支持 一-九十九 + 「两」
 *  - 单位:段/节/部分/章
 */
const SECTION_REF_RE = /第\s*(\d+)\s*(?:\/\s*\d+\s*)?(?:段|节|部分|章)/
const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
/** 中文数字 → 阿拉伯(支持 一-九十九;非法/超范围返回 null)。 */
export function parseChineseNumeral(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10)
    return n > 0 && n < 10000 ? n : null
  }
  if ([...t].some((c) => !(c in CN_DIGIT) && c !== '十')) return null
  if (t === '十') return 10
  const tenIdx = t.indexOf('十')
  if (tenIdx === -1) return CN_DIGIT[t] ?? null
  const tensPart = t.slice(0, tenIdx)
  const onesPart = t.slice(tenIdx + 1)
  const tens = tensPart === '' ? 1 : CN_DIGIT[tensPart] ?? -1
  const ones = onesPart === '' ? 0 : CN_DIGIT[onesPart] ?? -1
  if (tens < 0 || ones < 0 || tens > 9) return null
  const n = tens * 10 + ones
  return n > 0 ? n : null
}
/** 匹配消息中的段落引用,返回段号;无引用返回 null。 */
export function matchSectionRef(text: string): number | null {
  const arabic = text.match(SECTION_REF_RE)
  if (arabic) {
    const n = parseInt(arabic[1], 10)
    if (n > 0) return n
  }
  const chinese = text.match(/第\s*([零一二两三四五六七八九十]{1,4})\s*(?:段|节|部分|章)/)
  if (chinese) {
    const n = parseChineseNumeral(chinese[1])
    if (n && n > 0) return n
  }
  return null
}
/** 句子边界(中文/英文标点),用于超大段落硬切。 */
const SENTENCE_RE = /(?<=[。！？；.!?;])\s*/

/** 按标题切分;标题不足 2 个时回退 length 模式。 */
export function splitDocumentSections(body: string, targetTokens = 1500): DocSections {
  const text = body || ''
  const lines = text.split('\n')
  const heads: Array<{ line: number; title: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i])
    if (m) heads.push({ line: i, title: m[2].trim() })
  }

  if (heads.length >= 2) {
    const sections: DocSection[] = heads
      .map((h, i) => {
        const end = i + 1 < heads.length ? heads[i + 1].line : lines.length
        return { index: i + 1, title: h.title, content: lines.slice(h.line, end).join('\n').trim() }
      })
      // 过滤"只有标题行"的段(如文档大标题 # Title)—— 无可编辑正文。
      .filter((s) => s.content.split('\n').slice(1).join('\n').trim().length > 0)
    if (sections.length > 0) return { mode: 'heading', sections }
  }

  return { mode: 'length', sections: splitByLength(text, targetTokens) }
}

/** 段落 + token 长度兜底切分。 */
function splitByLength(text: string, targetTokens: number): DocSection[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const sections: DocSection[] = []
  const push = (content: string) => {
    if (!content) return
    sections.push({ index: sections.length + 1, title: `第 ${sections.length + 1} 段`, content })
  }

  let buf: string[] = []
  let bufTokens = 0
  const flush = () => {
    if (buf.length > 0) {
      push(buf.join('\n\n'))
      buf = []
      bufTokens = 0
    }
  }

  for (const p of paragraphs) {
    const tokens = estimateTokens(p)
    if (tokens > targetTokens) {
      // 超大段落:先冲掉缓冲区,再按句子边界硬切。
      flush()
      for (const piece of hardSplit(p, targetTokens)) push(piece)
      continue
    }
    if (bufTokens + tokens > targetTokens) flush()
    buf.push(p)
    bufTokens += tokens
  }
  flush()
  return sections
}

/** 按句子边界贪心切分;无标点长文本按字符窗口兜底。 */
function hardSplit(text: string, targetTokens: number): string[] {
  const sentences = text.split(SENTENCE_RE).filter(Boolean)
  if (sentences.length <= 1) {
    // 无可用句子边界 — 按字符窗口硬切。
    const windowChars = Math.max(64, Math.floor(targetTokens * 1.5))
    const pieces: string[] = []
    for (let i = 0; i < text.length; i += windowChars) pieces.push(text.slice(i, i + windowChars))
    return pieces
  }

  const pieces: string[] = []
  let cur = ''
  let curTokens = 0
  for (const s of sentences) {
    const t = estimateTokens(s)
    if (curTokens + t > targetTokens && cur) {
      pieces.push(cur)
      cur = ''
      curTokens = 0
    }
    cur += (cur ? ' ' : '') + s
    curTokens += t
  }
  if (cur) pieces.push(cur)
  return pieces
}

function clampIndex(index: number, total: number): number {
  if (total <= 0) return 1
  return Math.min(total, Math.max(1, index))
}

/**
 * 解析用户消息中的段落焦点(#866: 未识别信号时焦点继承,不再回退第 1 段)。
 * 1. 显式 "第 N 段/节/部分" → N;
 * 2. 消息中包含章节标题(长度 ≥2) → 该段;
 * 3. "继续/下一段/next" → 上一条助手消息提到的段 + 1(越界钳制);
 * 4. #866: 上一条助手消息播报过「第 i/N 段」(FOCUS_RULE 分步进度纪律)
 *    → 继承 i — 模糊指令(「这句再自然一点」)不再静默跳回文档头
 *    (生产形态:用户优化第 5 段中途发模糊消息,焦点重置,模型改错段);
 * 5. 其余 → 第 1 段(文档头)。
 */
export function resolveDocumentFocus(userText: string, sections: DocSection[], lastAssistantText?: string): number {
  const text = userText || ''
  // #833: 统一走 matchSectionRef(支持中文数字 + 「章」)。
  const explicit = matchSectionRef(text)
  if (explicit) return clampIndex(explicit, sections.length)

  const byTitle = sections.find((s) => s.title.length >= 2 && text.includes(s.title))
  if (byTitle) return byTitle.index

  if (/继续|下一段|下一部分|下部分|next/i.test(text)) {
    const m = lastAssistantText ? matchSectionRef(lastAssistantText) : null
    if (m) return clampIndex(m + 1, sections.length)
  }

  // #866: 继承助手最近一次播报的段(取最后一个匹配 — 批量模式连做多段
  // 时最后一处即停下的位置)。
  if (lastAssistantText) {
    const matches = [...lastAssistantText.matchAll(/第\s*((?:\d+)(?:\s*\/\s*\d+)?|[零一二两三四五六七八九十]{1,4})\s*(?:段|节|部分|章)/g)]
    if (matches.length > 0) {
      const last = parseChineseNumeral(matches[matches.length - 1][1].split('/')[0].trim())
      if (last) return clampIndex(last, sections.length)
    }
  }

  return 1
}

/** #868: 落点透明化 — span 起点之前最近的一个 markdown 标题(章节归属)。 */
export function nearestHeadingBefore(body: string, pos: number): string {
  const before = body.slice(0, pos)
  const lines = before.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = HEADING_RE.exec(lines[i])
    if (m) return m[2].trim().slice(0, 80)
  }
  return ''
}
