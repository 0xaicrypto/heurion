import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/db.ts'
import { DocFiles } from '../src/docs/workspace.ts'
import { mapNotification } from '../src/harness/events.ts'

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
    files.importUpload('d', 'docx', new Uint8Array([1]))

    const base = files.materializeHead('d')
    expect(files.snapshotAfterTurn('d', base, 'noop')).toBeNull()

    writeFileSync(files.workspaceFile('d', 'docx'), new Uint8Array([2]))
    expect(files.snapshotAfterTurn('d', base, 'edit')?.seq).toBe(2)

    const restored = files.restore('d', 1)
    expect(restored).toMatchObject({ seq: 3, source: 'restore' })
    expect([...files.readVersion('d', 3)]).toEqual([1])
    expect(store.getDoc('d')?.head_seq).toBe(3)
  })

  it('first AI turn on an empty doc creates v1', () => {
    const { store, files } = setup()
    store.createDoc('d', 'Deck', 'pptx')
    const base = files.materializeHead('d')
    expect(base).toBeNull()
    writeFileSync(files.workspaceFile('d', 'pptx'), new Uint8Array([9]))
    expect(files.snapshotAfterTurn('d', base, 'create')).toMatchObject({ seq: 1, source: 'ai' })
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
