/**
 * #1083/#1084（epic）— 正式参考文献端点。
 *
 * - GET    /api/v1/docs/:docId/citations              → 结构化引用列表（唯一事实源）
 * - GET    /api/v1/docs/:docId/citations/dangling     → 悬挂引用诊断（正文 + deck 内容合并
 *   扫描，复用 citation-store.findDanglingCitations 单一实现）
 * - DELETE /api/v1/docs/:docId/citations/:citationId   → 删除引用记录（真实记录场景）
 * - POST   /api/v1/docs/:docId/citations/dangling/:citationId/remove → 清除悬挂引用标记
 *   （悬挂引用按定义无记录可删；正文 + deck 内容同帧清理 — 与 GET /dangling
 *   的扫描范围一致；body 基于客户端 base_body 计算 + writeDocVersion 乐观锁，
 *   deck 侧以 base_deck 显式比对，避免覆盖用户未保存的编辑）
 *
 * 安全（复审安全漏洞 #1 修复）：citationId 路由参数在进入任何字符串拼接/
 * 正则构造前必须过 `CITE_ID_SAFE` 白名单（contracts shortcode 字符集
 * [A-Za-z0-9_-]+）；标记定位/计数/移除全部用字符串 split 语义（零 RegExp
 * 构造）— 正则注入/ReDoS 攻击面整类消除。
 *
 * 归属校验跟随现有 doc 路由口径：findFirst({ id, userId }) → 404（防枚举）。
 */
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { CITE_SHORTCODE_SINGLE } from '@heurion/contracts'
import {
  listDocCitations,
  getDocCitation,
  deleteDocCitation,
  serializeDocCitation,
  findDanglingCitations,
  deckCitationText,
  stripCitationMarkers,
  stripDeckCitationMarkers,
} from '../../lib/citation-store.js'
import { writeDocVersion } from '../../tools/doc-version-writer.js'

async function ownedDoc(request: FastifyRequest<{ Params: { docId: string } }>) {
  const userId = request.user!.userId
  return prisma.doc.findFirst({ where: { id: request.params.docId, userId } })
}

/** 悬挂标记计数（字符串语义，零 RegExp — citationId 攻击面隔离）。 */
function countMarkers(text: string, citationId: string): number {
  const marker = `[cite:${citationId}]`
  return text.split(marker).length - 1
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
    // #1081: 悬挂引用 = shortcode 有编号位但无 DocCitation 记录。
    // 复审 #8 修复: 正文 + deck 内容合并扫描（deck 内悬挂在健康横幅同样可见），
    // 复用 citation-store 单一实现（规范扩展时单一同步点）。
    const dangling = await findDanglingCitations(doc.id, String(doc.body || ''), doc.deck)
    const citations = await listDocCitations(doc.id)
    return { dangling, citations: citations.map(serializeDocCitation) }
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

  // 复审 #2 修复 — 悬挂引用的「删除」语义 = 清除正文/deck 中的标记本身
  // （悬挂引用按定义没有 DocCitation 记录，复用面向真实记录的 DELETE 必然 404）。
  // 复审 #3 修复 — 与 GET /dangling 扫描范围对齐：deck 内的悬挂标记同帧清除
  // （此前只处理 body，deck-only 悬挂点击删除必然 404）。
  // 复审 #1 修复 — citationId 白名单强校验（400）+ 全程字符串语义（零 RegExp 构造）。
  app.post('/api/v1/docs/:docId/citations/dangling/:citationId/remove', async (request, reply) => {
    const doc = await ownedDoc(request as never)
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const { citationId } = request.params as { citationId: string }
    if (!CITE_SHORTCODE_SINGLE.test(citationId)) {
      return reply.status(400).send({ error: 'Invalid citation id format' })
    }
    // 复审轮 4（P0/P1）— body/deck **对称**基线协议：
    //   base_body / base_deck = 客户端当前内容（含未保存编辑）→ 计算底稿；
    //   server_base / server_deck_base = 客户端所知服务端基线 → 过期 409；
    //   baseBody / baseDeck = 服务端读值 → writer 读-写窗口乐观锁。
    // （第二轮只把 body 侧接了这套链路，deck 侧 clientDeck 仅用于比对、
    // 计算仍用 serverDeck，且前端传的是保存基线而非实时值 — 未保存的
    // 画布编辑被静默丢弃。现在两条路径完全同构。）
    const payload = (request.body ?? {}) as { base_body?: unknown; server_base?: unknown; base_deck?: unknown; server_deck_base?: unknown }
    const clientBody = typeof payload.base_body === 'string' ? payload.base_body : null
    const serverBase = typeof payload.server_base === 'string' ? payload.server_base : null
    const clientDeck = typeof payload.base_deck === 'string' ? payload.base_deck : null
    const serverDeckBase = typeof payload.server_deck_base === 'string' ? payload.server_deck_base : null
    if (serverBase !== null && String(doc.body || '') !== serverBase) {
      return reply.status(409).send({ error: '文档已被其他窗口修改，请刷新后重试' })
    }
    if (serverDeckBase !== null && String(doc.deck ?? '') !== serverDeckBase) {
      return reply.status(409).send({ error: '幻灯片内容已被其他窗口修改，请刷新后重试' })
    }
    const serverBody = String(doc.body || '')
    const serverDeck = String(doc.deck ?? '')
    // 客户端当前内容（含未保存编辑）作为清除底稿 — 标记清除与未保存编辑
    // 一并落库（客户端内容即最新意图）；body/deck 的「调用方读 → writer 读」
    // 窗口由写回单点的 baseBody/baseDeck 乐观锁双轨保护。
    const effectiveBody = clientBody ?? serverBody
    const effectiveDeck = clientDeck ?? serverDeck

    const bodyRemoved = countMarkers(effectiveBody, citationId)
    const deckRemoved = countMarkers(deckCitationText(effectiveDeck), citationId)
    if (bodyRemoved === 0 && deckRemoved === 0) {
      return reply.status(404).send({ error: 'No dangling marker for this citation id in document content' })
    }

    const bodyChanged = bodyRemoved > 0
    const writeInput: Parameters<typeof writeDocVersion>[0] = {
      userId: request.user!.userId,
      docId: doc.id,
      snapshotLabel: '悬挂引用清理',
      writeSource: 'human',
      // 输入级乐观锁双轨：body 与 deck 同强度（复审轮 4）。
      baseBody: serverBody,
      baseDeck: doc.deck,
    }
    if (bodyChanged) {
      writeInput.body = stripCitationMarkers(effectiveBody, citationId)
    }
    let deckOut: string | null = null
    if (deckRemoved > 0) {
      const nextDeck = stripDeckCitationMarkers(effectiveDeck, citationId)
      writeInput.deck = JSON.parse(nextDeck) as Record<string, unknown>
      deckOut = nextDeck
    }
    // 写回单点 — 同帧快照（body+deck）+ 块投影维护 + 乐观锁（并发修改 → 409）。
    const outcome = await writeDocVersion(writeInput)
    if (outcome.conflict) return reply.status(409).send({ error: '文档已被其他窗口修改，请刷新后重试' })
    if (outcome.error) return reply.status(500).send({ error: outcome.error })
    // 复审轮 5（P0 镜像 bug）— body_changed 显式标记：deck-only 清除时
    // writeDocVersion 不触碰 body（outcome.body = 数据库旧值 prevBody），
    // 前端不得把它当"新内容"灌回编辑器（镜像第二轮的 deck 侧缺陷）。与
    // deck 侧的 deck:null 守卫同构 — 前端按「服务端实际改写的维度」同步。
    return { ok: true, body: outcome.body, body_changed: bodyChanged, deck: deckOut, removed: bodyRemoved + deckRemoved }
  })
}
