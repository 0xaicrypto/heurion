/**
 * #1101 §5 — deck 评论锚点 anchorShapeId（pptx 原生稳定 shapeId）。
 *
 * 覆盖（评论 API 全链路 — app.inject，真工件字节 + 真引擎 round-trip）：
 *   1. create：工件在场 → findText 首个命中 elementId 落库 + 序列化带出；
 *      无工件 → null（legacy 模糊路径不变）；投影过期（stale 瞬态）→ null。
 *   2. PATCH 改锚：重解析 shapeId；未命中 → 置回 null。
 *   3. 定位偏好：shapeId 命中 → located=true（slideIndex 漂移也不失配）；
 *      shapeId 失配（形状不存在）→ 回退 anchorText 模糊候选，行为同旧。
 *   4. 懒回填：存量 open 评论 anchorShapeId 为空 + findText 唯一解析 →
 *      落库 + located；锚点文本多形状命中（不唯一）→ 不回填。
 *
 * Mock 策略：不 mock Prisma / 引擎 — deck-bytes.test.ts 同款测试基建。
 */
import { describe, test, expect, afterAll } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'

async function getPrisma() {
  const { default: prisma } = await import('../../src/common/prisma.js')
  return prisma
}

const createdDocIds: string[] = []

/** 工件字节源 — 两个已知文本形状（slide1 要点 / slide2 数据）。 */
async function sampleArtifactBytes(): Promise<Buffer> {
  const { serializeDeckWireToPptx } = await import('../../src/lib/deck-bytes.js')
  return serializeDeckWireToPptx({
    title: '锚点测试 deck',
    slides: [
      { title: '页一', notes: '', content: [{ type: 'paragraph', text: '要点一：87 例 EGFR 敏感突变', style: 'bullet' }] },
      { title: '页二', notes: '', content: [{ type: 'paragraph', text: 'PFS 9.2 vs 5.4 个月', style: 'normal' }] },
    ],
  })
}

/** 建 doc + 落工件（putDeckArtifact 同帧重建投影 → staleness fresh）。
 *  归属用全局测试用户（authHeader 同源）— comments.api.test.ts 同款。 */
async function createDocWithArtifact(opts: { withoutArtifact?: boolean } = {}): Promise<string> {
  const prisma = await getPrisma()
  const userId = await getAuthUserId()
  const id = `doc_anchor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  await prisma.doc.create({ data: { id, userId, title: 'Anchor test doc', body: '# 正文\n\n内容。', createdAt: now, updatedAt: now } })
  createdDocIds.push(id)
  if (!opts.withoutArtifact) {
    const { putDeckArtifact } = await import('../../src/lib/deck-bytes.js')
    const put = await putDeckArtifact({ userId, docId: id, bytes: await sampleArtifactBytes() })
    if (put.conflict || put.error) throw new Error(`putDeckArtifact failed: ${put.error}`)
  }
  return id
}

async function createComment(docId: string, payload: Record<string, unknown>): Promise<any> {
  const app = await getApp()
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/docs/${docId}/comments`,
    headers: { ...(await authHeader()), 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  })
  return { status: res.statusCode, body: JSON.parse(res.payload) }
}

async function listWithAnchor(docId: string): Promise<Map<string, any>> {
  const app = await getApp()
  const res = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?with_anchor=1`, headers: await authHeader() })
  expect(res.statusCode).toBe(200)
  const list = JSON.parse(res.payload)
  return new Map(list.comments.map((c: any) => [c.id, c]))
}

const SHAPE_RE = /^ppt\/slides\/slide\d+\.xml-shape-\d+$/

describe('#1101 §5 评论锚点 anchorShapeId', () => {
  afterAll(async () => {
    const prisma = await getPrisma()
    const userId = await getAuthUserId().catch(() => null)
    for (const id of createdDocIds) {
      await prisma.doc.deleteMany({ where: { id } }).catch(() => {})
    }
    if (userId) {
      await prisma.fileIndex.deleteMany({ where: { userId, id: { startsWith: 'deck-' } } }).catch(() => {})
      const { uploadsBaseDir } = await import('../../src/lib/upload-path.js')
      const fs = await import('fs')
      fs.rmSync(uploadsBaseDir(userId), { recursive: true, force: true })
    }
  })

  test('create：工件在场 → anchorShapeId 落库并序列化带出；section 评论不受影响', async () => {
    const docId = await createDocWithArtifact()
    const deck = await createComment(docId, { target: 'deck_slide', slide_index: 1, anchor_text: '要点一：87 例 EGFR 敏感突变', text: '这页样本量要说明' })
    expect(deck.status).toBe(201)
    expect(deck.body.anchor_shape_id).toMatch(SHAPE_RE)
    // slide1 的文本形状 = slide1.xml 的第 2 个元素（标题 shape-0、正文 shape-1）
    expect(deck.body.anchor_shape_id).toBe('ppt/slides/slide1.xml-shape-1')

    const prisma = await getPrisma()
    const row = await prisma.docComment.findUnique({ where: { id: deck.body.id } })
    expect(row?.anchorShapeId).toBe('ppt/slides/slide1.xml-shape-1')

    // section 评论 → anchor_shape_id 恒 null
    const section = await createComment(docId, { section_id: 'sec_x', anchor_text: '内容。', text: '正文意见' })
    expect(section.status).toBe(201)
    expect(section.body.anchor_shape_id).toBeNull()
  })

  test('create：无工件（仅投影）→ anchorShapeId 为 null，legacy 路径不受影响', async () => {
    const docId = await createDocWithArtifact({ withoutArtifact: true })
    // 直接落一份 deck 投影（无工件 — 旧世界形态）
    const prisma = await getPrisma()
    await prisma.doc.update({
      where: { id: docId },
      data: {
        deck: JSON.stringify({ title: 't', slides: [{ title: '页一', content: [{ type: 'paragraph', text: '要点一：87 例 EGFR 敏感突变', style: 'bullet' }] }] }),
      },
    })
    const deck = await createComment(docId, { target: 'deck_slide', slide_index: 1, anchor_text: '要点一：87 例 EGFR 敏感突变', text: 'x' })
    expect(deck.status).toBe(201)
    expect(deck.body.anchor_shape_id).toBeNull()
    // with_anchor 诊断仍走投影模糊路径（located=true）
    const byId = await listWithAnchor(docId)
    expect(byId.get(deck.body.id).anchor.located).toBe(true)
    expect(byId.get(deck.body.id).anchor_shape_id).toBeNull()
  })

  test('create：投影过期（工件比 Doc 行新 — 瞬态写窗口）→ 跳过解析留 null', async () => {
    const docId = await createDocWithArtifact()
    const prisma = await getPrisma()
    // 模拟 putDeckArtifact 中断窗口：工件新、投影/Doc 行旧（staleness=stale）。
    const past = new Date(Date.now() - 60_000).toISOString()
    await prisma.doc.update({ where: { id: docId }, data: { updatedAt: past } })
    const deck = await createComment(docId, { target: 'deck_slide', slide_index: 1, anchor_text: '要点一：87 例 EGFR 敏感突变', text: 'x' })
    expect(deck.status).toBe(201)
    expect(deck.body.anchor_shape_id).toBeNull()
  })

  test('PATCH 改锚：重解析 shapeId；未命中 → 置回 null（回退模糊路径）', async () => {
    const docId = await createDocWithArtifact()
    const created = await createComment(docId, { target: 'deck_slide', slide_index: 1, anchor_text: '要点一：87 例 EGFR 敏感突变', text: 'x' })
    expect(created.body.anchor_shape_id).toBe('ppt/slides/slide1.xml-shape-1')
    const commentId = created.body.id

    const app = await getApp()
    const patch = async (payload: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/docs/${docId}/comments/${commentId}`,
        headers: { ...(await authHeader()), 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      })
      return { status: res.statusCode, body: JSON.parse(res.payload) }
    }

    // 改锚到 slide2 的文本 → shapeId 重解析为 slide2 的形状
    const reanchored = await patch({ anchor_text: 'PFS 9.2 vs 5.4 个月' })
    expect(reanchored.status).toBe(200)
    expect(reanchored.body.anchor_shape_id).toBe('ppt/slides/slide2.xml-shape-1')
    expect(reanchored.body.anchor_text).toBe('PFS 9.2 vs 5.4 个月')

    // 改锚到工件里不存在的文本 → shapeId 置回 null
    const missed = await patch({ anchor_text: '工件里根本没有这句话' })
    expect(missed.status).toBe(200)
    expect(missed.body.anchor_shape_id).toBeNull()
    const prisma = await getPrisma()
    const row = await prisma.docComment.findUnique({ where: { id: commentId } })
    expect(row?.anchorShapeId).toBeNull()
    expect(row?.anchorText).toBe('工件里根本没有这句话')
  })

  test('定位偏好：slideIndex 已漂移（指向不存在页）但 shapeId 命中 → located=true', async () => {
    const docId = await createDocWithArtifact()
    // 画布重排语义：评论 slide_index 停留旧值（9 = 已越界），但 shapeId 仍指向真实形状
    const created = await createComment(docId, { target: 'deck_slide', slide_index: 9, anchor_text: 'PFS 9.2 vs 5.4 个月', text: 'x' })
    expect(created.body.anchor_shape_id).toBe('ppt/slides/slide2.xml-shape-1')
    const byId = await listWithAnchor(docId)
    const one = byId.get(created.body.id)
    // legacy 路径（slideIndex 9 越界）必然 located=false — shapeId 分支胜出
    expect(one.anchor.located).toBe(true)
    expect(one.anchor.candidates).toBeUndefined()
  })

  test('shapeId 失配（形状不存在）→ 回退 anchorText 模糊：命中/候选与旧行为一致', async () => {
    const docId = await createDocWithArtifact()
    const prisma = await getPrisma()
    const userId = await getAuthUserId()
    // 直接落两条带伪造 shapeId 的评论（模拟 shapeId 失配：形状被删）
    const row = async (anchorText: string) => prisma.docComment.create({
      data: {
        docId, sectionId: '', anchorText, status: 'open', createdBy: userId,
        target: 'deck_slide', slideIndex: 2, anchorShapeId: 'ppt/slides/slide9.xml-shape-99',
        createdAt: new Date().toISOString(),
      },
    })
    const intact = await row('PFS 9.2 vs 5.4 个月')
    const drifted = await row('PFS 9.2 vs 5.4 个月且随访五年。')

    const byId = await listWithAnchor(docId)
    // shapeId miss → 投影模糊路径：完好锚点 located=true（与 #1051 旧行为一致）
    expect(byId.get(intact.id).anchor.located).toBe(true)
    expect(byId.get(intact.id).anchor.candidates).toBeUndefined()
    // 漂移锚点 → located=false + 最近候选（候选来自 slide 投影文本）
    const d = byId.get(drifted.id)
    expect(d.anchor.located).toBe(false)
    expect(Array.isArray(d.anchor.candidates)).toBe(true)
    expect(d.anchor.candidates[0].text).toContain('PFS 9.2')
  })

  test('懒回填：存量 open 评论 anchorShapeId 为空 + findText 唯一解析 → 落库', async () => {
    const docId = await createDocWithArtifact()
    const prisma = await getPrisma()
    const userId = await getAuthUserId()
    const legacy = await prisma.docComment.create({
      data: {
        docId, sectionId: '', anchorText: 'PFS 9.2 vs 5.4 个月', status: 'open',
        createdBy: userId, target: 'deck_slide', slideIndex: 2, createdAt: new Date().toISOString(),
      },
    })
    const byId = await listWithAnchor(docId)
    const one = byId.get(legacy.id)
    expect(one.anchor_shape_id).toBe('ppt/slides/slide2.xml-shape-1')
    expect(one.anchor.located).toBe(true)
    // 已落库 — 二次列表不再回填（幂等），DB 行持久化
    const row = await prisma.docComment.findUnique({ where: { id: legacy.id } })
    expect(row?.anchorShapeId).toBe('ppt/slides/slide2.xml-shape-1')
  })

  test('懒回填：锚点文本多形状命中（不唯一）→ 不回填，走 legacy 诊断', async () => {
    const docId = await createDocWithArtifact()
    const prisma = await getPrisma()
    const userId = await getAuthUserId()
    // 「页」字同时命中两个标题形状 → 唯一性不满足
    const ambiguous = await prisma.docComment.create({
      data: {
        docId, sectionId: '', anchorText: '页', status: 'open',
        createdBy: userId, target: 'deck_slide', slideIndex: 1, createdAt: new Date().toISOString(),
      },
    })
    const byId = await listWithAnchor(docId)
    const one = byId.get(ambiguous.id)
    expect(one.anchor_shape_id).toBeNull()
    const row = await prisma.docComment.findUnique({ where: { id: ambiguous.id } })
    expect(row?.anchorShapeId).toBeNull()
    // legacy 投影路径照常（slide1 投影文本含「页一」标题 → located=true）
    expect(one.anchor.located).toBe(true)
  })
})
