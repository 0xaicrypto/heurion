import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildDocReferenceBlocks, findUploadFileByName } from '../../src/modules/shared/chat-context.js'

/**
 * #fix: 写作会话参考材料里的上传文件此前只注入文件名,LLM 读不到正文。
 * buildDocReferenceBlocks 按 refType 识别文件引用、定位上传并注入提取文本。
 */
describe('buildDocReferenceBlocks 文件引用正文注入', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-ref-test-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')
  const fileId = '1750000000300_paper.txt'

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, fileId), 'Abstract: ATR confers radioresistance.', 'utf-8')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('文件类引用(pdf/docx/file)解析上传正文并注入,替换纯文件名', async () => {
    const findFileByName = vi.fn(async (name: string) => (name === 'paper.txt' ? { id: fileId } : null))
    const { blocks, resolved } = await buildDocReferenceBlocks('u1', [
      { id: 'ref_1', refType: 'file', snapshot: 'paper.txt', label: 'paper.txt' },
    ], { findFileByName })
    expect(resolved).toBe(1)
    expect(blocks[0]).toContain('### paper.txt')
    expect(blocks[0]).toContain('[已解析上传文件正文]')
    expect(blocks[0]).toContain('ATR confers radioresistance')
  })

  test('docx 引用同样走正文注入', async () => {
    const docxId = '1750000000301_paper.docx'
    const { Document, Packer, Paragraph } = await import('docx')
    const doc = new Document({
      sections: [{ children: [new Paragraph({ text: 'Mitochondria ATR and radioresistance' })] }],
    })
    fs.writeFileSync(path.join(uploadsDir, docxId), await Packer.toBuffer(doc))
    const findFileByName = vi.fn(async (name: string) => (name === 'paper.docx' ? { id: docxId } : null))
    const { blocks, resolved } = await buildDocReferenceBlocks('u1', [
      { id: 'ref_2', refType: 'docx', snapshot: 'paper.docx', label: 'paper.docx' },
    ], { findFileByName })
    expect(resolved).toBe(1)
    expect(blocks[0]).toContain('[已解析上传文件正文]')
    expect(blocks[0]).toContain('Mitochondria ATR and radioresistance')
  })

  test('上传记录不存在 → 回退文件名(原行为,不报错)', async () => {
    const findFileByName = vi.fn(async () => null)
    const { blocks, resolved } = await buildDocReferenceBlocks('u1', [
      { id: 'ref_3', refType: 'pdf', snapshot: 'missing.pdf', label: 'missing.pdf' },
    ], { findFileByName })
    expect(resolved).toBe(0)
    expect(blocks[0]).toContain('### missing.pdf')
    expect(blocks[0]).not.toContain('[已解析上传文件正文]')
    expect(blocks[0]).toContain('missing.pdf')
  })

  test('非文件引用(guideline 等纯文本)不触发文件查找', async () => {
    const findFileByName = vi.fn()
    const { blocks, resolved } = await buildDocReferenceBlocks('u1', [
      { id: 'ref_4', refType: 'guideline', snapshot: 'ESMO 指南摘要', label: '指南' },
    ], { findFileByName })
    expect(resolved).toBe(0)
    expect(findFileByName).not.toHaveBeenCalled()
    expect(blocks[0]).toContain('### 指南')
    expect(blocks[0]).toContain('ESMO 指南摘要')
  })

  test('提取失败(文件缺失/不可读)回退文件名,不中断整块', async () => {
    const missingId = '1750000000302_deleted.txt'
    const findFileByName = vi.fn(async (name: string) => (name === 'deleted.txt' ? { id: missingId } : null))
    const { blocks, resolved } = await buildDocReferenceBlocks('u1', [
      { id: 'ref_5', refType: 'file', snapshot: 'deleted.txt', label: 'deleted.txt' },
    ], { findFileByName })
    expect(resolved).toBe(0)
    expect(blocks[0]).not.toContain('[已解析上传文件正文]')
  })

  test('findUploadFileByName: fileIndex 不可用时按上传目录文件名兜底', async () => {
    // 目录里有真实文件,fileIndex 查询失败 → 兜底命中。
    const found = await findUploadFileByName('u1', 'paper.txt')
    expect(found).not.toBeNull()
    expect(found!.id).toBe(fileId)
  })

  test('findUploadFileByName: 文件名不匹配 → null', async () => {
    const found = await findUploadFileByName('u1', 'not-uploaded.pdf')
    expect(found).toBeNull()
  })

  test('findUploadFileByName + buildDocReferenceBlocks: fileIndex 查不到也能注入正文', async () => {
    const { blocks, resolved } = await buildDocReferenceBlocks('u1', [
      { id: 'ref_6', refType: 'pdf', snapshot: 'paper.txt', label: 'paper.txt' },
    ], { findFileByName: async (name) => findUploadFileByName('u1', name) })
    expect(resolved).toBe(1)
    expect(blocks[0]).toContain('[已解析上传文件正文]')
    expect(blocks[0]).toContain('ATR confers radioresistance')
  })
})
