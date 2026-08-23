import crypto from 'crypto'

/**
 * Generated-chart/scene download tokens (#176/#213/#440): <img src> cannot
 * send an Authorization header, so render tools issue a self-contained,
 * stateless query token bound to the file AND its owner. HMAC-signed (no
 * memory Map): survives server restarts; expiry is embedded in the token.
 *
 * Pure crypto utility — lives in `common/` so the tools layer can issue
 * tokens without importing from `modules/*` (layering, #666).
 */
const CHART_TOKEN_SECRET = process.env.CHART_TOKEN_SECRET || process.env.SERVER_SECRET || 'dev-secret-key'
const CHART_TOKEN_TTL_MS = parseInt(process.env.CHART_TOKEN_TTL_MS || (90 * 24 * 3600 * 1000).toString(), 10)

function signChartToken(fileId: string, userId: string, exp: number): string {
  return crypto.createHmac('sha256', CHART_TOKEN_SECRET)
    .update(`${fileId}\n${exp}\n${userId}`)
    .digest('base64url')
}

export function issueChartToken(fileId: string, userId: string, ttlMs = CHART_TOKEN_TTL_MS): string {
  const exp = Date.now() + ttlMs
  return `${exp.toString(36)}.${Buffer.from(userId).toString('base64url')}.${signChartToken(fileId, userId, exp)}`
}

export function verifyChartToken(fileId: string, token: string): string | null {
  const [expB36, userIdB64, sig] = token.split('.')
  if (!expB36 || !userIdB64 || !sig) return null
  const exp = parseInt(expB36, 36)
  if (!Number.isFinite(exp) || Date.now() > exp) return null
  const userId = Buffer.from(userIdB64, 'base64url').toString()
  const expected = signChartToken(fileId, userId, exp)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!crypto.timingSafeEqual(a, b)) return null
  return userId
}
