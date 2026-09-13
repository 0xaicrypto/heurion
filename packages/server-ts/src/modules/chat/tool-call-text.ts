/**
 * #1033 — `<tool_call>` 标记清理（终态文本 + 流式通道）。
 *
 * 事故根因：tool-loop 只对「最终文本」做闭合块清理；当循环以空 finalContent
 * 结束时，conversation-turn 的流式 fallback 会把含原始 `<tool_call>` 的历史
 * 再次喂给模型并原样流式输出。这里提供两级防御：
 * - `stripToolCallBlocks`：非流式文本清理（含未闭合块，丢弃到文本末尾）；
 * - `createToolCallStreamFilter`：流式过滤（跨 chunk 的标记也能拦住，
 *   未闭合块在 flush 时整体丢弃）。
 */

const OPEN = '<tool_call>'
const CLOSE = '</tool_call>'

/** 非流式清理：先删闭合块，再从首个未闭合 `<tool_call>` 起丢弃余下文本。 */
export function stripToolCallBlocks(text: string | null | undefined): string {
  let out = String(text || '')
  if (!out) return ''
  out = out.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
  const openIdx = out.indexOf(OPEN)
  if (openIdx >= 0) out = out.slice(0, openIdx)
  // 残留的孤立闭合标记一并清掉（模型截断时常见）。
  out = out.replace(/<\/tool_call>/g, '')
  return out.trim()
}

export interface ToolCallStreamFilter {
  /** 输入增量文本，返回可立即下发的干净文本（可能为空）。 */
  push: (chunk: string) => string
  /** 流结束时调用：吐出被缓冲但安全的文本；未闭合块整体丢弃。 */
  flush: () => string
}

/** 可能作为 OPEN 前缀但尚未完整的后缀长度（如 "<tool_"）。 */
function partialMarkerSuffix(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1)
  for (let n = max; n > 0; n--) {
    if (s.endsWith(marker.slice(0, n))) return n
  }
  return 0
}

/** 流式过滤：缓冲 `<tool_call>…</tool_call>` 区间（含跨 chunk 标记），其余立即透传。 */
export function createToolCallStreamFilter(): ToolCallStreamFilter {
  // hold = 尚未决定去留的文本；inside = 已进入 <tool_call> 块等待闭合。
  let hold = ''
  let inside = false
  return {
    push(chunk: string): string {
      hold += chunk
      let out = ''
      for (;;) {
        if (inside) {
          const closeIdx = hold.indexOf(CLOSE)
          if (closeIdx < 0) {
            // 只保留可能是 CLOSE 前缀的尾巴，其余块内容丢弃。
            if (hold.length > CLOSE.length) hold = hold.slice(-CLOSE.length)
            return out
          }
          hold = hold.slice(closeIdx + CLOSE.length)
          inside = false
          continue
        }
        const openIdx = hold.indexOf(OPEN)
        if (openIdx >= 0) {
          out += hold.slice(0, openIdx)
          hold = hold.slice(openIdx + OPEN.length)
          inside = true
          continue
        }
        const keep = partialMarkerSuffix(hold, OPEN)
        out += hold.slice(0, hold.length - keep)
        hold = keep > 0 ? hold.slice(-keep) : ''
        return out
      }
    },
    flush(): string {
      const rest = hold
      hold = ''
      if (inside) return ''
      const openIdx = rest.indexOf(OPEN)
      return openIdx >= 0 ? rest.slice(0, openIdx) : rest
    },
  }
}
