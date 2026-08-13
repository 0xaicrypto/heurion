import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { buildPersona, buildFileContext } from '../../src/modules/chat/user-context'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores'
import os from 'os'
import path from 'path'
import fs from 'fs'

describe('P2 — Chat Context Enhancement', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = path.join(os.tmpdir(), `nexus-p2-${Date.now()}-${Math.random().toString(36).slice(2,6)}`)
  })

  test('buildPersona includes preferences from Facts', () => {
    const facts = new FactsStore(path.join(baseDir, 'persona-test'))
    facts.add({ category: 'preference', importance: 5, content: 'Prefer Chinese clinical content' })
    facts.add({ category: 'preference', importance: 4, content: 'Concise responses under 200 words' })
    facts.add({ category: 'fact', importance: 3, content: 'Working on NSCLC Phase II trial' })

    const persona = buildPersona(facts, new KnowledgeStore(path.join(baseDir, 'k')))
    expect(persona).toContain('Prefer Chinese')
    expect(persona).toContain('Concise responses')
    expect(persona).toContain('NSCLC')
  })

  test('buildPersona includes knowledge article titles', () => {
    const facts = new FactsStore(path.join(baseDir, 'pf2'))
    const knowledge = new KnowledgeStore(path.join(baseDir, 'pk2'))
    knowledge.add({ title: 'EGFR mutation management', content: 'Guidelines...', sources: [] })
    knowledge.add({ title: 'Immunotherapy biomarkers', content: 'Review...', sources: [] })

    const persona = buildPersona(facts, knowledge)
    expect(persona).toContain('EGFR mutation management')
    expect(persona).toContain('Immunotherapy biomarkers')
  })

  test('buildPersona falls back gracefully with no data', () => {
    const facts = new FactsStore(path.join(baseDir, 'empty-f'))
    const knowledge = new KnowledgeStore(path.join(baseDir, 'empty-k'))
    const persona = buildPersona(facts, knowledge)
    expect(persona).toContain('Heurion')
    expect(persona.length).toBeGreaterThan(10)
  })

  test('buildFileContext returns summaries sorted by recency', () => {
    const files = [
      { file_id: 'f1', name: 'CT report 7-15.txt', size_bytes: 1800, textContent: 'RUL nodule 18mm', createdAt: new Date('2026-07-15').toISOString() },
      { file_id: 'f2', name: 'Lab 7-10.txt', size_bytes: 200, textContent: 'CEA 3.2 normal', createdAt: new Date('2026-07-10').toISOString() },
      { file_id: 'f3', name: 'Old scan.dcm', size_bytes: 12000, textContent: null, createdAt: new Date('2026-06-01').toISOString() },
    ]
    const ctx = buildFileContext(files as any)
    expect(ctx).toContain('CT report 7-15')
    expect(ctx).toContain('RUL nodule 18mm')
    expect(ctx).toContain('Lab 7-10')
    // DICOM without textContent shows basic info
    expect(ctx).toContain('Old scan')
  })

  test('buildFileContext returns empty for no files', () => {
    expect(buildFileContext([])).toBe('')
  })
})

import { buildAttachmentParts } from '../../src/modules/chat/chat-context.js'
import { resolveScene } from '../../src/modules/chat/chat-context.js'

describe('#544 buildAttachmentParts', () => {
  let baseDir: string
  beforeEach(() => {
    baseDir = path.join(os.tmpdir(), `nexus-att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    process.env.TWIN_BASE_DIR = baseDir
  })
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  function putUpload(userId: string, fileId: string, content: Buffer) {
    const dir = path.join(baseDir, userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, fileId), content)
  }

  test('视觉 provider: 位图 → image part', async () => {
    putUpload('u1', 'abc_pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const { parts, attachmentText, notes } = await buildAttachmentParts(['abc_pic.png'], { userId: 'u1', vision: true })
    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('image')
    expect(notes[0]).toContain('image → multimodal')
    expect(attachmentText).toBe('')
  })

  test('视觉 provider: 超限图片 → 文本说明', async () => {
    putUpload('u1', 'big_x.png', Buffer.alloc(4 * 1024 * 1024 + 1))
    const { parts, attachmentText } = await buildAttachmentParts(['big_x.png'], { userId: 'u1', vision: true })
    expect(parts).toHaveLength(0)
    expect(attachmentText).toContain('4MB')
  })

  test('非视觉 provider: 不读文件,仅按文件名降级', async () => {
    const { parts, attachmentText, notes } = await buildAttachmentParts(['abc_pic.png'], { userId: 'u1', vision: false })
    expect(parts).toHaveLength(0)
    expect(attachmentText).toContain('不支持图片输入')
    expect(notes[0]).toContain('no vision')
  })

  test('文本附件注入内容', async () => {
    putUpload('u1', 'abc_note.txt', Buffer.from('血红蛋白 120 g/L'))
    const { parts, attachmentText } = await buildAttachmentParts(['abc_note.txt'], { userId: 'u1', vision: true })
    expect(parts).toHaveLength(0)
    expect(attachmentText).toContain('血红蛋白 120 g/L')
  })

  test('空附件/缺失文件不产生内容', async () => {
    const r = await buildAttachmentParts([], { userId: 'u1', vision: true })
    expect(r.parts).toHaveLength(0)
    expect(r.attachmentText).toBe('')
    const r2 = await buildAttachmentParts(['missing_x.txt'], { userId: 'u1', vision: true })
    expect(r2.parts).toHaveLength(0)
    expect(r2.attachmentText).toBe('')
  })
})
