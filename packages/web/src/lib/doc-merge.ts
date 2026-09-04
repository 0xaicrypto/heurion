/**
 * #837 — AI 写回的三路行级合并。
 *
 * 场景:审阅未决时 AI 又完成了一轮写回 — 服务端基于旧正文(用户尚未
 * 接受上一轮)计算出新正文。审阅结束后重放时,若用户接受了上一轮
 * (正文已前移),直接 diff 会把上一轮的修改"反转"回去(生产事故:顺序乱)。
 * 此处以「服务端写回基线」为共同祖先,把前后两轮的非重叠改动合并;
 * 重叠(冲突)返回 null,由调用方提示并丢弃该轮写回。
 */
import { structuredPatch } from 'diff'

interface Hunk {
  oldStart: number
  oldLines: number
  lines: string[]
}

/**
 * mergeThreeWay(base, ours, theirs) → 合并结果;有冲突返回 null。
 * - ours = 用户当前正文(上一轮审阅已接受/拒绝后的状态)
 * - theirs = AI 在旧基线上写出的新正文
 * - base = 服务端计算 theirs 时的正文基线
 */
export function mergeThreeWay(base: string, ours: string, theirs: string): string | null {
  if (base === ours) return theirs
  if (base === theirs) return ours

  // 纯追加特例:双方都只是在 base 末尾追加(多节写作的常见形态 — AI
  // 每轮追加一节),行级合并会误判为"末行双方都改"冲突;直接拼接。
  if (ours.startsWith(base) && theirs.startsWith(base)) {
    return ours + theirs.slice(base.length)
  }

  // diff v9 签名:structuredPatch(oldFile, newFile, oldStr, newStr, oldHeader, newHeader, options)。
  // context=0: 纯变更 hunk(应用逻辑按行号定位,不依赖上下文),避免相邻
  // 段落的改动因上下文行重叠被误判为冲突。
  const patchA = structuredPatch('base', 'ours', base, ours, undefined, undefined, { context: 0 })
  const patchB = structuredPatch('base', 'theirs', base, theirs, undefined, undefined, { context: 0 })

  // 冲突检测:A/B 任一 hunk 在 base 坐标上区间相交 → 无法安全合并。
  for (const ha of patchA.hunks) {
    for (const hb of patchB.hunks) {
      const aStart = ha.oldStart
      const aEnd = ha.oldStart + ha.oldLines
      const bStart = hb.oldStart
      const bEnd = hb.oldStart + hb.oldLines
      if (aStart < bEnd && bStart < aEnd) return null
    }
  }

  // 应用:两份 hunk 都以 base 行号定位,按 oldStart 归并后顺序应用。
  const all: Array<Hunk & { tag: 'a' | 'b' }> = [
    ...patchA.hunks.map((h) => ({ ...h, tag: 'a' as const })),
    ...patchB.hunks.map((h) => ({ ...h, tag: 'b' as const })),
  ].sort((x, y) => x.oldStart - y.oldStart || x.oldLines - y.oldLines)

  const baseLines = base.split('\n')
  const out: string[] = []
  let cursor = 0 // 下一个未消费的 base 行(0-based)
  for (const h of all) {
    const start = h.oldStart - 1 // structuredPatch 行号 1-based
    while (cursor < start && cursor < baseLines.length) out.push(baseLines[cursor++])
    for (const line of h.lines) {
      // "\ No newline at end of file" 是元信息,不占 base 行
      if (line.startsWith('\\')) continue
      if (line.startsWith('+')) {
        out.push(line.slice(1))
      } else {
        // '-'(base 行被删)与 ' '(上下文)都消费一行 base
        cursor++
      }
    }
  }
  while (cursor < baseLines.length) out.push(baseLines[cursor++])
  return out.join('\n')
}
