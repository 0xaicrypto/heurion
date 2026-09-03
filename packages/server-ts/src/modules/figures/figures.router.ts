/**
 * #820/#822 — 图库"学术渲染"HTTP 面:源码溯源查看 + 强制重渲染。
 * 渲染编排在 figure.service;本 router 只做校验与 HTTP 映射(#687 惯例)。
 */
import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import { ensureFigure, getFigureRenderByFileId } from './figure.service.js'

export async function figuresRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // 图库"查看源码" — FigureRender 溯源(kind + 源码 + options)。
  app.get('/api/v1/figures/:fileId/source', async (request, reply) => {
    const userId = request.user!.userId
    const { fileId } = request.params as { fileId: string }
    if (!fileId.startsWith('fig_')) return reply.status(400).send({ error: 'not a figure file' })
    const row = await getFigureRenderByFileId(userId, fileId)
    if (!row) return reply.status(404).send({ error: 'figure render record not found' })
    return {
      kind: row.kind,
      source: row.source,
      options: JSON.parse(row.optionsJson || '{}'),
      width: row.width,
      height: row.height,
      rendered_ms: row.renderedMs,
      created_at: row.createdAt,
    }
  })

  // 图库"重渲染" — 同源码强制新渲染(force 跳过缓存),旧产物保留。
  app.post('/api/v1/figures/:fileId/rerender', async (request, reply) => {
    const userId = request.user!.userId
    const { fileId } = request.params as { fileId: string }
    if (!fileId.startsWith('fig_')) return reply.status(400).send({ error: 'not a figure file' })
    const row = await getFigureRenderByFileId(userId, fileId)
    if (!row) return reply.status(404).send({ error: 'figure render record not found' })
    const options = JSON.parse(row.optionsJson || '{}')
    const result = await ensureFigure(userId, {
      kind: row.kind as 'mermaid' | 'latex_math',
      source: row.source,
      display: options.display,
      theme: options.theme,
      scale: options.scale,
    }, { force: true })
    if (!result.ok) return reply.status(502).send({ error: result.reason })
    return { file_id: result.file.fileId, url: result.file.url, width: result.file.width, height: result.file.height }
  })
}
