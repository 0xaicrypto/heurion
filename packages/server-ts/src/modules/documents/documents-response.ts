/**
 * documents.router 响应形状辅助 — deck/projection JSON 安全解析与文件
 * URL 自愈（refreshFileUrls 的结构包装）。从 documents.router.ts 拆出
 * （P2 大文件棘轮；#1128 token 归一化改动让主文件超基线）。
 */
import type { Doc } from '@prisma/client'
import { refreshFileUrls } from '../../common/chart-token.js'

/** #773: Doc.deck 存 JSON 字符串 — 线上返回解析后的对象（损坏容错为 null）。 */
export function parseDeck(deck: unknown): unknown {
  if (typeof deck !== 'string' || !deck) return null
  try { return JSON.parse(deck) } catch { return null }
}

/** #fix: deck 内嵌图片 URL 自愈（refreshFileUrls 的 JSON 结构包装）。 */
export function refreshDeckUrls(deck: unknown, userId: string): unknown {
  if (!deck) return deck
  try { return JSON.parse(refreshFileUrls(JSON.stringify(deck), userId)) } catch { return deck }
}

/** #989 Phase 3: 投影 JSON 解析（损坏容错为 null，同 parseDeck 口径）。 */
export function parseBlockProjection(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/** #996/#997: 409 冲突响应携带服务端当前完整态 — 旧契约只有
 *  current_updated_at，前端渲染「Yours / AI's」双栏对照需再发一次 GET 全文；
 *  现将当前 title/body/deck/投影一次性随 409 下发，双栏零额外请求。
 *  口径与 GET /docs/:docId 一致（refreshFileUrls/refreshDeckUrls 自愈文件 URL）。 */
export function buildConflictCurrent(doc: Doc, userId: string): {
  title: string
  body: string
  deck: unknown
  block_projection: unknown
  updated_at: string
} {
  return {
    title: doc.title,
    body: refreshFileUrls(String(doc.body ?? ''), userId),
    deck: refreshDeckUrls(parseDeck(doc.deck), userId),
    block_projection: parseBlockProjection(doc.blockProjection),
    updated_at: doc.updatedAt,
  }
}
