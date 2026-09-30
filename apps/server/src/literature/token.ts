import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * 文献 MCP 的访问令牌：绑定到单个文档，由 heurion 签发、经 env 交给该文档的 dsh 进程。
 * 格式 `<docId>.<hmac>`，不含过期时间 —— 进程回收即作废（重启会重新签发同值，PoC 可接受）。
 */
export function signDocToken(secret: string, docId: string): string {
  return `${docId}.${createHmac('sha256', secret).update(`mcp:${docId}`).digest('base64url')}`
}

export function verifyDocToken(secret: string, token: string): string | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const docId = token.slice(0, dot)
  const expected = Buffer.from(signDocToken(secret, docId))
  const actual = Buffer.from(token)
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? docId : null
}
