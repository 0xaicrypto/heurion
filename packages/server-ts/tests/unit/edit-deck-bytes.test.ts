/**
 * #1101（pptx 字节单一标准）— edit_deck_bytes 工具单测。
 *
 * fixture：用 pptx-viewer-core Presentation.create 生成真实 pptx 字节
 * （spike #1102 同款 headless 用法），经 putDeckArtifact 落工件后执行工具。
 * 覆盖：
 * 1. set_text → replaceText 正式 API 生效（工件重解析含新文本；scope=slide 限定页）。
 * 2. set_text replace 手写参考文献形态 → 引用纪律护栏整次拒绝（工件不变）。
 * 3. set_notes → notes 更新 round-trip。
 * 4. add_slide / remove_slide / move_slide → 页数与顺序变化。
 * 5. 契约校验：scope='slide' 缺 slideIndex → 拒绝；页界越界 → 拒绝。
 * 6. legacy DeckWire → 自动 bootstrap（serialize → 工件）。
 * 7. 非 doc- 会话 / 文档不存在 → 拒绝。
 */
import { describe, test, expect, afterAll } from 'vitest'
import fs from 'fs'
import prisma from '../../src/common/prisma.js'
import { EditDeckBytesTool } from '../../src/tools/edit-deck-bytes-tool.js'
import { putDeckArtifact, getDeckArtifact } from '../../src/lib/deck-bytes.js'
import { parsePptx } from '../../src/lib/pptx-extractor.js'
import { uploadsBaseDir } from '../../src/lib/upload-path.js'

const USER = `usr_editdb_${Math.random().toString(36).slice(2, 8)}`
const createdDocIds: string[] = []

async function createDoc(deck?: string): Promise<string> {
  const now = new Date().toISOString()
  await prisma.user.upsert({
    where: { id: USER },
    create: { id: USER, displayName: `editdb_${USER}`, createdAt: now, updatedAt: now },
    update: {},
  })
  const id = `doc_${Math.random().toString(16).slice(2, 10).padEnd(16, '0').slice(0, 16)}`
  await prisma.doc.create({
    data: {
      id, userId: USER, title: 'Edit deck bytes test doc', body: '正文',
      ...(deck !== undefined ? { deck } : {}), createdAt: now, updatedAt: now,
    },
  })
  createdDocIds.push(id)
  return id
}

/** 真实 pptx fixture：2 页（标题/要点/notes）— 引擎 headless 生成（spike 同款）。 */
async function fixtureBytes(): Promise<Buffer> {
  const { Presentation } = await import('pptx-viewer-core')
  const pres = await Presentation.create({ title: 'fixture' })
  try {
    const s1 = pres.addSlide()
    s1.addText('原始标题', { x: 60, y: 40, width: 1160, height: 90, fontSize: 30, bold: true })
    s1.addText('旧文本：87 例 EGFR 敏感突变\n第二个要点', { x: 60, y: 150, width: 1160, height: 400, fontSize: 18 })
    s1.setNotes('旧备注')
    s1.build()
    const s2 = pres.addSlide()
    s2.addText('结论页标题', { x: 60, y: 40, width: 1160, height: 90, fontSize: 30, bold: true })
    s2.build()
    return Buffer.from(await pres.save())
  } finally {
    pres.handler.dispose()
  }
}

function tool(docId: string): EditDeckBytesTool {
  return new EditDeckBytesTool({ userId: USER, sessionId: `doc-${docId}` })
}

function expectSuccess(res: { success: boolean; output?: string; error?: string }): Record<string, any> {
  expect(res.success).toBe(true)
  return JSON.parse(String(res.output))
}

describe('#1101 edit_deck_bytes 工具', () => {
  afterAll(async () => {
    await prisma.doc.deleteMany({ where: { id: { in: createdDocIds } } }).catch(() => {})
    await prisma.fileIndex.deleteMany({ where: { userId: USER } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: USER } }).catch(() => {})
    fs.rmSync(uploadsBaseDir(USER), { recursive: true, force: true })
  })

  test('set_text 走 replaceText 正式 API（工件重解析含新文本；scope=slide 限定页）', async () => {
    const docId = await createDoc()
    const put = await putDeckArtifact({ userId: USER, docId, bytes: await fixtureBytes(), writeSource: 'ai' })
    const out = expectSuccess(await tool(docId).execute({
      actions: [{ op: 'set_text', find: '87 例 EGFR 敏感突变', replace: '120 例 EGFR 敏感突变' }],
      summary: '改数字',
    }))
    expect(out.actions_applied).toBe(1)
    expect(out.results[0].applied).toBe(true)

    // 新工件版本推进（乐观锁可感知）；重解析含新文本。
    const artifact = await getDeckArtifact(docId)
    expect(artifact!.artifactId).toBe(out.artifact_id)
    expect(artifact!.artifactId).not.toBe(put.artifactId)
    const parsed = parsePptx(artifact!.bytes)
    expect(JSON.stringify(parsed.slides)).toContain('120 例 EGFR 敏感突变')
    expect(JSON.stringify(parsed.slides)).not.toContain('87 例 EGFR 敏感突变')

    // 投影已同步重建（Doc.deck）。
    const doc = await prisma.doc.findUnique({ where: { id: docId } })
    expect(String(doc!.deck)).toContain('120 例')

    // scope='slide'：限定第 1 页替换。
    const scopedOut = expectSuccess(await tool(docId).execute({
      actions: [{ op: 'set_text', find: '原始标题', replace: '标题A', scope: 'slide', slideIndex: 1 }],
    }))
    expect(scopedOut.actions_applied).toBe(1)
    const scopedArtifact = await getDeckArtifact(docId)
    expect(JSON.stringify(parsePptx(scopedArtifact!.bytes).slides)).toContain('标题A')
  })

  test('引用纪律护栏：replace 手写参考文献形态 → 整次拒绝，工件不变', async () => {
    const docId = await createDoc()
    const put = await putDeckArtifact({ userId: USER, docId, bytes: await fixtureBytes() })
    const toolRes = await tool(docId).execute({
      actions: [
        { op: 'set_text', find: '第二个要点', replace: '1. Smith J, et al. 2020\n2. Li Q, et al. 2021' },
        { op: 'set_notes', slideIndex: 1, text: '不应生效的备注' },
      ],
    })
    expect(toolRes.success).toBe(false)
    expect(toolRes.error).toContain('insert_citation')

    // 整次拒绝 — 零动作执行，工件字节未变。
    const artifact = await getDeckArtifact(docId)
    expect(artifact!.artifactId).toBe(put.artifactId)
    const doc = await prisma.doc.findUnique({ where: { id: docId } })
    expect(String(doc!.deck)).not.toContain('未生效的备注')
  })

  test('set_notes：notes 更新 round-trip', async () => {
    const docId = await createDoc()
    await putDeckArtifact({ userId: USER, docId, bytes: await fixtureBytes() })
    const out = expectSuccess(await tool(docId).execute({
      actions: [{ op: 'set_notes', slideIndex: 1, text: '新备注内容' }],
    }))
    expect(out.actions_applied).toBe(1)
    const artifact = await getDeckArtifact(docId)
    const parsed = parsePptx(artifact!.bytes)
    expect(parsed.slides[0].notes).toBe('新备注内容')
  })

  test('add_slide / move_slide / remove_slide：页数与顺序', async () => {
    const docId = await createDoc()
    await putDeckArtifact({ userId: USER, docId, bytes: await fixtureBytes() })
    const t = tool(docId)

    // add_slide：在第 2 页后插入新页。
    const addOut = expectSuccess(await t.execute({
      actions: [{ op: 'add_slide', afterIndex: 2, title: '插入页', bullets: ['插入要点一', '插入要点二'] }],
    }))
    expect(addOut.slides).toBe(3)
    let artifact = await getDeckArtifact(docId)
    let parsed = parsePptx(artifact!.bytes)
    expect(parsed.slides).toHaveLength(3)
    expect(JSON.stringify(parsed.slides[2].paragraphs)).toContain('插入页')

    // move_slide：第 3 页移到第 1 位。
    expectSuccess(await t.execute({ actions: [{ op: 'move_slide', from: 3, to: 1 }] }))
    artifact = await getDeckArtifact(docId)
    parsed = parsePptx(artifact!.bytes)
    expect(JSON.stringify(parsed.slides[0].paragraphs)).toContain('插入页')

    // remove_slide：删第 1 页（move 后的插入页）→ 回到 2 页。
    const rmOut = expectSuccess(await t.execute({ actions: [{ op: 'remove_slide', slideIndex: 1 }] }))
    expect(rmOut.slides).toBe(2)
    artifact = await getDeckArtifact(docId)
    parsed = parsePptx(artifact!.bytes)
    expect(parsed.slides).toHaveLength(2)

    // 连删两页（会删到最后一页）→ 预检拒绝。
    const rmLast = await t.execute({ actions: [{ op: 'remove_slide', slideIndex: 1 }, { op: 'remove_slide', slideIndex: 1 }] })
    expect(rmLast.success).toBe(false)
    expect(rmLast.error).toContain('至少保留 1 页')
  })

  // #1101 复审轮 1（Fix 10）：afterIndex=0 的真实语义 = 插在原第一页之前
  // （insertSlide(0) splice 到下标 0）— 成功文案必须与实际落点一致。
  test('add_slide afterIndex=0 → 插入为第 1 页（原第一页之前），文案如实', async () => {
    const docId = await createDoc()
    await putDeckArtifact({ userId: USER, docId, bytes: await fixtureBytes() })
    const t = tool(docId)

    const out = expectSuccess(await t.execute({
      actions: [{ op: 'add_slide', afterIndex: 0, title: '置顶页' }],
    }))
    expect(out.results[0].detail).toContain('原第一页之前')
    expect(out.results[0].detail).not.toContain('页后插入')

    // 实际落点 = 新页成为第 1 页。
    const artifact = await getDeckArtifact(docId)
    const parsed = parsePptx(artifact!.bytes)
    expect(parsed.slides).toHaveLength(3)
    expect(JSON.stringify(parsed.slides[0].paragraphs)).toContain('置顶页')

    // 对照：afterIndex ≥ 1 → 维持「已在第 N 页后插入」文案。
    const out2 = expectSuccess(await t.execute({
      actions: [{ op: 'add_slide', afterIndex: 2, title: '中插页' }],
    }))
    expect(out2.results[0].detail).toContain('已在第 2 页后插入')
    const artifact2 = await getDeckArtifact(docId)
    const parsed2 = parsePptx(artifact2!.bytes)
    expect(JSON.stringify(parsed2.slides[2].paragraphs)).toContain('中插页')
  })

  test('契约校验：scope=slide 缺 slideIndex / 页界越界 → 拒绝', async () => {
    const docId = await createDoc()
    await putDeckArtifact({ userId: USER, docId, bytes: await fixtureBytes() })
    const t = tool(docId)

    const missingIdx = await t.execute({ actions: [{ op: 'set_text', find: 'x', replace: 'y', scope: 'slide' }] })
    expect(missingIdx.success).toBe(false)
    expect(missingIdx.error).toContain('slideIndex')

    const outOfRange = await t.execute({ actions: [{ op: 'set_notes', slideIndex: 99, text: 'x' }] })
    expect(outOfRange.success).toBe(false)
    expect(outOfRange.error).toContain('超出范围')
  })

  test('legacy DeckWire 无工件 → 首次编辑自动 bootstrap（serialize → 工件）', async () => {
    const docId = await createDoc(JSON.stringify({
      schemaVersion: 1,
      title: '遗留 deck',
      slides: [{ title: '遗留页', content: [{ type: 'paragraph', text: '遗留要点', style: 'bullet' }] }],
    }))
    const out = expectSuccess(await tool(docId).execute({
      actions: [{ op: 'set_text', find: '遗留要点', replace: '遗留要点（已编辑）' }],
    }))
    const artifact = await getDeckArtifact(docId)
    expect(artifact?.artifactId).toBe(out.artifact_id)
    const parsed = parsePptx(artifact!.bytes)
    expect(JSON.stringify(parsed.slides)).toContain('遗留要点（已编辑）')
  })

  test('非 doc- 会话 / 文档不存在 → 拒绝', async () => {
    const chatTool = new EditDeckBytesTool({ userId: USER, sessionId: 'chat-123' })
    const res = await chatTool.execute({ actions: [{ op: 'set_notes', slideIndex: 1, text: 'x' }] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('document writing session')

    // 同格式但不存在的 docId（归属读失败）→ not found。
    const fakeId = 'doc_ffffffffffffffff'
    const resFake = await tool(fakeId).execute({ actions: [{ op: 'set_notes', slideIndex: 1, text: 'x' }] })
    expect(resFake.success).toBe(false)
    expect(resFake.error).toContain('Document not found')
  })
})
