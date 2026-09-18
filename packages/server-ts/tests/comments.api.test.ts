/**
 * #1039 — Comment 数据模型与 CRUD API（TDD，issue 用例表 5 条 + 归属守卫）。
 *
 * Mock 策略：不 mock Prisma — 数据库走 vitest 既有测试基建（globalSetup
 * 重置 test.db 并 db push 最新 schema），用例数据用后即删（doc 级联清理），
 * 不依赖事务回滚。评论 API 不触 LLM，无需 mock ai-provider。
 */
import { describe, test, expect, afterAll } from 'vitest'
import { getApp, authHeader, getAuthUserId, registerSecondUser } from './setup.js'

async function getPrisma() {
  const { default: prisma } = await import('../src/common/prisma.js')
  return prisma
}

/** 已建 doc id 池 — afterAll 统一删除（DocComment/Reply 随 Cascade 级联）。 */
const createdDocIds: string[] = []

async function createDoc(body: string): Promise<string> {
  const prisma = await getPrisma()
  const userId = await getAuthUserId()
  const id = `doc_cmt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  await prisma.doc.create({ data: { id, userId, title: 'Comment test doc', body, createdAt: now, updatedAt: now } })
  createdDocIds.push(id)
  return id
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('#1039 comments API', () => {
  afterAll(async () => {
    const prisma = await getPrisma()
    for (const id of createdDocIds) {
      await prisma.doc.deleteMany({ where: { id } }).catch(() => {})
    }
  })

  /** 用例 1：创建评论 → 201，含 sectionId/anchorText/status=open。 */
  test('创建评论返回 201，status 默认 open，首条内容成为线程第一条回复', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n这是被评论的正文段落。\n')
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: JSON.stringify({ section_id: 'sec_intro', anchor_text: '这是被评论的正文段落。', text: '这段需要补数据来源' }),
    })
    expect(res.statusCode).toBe(201)
    const comment = JSON.parse(res.payload)
    expect(comment.section_id).toBe('sec_intro')
    expect(comment.anchor_text).toBe('这是被评论的正文段落。')
    expect(comment.status).toBe('open')
    expect(comment.resolved_at).toBeNull()
    expect(comment.created_by).toBeTruthy()
    // 首条评论内容落线程（role=user）
    expect(comment.replies).toHaveLength(1)
    expect(comment.replies[0].role).toBe('user')
    expect(comment.replies[0].text).toBe('这段需要补数据来源')

    // zod 校验：缺 section_id / anchor_text → 400
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: JSON.stringify({ anchor_text: '缺 section_id' }),
    })
    expect(bad.statusCode).toBe(400)
  })

  /** 用例 2：anchorText 漂移 → 创建仍成功，列表返回定位诊断 + 候选建议。 */
  test('锚点漂移：创建成功，列表对 open 评论返回 located=false + 最近候选', async () => {
    const app = await getApp()
    const docId = await createDoc(
      '# Methods\n\nWe enrolled 120 patients in this prospective cohort.\n\n# Results\n\nTreatment improved overall survival significantly.\n',
    )
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    // 漂移锚点：正文只有前半句，评论锚点带了正文不存在的后半句
    const drifted = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: h,
      payload: JSON.stringify({ section_id: 'sec_methods', anchor_text: 'We enrolled 120 patients in this prospective cohort and followed them for 5 years.', text: '队列人数对吗？' }),
    })
    expect(drifted.statusCode).toBe(201)
    // 完好锚点（正文原句可精确定位）作对照
    const intact = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: h,
      payload: JSON.stringify({ section_id: 'sec_results', anchor_text: 'Treatment improved overall survival significantly.', text: '数据来源？' }),
    })
    expect(intact.statusCode).toBe(201)
    const driftedId = JSON.parse(drifted.payload).id
    const intactId = JSON.parse(intact.payload).id

    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers: h })).payload)
    const byId = new Map<string, any>(list.comments.map((c: any) => [c.id, c]))
    // 漂移评论：located=false + 候选建议（复用 anchor-diagnostics）
    const d = byId.get(driftedId)
    expect(d.anchor).toBeTruthy()
    expect(d.anchor.located).toBe(false)
    expect(Array.isArray(d.anchor.candidates)).toBe(true)
    expect(d.anchor.candidates.length).toBeGreaterThan(0)
    // 最近候选应指向正文里那半句真实存在的原文
    expect(d.anchor.candidates[0].similarity).toBeGreaterThan(0.5)
    expect(d.anchor.candidates[0].text).toContain('We enrolled 120 patients')
    // 完好评论：located=true，无候选
    const i = byId.get(intactId)
    expect(i.anchor.located).toBe(true)
    expect(i.anchor.candidates).toBeUndefined()
  })

  /** 用例 3：追加回复 → 线程按时间序追加，role 区分 user/ai。 */
  test('追加回复按时间顺序排列，role 区分 user/ai', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: h,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '首条' }),
    })
    const commentId = JSON.parse(created.payload).id
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments/${commentId}/replies`,
      headers: h,
      payload: JSON.stringify({ role: 'user', text: '用户追问' }),
    })
    expect(r1.statusCode).toBe(201)
    await sleep(20) // 保证 createdAt 时间序可判
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments/${commentId}/replies`,
      headers: h,
      payload: JSON.stringify({ role: 'ai', text: 'AI 已按要求修改该节' }),
    })
    expect(r2.statusCode).toBe(201)
    // role 非法值 → 400（zod 枚举）
    const badRole = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments/${commentId}/replies`,
      headers: h,
      payload: JSON.stringify({ role: 'system', text: '非法角色' }),
    })
    expect(badRole.statusCode).toBe(400)

    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers: h })).payload)
    const thread = list.comments.find((c: any) => c.id === commentId)
    expect(thread.replies.map((r: any) => r.role)).toEqual(['user', 'user', 'ai'])
    expect(thread.replies.map((r: any) => r.text)).toEqual(['首条', '用户追问', 'AI 已按要求修改该节'])
  })

  /** 用例 4：resolved / reopen → status 正确切换，resolvedAt 置空/写入。 */
  test('标记 resolved 写入 resolvedAt，reopen 置回 null；非法 status 拒绝', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: h,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '首条' }),
    })
    const commentId = JSON.parse(created.payload).id

    // open → resolved：resolvedAt 写入
    const resolved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${docId}/comments/${commentId}`,
      headers: h,
      payload: JSON.stringify({ status: 'resolved' }),
    })
    expect(resolved.statusCode).toBe(200)
    const resolvedBody = JSON.parse(resolved.payload)
    expect(resolvedBody.status).toBe('resolved')
    expect(resolvedBody.resolved_at).toBeTruthy()

    // resolved → open（reopen）：resolvedAt 置回 null
    const reopened = await app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${docId}/comments/${commentId}`,
      headers: h,
      payload: JSON.stringify({ status: 'open' }),
    })
    const reopenedBody = JSON.parse(reopened.payload)
    expect(reopenedBody.status).toBe('open')
    expect(reopenedBody.resolved_at).toBeNull()

    // 非法枚举 → 400（zod 校验）
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${docId}/comments/${commentId}`,
      headers: h,
      payload: JSON.stringify({ status: 'closed' }),
    })
    expect(bad.statusCode).toBe(400)
  })

  /** 用例 5：列表按 sectionId / status 过滤均可用。 */
  test('列表支持 section_id 过滤与 status 过滤', async () => {
    const app = await getApp()
    const docId = await createDoc('# A\n\n甲节正文。\n\n# B\n\n乙节正文。\n')
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const mk = async (sectionId: string, anchor: string, text: string) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/docs/${docId}/comments`,
        headers: h,
        payload: JSON.stringify({ section_id: sectionId, anchor_text: anchor, text }),
      })
      return JSON.parse(res.payload).id
    }
    const aOpen = await mk('sec_a', '甲节正文。', 'A 节 open')
    const aResolved = await mk('sec_a', '甲节正文。', 'A 节 resolved')
    const bOpen = await mk('sec_b', '乙节正文。', 'B 节 open')
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${docId}/comments/${aResolved}`,
      headers: h,
      payload: JSON.stringify({ status: 'resolved' }),
    })

    // section_id 过滤
    const bySection = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?section_id=sec_a`, headers: h })).payload)
    expect(bySection.comments.map((c: any) => c.id).sort()).toEqual([aOpen, aResolved].sort())
    // status 过滤
    const byOpen = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?status=open`, headers: h })).payload)
    expect(byOpen.comments.map((c: any) => c.id).sort()).toEqual([aOpen, bOpen].sort())
    // 组合过滤
    const combined = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?section_id=sec_a&status=resolved`, headers: h })).payload)
    expect(combined.comments.map((c: any) => c.id)).toEqual([aResolved])
    // status 非法值 → 400
    const badStatus = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?status=whatever`, headers: h })
    expect(badStatus.statusCode).toBe(400)
  })

  /** 归属守卫：他人 doc 上的评论操作一律 404（与现有 doc 路由同语义）。 */
  test('跨用户访问他人文档的评论返回 404', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: h,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '首条' }),
    })
    const commentId = JSON.parse(created.payload).id

    const second = await registerSecondUser()
    const h2 = { authorization: `Bearer ${second.token}`, 'content-type': 'application/json' }
    const list = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers: h2 })
    expect(list.statusCode).toBe(404)
    const replyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments/${commentId}/replies`,
      headers: h2,
      payload: JSON.stringify({ text: '越权回复' }),
    })
    expect(replyRes.statusCode).toBe(404)
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${docId}/comments/${commentId}`,
      headers: h2,
      payload: JSON.stringify({ status: 'resolved' }),
    })
    expect(patchRes.statusCode).toBe(404)
    // 不带 token → 401
    const noAuth = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments` })
    expect(noAuth.statusCode).toBe(401)
  })
})

/**
 * #1051 — 锚点模型扩展到 deck slide（TDD，issue 用例表服务端侧）。
 * 可判别锚点联合：{ target:'section', sectionId } | { target:'deck_slide', slideIndex(1-based), blockIndex? }；
 * anchor 诊断对 deck_slide 用 doc.deck 里对应 slide 的文本做定位（同一套
 * 归一化/模糊匹配 + 候选建议，不为 deck 换一套定位方式）。
 */
describe('#1051 deck slide 锚点（comments API）', () => {
  afterAll(async () => {
    const prisma = await getPrisma()
    for (const id of createdDocIds) {
      await prisma.doc.deleteMany({ where: { id } }).catch(() => {})
    }
  })

  const DECK = JSON.stringify({
    title: '研究 deck',
    slides: [
      { title: '背景', content: [{ type: 'paragraph', text: '研究背景要点。', style: 'bullet' }] },
      { title: '方法', content: [{ type: 'paragraph', text: '120 例前瞻队列。', style: 'bullet' }] },
      { title: '结论', content: [{ type: 'paragraph', text: '生存显著改善。', style: 'bullet' }] },
    ],
  })

  async function createDocWithDeck(deck: string): Promise<string> {
    const prisma = await getPrisma()
    const userId = await getAuthUserId()
    const id = `doc_cmtdeck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    await prisma.doc.create({ data: { id, userId, title: 'Deck comment test doc', body: '# Intro\n\n正文。\n', deck, createdAt: now, updatedAt: now } })
    createdDocIds.push(id)
    return id
  }

  /** 用例 1（服务端侧）：创建带 target/slide_index 的评论 → 落库并回显判别字段。 */
  test('创建 deck_slide 评论：target/slide_index 回显，section_id 可空', async () => {
    const app = await getApp()
    const docId = await createDocWithDeck(DECK)
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: h,
      payload: JSON.stringify({ target: 'deck_slide', slide_index: 2, anchor_text: '120 例前瞻队列。', text: '这页样本量要说明随访时长' }),
    })
    expect(res.statusCode).toBe(201)
    const comment = JSON.parse(res.payload)
    expect(comment.target).toBe('deck_slide')
    expect(comment.slide_index).toBe(2)
    expect(comment.section_id).toBeNull()
    expect(comment.status).toBe('open')

    // 校验：deck_slide 缺 slide_index → 400；section 缺 section_id → 400；非法 target → 400
    const noSlide = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h,
      payload: JSON.stringify({ target: 'deck_slide', anchor_text: 'x', text: 'x' }),
    })
    expect(noSlide.statusCode).toBe(400)
    const noSection = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h,
      payload: JSON.stringify({ anchor_text: 'x', text: 'x' }),
    })
    expect(noSection.statusCode).toBe(400)
    const badTarget = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h,
      payload: JSON.stringify({ target: 'slide', section_id: 's1', anchor_text: 'x', text: 'x' }),
    })
    expect(badTarget.statusCode).toBe(400)

    // 存量语义回归：不带 target 默认 section
    const legacy = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: 'x' }),
    })
    expect(legacy.statusCode).toBe(201)
    expect(JSON.parse(legacy.payload).target).toBe('section')
  })

  /** 用例 2/5（服务端侧）：deck 评论锚点诊断对 slide 文本定位；漂移给候选；slide 删除不崩溃。 */
  test('deck 评论锚点诊断：slide 内定位/漂移候选/越界均可用', async () => {
    const app = await getApp()
    const docId = await createDocWithDeck(DECK)
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const mk = async (slideIndex: number | undefined, anchor: string) => {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h,
        payload: JSON.stringify({ target: 'deck_slide', slide_index: slideIndex, anchor_text: anchor, text: '意见' }),
      })
      return JSON.parse(res.payload).id as string
    }
    const intact = await mk(2, '120 例前瞻队列。')
    const drifted = await mk(2, '120 例前瞻队列且随访了五年。')
    const gone = await mk(9, '不存在页的锚点。')
    const noIndex = await (async () => {
      // 直接落库一条缺 slide_index 的 deck 评论（旧数据/异常数据兜底）— 列表不得崩溃
      const prisma = await getPrisma()
      const userId = await getAuthUserId()
      const row = await prisma.docComment.create({
        data: { docId, sectionId: '', anchorText: 'x', status: 'open', createdBy: userId, target: 'deck_slide', createdAt: new Date().toISOString() },
      })
      return row.id
    })()

    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers: h })).payload)
    const byId = new Map<string, any>(list.comments.map((c: any) => [c.id, c]))
    // 完好锚点：slide 文本内精确定位
    expect(byId.get(intact).anchor.located).toBe(true)
    expect(byId.get(intact).anchor.candidates).toBeUndefined()
    // 漂移：slide 文本内模糊兜底失败 → located=false + slide 内最近候选
    const d = byId.get(drifted)
    expect(d.anchor.located).toBe(false)
    expect(Array.isArray(d.anchor.candidates)).toBe(true)
    expect(d.anchor.candidates[0].text).toContain('120 例前瞻队列')
    // slide 越界（已删除）：located=false，不崩溃、不误报候选来源
    expect(byId.get(gone).anchor.located).toBe(false)
    // 异常数据（deck_slide 缺 slide_index）：located=false，不崩溃
    expect(byId.get(noIndex).anchor.located).toBe(false)
  })

  /** 用例 2（服务端侧）：正文评论与 deck 评论同表共存，列表可区分来源。 */
  test('正文评论与 deck 评论共存，target 判别正确', async () => {
    const app = await getApp()
    const docId = await createDocWithDeck(DECK)
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h,
      payload: JSON.stringify({ section_id: 'sec_intro', anchor_text: '正文。', text: '正文意见' }),
    })
    await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h,
      payload: JSON.stringify({ target: 'deck_slide', slide_index: 3, block_index: 0, anchor_text: '生存显著改善。', text: 'slide 意见' }),
    })
    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers: h })).payload)
    const targets = list.comments.map((c: any) => c.target).sort()
    expect(targets).toEqual(['deck_slide', 'section'])
    const deckOne = list.comments.find((c: any) => c.target === 'deck_slide')
    expect(deckOne.slide_index).toBe(3)
    expect(deckOne.block_index).toBe(0)
  })
})
