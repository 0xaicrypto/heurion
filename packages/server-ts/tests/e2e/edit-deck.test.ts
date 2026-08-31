import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { EditDeckTool } from '../../src/tools/edit-deck-tool.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

const DECK = {
  schemaVersion: 1,
  title: 'EGFR 研究汇报',
  slides: [
    { title: '研究背景', content: [{ type: 'paragraph', text: 'EGFR 突变 NSCLC 一线治疗', style: 'bullet' }] },
    { title: '关键结果', content: [{ type: 'paragraph', text: '中位 PFS 5.2 个月', style: 'bullet' }] },
    { title: '结论', content: [{ type: 'paragraph', text: '获益人群需筛选', style: 'bullet' }] },
  ],
}

async function createDocWithDeck(app: any, deck: unknown) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/docs',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { title: 'Deck Test' },
  })
  const docId = JSON.parse(res.payload).id
  await app.inject({
    method: 'PUT', url: `/api/v1/docs/${docId}`,
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { body: '# 正文\n\n文章原文。', deck },
  })
  return docId
}

describe('#773 edit_deck 工具', () => {
  test('update: 改第 2 页 → deck 更新、body 不变、快照同帧带旧 deck', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDocWithDeck(app, DECK)

    const result = await new EditDeckTool({ userId, sessionId: `doc-${docId}` })
      .execute({ action: 'update', slide_index: 2, title: '疗效结果', bullets: ['PFS 5.2 个月', 'ORR 68%'] })

    expect(result.success).toBe(true)
    const { body, deck, summary } = JSON.parse(result.output as string)
    expect(body).toContain('文章原文。')
    expect(deck.slides).toHaveLength(3)
    expect(deck.slides[1].title).toBe('疗效结果')
    expect(deck.slides[1].content.map((c: any) => c.text)).toEqual(['PFS 5.2 个月', 'ORR 68%'])
    expect(summary).toContain('第 2 页')

    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(JSON.parse(doc.deck).slides[1].title).toBe('疗效结果')
    expect(doc.body).toContain('文章原文。')

    const snap = await (prisma as any).docSnapshot.findFirst({ where: { docId }, orderBy: { id: 'desc' } })
    expect(snap.label).toBe('AI deck edit')
    expect(JSON.parse(snap.deck).slides[1].title).toBe('关键结果')
  }, 30000)

  test('delete / insert_after: 删页与插页（1-based 定位）', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDocWithDeck(app, DECK)
    const tool = () => new EditDeckTool({ userId, sessionId: `doc-${docId}` })

    const del = await tool().execute({ action: 'delete', slide_index: 1 })
    expect(del.success).toBe(true)
    expect(JSON.parse(del.output as string).deck.slides.map((s: any) => s.title)).toEqual(['关键结果', '结论'])

    const ins = await tool().execute({ action: 'insert_after', slide_index: 1, title: '方法', bullets: ['RCT 设计'] })
    expect(ins.success).toBe(true)
    expect(JSON.parse(ins.output as string).deck.slides.map((s: any) => s.title)).toEqual(['关键结果', '方法', '结论'])
  }, 30000)

  test('缺 deck / 越界 index / 缺 bullets → 可读报错；非 doc 会话拒绝', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()

    const res = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'No Deck' },
    })
    const noDeckId = JSON.parse(res.payload).id
    const noDeck = await new EditDeckTool({ userId, sessionId: `doc-${noDeckId}` })
      .execute({ action: 'delete', slide_index: 1 })
    expect(noDeck.success).toBe(false)
    expect(noDeck.error).toContain('没有 deck')
    expect(noDeck.error).toContain('organize')

    const docId = await createDocWithDeck(app, DECK)
    const outOfRange = await new EditDeckTool({ userId, sessionId: `doc-${docId}` })
      .execute({ action: 'delete', slide_index: 9 })
    expect(outOfRange.success).toBe(false)
    expect(outOfRange.error).toContain('超出范围')

    const noBullets = await new EditDeckTool({ userId, sessionId: `doc-${docId}` })
      .execute({ action: 'update', slide_index: 1, title: '新标题' })
    expect(noBullets.success).toBe(false)
    expect(noBullets.error).toContain('bullets')

    const nonDoc = await new EditDeckTool({ userId, sessionId: 'global-x' })
      .execute({ action: 'delete', slide_index: 1 })
    expect(nonDoc.success).toBe(false)
    expect(nonDoc.error).toContain('document writing session')
  }, 30000)

  test('#773 edit_deck 仅 doc- 会话暴露（工具面门控）', async () => {
    const app = await getApp()
    const ctx = {
      userId: 'u', memory: {} as any, facts: {} as any, episodes: {} as any,
      skills: {} as any, knowledge: {} as any, eventLog: {} as any,
    }
    const { ToolRegistry } = await import('../../src/tools/tool-registry.js')
    const registry = new ToolRegistry(ctx as any)
    const docDefs = await registry.getDefinitionsForUser('document', 'doc-7')
    expect(docDefs.map((d) => d.function.name)).toContain('edit_deck')
    const generalDefs = await registry.getDefinitionsForUser('general', 'session_abc')
    expect(generalDefs.map((d) => d.function.name)).not.toContain('edit_deck')
    void app
  }, 30000)
})

describe('#773 deck REST（GET/PUT docs + 再导出内容源）', () => {
  test('PUT 保存 deck → GET 返回 deck；deck-only 变更也建快照', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'REST Deck' },
    })
    const docId = JSON.parse(res.payload).id

    const put = await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { deck: DECK },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().deck.title).toBe('EGFR 研究汇报')

    const get = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}`,
      headers: await authHeader(),
    })
    expect(get.json().deck).toEqual(DECK)

    // deck-only 变更也建快照 — 快照行存旧状态（与 body 语义一致：首保
    // 无旧 deck → null；二次保存时快照 deck = 上一版 deck）。
    const snaps1 = await (prisma as any).docSnapshot.findMany({ where: { docId } })
    expect(snaps1).toHaveLength(1)
    expect(snaps1[0].label).toBe('保存版本')
    expect(snaps1[0].deck).toBeNull()

    const DECK_V2 = { ...DECK, title: 'EGFR 研究汇报 v2' }
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { deck: DECK_V2 },
    })
    const snaps2 = await (prisma as any).docSnapshot.findMany({ where: { docId }, orderBy: { id: 'desc' } })
    expect(snaps2).toHaveLength(2)
    expect(JSON.parse(snaps2[0].deck)).toEqual(DECK)
  }, 30000)
})
