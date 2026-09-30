import { describe, expect, it } from 'vitest'
import type { CommentAnchor } from '../src/db.ts'
import type { Projection } from '../src/docs/office.ts'
import { auditCommentAnchors, locateAnchor } from '../src/docs/comments.ts'
import { commentToolHandlers } from '../src/literature/mcp.ts'
import { Store } from '../src/db.ts'

const proj = (nodes: Array<{ id: string; text: string }>): Projection => ({
  nodes: nodes.map(n => ({ ...n, kind: 'paragraph' as const })),
})

const anchor = (over: Partial<CommentAnchor> = {}): CommentAnchor => ({ text_snippet: '研究背景', para_id: 'P1', ...over })

function setup() {
  const store = new Store(':memory:')
  store.createDoc('d1', 'Paper', 'docx')
  store.createDoc('d2', 'Other', 'docx')
  return store
}

describe('评论存储', () => {
  it('创建 / 双重过滤 / 回复 / resolve / reopen', () => {
    const store = setup()
    const c = store.addComment('d1', anchor())
    expect(c.status).toBe('open')
    expect(c.kind).toBe('docx')

    // 跨文档 id 不可见
    expect(store.getComment('d2', c.id)).toBeUndefined()
    expect(store.getComment('d1', c.id)?.id).toBe(c.id)

    store.addReply('d1', c.id, 'user', '补充 RCT 证据')
    expect(store.getComment('d1', c.id)!.replies).toHaveLength(1)

    expect(store.resolveComment('d1', c.id, 'user')).toBe(true)
    expect(store.resolveComment('d1', c.id, 'user')).toBe(false)
    expect(store.reopenComment('d1', c.id)).toBe(true)
    expect(store.getComment('d1', c.id)).toMatchObject({ status: 'open', resolved_by: null })
  })
})

describe('MCP 评论工具', () => {
  it('list：跨文档令牌枚举不到他人评论；open 附 located', async () => {
    const store = setup()
    const c = store.addComment('d1', anchor())
    store.getDoc('d1')!.head_seq // 有 head 才有投影对照；这里 0 → 不附诊断

    const h1 = commentToolHandlers({ store }, 'd1')
    const h2 = commentToolHandlers({ store }, 'd2')

    const listed = JSON.parse((await h1.list({})).content[0]!.text)
    expect(listed.count).toBe(1)
    expect(listed.comments[0]!.comment_id).toBe(c.id)

    // d2 的令牌直查 d1 的线程 → 空 + 说明
    const cross = JSON.parse((await h2.list({ comment_id: c.id })).content[0]!.text)
    expect(cross.count).toBe(0)
    expect(cross.note).toContain('不属于本文档')
  })

  it('reply：role 服务端固定 ai；他人文档拒绝', async () => {
    const store = setup()
    const c = store.addComment('d1', anchor())
    const h1 = commentToolHandlers({ store }, 'd1')
    const h2 = commentToolHandlers({ store }, 'd2')

    const ok = JSON.parse((await h1.reply({ comment_id: c.id, text: "已补充" })).content[0]!.text)
    expect(ok.role).toBe('ai')
    expect(store.getComment('d1', c.id)!.replies[0]!.role).toBe('ai')

    const cross = await h2.reply({ comment_id: c.id, text: "越权" })
    expect(JSON.parse(cross.content[0]!.text).code).toBe('unit_not_found')

    const empty = await h1.reply({ comment_id: c.id, text: "  " })
    expect(JSON.parse(empty.content[0]!.text).code).toBe('empty_args')
  })

  it('resolve：无 AI 回复拒绝；AI 回复后可关闭，重复关闭给 unit_unchanged', async () => {
    const store = setup()
    const c = store.addComment('d1', anchor())
    const h = commentToolHandlers({ store }, 'd1')

    const refused = JSON.parse((await h.resolve({ comment_id: c.id })).content[0]!.text)
    expect(refused.code).toBe('validation_error')

    await h.reply({ comment_id: c.id, text: "无需改动，该段已满足要求" })
    const ok = JSON.parse((await h.resolve({ comment_id: c.id })).content[0]!.text)
    expect(ok.status).toBe('resolved')

    const again = JSON.parse((await h.resolve({ comment_id: c.id })).content[0]!.text)
    expect(again.code).toBe('unit_unchanged')
  })
})

describe('锚点定位与漂移审计', () => {
  it('located：目标在 + 片段命中；目标被删 → 漂移 + 候选', () => {
    const before = proj([{ id: 'P1', text: '研究背景与意义' }, { id: 'P2', text: '方法' }])
    const afterDelete = proj([{ id: 'P2', text: '方法' }])

    expect(locateAnchor(anchor(), before).located).toBe(true)

    // 目标没了、片段在别处出现 → 漂移但给候选
    const moved = proj([{ id: 'P2', text: '前言：研究背景与意义' }])
    const diag = locateAnchor(anchor(), moved)
    expect(diag.located).toBe(false)
    expect(diag.candidates).toEqual([{ id: 'P2', text: '前言：研究背景与意义' }])

    // 片段整段消失 → 漂移无候选
    expect(locateAnchor(anchor(), afterDelete)).toEqual({ located: false })
  })

  it('落版审计：删除锚点段落后线程标漂移（幂等）', () => {
    const store = setup()
    store.addComment('d1', anchor())
    const p1 = proj([{ id: 'P1', text: '研究背景与意义' }])
    expect(auditCommentAnchors(store, 'd1', 1, p1)).toEqual([])
    expect(store.listComments('d1', 'open')[0]!.drifted).toBe(false)

    const p2 = proj([{ id: 'P2', text: '方法' }])
    expect(auditCommentAnchors(store, 'd1', 2, p2)).toEqual([store.listComments('d1', 'open')[0]!.id])
    expect(store.listComments('d1', 'open')[0]!.drifted).toBe(true)

    // 再跑一遍幂等
    expect(auditCommentAnchors(store, 'd1', 2, p2)).toHaveLength(1)
  })
})
