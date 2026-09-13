/**
 * R3 — doom-loop detection (opencode processor.ts parity).
 *
 * The same tool called 3+ consecutive times with identical arguments is
 * almost always a stuck loop (the model keeps re-invoking because the
 * result doesn't satisfy it). Detected pre-execution so the extra calls
 * can be surfaced as a warning before burning more tokens.
 *
 * #1024: 参数字节完全相同只是最粗的形态 — 模型每次换一个猜测（锚点文本
 * 略改）就能绕过，靠轮次耗尽兜底。新增「同工具 + 同错误分类连续失败 N 次」
 * 的语义熔断，与字节比对是 OR 关系（不是替换）。
 */

export interface ToolCallEntry {
  tool: string
  argsKey: string
}

function argsKeyOf(args: unknown): string {
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return String(args ?? '')
  }
}

/**
 * Push the current call onto a rolling history and return whether it is a
 * doom-loop: the LAST THREE entries (including this one) are the same tool
 * with the same serialized arguments.
 */
export function detectDoomLoop(
  history: ToolCallEntry[],
  tool: string,
  args: unknown,
): boolean {
  const key = argsKeyOf(args)
  history.push({ tool, argsKey: key })
  if (history.length < 3) return false
  const last3 = history.slice(-3)
  return last3.every((e) => e.tool === tool && e.argsKey === key)
}

/* ── #1024: 失败语义分类 + 连续同类失败检测 ────────────────────────── */

export type ToolFailureClass =
  | 'empty_args'
  | 'anchor_not_found'
  | 'ambiguous_anchor'
  | 'section_invalid'
  | 'conflict'
  | 'timeout'
  | 'budget'
  | 'not_found'
  | 'tool_error'

/** 同一工具因同一类错误连续失败达到该次数 → 语义熔断（停止继续重试）。 */
export const FAILURE_STREAK_THRESHOLD = 3

/**
 * 工具错误文本 → 稳定分类。顺序敏感：先具体（锚点歧义）后泛化（找不到）。
 * 分类只用于观测/熔断判定，不改变错误原文回传。
 */
export function classifyToolFailure(error: string | undefined): ToolFailureClass {
  const e = String(error || '')
  if (!e.trim()) return 'tool_error'
  if (/多次|出现多次|ambiguous|唯一/i.test(e)) return 'ambiguous_anchor'
  if (/old_text|锚点|原文|没找到|未找到|不匹配|no match|not found in document/i.test(e)) return 'anchor_not_found'
  if (/section|节 id|target_section|id 已失效|节引用/i.test(e)) return 'section_invalid'
  if (/没有任何参数|空参|参数在传输中丢失|empty args|no arguments/i.test(e)) return 'empty_args'
  if (/并发修改|已被并发|stale|conflict|乐观锁/i.test(e)) return 'conflict'
  if (/超时|执行超过|timed out|timeout|无数据|被中止/i.test(e)) return 'timeout'
  if (/预算|budget|上限|额度/i.test(e)) return 'budget'
  if (/not found|不存在/i.test(e)) return 'not_found'
  return 'tool_error'
}

export interface ToolFailureEntry {
  tool: string
  failureClass: ToolFailureClass
}

/**
 * 语义熔断判定：history 末尾（含本次）连续 threshold 条为「同工具 + 同
 * 分类」失败 → true。不同分类出现即中断连续计数（调用方在分类变化时重置/
 * 由末尾判断自然失效）。history 元素为「已执行完成」的失败记录。
 */
export function detectFailureStreak(
  history: ToolFailureEntry[],
  tool: string,
  failureClass: ToolFailureClass,
  threshold: number = FAILURE_STREAK_THRESHOLD,
): boolean {
  if (threshold <= 1) return true
  if (history.length < threshold) return false
  const tail = history.slice(-threshold)
  return tail.every((e) => e.tool === tool && e.failureClass === failureClass)
}

/** 语义熔断命中后的纠偏消息（注入模型上下文 + 芯片预览）。 */
export function failureStreakCorrection(tool: string, failureClass: ToolFailureClass, count: number): string {
  return `该工具（${tool}）已因同类错误（${failureClass}）连续失败 ${count} 次，本次调用已跳过。请更换策略（改用其他工具或修正参数来源），或直接向用户说明失败原因与建议，不要再用相同方式重试。`
}
