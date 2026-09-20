/**
 * #1039 — Comment 数据模型与 CRUD API（TDD，issue 用例表 5 条 + 归属守卫）。
 *
 * Mock 策略：不 mock Prisma — 数据库走 vitest 既有测试基建（globalSetup
 * 重置 test.db 并 db push 最新 schema），用例数据用后即删（doc 级联清理），
 * 不依赖事务回滚。评论 API 不触 LLM，无需 mock ai-provider。
 */
import { describe, test, expect, afterAll, vi } from 'vitest'
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

    // #1064: 锚点诊断改懒计算 — 显式 ?with_anchor=1 才跑定位诊断
    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?with_anchor=1`, headers: h })).payload)
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

  /** 用例 3：追加回复 → 线程按时间序追加（#1064: role 'ai' 只能走服务端内部函数）。 */
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
    // #1064: role:'ai' 不可由客户端自封 — HTTP 路径拒绝（400），
    // AI 回复改由服务端内部函数写入（#1041 服务端收口后续接入）。
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments/${commentId}/replies`,
      headers: h,
      payload: JSON.stringify({ role: 'ai', text: 'AI 已按要求修改该节' }),
    })
    expect(r2.statusCode).toBe(400)
    const { appendCommentReplyInternal } = await import('../src/modules/comments/comments.router.js')
    await appendCommentReplyInternal({ commentId, role: 'ai', text: 'AI 已按要求修改该节' })
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

    // #1064: 锚点诊断改懒计算 — 显式 ?with_anchor=1 才跑定位诊断
    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?with_anchor=1`, headers: h })).payload)
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

/**
 * #1064 — Comments API 健壮性批次（TDD）：
 *   1. 逐字段长度上限（anchor_text 2000 / text 10000，超限 400）
 *   2. GET 列表分页（limit 默认 50 上限 200 + offset）+ 锚点诊断懒计算（?with_anchor=1）
 *      + deck JSON 单次解析复用
 *   3. deckSlideText 纳入 table 块文本（表格锚点不再必然误报）
 *   4. role:'ai' 不可由客户端自封（HTTP 拒绝，仅服务端内部路径可写）
 *   5. 校验错误信封统一为仓库主流 { error: parsed.error.format() }
 */
describe('#1064 comments API 健壮性批次', () => {
  afterAll(async () => {
    const prisma = await getPrisma()
    for (const id of createdDocIds) {
      await prisma.doc.deleteMany({ where: { id } }).catch(() => {})
    }
  })

  const h = async () => ({ ...(await authHeader()), 'content-type': 'application/json' })

  // ── 项 1：逐字段长度上限 ────────────────────────────────────────────
  test('anchor_text/text 超上限返回 400，边界值可用', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const headers = await h()
    const post = async (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers, payload: JSON.stringify(payload) })

    // 边界值可用：anchor_text 2000 / text 10000 → 201
    const edge = await post({ section_id: 's1', anchor_text: '正'.repeat(2000), text: '评'.repeat(10000) })
    expect(edge.statusCode).toBe(201)
    // 超限 → 400：anchor_text 2001 / text 10001
    const longAnchor = await post({ section_id: 's1', anchor_text: 'x'.repeat(2001), text: 'ok' })
    expect(longAnchor.statusCode).toBe(400)
    const longText = await post({ section_id: 's1', anchor_text: '正文。', text: 'x'.repeat(10001) })
    expect(longText.statusCode).toBe(400)
    // 回复同样受 cap：text 10001 → 400（10000 → 201）
    const commentId = JSON.parse(edge.payload).id
    const longReply = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/replies`, headers,
      payload: JSON.stringify({ text: 'x'.repeat(10001) }),
    })
    expect(longReply.statusCode).toBe(400)
    const edgeReply = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/replies`, headers,
      payload: JSON.stringify({ text: 'x'.repeat(10000) }),
    })
    expect(edgeReply.statusCode).toBe(201)
  })

  // ── 项 2：列表分页 + 锚点诊断懒计算 ─────────────────────────────────
  test('列表分页语义：limit 默认 50 上限 200，offset 翻页，has_more 正确', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const headers = await h()
    // 直接落库 51 条评论（createdAt 逐条递增保证确定性次序）
    const prisma = await getPrisma()
    const userId = await getAuthUserId()
    const base = Date.now()
    const ids: string[] = []
    for (let i = 0; i < 51; i++) {
      const id = `doccmtpage_${base}_${i}`
      await prisma.docComment.create({
        data: { docId, sectionId: 's1', anchorText: '正文。', status: 'open', createdBy: userId, createdAt: new Date(base + i).toISOString(), id },
      })
      ids.push(id)
    }
    // 默认 limit=50：返回前 50 条 + has_more=true
    const page1 = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers })).payload)
    expect(page1.limit).toBe(50)
    expect(page1.comments).toHaveLength(50)
    expect(page1.comments.map((c: any) => c.id)).toEqual(ids.slice(0, 50))
    expect(page1.has_more).toBe(true)
    // offset 翻页：offset=50 → 剩下 1 条，has_more=false
    const page2 = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?offset=50`, headers })).payload)
    expect(page2.comments.map((c: any) => c.id)).toEqual([ids[50]])
    expect(page2.has_more).toBe(false)
    // 中间窗口：limit=2&offset=2
    const window = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?limit=2&offset=2`, headers })).payload)
    expect(window.limit).toBe(2)
    expect(window.offset).toBe(2)
    expect(window.comments.map((c: any) => c.id)).toEqual([ids[2], ids[3]])
    expect(window.has_more).toBe(true)
    // 上限约束：limit=201 → 400；limit=200 → 200；非整数/非法 → 400
    const over = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?limit=201`, headers })
    expect(over.statusCode).toBe(400)
    const cap = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?limit=200`, headers })
    expect(cap.statusCode).toBe(200)
    const zero = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?limit=0`, headers })
    expect(zero.statusCode).toBe(400)
    const notInt = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?limit=1.5`, headers })
    expect(notInt.statusCode).toBe(400)
  }, 20000)

  test('锚点诊断懒计算：默认列表不算 anchor，?with_anchor=1 才算', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n这是被评论的正文段落。\n')
    const headers = await h()
    const created = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers,
      payload: JSON.stringify({ section_id: 'sec_intro', anchor_text: '这是被评论的正文段落。', text: '首条' }),
    })
    expect(created.statusCode).toBe(201)
    // 默认：不跑诊断 — open 评论也无 anchor 字段
    const plain = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers })).payload)
    expect(plain.comments).toHaveLength(1)
    expect(plain.comments[0].anchor).toBeUndefined()
    // 显式 with_anchor=1：诊断在场
    const withAnchor = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?with_anchor=1`, headers })).payload)
    expect(withAnchor.comments[0].anchor).toBeTruthy()
    expect(withAnchor.comments[0].anchor.located).toBe(true)
  })

  // ── 项 3：deckSlideText 纳入 table 块文本 ───────────────────────────
  test('表格块文本进入宿主文本：表格锚点 located=true（不再必然误报）', async () => {
    const app = await getApp()
    const deck = JSON.stringify({
      title: '表格 deck',
      slides: [
        {
          title: '数据页',
          content: [
            { type: 'paragraph', text: '普通段落文本。', style: 'normal' },
            { type: 'table', data: JSON.stringify({ rows: [['组别', '均值'], ['治疗组', '42.5'], ['对照组', '31.2']], header: true }) },
          ],
        },
      ],
    })
    const prisma = await getPrisma()
    const userId = await getAuthUserId()
    const id = `doc_cmttable_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    await prisma.doc.create({ data: { id, userId, title: 'Table anchor doc', body: '# Intro\n\n正文。\n', deck, createdAt: now, updatedAt: now } })
    createdDocIds.push(id)
    const headers = await h()
    const mk = async (anchor: string) => {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/docs/${id}/comments`, headers,
        payload: JSON.stringify({ target: 'deck_slide', slide_index: 1, anchor_text: anchor, text: '意见' }),
      })
      return JSON.parse(res.payload).id as string
    }
    // 锚点指向表格单元格 — 修复前必然 located=false
    const cell = await mk('对照组')
    const cell2 = await mk('42.5')
    // 段落文本仍可定位（回归）
    const para = await mk('普通段落文本。')

    // 完好 deck：表格/段落锚点均可定位
    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${id}/comments?with_anchor=1`, headers })).payload)
    const byId = new Map<string, any>(list.comments.map((c: any) => [c.id, c]))
    expect(byId.get(cell).anchor.located).toBe(true)
    expect(byId.get(cell2).anchor.located).toBe(true)
    expect(byId.get(para).anchor.located).toBe(true)

    // 换上损坏 table data JSON 的 deck：table 块跳过（不崩溃），该 slide 已无宿主文本 → located=false
    await prisma.doc.update({
      where: { id },
      data: { deck: JSON.stringify({ title: 'x', slides: [{ title: '数据页', content: [{ type: 'table', data: '{broken-json' }] }] }) },
    })
    const brokenAnchor = await mk('普通段落文本。')
    const list2 = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${id}/comments?with_anchor=1`, headers })).payload)
    const byId2 = new Map<string, any>(list2.comments.map((c: any) => [c.id, c]))
    expect(byId2.get(brokenAnchor).anchor.located).toBe(false)
  })

  // ── 项 4：role:'ai' 不可由客户端自封 ────────────────────────────────
  test('客户端自封 role:ai 被拒（400）；服务端内部函数可写 ai 回复', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const headers = await h()
    const created = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '首条' }),
    })
    const commentId = JSON.parse(created.payload).id
    // 客户端自封 'ai' → 400
    const selfAi = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/replies`, headers,
      payload: JSON.stringify({ role: 'ai', text: '伪装 AI' }),
    })
    expect(selfAi.statusCode).toBe(400)
    // 显式 'user' 与缺省（默认 user）均可用
    const okUser = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/replies`, headers,
      payload: JSON.stringify({ role: 'user', text: '显式 user' }),
    })
    expect(okUser.statusCode).toBe(201)
    expect(JSON.parse(okUser.payload).role).toBe('user')
    // 服务端内部路径：'ai' 仅内部函数可写
    const { appendCommentReplyInternal } = await import('../src/modules/comments/comments.router.js')
    const aiReply = await appendCommentReplyInternal({ commentId, role: 'ai', text: '内部 AI 回复' })
    expect(aiReply.role).toBe('ai')
    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers })).payload)
    const thread = list.comments.find((c: any) => c.id === commentId)
    expect(thread.replies.map((r: any) => r.role)).toEqual(['user', 'user', 'ai'])
    expect(thread.replies.map((r: any) => r.text)).toEqual(['首条', '显式 user', '内部 AI 回复'])
  })

  // ── 项 5：校验错误信封统一 ──────────────────────────────────────────
  test('校验错误信封为 { error: zod format() }（无 details 字段）', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const headers = await h()
    // 创建评论校验失败（缺 section_id — 基础对象通过、superRefine 生效）
    const badCreate = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers,
      payload: JSON.stringify({ anchor_text: '缺 section_id', text: 'ok' }),
    })
    expect(badCreate.statusCode).toBe(400)
    const createBody = JSON.parse(badCreate.payload)
    expect(createBody.details).toBeUndefined()
    expect(typeof createBody.error).toBe('object')
    // zod error.format() 形状：{ _errors: [], <field>: { _errors: [...] } }
    expect(Array.isArray(createBody.error._errors)).toBe(true)
    expect(createBody.error.section_id._errors.length).toBeGreaterThan(0)
    // 列表 query 校验失败
    const badList = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?status=whatever`, headers })
    expect(badList.statusCode).toBe(400)
    const listBody = JSON.parse(badList.payload)
    expect(listBody.details).toBeUndefined()
    expect(typeof listBody.error).toBe('object')
    expect(listBody.error.status._errors.length).toBeGreaterThan(0)
    // 回复校验失败
    const created = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '首条' }),
    })
    const commentId = JSON.parse(created.payload).id
    const badReply = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/replies`, headers,
      payload: JSON.stringify({ role: 'system', text: '非法角色' }),
    })
    expect(badReply.statusCode).toBe(400)
    const replyBody = JSON.parse(badReply.payload)
    expect(replyBody.details).toBeUndefined()
    expect(typeof replyBody.error).toBe('object')
    // PATCH 校验失败
    const badPatch = await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers,
      payload: JSON.stringify({ status: 'closed' }),
    })
    expect(badPatch.statusCode).toBe(400)
    const patchBody = JSON.parse(badPatch.payload)
    expect(patchBody.details).toBeUndefined()
    expect(typeof patchBody.error).toBe('object')
  })
})

// ── #1064 集成收口 + #1072-2 来源可信: AI 回复专用入口 ──────────────────
// #1072-2 契约（web 适配者必读）：POST body 必须携带 turn_id — 须是该用户
// 该文档 chat 事件日志（per-user JSONL，core/event-log.ts，与 SSE
// turn_complete.assistant_event_idx 同源）里真实存在的 assistant_response
// 事件序号；doc chat 会话 id 固定 `doc-<docId>`。找不到/跨文档会话/跨用户/
// user_message 冒充一律 403。取舍：不做时间窗（事件日志无 TTL，时间窗会
// 误伤长会话；信任语义由「真实存在的 AI turn」承载）。
// 注意：不是 doc_chat_messages 表 — 遗留表无写入方，事件日志才是 chat 的
// 真实持久层。
import { EventLog } from '../src/core/event-log.js'
import { twinsBaseDir } from '../src/lib/upload-path.js'

describe('#1064 集成收口 + #1072-2 — POST /comments/:id/ai-replies', () => {
  /** 在认证用户的事件日志里追加一条事件，返回事件 idx（即 web 侧 assistant_event_idx 口径）。 */
  async function appendTurn(docId: string, eventType: 'assistant_response' | 'user_message'): Promise<string> {
    const userId = await getAuthUserId()
    const log = new EventLog(twinsBaseDir(userId), userId)
    const evt = log.append({
      timestamp: Date.now() / 1000,
      eventType,
      content: eventType === 'assistant_response' ? 'AI 已按要求修改该节' : '用户指令',
      metadata: {},
      agentId: userId,
      sessionId: `doc-${docId}`,
    })
    await log.flush()
    log.close()
    return String(evt.idx)
  }

  test('真实 AI turn 序号 → 201，role 服务端固定 ai', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: h,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '请补充来源' }),
    })
    const commentId = JSON.parse(created.payload).id
    const turnId = await appendTurn(docId, 'assistant_response')
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`,
      headers: h,
      payload: JSON.stringify({ text: 'AI 已修改该节', turn_id: turnId }),
    })
    expect(r.statusCode).toBe(201)
    const reply = JSON.parse(r.payload)
    expect(reply.role).toBe('ai')
    expect(reply.text).toBe('AI 已修改该节')
  })

  test('伪造 turn_id（事件日志中不存在）→ 403', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const created = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '首条' }),
    })
    const commentId = JSON.parse(created.payload).id
    const forged = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`, headers: h,
      payload: JSON.stringify({ text: '伪造 AI 的话', turn_id: '999999' }),
    })
    expect(forged.statusCode).toBe(403)
    // 自封 role 字段被忽略（zod 剥离）+ 缺 turn_id → 400
    const bad = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`, headers: h,
      payload: JSON.stringify({ text: 'x', role: 'system' }),
    })
    expect(bad.statusCode).toBe(400)
  })

  test('turn_id 校验按 user+doc+eventType 收紧：跨文档会话 / user 消息冒充 / 其他用户 turn → 403；缺 turn_id → 400', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const created = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '首条' }),
    })
    const commentId = JSON.parse(created.payload).id

    // 同一用户另一文档会话的 assistant_response（sessionId=doc-<otherDoc>）→ 会话不符 → 403
    const otherDocId = await createDoc('# B\n\n另一文档。\n')
    const crossDocTurn = await appendTurn(otherDocId, 'assistant_response')
    const crossDoc = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`, headers: h,
      payload: JSON.stringify({ text: '跨文档 turn', turn_id: crossDocTurn }),
    })
    expect(crossDoc.statusCode).toBe(403)

    // 本文档会话内 user_message — 不是 AI turn → 403
    const userTurn = await appendTurn(docId, 'user_message')
    const userMsg = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`, headers: h,
      payload: JSON.stringify({ text: '拿用户消息冒充', turn_id: userTurn }),
    })
    expect(userMsg.statusCode).toBe(403)

    // 其他用户事件日志里的序号 — 加载的是认证用户自己的日志，天然不符 → 403
    const second = await registerSecondUser()
    const foreignLog = new EventLog(twinsBaseDir(second.userId), second.userId)
    const foreignEvt = foreignLog.append({
      timestamp: Date.now() / 1000, eventType: 'assistant_response', content: '他人 turn',
      metadata: {}, agentId: second.userId, sessionId: `doc-${docId}`,
    })
    await foreignLog.flush()
    foreignLog.close()
    const foreign = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`, headers: h,
      payload: JSON.stringify({ text: '他人 turn', turn_id: String(foreignEvt.idx) }),
    })
    expect(foreign.statusCode).toBe(403)

    // 缺 turn_id → 400（zod）
    const noTurn = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`, headers: h,
      payload: JSON.stringify({ text: '没有凭据' }),
    })
    expect(noTurn.statusCode).toBe(400)
    // 空 turn_id → 400
    const emptyTurn = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`, headers: h,
      payload: JSON.stringify({ text: '空凭据', turn_id: '' }),
    })
    expect(emptyTurn.statusCode).toBe(400)
  })

  test('跨用户 404 + 空 text 400（信封为 zod format）', async () => {
    const app = await getApp()
    const docId = await createDoc('# A\n\n正文。\n')
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments`,
      headers: h,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '首条' }),
    })
    const commentId = JSON.parse(created.payload).id
    // 第二个用户 → 404（归属校验，不暴露存在性）
    const second = await registerSecondUser()
    const other = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`,
      headers: { authorization: `Bearer ${second.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '越权' }),
    })
    expect(other.statusCode).toBe(404)
    // 空 text → 400，信封统一 { error: format }（turn_id 在场 — 400 只由空 text 触发）
    const empty = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/comments/${commentId}/ai-replies`,
      headers: h,
      payload: JSON.stringify({ text: '', turn_id: 'turn_any' }),
    })
    expect(empty.statusCode).toBe(400)
    const body = JSON.parse(empty.payload)
    expect(typeof body.error).toBe('object')
    expect(body.error).not.toHaveProperty('details')
  })
})

/**
 * #1091 — deck 评论 pending-confirm 态持久化（TDD，issue 用例表 6 条，服务端侧）。
 * PATCH /comments/:id 扩展 deck_snapshot?: string | null — string ≤1MB 且
 * JSON 可解析（与 #1047 table data 同风格校验），null = 清除；status 变可选
 * （仅清快照/仅落快照的 PATCH 不触碰 status/resolvedAt）。列表对 deck_slide
 * 评论有快照则带出（字段名 snake_case 对齐 #1051 序列化风格）。
 */
describe('#1091 deck 评论快照持久化', () => {
  afterAll(async () => {
    const prisma = await getPrisma()
    for (const id of createdDocIds) {
      await prisma.doc.deleteMany({ where: { id } }).catch(() => {})
    }
  })

  const h = async () => ({ ...(await authHeader()), 'content-type': 'application/json' })
  const SNAP = JSON.stringify({ title: '写回前画布', slides: [{ title: '背景', content: [{ type: 'paragraph', text: '研究背景要点。', style: 'bullet' }] }] })

  async function createDeckDoc(): Promise<string> {
    const prisma = await getPrisma()
    const userId = await getAuthUserId()
    const id = `doc_cmtsnap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    await prisma.doc.create({ data: { id, userId, title: 'Deck snapshot doc', body: '# Intro\n\n正文。\n', deck: '{"title":"d","slides":[]}', createdAt: now, updatedAt: now } })
    createdDocIds.push(id)
    return id
  }

  async function createDeckComment(docId: string): Promise<string> {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: await h(),
      payload: JSON.stringify({ target: 'deck_slide', slide_index: 1, anchor_text: '背景', text: '这页要改' }),
    })
    expect(res.statusCode).toBe(201)
    return JSON.parse(res.payload).id as string
  }

  /** 用例 1：写回落地 — PATCH 带 deck_snapshot（非空 JSON）落库并回显。 */
  test('PATCH deck_snapshot 落库：200 回显快照，仅快照 PATCH 不触碰 status/resolvedAt', async () => {
    const app = await getApp()
    const docId = await createDeckDoc()
    const commentId = await createDeckComment(docId)
    const headers = await h()
    const patched = await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers,
      payload: JSON.stringify({ deck_snapshot: SNAP }),
    })
    expect(patched.statusCode).toBe(200)
    const body = JSON.parse(patched.payload)
    expect(body.status).toBe('open')
    expect(body.resolved_at).toBeNull()
    expect(body.deck_snapshot).toBe(SNAP)
    // 真落库（不是只回显）— prisma 直查
    const prisma = await getPrisma()
    const row = await prisma.docComment.findUnique({ where: { id: commentId } })
    expect(row?.deckSnapshot).toBe(SNAP)
  })

  /** 用例 2：刷新（重新 list）— deck_slide open 评论带出 deck_snapshot。 */
  test('列表带出快照：deck_slide 评论 deck_snapshot 随默认序列化返回', async () => {
    const app = await getApp()
    const docId = await createDeckDoc()
    const commentId = await createDeckComment(docId)
    await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers: await h(),
      payload: JSON.stringify({ deck_snapshot: SNAP }),
    })
    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers: await h() })).payload)
    const thread = list.comments.find((c: any) => c.id === commentId)
    expect(thread.deck_snapshot).toBe(SNAP)
  })

  /** 用例 3：确认 — PATCH {status:'resolved', deck_snapshot: null} 一步完成。 */
  test('确认：status=resolved 且快照清空（列表不再带出）', async () => {
    const app = await getApp()
    const docId = await createDeckDoc()
    const commentId = await createDeckComment(docId)
    const headers = await h()
    await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers,
      payload: JSON.stringify({ deck_snapshot: SNAP }),
    })
    const confirmed = await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers,
      payload: JSON.stringify({ status: 'resolved', deck_snapshot: null }),
    })
    expect(confirmed.statusCode).toBe(200)
    const body = JSON.parse(confirmed.payload)
    expect(body.status).toBe('resolved')
    expect(body.resolved_at).toBeTruthy()
    expect(body.deck_snapshot).toBeUndefined()
    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?status=resolved`, headers })).payload)
    expect(list.comments.find((c: any) => c.id === commentId).deck_snapshot).toBeUndefined()
  })

  /** 用例 4（服务端侧）：撤销的清账半步 — PATCH {deck_snapshot: null}，status 保持 open 不触碰。 */
  test('撤销清快照：PATCH deck_snapshot=null 后 status 仍 open，快照消失', async () => {
    const app = await getApp()
    const docId = await createDeckDoc()
    const commentId = await createDeckComment(docId)
    const headers = await h()
    await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers,
      payload: JSON.stringify({ deck_snapshot: SNAP }),
    })
    const cleared = await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers,
      payload: JSON.stringify({ deck_snapshot: null }),
    })
    expect(cleared.statusCode).toBe(200)
    const body = JSON.parse(cleared.payload)
    expect(body.status).toBe('open')
    expect(body.resolved_at).toBeNull()
    expect(body.deck_snapshot).toBeUndefined()
    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers })).payload)
    expect(list.comments.find((c: any) => c.id === commentId).deck_snapshot).toBeUndefined()
  })

  /** 用例 5：非 JSON 快照 → 400（信封 format）；超限 → 非 2xx 拒绝。
   *  注：Fastify 默认 bodyLimit=1MiB 在 HTTP 层先挡超限 body（413），zod 的
   *  1MB cap 为纵深防御（app.ts 不在本 issue 改动面，bodyLimit 不动）。 */
  test('快照校验：非 JSON → 400，超 1MB → 413（bodyLimit 先挡），边界内合法 JSON 可用', async () => {
    const app = await getApp()
    const docId = await createDeckDoc()
    const commentId = await createDeckComment(docId)
    const headers = await h()
    // 非 JSON 字符串 → 400（zod refine，信封 { error: format }）
    const badJson = await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers,
      payload: JSON.stringify({ deck_snapshot: '{broken-json' }),
    })
    expect(badJson.statusCode).toBe(400)
    expect(typeof JSON.parse(badJson.payload).error).toBe('object')
    // 超限（1MiB + 1 字节，zod cap 同为 1MB）→ 413（Fastify bodyLimit 先挡）
    const bigSnap = `"` + 'a'.repeat(1024 * 1024) + `"`
    const tooBig = await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers,
      payload: JSON.stringify({ deck_snapshot: bigSnap }),
    })
    expect(tooBig.statusCode).toBe(413)
    // 边界内（1MB 减去 JSON 信封开销，合法 JSON）→ 200
    const edgeSnap = `"` + 'a'.repeat(1024 * 1024 - 64) + `"`
    const edge = await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers,
      payload: JSON.stringify({ deck_snapshot: edgeSnap }),
    })
    expect(edge.statusCode).toBe(200)
    // 校验失败不得写入 — 库里快照是边界值这一次（非 JSON 那次被拒未落库）
    const prisma = await getPrisma()
    const row = await prisma.docComment.findUnique({ where: { id: commentId } })
    expect(row?.deckSnapshot).toBe(edgeSnap)
  })

  /** 用例 6：正文评论路径不受影响 — PATCH status 照旧，序列化不带 deck_snapshot。 */
  test('正文评论不受影响：PATCH status 照旧可用，列表不带 deck_snapshot 字段', async () => {
    const app = await getApp()
    const docId = await createDeckDoc()
    const h0 = await h()
    const created = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers: h0,
      payload: JSON.stringify({ section_id: 's1', anchor_text: '正文。', text: '首条' }),
    })
    const commentId = JSON.parse(created.payload).id
    // PATCH status 照旧（不带 deck_snapshot）
    const resolved = await app.inject({
      method: 'PATCH', url: `/api/v1/docs/${docId}/comments/${commentId}`, headers: h0,
      payload: JSON.stringify({ status: 'resolved' }),
    })
    expect(resolved.statusCode).toBe(200)
    const body = JSON.parse(resolved.payload)
    expect(body.status).toBe('resolved')
    expect(body.resolved_at).toBeTruthy()
    // deck_slide 之外的 target 不带 deck_snapshot（字段仅 deck 语义使用）
    expect(body.deck_snapshot).toBeUndefined()
  })
})

// ── #1074-6: 评论列表按需 select — with_anchor=1 才查 body/deck 大字段 ──
// 「懒计算」此前只省 CPU 不省 DB I/O：doc.body/deck 大字段无论是否需要诊断
// 都查出。现在 with_anchor=0（默认）只取 id（归属校验），大字段不进查询。
describe('#1074-6 评论列表按需 select', () => {
  const h = async () => ({ ...(await authHeader()), 'content-type': 'application/json' })

  test('行为不变：默认列表返回元数据无 anchor；with_anchor=1 返回 anchor', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n这是被评论的正文段落。\n')
    const headers = await h()
    const created = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`, headers,
      payload: JSON.stringify({ section_id: 'sec_intro', anchor_text: '这是被评论的正文段落。', text: '首条' }),
    })
    expect(created.statusCode).toBe(201)
    // 默认（with_anchor=0）：元数据齐全、无 anchor
    const plain = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers })).payload)
    expect(plain.comments).toHaveLength(1)
    expect(plain.comments[0].anchor_text).toBe('这是被评论的正文段落。')
    expect(plain.comments[0].anchor).toBeUndefined()
    // with_anchor=1：anchor 在场且定位成功（大字段查询路径的回归护栏）
    const withAnchor = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?with_anchor=1`, headers })).payload)
    expect(withAnchor.comments[0].anchor).toBeTruthy()
    expect(withAnchor.comments[0].anchor.located).toBe(true)
  })

  test('查询差异：默认不 select body/deck，with_anchor=1 才 select（大字段不进查询）', async () => {
    const app = await getApp()
    const docId = await createDoc('# Intro\n\n正文。\n')
    const headers = await h()
    const prisma = await getPrisma()
    const spy = vi.spyOn(prisma.doc, 'findFirst')
    try {
      await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments`, headers })
      await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/comments?with_anchor=1`, headers })
      expect(spy).toHaveBeenCalledTimes(2)
      // 第 1 次（默认）：select 只取 id — body/deck 大字段不在查询投影里
      const plainSelect = spy.mock.calls[0][0] as { select?: Record<string, unknown> }
      expect(plainSelect.select).toBeTruthy()
      expect(plainSelect.select!.id).toBe(true)
      expect(plainSelect.select!.body).toBeUndefined()
      expect(plainSelect.select!.deck).toBeUndefined()
      // 第 2 次（with_anchor=1）：body/deck 在 select 里
      const anchorSelect = spy.mock.calls[1][0] as { select?: Record<string, unknown> }
      expect(anchorSelect.select!.id).toBe(true)
      expect(anchorSelect.select!.body).toBe(true)
      expect(anchorSelect.select!.deck).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
