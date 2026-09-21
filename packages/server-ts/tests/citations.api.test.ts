/**
 * #1083/#1081 — DocCitation 端点（TDD，issue 用例表）。
 *
 * Mock 策略：不 mock Prisma — 数据库走 vitest 既有测试基建（globalSetup
 * 重置 test.db 并 db push 最新 schema），用例数据用后即删。不触 LLM。
 *
 * 用例覆盖：
 * 1. 创建 DocCitation 不带 doi / 非法 doi → store 层拒绝（citation-store.test.ts 锁定），
 *    本文件锁定端点层：列表/悬挂诊断/删除 + 归属守卫（他人 doc → 404）。
 * 2. 悬挂引用诊断：正文 [cite:id] 无记录 → dangling 列出且带出现次数。
 * 3. 删除引用记录 → 404 after；悬挂随之消失（记录在场后）。
 */
import { describe, test, expect, afterAll } from 'vitest'
import { getApp, authHeader, getAuthUserId, registerSecondUser } from './setup.js'

async function getPrisma() {
  const { default: prisma } = await import('../src/common/prisma.js')
  return prisma
}

const createdDocIds: string[] = []

async function createDoc(body: string): Promise<string> {
  const prisma = await getPrisma()
  const userId = await getAuthUserId()
  const id = `doc_cit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  await prisma.doc.create({ data: { id, userId, title: 'Citations test doc', body, createdAt: now, updatedAt: now } })
  createdDocIds.push(id)
  return id
}

async function seedCitation(docId: string, doi: string) {
  const { resolveOrCreateDocCitation } = await import('../src/lib/citation-store.js')
  return resolveOrCreateDocCitation({ docId, doi, title: `T ${doi}`, authors: ['A B'], source: 'crossref' })
}

describe('#1083/#1081 citations API', () => {
  afterAll(async () => {
    const prisma = await getPrisma()
    for (const id of createdDocIds) {
      await prisma.doc.deleteMany({ where: { id } }).catch(() => {})
    }
  })

  test('列表：结构化引用按 docId 返回，authors 反序列化为数组', async () => {
    const app = await getApp()
    const docId = await createDoc('A [cite:cite_x1] B')
    const row = await seedCitation(docId, '10.1000/list.1')
    const res = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/citations`, headers: await authHeader() })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.payload)
    expect(data.citations).toHaveLength(1)
    expect(data.citations[0].id).toBe(row.id)
    expect(data.citations[0].doi).toBe('10.1000/list.1')
    expect(Array.isArray(data.citations[0].authors)).toBe(true)
  })

  test('悬挂诊断：正文 shortcode 无记录 → dangling 列出（带出现次数）；建行后消失', async () => {
    const app = await getApp()
    const docId = await createDoc('')
    const row = await seedCitation(docId, '10.1000/dg.1')
    const prisma = await getPrisma()
    await prisma.doc.update({ where: { id: docId }, data: { body: `A [cite:${row.id}] B [cite:cite_ghost] C [cite:${row.id}]` } })
    const res = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/citations/dangling`, headers: await authHeader() })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.payload)
    expect(data.dangling).toEqual([{ id: 'cite_ghost', occurrences: 1 }])
    // 已知引用出现在 citations（供前端对账）
    expect(data.citations.some((c: { id: string }) => c.id === row.id)).toBe(true)
    // 补建 ghost 记录（id 恰为 'cite_ghost'）→ 悬挂消失
    await prisma.docCitation.create({ data: { id: 'cite_ghost', docId, doi: '10.1000/dg.9', title: 'ghost', authors: '[]', source: 'crossref', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }).catch(() => {})
    const res2 = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/citations/dangling`, headers: await authHeader() })
    expect(JSON.parse(res2.payload).dangling).toEqual([])
    await prisma.docCitation.deleteMany({ where: { docId, id: 'cite_ghost' } })
  })

  test('删除引用记录：本人可删，删除后列表移除；他人文档 → 404 防枚举', async () => {
    const app = await getApp()
    const docId = await createDoc('A [cite:cite_x2]')
    const row = await seedCitation(docId, '10.1000/del.1')
    // 他人删除 → 404（不泄露存在性）
    const other = await registerSecondUser()
    const resOther = await app.inject({ method: 'DELETE', url: `/api/v1/docs/${docId}/citations/${row.id}`, headers: { authorization: `Bearer ${other.token}` } })
    expect(resOther.statusCode).toBe(404)
    // 本人删除 → ok + 列表移除
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/docs/${docId}/citations/${row.id}`, headers: await authHeader() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).ok).toBe(true)
    const list = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/citations`, headers: await authHeader() })
    expect(JSON.parse(list.payload).citations).toHaveLength(0)
    // 重复删除 → 404
    const resAgain = await app.inject({ method: 'DELETE', url: `/api/v1/docs/${docId}/citations/${row.id}`, headers: await authHeader() })
    expect(resAgain.statusCode).toBe(404)
  })

  test('复审 #2/#3 — 悬挂引用清除端点：body+deck 同帧清除，客户端基线保护未保存修改', async () => {
    const app = await getApp()
    const docId = await createDoc('A [cite:cite_ghostX] B [cite:cite_ghostX]')
    // 面向真实记录的 DELETE 对悬挂引用 → 404（无记录可删）
    const resOld = await app.inject({ method: 'DELETE', url: `/api/v1/docs/${docId}/citations/cite_ghostX`, headers: await authHeader() })
    expect(resOld.statusCode).toBe(404)
    // 专用清除端点（base_body = 客户端未保存内容；server_base = 客户端所知
    // 服务端基线 = 当前服务端值）→ 标记移除 + 未保存编辑一并落库
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/citations/dangling/cite_ghostX/remove`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {
        base_body: 'A [cite:cite_ghostX] B [cite:cite_ghostX] 用户未保存的编辑',
        server_base: 'A [cite:cite_ghostX] B [cite:cite_ghostX]',
      },
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.payload)
    expect(data.ok).toBe(true)
    expect(data.removed).toBe(2)
    expect(data.deck).toBeNull()
    // 复审轮 5: body_changed 显式标记（前端只同步实际改写的维度）
    expect(data.body_changed).toBe(true)
    const updated = await getPrisma().then((p) => p.doc.findUnique({ where: { id: docId } }))
    expect(updated!.body).toContain('用户未保存的编辑') // 未保存编辑保留并落库
    expect(updated!.body).not.toContain('[cite:cite_ghostX]')

    // 复审 #2: server_base 过期（服务端已被其他窗口推进）→ 409 不覆盖
    // （serverDeck/server_deck_base 复审轮 4 断言需要 deck 基线 — 前置定义）
    const serverDeck = JSON.stringify({ title: 'D', slides: [{ title: '页 [cite:cite_ghostX]' }] })
    const stale = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/citations/dangling/cite_ghostX/remove`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { server_base: '过期版本' },
    })
    expect(stale.statusCode).toBe(409)
    // 复审轮 4: server_deck_base 过期 → 409（deck 侧同强度）
    await getPrisma().then((db) => db.doc.update({ where: { id: docId }, data: { deck: serverDeck } }))
    const staleDeck = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/citations/dangling/cite_ghostX/remove`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { server_deck_base: '过期 deck' },
    })
    expect(staleDeck.statusCode).toBe(409)
    // deck 内悬挂同帧清除（复审 #3 + 复审轮 4 P0：客户端实时 deck 基线
    // 参与计算 — 未保存的画布编辑保留，标记从客户端版本剥除）
    const prisma = await getPrisma()
    await prisma.doc.update({ where: { id: docId }, data: { deck: serverDeck } })
    const clientDeckUnsaved = JSON.stringify({ title: 'D', slides: [{ title: '用户未保存的标题 [cite:cite_ghostX]' }] })
    const resDeck = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/citations/dangling/cite_ghostX/remove`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {
        base_deck: clientDeckUnsaved,
        server_deck_base: serverDeck, // 客户端所知服务端基线 = 当前值 → 不冲突
      },
    })
    expect(resDeck.statusCode).toBe(200)
    const deckData = JSON.parse(resDeck.payload)
    // 未保存的画布编辑保留（复审轮 4 P0：此前 serverDeck 参与计算 → 编辑被静默丢弃）
    expect(deckData.deck).toContain('用户未保存的标题')
    expect(deckData.deck).not.toContain('[cite:cite_ghostX]')
    // 复审轮 5 P0 镜像修复 — deck-only 清除：body_changed=false，前端不得把
    // 返回的旧 body 灌回编辑器（服务端 outcome.body = 未改写的库值）
    expect(deckData.body_changed).toBe(false)
    // body 未被本请求改写 → 返回库值（前端守卫不会灌回编辑器）
    expect(deckData.body).toBe('A B 用户未保存的编辑')
    // 标记已不存在 → 重复清理 → 404
    const resAgain = await app.inject({ method: 'POST', url: `/api/v1/docs/${docId}/citations/dangling/cite_ghostX/remove`, headers: await authHeader() })
    expect(resAgain.statusCode).toBe(404)
    // 他人文档 → 404 防枚举
    const otherDoc = await createDoc('X [cite:cite_ghostY]')
    const other = await registerSecondUser()
    const resOther2 = await app.inject({ method: 'POST', url: `/api/v1/docs/${otherDoc}/citations/dangling/cite_ghostY/remove`, headers: { authorization: `Bearer ${other.token}` } })
    expect(resOther2.statusCode).toBe(404)
  })

  test('复审安全 #1 — citationId 正则注入被白名单拒绝（400，不触发 RegExp 构造）', async () => {
    const app = await getApp()
    const docId = await createDoc('X')
    // ReDoS 形态（嵌套量词）与不闭合括号形态均被字符集白名单拦截
    for (const evil of ['a+)+$', '((a+)+', '(a|b)+$']) {
      const res = await app.inject({ method: 'POST', url: `/api/v1/docs/${docId}/citations/dangling/${encodeURIComponent(evil)}/remove`, headers: await authHeader() })
      expect(res.statusCode).toBe(400)
    }
    // 同文档内合法 id 不受影响
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/citations/dangling/cite_ok_1/remove`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404) // 无标记 → 404（而非 400/500）
  })

  test('复审轮 4 — server_deck_base 过期 → 409（deck 侧乐观链路对齐 body）', async () => {
    const app = await getApp()
    const docId = await createDoc('A [cite:cite_ghostZ]')
    const prisma = await getPrisma()
    await prisma.doc.update({ where: { id: docId }, data: { deck: JSON.stringify({ title: 'D', slides: [{ title: '页 [cite:cite_ghostZ]' }] }) } })
    // server_deck_base 过期（服务端 deck 已被其他窗口推进）→ 409；
    // base_deck 是计算底稿（客户端未保存内容）— 与 body 侧 server_base 同语义。
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/citations/dangling/cite_ghostZ/remove`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { server_deck_base: '过期 deck' },
    })
    expect(res.statusCode).toBe(409)
  })

  test('复审 #8 — 悬挂诊断扫描 deck 内容 + occurrences 计数', async () => {
    const app = await getApp()
    const docId = await createDoc('正文 [cite:cite_bd1]')
    const prisma = await getPrisma()
    const deck = JSON.stringify({ title: 'D', slides: [{ title: '页 [cite:cite_bd2]', content: [{ type: 'paragraph', text: '块 [cite:cite_bd2] [cite:cite_bd1]' }] }] })
    await prisma.doc.update({ where: { id: docId }, data: { deck } })
    const res = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/citations/dangling`, headers: await authHeader() })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.payload)
    const byId = new Map(data.dangling.map((d: { id: string; occurrences: number }) => [d.id, d.occurrences]))
    expect(byId.get('cite_bd1')).toBe(2) // 正文 1 + deck 块 1
    expect(byId.get('cite_bd2')).toBe(2) // deck 标题 1 + 块 1
  })

  test('未认证 → 401', async () => {
    const app = await getApp()
    const docId = await createDoc('x')
    const res = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/citations` })
    expect(res.statusCode).toBe(401)
  })
})
