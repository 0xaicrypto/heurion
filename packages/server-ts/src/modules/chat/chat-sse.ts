/**
 * #303: SSE transport for /agent/chat — a thin wrapper over the raw socket
 * so handlers never touch writeHead/write directly. Owns the disconnect
 * abort signal and the final close.
 */
import type { FastifyReply } from 'fastify'
import type { ChatStreamChunk } from '@heurion/contracts'

export type SendEvent = (event: ChatStreamChunk) => void

export interface SseSender {
  send(d: ChatStreamChunk): void
  /** Abort signal fired when the client disconnects. */
  signal: AbortSignal
  end(): void
}

export function createSseSender(reply: FastifyReply): SseSender {
  // #790: typed facade over the raw transport — polish 等非 chat 流复用
  // 同一套 wire 语义（headers/断连 abort/关闭），不再各写一份 writeHead。
  const raw = createRawSseSender(reply)
  return {
    send: (d) => raw.send(d),
    signal: raw.signal,
    end: () => raw.end(),
  }
}

/**
 * #790: 无 chat 语义的 SSE 传输 — 形状与 createSseSender 相同，但 send
 * 接受 unknown（如 polish 的 {text}/{type:'reasoning'} 流）。此前
 * documents.router 手写 writeHead + (d:any) => raw.write，headers/close/
 * 心跳语义重复实现且无断连感知。
 */
export function createRawSseSender(reply: FastifyReply): { send: (d: unknown) => void; signal: AbortSignal; end(): void } {
  const controller = new AbortController()
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  // #fix: SSE 心跳 — 网关/Cloudflare 会掐断约 100s 无字节的连接。工具执行
  // 期间（render_scene / generate_image / edit_document / delegate）没有任何
  // 事件下发，浏览器端表现为 "网络连接中断（服务器可能已重启或网络不稳定）"。
  // 每 15s 写一行 SSE 注释（`: ping`）保活；前端 parseSseStream 只消费
  // `data: ` 行，注释被透明忽略。
  const heartbeat = setInterval(() => {
    if (reply.raw.destroyed || reply.raw.writableEnded) return
    try { reply.raw.write(': ping\n\n') } catch { /* socket gone */ }
  }, 15_000)
  // unref: 心跳绝不阻止进程退出（测试/优雅停机）。
  heartbeat.unref?.()
  const stopHeartbeat = () => clearInterval(heartbeat)
  reply.raw.on('close', () => { stopHeartbeat(); try { controller.abort() } catch { /* ignore */ } })
  return {
    send: (d) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return
      try { reply.raw.write(`data: ${JSON.stringify(d)}\n\n`) } catch { /* socket gone */ }
    },
    signal: controller.signal,
    end: () => { stopHeartbeat(); try { reply.raw.end() } catch { /* already closed */ } },
  }
}
