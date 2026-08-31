import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #771 — preview_file handler 测试。
 * soffice/pdftoppm 在测试环境不可用（CI/本地无 LibreOffice）—
 * 核心断言：缺依赖时抛 PREVIEW_UNAVAILABLE（控制面据此优雅降级），
 * 输入校验先行；转图管线用 mock execFile 覆盖 happy path。
 */

const mocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  saveFile: vi.fn(async (content: Buffer, fileName: string, mimeType: string) => ({
    fileId: `f_${fileName}`,
    fileName,
    mimeType,
  })),
  existingFiles: new Set<string>(),
  writtenInputPath: null as string | null,
  pdfProduced: false,
}))

vi.mock('child_process', () => ({
  // preview.ts 顶部 promisify(execFile) — mock 必须是 nodeback 形态。
  execFile: (cmd: string, args: string[], opts: any, cb?: any) => {
    const callback = typeof opts === 'function' ? opts : cb
    mocks.execFileAsync(cmd, args)
      .then((v: unknown) => callback(null, v))
      .catch((e: Error) => callback(e))
  },
}))

vi.mock('../src/storage.js', async () => ({
  saveFile: mocks.saveFile,
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  const mock = {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p: string, data: any) => {
      // 记录输入文件路径 — existsSync 的 mock 据此放行同名 .pdf。
      mocks.writtenInputPath = String(p)
    }),
    existsSync: vi.fn((p: string) => {
      if (mocks.pdfProduced && mocks.writtenInputPath && String(p) === mocks.writtenInputPath.replace(/\.[^.]+$/, '.pdf')) return true
      return mocks.existingFiles.has(String(p))
    }),
    readFileSync: vi.fn((p: string) => Buffer.from(`png:${p}`)),
    readdirSync: vi.fn(() => ['page-1.png', 'page-2.png', 'notes.txt']),
    rmSync: vi.fn(),
  }
  // handler 用 `import fs from 'fs'`（default import）— 必须同时提供 default。
  return { ...mock, default: mock }
})

import { previewFile } from '../src/handlers/preview.js'

beforeEach(() => {
  mocks.execFileAsync.mockReset()
  mocks.existingFiles.clear()
  mocks.writtenInputPath = null
  mocks.pdfProduced = false
})

describe('#771 preview_file', () => {
  test('缺 soffice/pdftoppm → PREVIEW_UNAVAILABLE（优雅降级信号）', async () => {
    // which soffice / pdftoppm 都失败。
    mocks.execFileAsync.mockRejectedValue(new Error('not found'))
    await expect(previewFile({ data_base64: Buffer.from('x').toString('base64') }))
      .rejects.toThrow(/PREVIEW_UNAVAILABLE/)
  })

  test('输入校验：data_base64 缺失', async () => {
    await expect(previewFile({})).rejects.toThrow(/data_base64/)
  })

  test('happy path：soffice→pdf→pdftoppm→逐页 saveFile（页序数值排序）', async () => {
    // which 调用通过（第 1、2 次），后续 execFileAsync 走转换管线。
    mocks.execFileAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'which') return { stdout: '/usr/bin/soffice', stderr: '' }
      // soffice "转换完成" — PDF 出现（handler 随即检查 existsSync → pdftoppm）。
      if (cmd === 'soffice') mocks.pdfProduced = true
      if (cmd === 'pdftoppm') {
        mocks.existingFiles.add('page-1.png')
        mocks.existingFiles.add('page-2.png')
      }
      return { stdout: '', stderr: '' }
    })
    const result = await previewFile({
      data_base64: Buffer.from('fake pptx bytes').toString('base64'),
      file_name: 'deck.pptx',
      max_pages: 5,
    })
    // 目录列表含 notes.txt — 只挑 page-N.png，数值排序，逐页 saveFile。
    expect(result.page_count).toBe(2)
    expect(result.pages.map((p: any) => p.fileId)).toEqual(['f_page-1.png', 'f_page-2.png'])
    // soffice 转换目标为 PDF。
    const sofficeCall = mocks.execFileAsync.mock.calls.find((c) => c[0] === 'soffice')
    expect(sofficeCall?.[1]).toContain('--convert-to')
    expect(sofficeCall?.[1]).toContain('pdf')
  })

  test('soffice 未产出 PDF → PREVIEW_FAILED', async () => {
    mocks.execFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === 'which') return { stdout: '/usr/bin/x', stderr: '' }
      return { stdout: '', stderr: '' } // 不创建 input.pdf
    })
    await expect(previewFile({ data_base64: Buffer.from('x').toString('base64') }))
      .rejects.toThrow(/PREVIEW_FAILED/)
  })
})
