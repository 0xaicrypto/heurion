import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { stateToDoc, writeFragment } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'

const bold = schema.marks.bold!.create()
const comment = schema.marks.comment!.create({ thread: 't1' })
const cite = schema.nodes.citation!.create({ cite_id: 'cx' })
/** 引用之后的文字只改格式：y-prosemirror 1.3.7 不更新这种格式变化，需要 writeFragment 修补。 */
const doc = (tail: Parameters<typeof schema.text>[1], extra = '') => schema.node('doc', null, [
  schema.node('paragraph', { id: 'p1' }, [schema.text('HR ', [comment]), schema.text('0.80', [bold, comment]), cite, schema.text('。尾。' + extra, tail)]),
  schema.node('paragraph', { id: 'p2' }, [schema.text('other')]),
])
const text = (ydoc: Y.Doc) => stateToDoc(Y.encodeStateAsUpdate(ydoc)).child(0).textContent
const firstText = (frag: Y.XmlFragment) => (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText

describe('Yjs 写入核对：原地修补格式', () => {
  it('只改格式的修补不替换 Yjs 元素', () => {
    const ydoc = new Y.Doc()
    ydoc.transact(() => writeFragment(ydoc, doc([bold])))
    const frag = ydoc.getXmlFragment('body')
    const before = frag.get(0)
    ydoc.transact(() => writeFragment(ydoc, doc([comment])))
    expect(frag.get(0)).toBe(before)
    expect(stateToDoc(Y.encodeStateAsUpdate(ydoc)).eq(doc([comment]))).toBe(true)
  })

  it('协作者在同一段的并发输入不丢', () => {
    const ydoc = new Y.Doc()
    ydoc.transact(() => writeFragment(ydoc, doc([bold])))
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc))
    ydoc.transact(() => writeFragment(ydoc, doc([comment])))
    remote.transact(() => firstText(remote.getXmlFragment('body')).insert(0, 'CONCURRENT '))
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(ydoc)))
    expect(text(ydoc)).toBe('CONCURRENT HR 0.80。尾。')
  })

  it('撤销触发修补的回合：只撤该回合，用户之后的输入保留', () => {
    const ydoc = new Y.Doc()
    ydoc.transact(() => writeFragment(ydoc, doc([bold])))
    const frag = ydoc.getXmlFragment('body')
    const turn = { turn: 'T1' }
    const undo = new Y.UndoManager(frag, { trackedOrigins: new Set([turn]), captureTimeout: 1e15 })
    ydoc.transact(() => writeFragment(ydoc, doc([comment], 'AI加的')), turn)
    ydoc.transact(() => firstText(frag).insert(0, 'LATER '))
    while (undo.canUndo()) undo.undo()
    expect(text(ydoc)).toBe('LATER HR 0.80。尾。')
  })

  it('之后的提交修补了上一回合改过的块，撤销上一回合仍然生效', () => {
    const ydoc = new Y.Doc()
    ydoc.transact(() => writeFragment(ydoc, doc([bold])))
    const frag = ydoc.getXmlFragment('body')
    const turn = { turn: 'T1' }
    const undo = new Y.UndoManager(frag, { trackedOrigins: new Set([turn]), captureTimeout: 1e15 })
    ydoc.transact(() => writeFragment(ydoc, doc([bold], 'AI加的')), turn)
    ydoc.transact(() => writeFragment(ydoc, doc([comment], 'AI加的')), { user: true })
    while (undo.canUndo()) undo.undo()
    expect(text(ydoc)).toBe('HR 0.80。尾。')
  })
})
