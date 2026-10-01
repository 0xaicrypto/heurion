import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/db.ts'
import { DocFiles } from '../src/docs/workspace.ts'
import { mapNotification } from '../src/harness/events.ts'

const docxOf = (text: string) =>
  zipSync({
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'h2-'))
  const store = new Store(':memory:')
  const files = new DocFiles(store, join(dir, 'ws'), join(dir, 'versions'))
  return { store, files }
}

describe('DocFiles', () => {
  it('versions only when the workspace file changes, and restore appends', () => {
    const { store, files } = setup()
    store.createDoc('d', 'Paper', 'docx')
    files.importUpload('d', 'docx', docxOf('第一版'))

    const base = files.materializeHead('d')
    expect(files.snapshotAfterTurn('d', base, 'noop')).toBeNull()

    writeFileSync(files.workspaceFile('d', 'docx'), docxOf('第二版'))
    expect(files.snapshotAfterTurn('d', base, 'edit')?.seq).toBe(2)

    const restored = files.restore('d', 1)
    expect(restored).toMatchObject({ seq: 3, source: 'restore' })
    expect(store.getDoc('d')?.head_seq).toBe(3)
  })

  it('first AI turn on an empty doc creates v1', () => {
    const { store, files } = setup()
    store.createDoc('d', 'Deck', 'pptx')
    const base = files.materializeHead('d')
    expect(base).toBeNull()
    writeFileSync(files.workspaceFile('d', 'pptx'), zipSync({ 'ppt/slides/slide1.xml': strToU8('<p:sld/>') }))
    expect(files.snapshotAfterTurn('d', base, 'create')).toMatchObject({ seq: 1, source: 'ai' })
  })

  it('损坏/半成品字节不落版本（结构检查交给 dsh office 技能）', () => {
    const { store, files } = setup()
    store.createDoc('d', 'Paper', 'docx')
    files.importUpload('d', 'docx', docxOf('第一版'))
    writeFileSync(files.workspaceFile('d', 'docx'), new Uint8Array([2, 3, 4]))
    expect(files.snapshotAfterTurn('d', files.materializeHead('d'), '坏字节')).toBeNull()
    expect(store.getDoc('d')?.head_seq).toBe(1)
  })
})

describe('mapNotification', () => {
  it('maps root-session assistant blocks and ignores other sessions', () => {
    const n = {
      method: 'session.event',
      params: { sessionId: 's', event: { type: 'assistant/message', data: { message: { content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'done' },
        { type: 'tool-call', id: 'c1', name: 'shell', arguments: '{}' },
      ] } } } },
    }
    expect(mapNotification(n, 's')).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'assistant', text: 'done' },
      { type: 'tool_call', callId: 'c1', name: 'shell', arguments: '{}' },
    ])
    expect(mapNotification(n, 'other')).toEqual([])
  })

  it('maps turn/end error reasons to a readable error event', () => {
    const n = { method: 'session.event', params: { sessionId: 's', event: { type: 'turn/end', data: {
      turn: 1, reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } },
    } } } }
    expect(mapNotification(n, 's')).toEqual([
      { type: 'turn_end', reason: 'error' },
      { type: 'error', message: '服务端未配置 DEEPSEEK_API_KEY，请在 .env 中填写后重启 server。' },
    ])
  })
})
