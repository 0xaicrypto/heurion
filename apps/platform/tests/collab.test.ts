import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { Node as PMNode } from 'prosemirror-model'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { attachCollab, MSG_SYNC } from '../src/collab/gateway.ts'
import { PostCheck, type Notice } from '../src/collab/postcheck.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { OpError } from '../src/ops/types.ts'
import { Store } from '../src/store/db.ts'

const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function start(markdown: string) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const postcheck = new PostCheck(docs)
  const row = docs.create({ owner: 'u1', title: 't', content: schema.node('doc', null, parseBlocks(markdown)) })
  const server = createServer()
  attachCollab(server, { docs, authenticate: t => t === 'ok' ? 'u1' : null })
  await new Promise<void>(r => server.listen(0, r))
  servers.push(server)
  const port = (server.address() as AddressInfo).port
  return { store, docs, ops, postcheck, docId: row.id, url: (token = 'ok') => `ws://127.0.0.1:${port}/collab/${row.id}?token=${token}` }
}

/** 模拟浏览器：Y.Doc + 最小同步协议（与前端 provider 相同）。 */
async function client(url: string) {
  const ydoc = new Y.Doc()
  const ws = new WebSocket(url)
  let synced = false
  ws.on('message', (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data))
    if (decoding.readVarUint(decoder) !== MSG_SYNC) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    const kind = syncProtocol.readSyncMessage(decoder, encoder, ydoc, 'remote')
    if (kind === syncProtocol.messageYjsSyncStep2) synced = true
    if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder))
  })
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote' || ws.readyState !== ws.OPEN) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    ws.send(encoding.toUint8Array(encoder))
  })
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject) })
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.writeSyncStep1(encoder, ydoc)
  ws.send(encoding.toUint8Array(encoder))
  await until(() => synced)
  const frag = ydoc.getXmlFragment('body')
  return {
    ydoc,
    ws,
    doc: (): PMNode => yXmlFragmentToProseMirrorRootNode(frag, schema),
    /** 模拟编辑器的一次本地修改。 */
    edit: (fn: (doc: PMNode) => PMNode) => {
      const next = fn(yXmlFragmentToProseMirrorRootNode(frag, schema))
      ydoc.transact(() => updateYFragment(ydoc, frag, next, { mapping: new Map(), isOMark: new Map() } as never))
    },
  }
}

const replaceChild = (doc: PMNode, index: number, node: PMNode) => doc.copy(doc.content.replaceChild(index, node))
const para = (text: string, id: string | null = null) => schema.node('paragraph', { id }, text ? [schema.text(text)] : [])

describe('协同网关', () => {
  it('浏览器编辑实时写入服务端，合批落成用户提交', async () => {
    const t = await start('第一段。\n\n第二段。')
    const c = await client(t.url())
    const first = c.doc().child(0).attrs.id as string
    c.edit(d => replaceChild(d, 0, para('第一段（已改）。', first)))
    await until(() => t.docs.get(t.docId).child(0).textContent === '第一段（已改）。')
    t.docs.flush(t.docId)
    expect(t.docs.rev(t.docId)).toBe(1)
    expect(t.store.lastChangeBy(t.docId, first, 'user')).toBe(1)
    c.ws.close()
  })

  it('服务端提交（AI）广播到浏览器', async () => {
    const t = await start('第一段。')
    const c = await client(t.url())
    const id = c.doc().child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: id, markdown: 'AI 新增。' }] }, { actor: 'ai', turnId: null })
    await until(() => c.doc().childCount === 2)
    expect(c.doc().child(1).textContent).toBe('AI 新增。')
    c.ws.close()
  })

  it('编辑器拆段复制的 id 被修复并同步回浏览器', async () => {
    const t = await start('一段。')
    const c = await client(t.url())
    const id = c.doc().child(0).attrs.id as string
    c.edit(d => d.copy(d.content.append(schema.node('doc', null, [para('拆出来的。', id)]).content)))
    await until(() => t.docs.get(t.docId).childCount === 2)
    t.docs.flush(t.docId)
    await until(() => c.doc().child(1).attrs.id !== id)
    const ids = [t.docs.get(t.docId).child(0).attrs.id, t.docs.get(t.docId).child(1).attrs.id]
    expect(ids[0]).toBe(id)
    expect(ids[1]).toBeTruthy()
    expect(ids[1]).not.toBe(id)
    c.ws.close()
  })

  it('用户优先：浏览器刚改过（尚未落库）的块，AI 用旧 rev 改会被拒绝', async () => {
    const t = await start('第一段。')
    const c = await client(t.url())
    const id = c.doc().child(0).attrs.id as string
    c.edit(d => replaceChild(d, 0, para('用户正在改。', id)))
    await until(() => t.docs.get(t.docId).child(0).textContent === '用户正在改。')
    let err: unknown
    try {
      t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id, markdown: 'AI 覆盖。' }] }, { actor: 'ai', turnId: null })
    } catch (e) { err = e }
    expect((err as OpError).code).toBe('conflict_user_edited')
    expect(t.docs.get(t.docId).child(0).textContent).toBe('用户正在改。')
    c.ws.close()
  })

  it('撤销一轮 AI 修改：只撤该回合，用户期间的编辑保留', async () => {
    const t = await start('甲段。\n\n乙段。')
    const c = await client(t.url())
    const [a, b] = [c.doc().child(0).attrs.id as string, c.doc().child(1).attrs.id as string]
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: a, find: '甲段', replace: 'AI 改甲' },
      { op: 'insert_after', anchor_id: b, markdown: 'AI 新增丙。' },
    ] }, { actor: 'ai', turnId: 'r1' })
    await until(() => c.doc().childCount === 3)
    c.edit(d => replaceChild(d, 1, para('用户改乙。', b)))
    await until(() => t.docs.get(t.docId).child(1).textContent === '用户改乙。')
    expect(t.docs.canRevertTurn(t.docId, 'r1')).toBe(true)
    t.docs.revertTurn(t.docId, 'r1')
    const now = t.docs.get(t.docId)
    expect(now.childCount).toBe(2)
    expect(now.child(0).textContent).toBe('甲段。')
    expect(now.child(1).textContent).toBe('用户改乙。')
    await until(() => c.doc().childCount === 2)
    expect(t.docs.canRevertTurn(t.docId, 'r1')).toBe(false)
    c.ws.close()
  })

  it('事后检查：用户手写 DOI 给出提示，不拒绝', async () => {
    const t = await start('正文。')
    const notices: Notice[] = []
    t.postcheck.on('notice', n => notices.push(n))
    const c = await client(t.url())
    const id = c.doc().child(0).attrs.id as string
    c.edit(d => replaceChild(d, 0, para('见 doi:10.1056/NEJMoa1607141。', id)))
    await until(() => t.docs.get(t.docId).child(0).textContent.includes('doi'))
    t.docs.flush(t.docId)
    expect(notices[0]?.code).toBe('manual_citation')
    expect(t.docs.get(t.docId).child(0).textContent).toContain('10.1056')
    c.ws.close()
  })

  it('无效令牌被拒绝', async () => {
    const t = await start('x')
    const ws = new WebSocket(t.url('bad'))
    const status = await new Promise<number>(resolve => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)))
    expect(status).toBe(401)
  })
})
