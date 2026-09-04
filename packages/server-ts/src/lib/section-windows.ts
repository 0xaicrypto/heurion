/**
 * 章节感知的事实抽取窗口(file-pipeline propose 阶段)。
 *
 * markdown 标题优先断开(结构来自 document-extractor 的结构恢复,非启发式
 * 猜测),超长章节内部用 chunkText(段落感知)滑窗;跨章节 round-robin
 * 轮转取窗,预算摊平到全文 — 长文档尾部(Results/Discussion 等 fact 密度
 * 最高处)不再被 head-only 截断丢弃。纯函数,便于单元测试。
 */
import { chunkText } from './text-chunker.js'

/** Markdown 标题行(#..###### + 空格 + 非空文字)。 */
const MD_HEADING_RE = /^#{1,6}\s+\S/

/**
 * 按标题切章节(标题行开启新章节,标题前的文字为上一节/前言),
 * 超长章节内部段落感知滑窗,跨章节 round-robin 轮转取窗 —
 * 同一轮内各章节各取一窗,预算耗尽即停。短文档退化为单窗口。
 */
export function buildSectionWindows(text: string, windowChars: number, maxWindows: number): string[] {
  const sections: string[] = []
  let current: string[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (MD_HEADING_RE.test(line) && current.length > 0) {
      sections.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) sections.push(current.join('\n'))
  const perSection = sections
    .filter((s) => s.trim())
    .map((s) => (s.length <= windowChars ? [s] : chunkText(s, { size: windowChars, overlap: 0 })))
  const windows: string[] = []
  let round = 0
  while (windows.length < maxWindows) {
    let took = 0
    for (const parts of perSection) {
      if (windows.length >= maxWindows) break
      if (round < parts.length) {
        windows.push(parts[round])
        took++
      }
    }
    if (took === 0) break
    round++
  }
  return windows
}
