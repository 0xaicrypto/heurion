/**
 * llm-markdown-fix — 把 LLM 输出的"脏 markdown"规范化为标准 markdown。
 *
 * 模型常见的非标准输出:
 *  - 表格缺前导 |、分隔行列数不一致、整表挤成单行
 *  - 分隔行写成 |--、---| 等非标准形式
 *  - 用代码围栏包裹单个标点/短符号(如 ```..```)
 *
 * 核心: 纯函数 fixMarkdown(input, options?) → 标准 markdown,
 * 规则管线化,每规则独立可测、可启用/禁用。
 */
export interface FixOptions {
  /** 启用的规则(默认全部)。 */
  rules?: string[]
  /** 是否将 <=maxShortCodeLen 字符的围栏标点还原为普通文本。 */
  maxShortCodeLen?: number
}

export type MarkdownFixRule = (md: string, options: Required<FixOptions>) => string

import { fixSingleLineTables } from './rules/single-line-tables.js'
import { fixTableHeadersAndColumns } from './rules/table-headers-columns.js'
import { fixNonStandardSeparator } from './rules/non-standard-separator.js'
import { fixPunctuationCode } from './rules/punctuation-code.js'

/** 规则注册表: 名称 → 实现(顺序即默认执行顺序)。 */
export const RULES: Record<string, MarkdownFixRule> = {
  singleLineTables: fixSingleLineTables,
  tableHeadersColumns: fixTableHeadersAndColumns,
  nonStandardSeparator: fixNonStandardSeparator,
  punctuationCode: fixPunctuationCode,
}

export const DEFAULT_RULES = Object.keys(RULES)

function normalizeOptions(options: FixOptions = {}): Required<FixOptions> {
  return {
    rules: options.rules ?? DEFAULT_RULES,
    maxShortCodeLen: options.maxShortCodeLen ?? 4,
  }
}

/** 主入口: 按管线依次执行启用的规则。 */
export function fixMarkdown(input: string, options: FixOptions = {}): string {
  if (!input) return input
  const opts = normalizeOptions(options)
  let out = input
  for (const name of opts.rules) {
    const rule = RULES[name]
    if (!rule) continue
    out = rule(out, opts)
  }
  return out
}

export { fixSingleLineTables, fixTableHeadersAndColumns, fixNonStandardSeparator, fixPunctuationCode }
