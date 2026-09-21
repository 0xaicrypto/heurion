/**
 * #1079 — 引用纪律护栏（轻量正则启发式，零 I/O）。
 *
 * 目标：拦住模型在 edit_document 里**手写参考文献列表**的行为（正式引用
 * 唯一入口是 insert_citation → [cite:id] 标记，References 列表由导出边界
 * #1078 自动生成）。护栏必须 SAFE：正常编辑、含合法 [cite:id] 标记的
 * 编辑、引用了 1 条文献的普通句子都不能误伤。
 */
import { CITE_SHORTCODE_PATTERN } from '@heurion/contracts'

/** 行首形如 `[1] ` / `[12]` 的编号行（手写 References 的典型形态）。 */
const BRACKET_NUM_LINE = /^\s*\[\d+\]/

/** 行首形如 `1. Smith J, ... 2020` 的编号行。 */
const DOT_NUM_LINE = /^\s*\d+\.\s+/

/** 参考文献条目的典型线索（作者缩写/期刊/年份/DOI/et al/中文「等」）。 */
const REFERENCE_CUES =
  /\bet\s+al\b|doi\s*[:.]|10\.\d{4,9}\/|[A-Z][a-z]+\s+[A-Z](?:,|\.)|\d{4}[;:]\d|《|》|期刊|学报|出版社|等[,.，。]\s*$/

/** contracts 共享 /g 正则的布尔判定 — 用非全局副本，避免 lastIndex 泄漏。 */
const CITE_SHORTCODE_RE = new RegExp(CITE_SHORTCODE_PATTERN.source)

/**
 * #1079: 检测「手写参考文献列表」形态 —
 * ≥2 行连续的非空行，每行以 `[数字]` 或 `数字.` 开头且带文献条目线索，
 * 且整段文本不含任何合法 [cite:id] 标记（有标记说明在走正式引用通道）。
 * 纯函数、零 I/O — 工具层与单测共用。
 */
export function looksLikeHandwrittenReferences(text: string): boolean {
  if (!text) return false
  // 文本已含 [cite:id] 标记 → 模型在走正式引用通道，放行。
  if (CITE_SHORTCODE_RE.test(text)) return false

  const refLikeLines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && (BRACKET_NUM_LINE.test(l) || DOT_NUM_LINE.test(l)) && REFERENCE_CUES.test(l))
  return refLikeLines.length >= 2
}

/** #1079: 命中护栏时的统一纠偏文案（模型可执行：改走 insert_citation）。 */
export const HANDWRITTEN_REFERENCES_GUIDANCE =
  '检测到手写参考文献列表（连续的 [1]/[2] 或 "1." 编号条目）— 正式引用禁止手写。请改用 insert_citation 工具：检索文献后把它返回的 [cite:citation_id] 标记用 edit_document 插入正文相应位置即可，References 列表由系统在导出时自动生成。本次编辑未生效。'
