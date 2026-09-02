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

/**
 * #fix: 文档图片 URL 自愈 — 读取文档(body/deck)时统一重写文件下载 URL：
 * - 旧版 generate_image 坏链 `/api/v1/files/<id>/download`（该形状在主
 *   服务器上无路由且无 token；模型曾把工具输出里的这个坏 URL 写进文档
 *   正文）→ canonical + 新签 token；
 * - canonical URL 的 token 过期（90d TTL）或历史签名失效 → 重签。
 * 仅改写响应、不落库 — 编辑器(TipTap)/deck/预览三条渲染路径同时拿到
 * 可直接被 <img> 加载的 URL（<img> 无法携带 Authorization 头）。
 */
export function refreshFileUrls(text: string, userId: string): string {
  if (!text || !text.includes('/api/v1/files/')) return text
  const mint = (_m: string, id: string) => `/api/v1/files/download/${id}?token=${issueChartToken(id, userId)}`
  return (
    text
      // canonical 形状 — 重签 token（过期/陈旧签名/缺失均覆盖）。
      .replace(/\/api\/v1\/files\/download\/([\w.\-]+)(?:\?token=[^\s)"'\\]*)?/g, mint)
      // 旧版坏链形状 — 负向排除 canonical 与 preview-page 前缀。
      .replace(/\/api\/v1\/files\/(?!download\/|preview-page\/)([\w.\-]+)\/download(?:\?token=[^\s)"'\\]*)?/g, mint)
  )
}
