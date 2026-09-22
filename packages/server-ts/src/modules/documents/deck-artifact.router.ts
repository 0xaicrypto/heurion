/**
 * #1101（pptx 字节单一标准）— deck pptx 工件 HTTP 端点（人类保存路径）。
 *
 * - GET  /api/v1/docs/:docId/deck-artifact → { artifactId, version, downloadUrl }
 *   （tokenized file download URL，复用 files 模块的 chart-token 机制 —
 *   <img>/react-viewer 无鉴权头也能拉字节；无工件 → 404）
 * - POST /api/v1/docs/:docId/deck-artifact → 原始 pptx 字节体
 *   （octet-stream 或 pptx mime；header X-Deck-Base = 调用方所基于的旧工件
 *   版本戳 — 乐观锁，服务端当前工件已推进 → 409 提示重载，设计 §6 残余
 *   并发写防线）→ putDeckArtifact（writeSource 'human'）→
 *   200 { ok, artifactId, version } / 409 冲突 / 400 非法 pptx / 404 非本人。
 *
 * 归属校验跟随现有 doc 路由口径：findFirst({ id, userId }) → 404（防枚举，
 * citations.router 同款）。字节体上限 50MB（MAX_DECK_BYTES，超限 413）。
 */
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { findOwned } from '../../common/ownership.js'
import { issueChartToken } from '../../common/chart-token.js'
import { parsePptx, PPTX_MIME_TYPE } from '../../lib/pptx-extractor.js'
import { DeckBytesError, getDeckArtifact, putDeckArtifact } from '../../lib/deck-bytes.js'

/** 路由级请求体上限（与 MAX_DECK_BYTES 对齐 — Fastify 默认 1MB 会被 MB 级
 * pptx 撞破；超限 413 而非裸 500，对齐 files.router 超限语义）。 */
const DECK_BODY_LIMIT = 50 * 1024 * 1024

async function ownedDoc(request: FastifyRequest<{ Params: { docId: string } }>) {
  const userId = request.user!.userId
  return findOwned(prisma.doc, request.params.docId, userId)
}

export async function deckArtifactRouter(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard)

  // 原始字节体解析（本路由作用域内）：octet-stream 与 pptx mime 直通 Buffer。
  const rawParser = (_req: unknown, body: unknown, done: (err: Error | null, body?: Buffer) => void) => {
    done(null, Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? '')))
  }
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, rawParser)
  app.addContentTypeParser(PPTX_MIME_TYPE, { parseAs: 'buffer' }, rawParser)

  app.get('/api/v1/docs/:docId/deck-artifact', async (request, reply) => {
    const doc = await ownedDoc(request as never)
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const artifact = await getDeckArtifact(doc.id)
    if (!artifact) return reply.status(404).send({ error: 'Deck artifact not found' })
    const userId = request.user!.userId
    return {
      artifact_id: artifact.artifactId,
      version: artifact.version,
      mime: artifact.mime,
      updated_at: artifact.updatedAt,
      // tokenized download（files 模块同机制 — 短时效 chart token 带 owner）。
      download_url: `/api/v1/files/download/${artifact.artifactId}?token=${issueChartToken(artifact.artifactId, userId)}`,
    }
  })

  app.post('/api/v1/docs/:docId/deck-artifact', { bodyLimit: DECK_BODY_LIMIT }, async (request, reply) => {
    const doc = await ownedDoc(request as never)
    if (!doc) return reply.status(404).send({ error: 'Document not found' })

    const bytes = request.body as unknown
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return reply.status(400).send({ error: 'Expected raw pptx bytes (application/octet-stream or pptx mime)' })
    }
    // 入口校验：字节必须可解析为 pptx — 拒绝垃圾工件入库（真相源纪律）。
    const parsed = parsePptx(bytes)
    if (!parsed.ok) {
      return reply.status(400).send({ error: parsed.error || '无法解析 PPTX' })
    }

    // 乐观锁：X-Deck-Base = 调用方所基于的旧工件版本戳。服务端工件已推进
    // （其他窗口已保存）→ 409 提示重载（设计 §6：后写者不得静默覆盖先写者）。
    const baseArtifact = request.headers['x-deck-base']
    const current = doc.deckArtifactId || ''
    if (typeof baseArtifact === 'string' && baseArtifact && baseArtifact !== current) {
      return reply.status(409).send({
        error: 'deck 已被其他窗口修改（工件版本不一致），请刷新后重试',
        current_version: current || null,
      })
    }

    const userId = request.user!.userId
    try {
      const put = await putDeckArtifact({
        userId,
        docId: doc.id,
        bytes,
        baseDeck: doc.deck ?? null,
        writeSource: 'human',
      })
      if (put.conflict) return reply.status(409).send({ error: put.error || '写回冲突，请刷新后重试' })
      if (put.error) return reply.status(500).send({ error: put.error })
      return { ok: true, artifact_id: put.artifactId, version: put.version, changed: put.changed }
    } catch (err) {
      if (err instanceof DeckBytesError) {
        return err.status === 'not-found' ? reply.status(404).send({ error: err.message }) : reply.status(400).send({ error: err.message })
      }
      return reply.status(500).send({ error: (err as Error).message.slice(0, 200) })
    }
  })
}
