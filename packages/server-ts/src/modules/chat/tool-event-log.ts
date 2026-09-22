/**
 * #1106 — 工具事件留痕通道（自 tool-loop.ts 提取）。
 *
 * #658 write-time truncation：tool_result 事件落 eventLog 前做写时截断 —
 * 超长输出溢写到 per-user truncation 目录，事件仅保留预览 + 磁盘路径
 * （供未来「查看完整输出」流程恢复）。eventLog（及其上层的 history /
 * extraction / compaction 全部 LLM 上下文读路）无需独立 prune pass 即可
 * 保持有界。
 *
 * 提取为独立模块：runToolCallLoop 不再内联这段 I/O 策略，单元可独立
 * 测试（截断阈值/溢写文件名/失败降级切片）。
 */
import type { getUserContext } from '../shared/user-context.js'
import { twinsRoot } from '../../lib/upload-path.js'

/** tool_result 事件正文字符上限（超出溢写磁盘）。 */
export const TOOL_EVENT_TRUNCATE_CHARS = 500

export type ToolEventAppender = (
  eventType: string,
  content: string,
  metadata: Record<string, unknown>,
) => Promise<void>

/**
 * 创建 per-session 的工具事件写入器。溢写目录 = twinsRoot/<userId>/truncation，
 * 文件名含 sessionId（清洗后）+ 时间戳 + 随机后缀，避免并发冲突。
 */
export function createToolEventAppender(params: {
  ctx: Awaited<ReturnType<typeof getUserContext>>
  userId: string
  sessionId: string
}): ToolEventAppender {
  const { ctx, userId, sessionId } = params
  return async (eventType: string, content: string, metadata: Record<string, unknown>) => {
    let body = content
    if (eventType === 'tool_result' && body.length > TOOL_EVENT_TRUNCATE_CHARS) {
      try {
        const { mkdir, writeFile } = await import('fs/promises')
        const { join } = await import('path')
        const baseDir = twinsRoot()
        const dir = join(baseDir, userId, 'truncation')
        await mkdir(dir, { recursive: true })
        const name = `tool_${sessionId.replace(/[^\w-]/g, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
        await writeFile(join(dir, name), content, 'utf-8')
        body = `[Tool output truncated to ${TOOL_EVENT_TRUNCATE_CHARS} chars — full output spilled to ${name}]\n${content.slice(0, TOOL_EVENT_TRUNCATE_CHARS)}`
        metadata = { ...metadata, truncatedTo: TOOL_EVENT_TRUNCATE_CHARS, spillFile: name }
      } catch {
        body = content.slice(0, TOOL_EVENT_TRUNCATE_CHARS)
      }
    }
    ctx.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType,
      content: body,
      metadata,
      agentId: userId,
      sessionId,
    })
  }
}
