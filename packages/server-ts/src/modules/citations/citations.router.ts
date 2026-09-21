/**
 * #1083/#1084（epic）— 正式参考文献端点。
 *
 * - GET    /api/v1/docs/:docId/citations            → 结构化引用列表（唯一事实源）
 * - GET    /api/v1/docs/:docId/citations/dangling   → 悬挂引用诊断（正文 [cite:id]
 *   找不到 DocCitation 记录 — 迁移未命中/数据异常/跨文档复制，#1081）
 * - DELETE /api/v1/docs/:docId/citations/:citationId → 删除引用记录（清理入口；
 *   正文标记的移除由前端/AI 编辑链路完成）
 *
 * 归属校验跟随现有 doc 路由口径：findFirst({ id, userId }) → 404（防枚举）。
 * 序号不落库 — 渲染/导出按正文 shortcode 首现顺序动态计算（contracts）。
 */
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { assignCitationNumbers } from '@heurion/contracts'
import {
  listDocCitations,
  getDocCitation,
  deleteDocCitation,
  serializeDocCitation,
} from '../../lib/citation-store.js'

async function ownedDoc(request: FastifyRequest<{ Params: { docId: string } }>) {
  const userId = request.user!.userId
  return prisma.doc.findFirst({ where: { id: request.params.docId, userId } })
}

export async function citationsRouter(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/docs/:docId/citations', async (request, reply) => {
    const doc = await ownedDoc(request as never)
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const rows = await listDocCitations(doc.id)
    return { citations: rows.map(serializeDocCitation) }
  })

  app.get('/api/v1/docs/:docId/citations/dangling', async (request, reply) => {
    const doc = await ownedDoc(request as never)
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    // #1081: 悬挂引用 = 正文 shortcode 有编号位但无 DocCitation 记录。
    // 编号算法与在线渲染/References 列表/导出共用 contracts.assignCitationNumbers。
    const body = String(doc.body || '')
    const known = await listDocCitations(doc.id)
    const knownIds = new Set(known.map((c) => c.id))
    const dangling: Array<{ id: string; occurrences: number }> = []
    for (const id of assignCitationNumbers(body).keys()) {
      if (!knownIds.has(id)) {
        const occurrences = [...body.matchAll(new RegExp(`\\[cite:${id}\\]`, 'g'))].length
        dangling.push({ id, occurrences })
      }
    }
    return { dangling, citations: known.map(serializeDocCitation) }
  })

  app.delete('/api/v1/docs/:docId/citations/:citationId', async (request, reply) => {
    const doc = await ownedDoc(request as never)
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const { citationId } = request.params as { citationId: string }
    const target = await getDocCitation(doc.id, citationId)
    if (!target) return reply.status(404).send({ error: 'Citation not found' })
    await deleteDocCitation(doc.id, citationId)
    return { ok: true }
  })
}
