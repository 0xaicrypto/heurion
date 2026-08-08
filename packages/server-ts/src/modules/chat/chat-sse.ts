/**
 * #303: SSE transport for /agent/chat — a thin wrapper over the raw socket
 * so handlers never touch writeHead/write directly. Owns the disconnect
 * abort signal and the final close.
 */
import type { FastifyReply } from 'fastify'

export interface SseSender {
  send(d: unknown): void
  /** Abort signal fired when the client disconnects. */
  signal: AbortSignal
  end(): void
}

export function createSseSender(reply: FastifyReply): SseSender {
  const controller = new AbortController()
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  // #185: stop LLM work on client disconnect (no wasted tokens), never write
  // to a destroyed socket.
  reply.raw.on('close', () => { try { controller.abort() } catch { /* ignore */ } })
  return {
    send: (d) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return
      try { reply.raw.write(`data: ${JSON.stringify(d)}\n\n`) } catch { /* socket gone */ }
    },
    signal: controller.signal,
    end: () => { try { reply.raw.end() } catch { /* already closed */ } },
  }
}
