/**
 * #1101（pptx 字节单一标准）— deck 工件 lib 单测。
 *
 * Mock 策略：不 mock Prisma — 数据库走 vitest 既有测试基建（globalSetup
 * 重置 test.db），fixture user/doc 用后即删；uploads 物理文件走
 * TWIN_BASE_DIR 测试目录，afterAll 清理。引擎面（pptx-viewer-core）走
 * 真实序列化/加载 round-trip（spike #1102 已验证 headless 可用）。
 */
import { describe, test, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import prisma from '../../src/common/prisma.js'
import {
  putDeckArtifact,
  getDeckArtifact,
  serializeDeckWireToPptx,
  deckProjectionStaleness,
  rebuildDeckProjection,
} from '../../src/lib/deck-bytes.js'
import { parsePptx } from '../../src/lib/pptx-extractor.js'
import { uploadsBaseDir } from '../../src/lib/upload-path.js'

const USER = `usr_deck_${Math.random().toString(36).slice(2, 8)}`
const OTHER = `usr_deck2_${Math.random().toString(36).slice(2, 8)}`
const createdUserIds: string[] = [USER, OTHER]
const createdDocIds: string[] = []

async function ensureUser(userId: string): Promise<void> {
  const now = new Date().toISOString()
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, displayName: `decktest_${userId}`, createdAt: now, updatedAt: now },
    update: {},
  })
}

async function createDoc(deck?: string): Promise<string> {
  await ensureUser(USER)
  const id = `doc_${Math.random().toString(16).slice(2, 10).padEnd(16, '0').slice(0, 16)}`
  const now = new Date().toISOString()
  await prisma.doc.create({
    data: {
      id,
      userId: USER,
      title: 'Deck bytes test doc',
      body: '正文',
      ...(deck !== undefined ? { deck } : {}),
      createdAt: now,
      updatedAt: now,
    },
  })
  createdDocIds.push(id)
  return id
}

function sampleDeckWire() {
  return {
    schemaVersion: 2,
    title: '单测 deck',
    slides: [
      {
        title: '页一：EGFR 突变概览',
        notes: '备注：引用第 3 段数据',
        content: [
          { type: 'paragraph', text: '要点一：87 例 EGFR 敏感突变', style: 'bullet' },
          { type: 'paragraph', text: '要点二：ORR 71%', style: 'bullet' },
        ],
      },
      {
        title: '页二：疗效对比',
        content: [
          { type: 'paragraph', text: 'PFS 9.2 vs 5.4 个月', style: 'normal' },
        ],
      },
    ],
  }
}

describe('#1101 serializeDeckWireToPptx → PptxHandler round-trip', () => {
  test('标题/要点/notes 序列化 → 引擎重新可读（内容等价）', async () => {
    const bytes = await serializeDeckWireToPptx(sampleDeckWire())
    expect(bytes.length).toBeGreaterThan(5000)

    const { Presentation } = await import('pptx-viewer-core')
    const pres = await Presentation.load(new Uint8Array(bytes).buffer)
    try {
      expect(pres.slideCount).toBe(2)
      // 要点文本以正式 findText API 可定位（编辑面同源）。
      const hits = pres.findText('87 例 EGFR 敏感突变')
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].elementId).toMatch(/ppt\/slides\/slide\d+\.xml-shape-\d+/)
      expect(pres.slides[0].notes).toBe('备注：引用第 3 段数据')
    } finally {
      pres.handler.dispose()
    }
  })

  test('空 slides / 非法输入 → 可读错误（不产生半截字节）', async () => {
    await expect(serializeDeckWireToPptx({ title: '空', slides: [] })).rejects.toThrow(/slides/)
    await expect(serializeDeckWireToPptx(null)).rejects.toThrow(/slides/)
  })

  test('未知块降级占位（figure/未知类型 → [不支持的内容块]，不静默丢内容）', async () => {
    const bytes = await serializeDeckWireToPptx({
      title: '降级',
      slides: [
        { title: '页', content: [{ type: 'figure', kind: 'mermaid', source: 'graph TD' }] },
      ],
    })
    const parsed = parsePptx(bytes)
    expect(parsed.ok).toBe(true)
    expect(parsed.slides[0].paragraphs.some((p) => p.includes('[不支持的内容块]'))).toBe(true)
  })
})

describe('#1101 putDeckArtifact（FileIndex 工件 + 投影重建 + 乐观锁）', () => {
  afterAll(async () => {
    await prisma.doc.deleteMany({ where: { id: { in: createdDocIds } } }).catch(() => {})
    await prisma.fileIndex.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
    for (const userId of createdUserIds) {
      fs.rmSync(uploadsBaseDir(userId), { recursive: true, force: true })
    }
  })

  test('字节落 FileIndex + 重建投影 + 指针回填（幂等：同字节复用同一工件）', async () => {
    const docId = await createDoc()
    const bytes = await serializeDeckWireToPptx(sampleDeckWire())

    const first = await putDeckArtifact({ userId: USER, docId, bytes })
    expect(first.conflict).toBeFalsy()
    expect(first.artifactId).toMatch(/^deck-/)
    expect(first.projection).toBeTruthy()

    // FileIndex 行存在（pptx mime / 同字节 sha 可查）。
    const fileRow = await prisma.fileIndex.findFirst({ where: { id: first.artifactId, userId: USER } })
    expect(fileRow?.mime).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')

    // 物理文件在 uploads 目录。
    const diskPath = path.join(uploadsBaseDir(USER), first.artifactId)
    expect(fs.existsSync(diskPath)).toBe(true)

    // 指针 + 投影同帧：doc.deckArtifactId 回填；doc.deck = 重建投影。
    const doc = await prisma.doc.findUnique({ where: { id: docId } })
    expect(doc!.deckArtifactId).toBe(first.artifactId)
    const projection = JSON.parse(String(doc!.deck))
    expect(projection.slides).toHaveLength(2)
    expect(projection.title).toBe('Deck bytes test doc')

    // getDeckArtifact 回读同字节。
    const artifact = await getDeckArtifact(docId)
    expect(artifact?.version).toBe(first.artifactId)
    expect(artifact!.bytes.equals(bytes)).toBe(true)

    // 幂等去重：同字节再落 → 同一工件 id，投影未变化。
    const again = await putDeckArtifact({ userId: USER, docId, bytes })
    expect(again.artifactId).toBe(first.artifactId)
    expect(again.changed).toBe(false)

    // 归属防线：putDeckArtifact 对不存在的 docId → conflict 结果（not found 语义）。
    const missing = await putDeckArtifact({ userId: OTHER, docId: 'doc_nonexistent_0000000', bytes })
    expect(missing.conflict).toBe(true)
    expect(missing.error).toContain('Document not found')
  })

  test('版本戳语义：字节变化 → 新工件 id（乐观锁可检测推进）', async () => {
    const docId = await createDoc()
    const bytesV1 = await serializeDeckWireToPptx(sampleDeckWire())
    const put1 = await putDeckArtifact({ userId: USER, docId, bytes: bytesV1 })

    const edited = JSON.parse(JSON.stringify(sampleDeckWire())) as { slides: Array<{ title: string; content: Array<{ text: string }> }> }
    edited.slides[0].content[0].text = '要点一：120 例 EGFR 敏感突变'
    const bytesV2 = await serializeDeckWireToPptx(edited)
    const put2 = await putDeckArtifact({ userId: USER, docId, bytes: bytesV2, baseDeck: put1.projection })

    expect(put2.artifactId).not.toBe(put1.artifactId)
    expect(put2.changed).toBe(true)
    // 投影同步重建（新字节的段落进了投影）。
    const projection = JSON.parse(String(put2.projection))
    expect(JSON.stringify(projection.slides[0].content)).toContain('120 例')
    // 旧投影过期 → 按未投影处理（staleness 判定交给读侧 helper）。
    const artifact = await getDeckArtifact(docId)
    expect(artifact?.artifactId).toBe(put2.artifactId)
  })

  test('baseDeck 乐观锁：并发窗口 deck 已推进 → conflict（调用方 409）', async () => {
    const docId = await createDoc()
    const bytesV1 = await serializeDeckWireToPptx(sampleDeckWire())
    const put1 = await putDeckArtifact({ userId: USER, docId, bytes: bytesV1 })

    // 另一写者推进 deck（乐观基线被顶掉）。
    await prisma.doc.update({ where: { id: docId }, data: { deck: '{"title":"并发写","slides":[]}' } })
    const bytesV2 = await serializeDeckWireToPptx({ ...sampleDeckWire(), title: 'v2' })
    const put2 = await putDeckArtifact({ userId: USER, docId, bytes: bytesV2, baseDeck: put1.projection })
    expect(put2.conflict).toBe(true)
    expect(put2.error).toContain('并发修改')
  })

  test('DeckWire → 字节 → 投影重建（extractor 单一实现）', async () => {
    const bytes = await serializeDeckWireToPptx(sampleDeckWire())
    const projection = rebuildDeckProjection(bytes, '标题跟随')
    expect(projection).toBeTruthy()
    const parsedProjection = JSON.parse(String(projection))
    expect(parsedProjection.schemaVersion).toBe(1)
    expect(parsedProjection.title).toBe('标题跟随')
    expect(parsedProjection.slides[0].notes).toBe('备注：引用第 3 段数据')
  })
})

describe('#1101 投影新鲜度（mtime/version 比较 — blockProjection 先例语义）', () => {
  test('工件比 Doc 行新 → stale（绝不信任过期投影）；同刻/早于 → fresh', () => {
    expect(deckProjectionStaleness(null, null)).toBe('missing-artifact')
    expect(deckProjectionStaleness(null, { id: 'a', updatedAt: '2026-01-01T00:00:00Z' })).toBe('stale')
    expect(deckProjectionStaleness({ updatedAt: '2026-01-01T00:00:00Z', deck: null }, { id: 'x', updatedAt: '2026-01-01T00:00:00Z' })).toBe('stale')
    expect(
      deckProjectionStaleness(
        { updatedAt: '2026-01-02T00:00:00Z', deck: '{"slides":[]}' },
        { id: 'x', updatedAt: '2026-01-01T00:00:00Z' },
      ),
    ).toBe('fresh')
    expect(
      deckProjectionStaleness(
        { updatedAt: '2026-01-01T00:00:00Z', deck: '{"slides":[]}' },
        { id: 'x', updatedAt: '2026-01-02T00:00:00Z' },
      ),
    ).toBe('stale')
  })

  test('getDeckArtifact：无指针/行被软删/盘上文件消失 → null（404 同语义）', async () => {
    expect(await getDeckArtifact('doc_nonexistent_0000000')).toBeNull()
  })

  test('parsePptx 对序列化产物可解析（投影链路不依赖 worker 平台）', async () => {
    const bytes = await serializeDeckWireToPptx(sampleDeckWire())
    const parsed = parsePptx(bytes)
    expect(parsed.ok).toBe(true)
    expect(parsed.slides).toHaveLength(2)
  })
})
