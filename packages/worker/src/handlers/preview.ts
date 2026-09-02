import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import { saveFile } from '../storage.js'
// #790: payload 形状来自 contracts 单一来源（此前本文件手写 interface）。
import { previewPayloadSchema, type PreviewPayload } from '@heurion/contracts'

const execFileAsync = promisify(execFile)

/**
 * #771 — preview_file: 渲染产物 / 上传 pptx → 翻页预览 PNG 列表。
 *
 * 管线：pptx/docx → (LibreOffice headless) → PDF → (pdftoppm) → PNG 每页。
 * 与前端解耦，docx/pptx 通吃（issue 方案 A）；result 返回 pages 列表，
 * 控制面逐页换取带 token 的代理 URL 下发浏览器。
 *
 * 优雅降级：镜像未装 soffice/pdftoppm 时抛 PREVIEW_UNAVAILABLE —
 * 控制面映射为 501 + degraded，前端降级为仅下载（验收标准）。
 *
 * 安全：输入是控制面（token 鉴权）提交的渲染产物/已上传文件字节；
 * soffice 对不可信文件的解析历史上有 CVE 暴露面 — worker 容器内运行、
 * 无网络依赖、超时 120s + 临时目录即用即删。
 */

export type PreviewInput = PreviewPayload

const PREVIEW_MAX_INPUT_BYTES = 60 * 1024 * 1024
const PREVIEW_DEFAULT_PAGES = 30
const SOFFICE_TIMEOUT_MS = 120_000

async function whichAvailable(bin: string): Promise<boolean> {
  try {
    await execFileAsync('which', [bin])
    return true
  } catch {
    return false
  }
}

export async function previewFile(payload: unknown) {
  // #686: 入口收 unknown — zod 校验在内部（server.ts 的入口校验保留为快速失败）。
  const parsed = previewPayloadSchema.safeParse(payload ?? {})
  if (!parsed.success) {
    throw new Error(`preview_file payload failed validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  const input: PreviewInput = parsed.data
  if (!input.data_base64) throw new Error('preview_file requires data_base64')
  const binary = Buffer.from(input.data_base64, 'base64')
  if (binary.length === 0) throw new Error('preview_file got empty data')
  if (binary.length > PREVIEW_MAX_INPUT_BYTES) {
    throw new Error(`preview_file input exceeds ${Math.round(PREVIEW_MAX_INPUT_BYTES / 1024 / 1024)}MB`)
  }

  // 优雅降级检测 — 缺 LibreOffice/poppler 时给控制面可识别的错误码。
  if (!(await whichAvailable('soffice')) || !(await whichAvailable('pdftoppm'))) {
    throw new Error('PREVIEW_UNAVAILABLE: soffice (LibreOffice) and pdftoppm (poppler-utils) are required for preview rendering')
  }

  const maxPages = Math.min(Math.max(1, Number(input.max_pages) || PREVIEW_DEFAULT_PAGES), 60)
  const dir = path.join(os.tmpdir(), `heurion-preview-${randomUUID()}`)
  fs.mkdirSync(dir, { recursive: true })
  try {
    // #785: 保留原始扩展名（pptx/docx）— soffice 按扩展名选导入滤镜，
    // docx 被强制落成 input.pptx 必然 PREVIEW_FAILED。未知/缺扩展名回退
    // input.bin；basename 防御 payload 携带路径片段（#793 纵深）。
    const rawName = input.file_name ? path.basename(input.file_name) : ''
    const ext = path.extname(rawName).toLowerCase()
    const fileName = ext === '.pptx' || ext === '.docx' ? rawName : 'input.bin'
    const inputPath = path.join(dir, fileName)
    fs.writeFileSync(inputPath, binary)

    await execFileAsync('soffice', [
      '--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf',
      '--outdir', dir, inputPath,
    ], { timeout: SOFFICE_TIMEOUT_MS })
    const pdfPath = inputPath.replace(/\.[^.]+$/, '.pdf')
    if (!fs.existsSync(pdfPath)) throw new Error('PREVIEW_FAILED: LibreOffice did not produce a PDF')

    await execFileAsync('pdftoppm', [
      '-png', '-r', '96', '-f', '1', '-l', String(maxPages),
      pdfPath, path.join(dir, 'page'),
    ], { timeout: SOFFICE_TIMEOUT_MS })

    // pdftoppm 输出 page-1.png / page-01.png（按总页数决定位数）— 数值排序。
    const pages = fs.readdirSync(dir)
      .filter((f) => /^page-\d+\.png$/.test(f))
      .sort((a, b) => (parseInt(a.match(/\d+/)![0], 10)) - (parseInt(b.match(/\d+/)![0], 10)))
    if (pages.length === 0) throw new Error('PREVIEW_FAILED: pdftoppm produced no pages')

    const out: Array<{ fileId: string; fileName: string; mimeType: string }> = []
    for (const f of pages) {
      const saved = await saveFile(fs.readFileSync(path.join(dir, f)), f, 'image/png', 'previews')
      out.push({ fileId: saved.fileId, fileName: saved.fileName, mimeType: saved.mimeType })
    }
    return { pages: out, page_count: out.length }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
