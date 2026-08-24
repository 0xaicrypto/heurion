import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { extractDocumentMarkdownWithImagesFromUpload, type ExtractedPdfImage } from '../lib/document-extractor.js'
import { issueChartToken } from '../common/chart-token.js'
import fs from 'fs'
import path from 'path'

/**
 * #fix: 空白归一化 — 任意空白序列塌缩为单个空格,去除软连字符(U+00AD)。
 * PDF 提取正文里满是换行/空格伪影,LLM 的 old_text 在空白上常有细微
 * 差异(换行位置、连续空格、连字断开),逐字节 indexOf 必然失败。
 */
export function normalizeForMatch(s: string): string {
  return s.replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim()
}

/** 完全忽略空白/软连字符(兜底匹配用 — PDF 断行把词拆开时插入的空格)。 */
function normalizeWsFree(s: string): string {
  return s.replace(/[\u00ad\s]/g, '')
}

/** 归一化索引 → 原始下标:空白序列按一个空格计(塌缩口径)。 */
function walkCollapsed(body: string, target: number): number {
  let raw = 0
  let norm = 0
  while (norm < target && raw < body.length) {
    const c = body[raw]
    if (c === '\u00ad') {
      raw++
      continue
    }
    if (/\s/.test(c)) {
      while (raw < body.length && /\s/.test(body[raw])) raw++
      norm++
    } else {
      raw++
      norm++
    }
  }
  return raw
}

/** 归一化索引 → 原始下标:空白/软连字符不占位(完全忽略口径)。 */
function walkWsFree(body: string, target: number): number {
  let raw = 0
  let norm = 0
  while (norm < target && raw < body.length) {
    const c = body[raw]
    if (c === '\u00ad' || /\s/.test(c)) {
      raw++
      continue
    }
    raw++
    norm++
  }
  return raw
}

export interface NormalizedSpan {
  start: number
  end: number
  k: number
  normBody: string
  normNeedle: string
}

/**
 * #fix: 在 body 中查找与 needle 归一化后相同的片段,返回原始 body 中的
 * [start, end)(含空白差异,替换后不留残留)。找不到返回 null。
 * 两级匹配:
 *   1) 空白塌缩(换行位置/连续空格差异);
 *   2) 完全忽略空白(兜底 — PDF 断行把长词拆开插入空格,如药物名跨行)。
 * 命中级别连同归一化串返回,调用方可复用做多次命中判定。
 */
export function findNormalizedSpan(body: string, needle: string): NormalizedSpan | null {
  const nb = normalizeForMatch(body)
  const nn = normalizeForMatch(needle)
  const k = nb.indexOf(nn)
  if (k !== -1) {
    return { start: walkCollapsed(body, k), end: walkCollapsed(body, k + nn.length), k, normBody: nb, normNeedle: nn }
  }

  const fb = normalizeWsFree(body)
  const fn = normalizeWsFree(needle)
  const k2 = fb.indexOf(fn)
  if (k2 === -1) return null
  return { start: walkWsFree(body, k2), end: walkWsFree(body, k2 + fn.length), k: k2, normBody: fb, normNeedle: fn }
}

/**
 * §15.4/#171 — edit_document: the conversational-writing write-back tool.
 *
 * 三种模式:
 * - import 模式(import_reference):把参考材料(上传的 PDF/DOCX/txt)的
 *   正文导入空文档 — 分步润色的前置步骤。导入后文档有了正文,分段/焦点/
 *   锚点机制自动生效,再按 range 模式逐段润色。导入不消耗模型输出。
 * - range 模式(old_text + new_text):局部编辑 — 在文档中精确替换一个
 *   原文片段。长文档分步润色靠它:一次改一段,用户确认后继续下一段,
 *   模型永远不需要把整篇文档重写一遍(输出 token 上限之外)。
 * - full 模式(full_text):全量替换,仅适合短文档整体修改。
 *
 * 版本化 + 自动快照 + 前端 diff 审阅(doc_updated SSE)对三种模式一致。
 */
export class EditDocumentTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'edit_document' }

  get description(): string {
    return [
      'Edit the current writing-session document. Three modes:',
      '- Import: pass `import_reference` (the reference-material name to import) when the document body is EMPTY and the user wants to work on an uploaded reference (PDF/DOCX/txt). This copies the reference text into the document.',
      '- Range edit (preferred for polishing long documents): pass `old_text` (the original text to replace, copied from the current document — line breaks/whitespace differences are tolerated) and `new_text` (the replacement). One edit per call; make multiple calls to edit multiple parts. When the document body is EMPTY and exactly one reference exists, the tool auto-imports it before applying the edit (so you can polish an uploaded reference without a separate import call).',
      '- Full rewrite: pass `full_text` (complete new document in markdown). Only for short documents or when the user explicitly asks to rewrite the whole document.',
      'Use this instead of explaining changes.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        import_reference: { type: 'string', description: 'Import mode: the label/name of the reference material to import into the empty document (e.g. the uploaded file name).' },
        old_text: { type: 'string', description: 'Range mode: the original text to replace (must match the current document — whitespace/line-break differences are tolerated).' },
        new_text: { type: 'string', description: 'Range mode: the replacement text (empty to delete).' },
        full_text: { type: 'string', description: 'Full mode: the complete new document content in markdown.' },
        summary: { type: 'string', description: 'A one-line summary of what changed.' },
      },
      required: [],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.ctx.sessionId || ''
    if (!sessionId.startsWith('doc-')) {
      return { success: false, error: 'edit_document is only available in a document writing session' }
    }
    const docId = sessionId.slice(4)

    const importRef = typeof args.import_reference === 'string' ? args.import_reference.trim() : ''
    if (importRef) return this.importReference(docId, importRef, String(args.summary || 'imported reference'))

    const oldText = typeof args.old_text === 'string' ? args.old_text : ''
    const newText = typeof args.new_text === 'string' ? args.new_text : ''
    const fullText = typeof args.full_text === 'string' ? args.full_text : ''

    // #fix: 分步编辑 — 提供了 old_text 就走局部替换,不要求完整文档。
    if (oldText) {
      if (!oldText.trim()) return { success: false, error: 'old_text is empty' }
      return this.rangeEdit(docId, oldText, newText, String(args.summary || 'range edit'))
    }

    if (!fullText.trim()) {
      return { success: false, error: 'Provide import_reference (empty document), old_text+new_text (range edit), or full_text (full rewrite).' }
    }
    return this.fullReplace(docId, fullText, String(args.summary || 'document updated'))
  }

  /** 当前文档的全部参考材料(label 与原始记录)。 */
  private async resolveImportTargets(docId: string): Promise<Array<{ r: any; label: string }>> {
    const refs = await (prisma as any).docReference.findMany({ where: { userId: this.ctx.userId, docId } })
    return (refs || []).map((r: any) => {
      let label = ''
      try { label = JSON.parse(r.sourceNodes || '{}').label || '' } catch { /* ignore */ }
      return { r, label: label || r.snapshot || r.id }
    })
  }

  /** 提取参考材料正文:文件类走 markdown+图片提取;纯文本引用直接用 snapshot。 */
  private async extractRefText(docId: string, ref: any, label: string): Promise<{ text: string; error?: string }> {
    const kind = String(ref.refType || '')
    if (kind !== 'file' && kind !== 'pdf' && kind !== 'docx') {
      return { text: String(ref.snapshot || '') }
    }
    // 先查 FileIndex(生产库),不可用则扫描上传目录按文件名兜底。
    const fileIndex = (prisma as any).fileIndex
    const byIndex = fileIndex
      ? await fileIndex.findFirst({
          where: { userId: this.ctx.userId, name: String(ref.snapshot || ''), deletedAt: null },
          orderBy: { createdAt: 'desc' },
        }).catch(() => null)
      : null
    const fileId = byIndex?.id || this.findUploadByFileName(this.ctx.userId, String(ref.snapshot || ''))
    if (!fileId) return { text: '', error: `参考材料「${label}」对应的上传文件不存在` }
    // #fix: 导入走 markdown+图片提取 — PDF 恢复标题/段落结构,DOCX 保留
    // mammoth 结构;内嵌图落盘为托管文件并在文档里渲染(取代 [图])。
    const extracted = await extractDocumentMarkdownWithImagesFromUpload(this.ctx.userId, fileId)
    const text = this.embedDocumentImages(docId, extracted.text, extracted.images)
    if (!text) return { text: '', error: `无法从参考材料「${label}」提取正文` }
    return { text }
  }

  /** 把正文写入文档(差异时快照旧版),返回新正文。 */
  private async writeDocBody(docId: string, text: string, snapshotLabel: string): Promise<{ body: string; error?: string }> {
    const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
    if (!existing) return { body: '', error: `Document not found: ${docId}` }

    const now = new Date().toISOString()
    if (existing.body !== text) {
      await (prisma as any).docSnapshot.create({
        data: { docId, userId: this.ctx.userId, body: existing.body, label: snapshotLabel, createdAt: now },
      })
    }
    await (prisma as any).doc.update({
      where: { id: docId },
      data: { body: text, updatedAt: now },
    })
    return { body: text }
  }

  /** 导入模式:按 label 定位参考材料,把提取的正文写入文档。 */
  private async importReference(docId: string, reference: string, summary: string): Promise<ToolResult> {
    try {
      const labels = await this.resolveImportTargets(docId)
      const hit = labels.find(({ r, label }) => label.includes(reference) || reference.includes(label))
      if (!hit) {
        const available = labels.map((l) => l.label).slice(0, 5).join('、') || '(无)'
        return { success: false, error: `未找到参考材料 "${reference}"。当前参考材料:${available}。请用参考材料的名称(label)作为 import_reference。` }
      }

      const { text, error } = await this.extractRefText(docId, hit.r, hit.label)
      if (error) return { success: false, error: error }
      const { body, error: writeError } = await this.writeDocBody(docId, text, 'AI import')
      if (writeError) return { success: false, error: writeError }
      return { success: true, output: JSON.stringify({ body, summary: `已导入参考材料「${hit.label}」(${text.length} 字符)` }) }
    } catch (err) {
      return { success: false, error: `edit_document import failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** 局部编辑:在文档中精确匹配 oldText 并替换为 newText。 */
  private async rangeEdit(docId: string, oldText: string, newText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      let body = String(existing.body || '')
      // #fix: 正文为空时局部编辑必然失败 — 若存在唯一参考材料(用户上传
      // PDF/DOCX 后直接说"润色"的典型场景),自动导入后再执行本编辑,
      // 不依赖模型先单独调一次 import_reference;多参考/无参考才报错引导。
      if (!body.trim()) {
        const labels = await this.resolveImportTargets(docId)
        if (labels.length === 1) {
          const { text, error } = await this.extractRefText(docId, labels[0].r, labels[0].label)
          if (error) return { success: false, error: error }
          const { body: importedBody, error: writeError } = await this.writeDocBody(docId, text, 'AI import')
          if (writeError) return { success: false, error: writeError }
          body = importedBody
        } else if (labels.length === 0) {
          return {
            success: false,
            error: '文档正文为空,且没有可导入的参考材料。请先上传参考资料,或内容很短时用 full_text 直接写入。',
          }
        } else {
          const available = labels.map((l) => l.label).slice(0, 5).join('、')
          return {
            success: false,
            error: `文档正文为空,且有多个参考材料(${available})。请先用 import_reference 明确导入其中之一(分步润色的前置步骤),或内容很短时用 full_text 直接写入。`,
          }
        }
      }
      // #fix: 空白归一化匹配 — PDF 提取的换行/空格伪影与 LLM 复制的
      // old_text 之间允许空白差异(换行位置、连续空格、软连字符),其余
      // 字符必须逐字一致。命中后替换原始 span,新正文不留空白残留。
      const span = findNormalizedSpan(body, oldText)
      if (!span) {
        // 帮助模型修正锚点:给出文档开头附近的可匹配片段。
        const probe = normalizeForMatch(body).slice(0, 120)
        return {
          success: false,
          error: `old_text 在文档中未找到(已忽略空格/换行差异后仍不匹配),请从上方 Current Document 部分逐字复制待修改的原文。文档开头附近是: "${probe}"`,
        }
      }
      // 归一化匹配同样参与多次命中判定 — 两个片段仅空白不同也视为重复。
      if (span.normBody.indexOf(span.normNeedle, span.k + span.normNeedle.length) !== -1) {
        return {
          success: false,
          error: 'old_text 在文档中出现多次,请包含更多上下文让锚点唯一(比如加上前后句)',
        }
      }

      const newBody = body.slice(0, span.start) + newText + body.slice(span.end)
      if (newBody === body) return { success: false, error: 'old_text 与 new_text 相同,没有任何变化' }

      const now = new Date().toISOString()
      await (prisma as any).docSnapshot.create({
        data: { docId, userId: this.ctx.userId, body, label: 'AI edit', createdAt: now },
      })
      await (prisma as any).doc.update({
        where: { id: docId },
        data: { body: newBody, updatedAt: now },
      })

      return {
        success: true,
        output: JSON.stringify({ body: newBody, summary }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** 全量替换(旧行为,仅短文档)。 */
  private async fullReplace(docId: string, fullText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      const now = new Date().toISOString()
      if (existing.body !== fullText) {
        await (prisma as any).docSnapshot.create({
          data: { docId, userId: this.ctx.userId, body: existing.body, label: 'AI edit', createdAt: now },
        })
      }
      await (prisma as any).doc.update({
        where: { id: docId },
        data: { body: fullText, updatedAt: now },
      })

      return {
        success: true,
        output: JSON.stringify({ body: fullText, summary }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** FileIndex 表缺失时的兜底:扫描上传目录,按文件名(去 fileId 前缀)定位。 */
  private findUploadByFileName(userId: string, name: string): string | null {
    if (!name) return null
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    if (!fs.existsSync(dir)) return null
    for (const f of fs.readdirSync(dir)) {
      const derived = f.split('_').slice(1).join('_') || f
      if (derived === name) return f
    }
    return null
  }

  /**
   * #fix: 内嵌图 → 文档托管图片。图片落盘为 uploads/img_<docId>_<n>.<ext>,
   * 签发 chart token(绑定文件+所有者,<img> 无鉴权头也能加载),生成
   * ![图 N](/api/v1/files/download/...?token=...) markdown。
   * 替换顺序:
   *   1) DOCX 的 [图]/\[图\] 占位符按序替换;
   *   2) 剩余图片按 "Figure N / 图 N" 标题行就近插入(PDF 常见);
   *   3) 仍未插入的追加到文末 "## 图" 段。
   */
  private embedDocumentImages(docId: string, text: string, images: ExtractedPdfImage[]): string {
    if (!images.length) return text

    const extByMime: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
      'image/gif': 'gif', 'image/bmp': 'bmp',
    }
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.ctx.userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })

    const urls = images.map((img, i) => {
      const ext = extByMime[img.mime] || 'png'
      const fileId = `img_${docId}_${i + 1}.${ext}`
      fs.writeFileSync(path.join(dir, fileId), Buffer.from(img.dataBase64, 'base64'))
      const token = issueChartToken(fileId, this.ctx.userId)
      return `/api/v1/files/download/${fileId}?token=${token}`
    })

    let body = text
    let used = 0
    // 1) DOCX 占位符 [图] / \[图\](turndown 转义方括号)按序替换。
    body = body.replace(/\\?\[图\\?\]/g, () => {
      if (used < urls.length) {
        const n = used + 1
        used++
        return `![图 ${n}](${urls[n - 1]})`
      }
      return '[图]'
    })

    // 2) 剩余图片按 Figure/图 标题行就近插入(PDF 文本没有占位符)。
    if (used < urls.length) {
      const lines = body.split('\n')
      const outLines: string[] = []
      for (const line of lines) {
        outLines.push(line)
        if (used < urls.length && /^\s*(?:Figure|Fig\.?|图)\s*\d+/i.test(line)) {
          used++
          outLines.push(`![图 ${used}](${urls[used - 1]})`)
        }
      }
      body = outLines.join('\n')
    }

    // 3) 仍未插入的追加到文末。
    if (used < urls.length) {
      const leftover = urls.slice(used).map((u, i) => `![图 ${used + 1 + i}](${u})`).join('\n\n')
      body = `${body}\n\n## 图\n${leftover}`
    }
    return body
  }
}
