import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { extractDocumentMarkdownFromUpload } from '../lib/document-extractor.js'
import fs from 'fs'
import path from 'path'

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
      '- Range edit (preferred for polishing long documents): pass `old_text` (the EXACT original text to replace, copied verbatim from the current document) and `new_text` (the replacement). One edit per call; make multiple calls to edit multiple parts.',
      '- Full rewrite: pass `full_text` (complete new document in markdown). Only for short documents or when the user explicitly asks to rewrite the whole document.',
      'Use this instead of explaining changes.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        import_reference: { type: 'string', description: 'Import mode: the label/name of the reference material to import into the empty document (e.g. the uploaded file name).' },
        old_text: { type: 'string', description: 'Range mode: the exact original text to replace (must match the current document verbatim).' },
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

  /** 导入模式:按 label 定位参考材料,把提取的正文写入文档。 */
  private async importReference(docId: string, reference: string, summary: string): Promise<ToolResult> {    try {
      const refs = await (prisma as any).docReference.findMany({ where: { userId: this.ctx.userId, docId } })
      const labels: Array<{ r: any; label: string }> = (refs || []).map((r: any) => {
        let label = ''
        try { label = JSON.parse(r.sourceNodes || '{}').label || '' } catch { /* ignore */ }
        return { r, label: label || r.snapshot || r.id }
      })
      const hit = labels.find(({ r, label }) => label.includes(reference) || reference.includes(label))
      if (!hit) {
        const available = labels.map((l) => l.label).slice(0, 5).join('、') || '(无)'
        return { success: false, error: `未找到参考材料 "${reference}"。当前参考材料:${available}。请用参考材料的名称(label)作为 import_reference。` }
      }

      // 文件类引用(file/pdf/docx)→ 从上传文件提取正文;纯文本引用直接用 snapshot。
      const kind = String(hit.r.refType || '')
      const isFileRef = kind === 'file' || kind === 'pdf' || kind === 'docx'
      let text = ''
      if (isFileRef) {
        // 先查 FileIndex(生产库),不可用则扫描上传目录按文件名兜底。
        const fileIndex = (prisma as any).fileIndex
        const byIndex = fileIndex
          ? await fileIndex.findFirst({
              where: { userId: this.ctx.userId, name: String(hit.r.snapshot || ''), deletedAt: null },
              orderBy: { createdAt: 'desc' },
            }).catch(() => null)
          : null
        const fileId = byIndex?.id || this.findUploadByFileName(this.ctx.userId, String(hit.r.snapshot || ''))
        // #fix: 导入走 markdown 提取 — PDF 恢复标题/段落结构,DOCX 保留
        // mammoth 结构,文档画布(TipTap)才能正确渲染而不是一坨平铺文本。
        if (fileId) text = await extractDocumentMarkdownFromUpload(this.ctx.userId, fileId)
        if (!text) text = `[无法从参考材料 ${hit.label} 提取正文]`
      } else {
        text = String(hit.r.snapshot || '')
      }

      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      const now = new Date().toISOString()
      if (existing.body !== text) {
        await (prisma as any).docSnapshot.create({
          data: { docId, userId: this.ctx.userId, body: existing.body, label: 'AI import', createdAt: now },
        })
      }
      await (prisma as any).doc.update({
        where: { id: docId },
        data: { body: text, updatedAt: now },
      })
      return { success: true, output: JSON.stringify({ body: text, summary: `已导入参考材料「${hit.label}」(${text.length} 字符)` }) }
    } catch (err) {
      return { success: false, error: `edit_document import failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** 局部编辑:在文档中精确匹配 oldText 并替换为 newText。 */
  private async rangeEdit(docId: string, oldText: string, newText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      const body = String(existing.body || '')
      // #fix: 正文为空时局部编辑必然失败 — 引导模型先 import_reference
      // 把参考材料导入文档(再按分步流程逐段润色),或短内容用 full_text。
      if (!body.trim()) {
        return {
          success: false,
          error: '文档正文为空,无法做局部编辑。请先调用 edit_document 的 import_reference 参数把参考材料导入文档(分步润色的前置步骤),或内容很短时用 full_text 直接写入。',
        }
      }
      const first = body.indexOf(oldText)
      if (first === -1) {
        // 帮助模型修正锚点:给出文档开头附近的可匹配片段。
        const probe = body.slice(0, 400).replace(/\s+/g, ' ').slice(0, 120)
        return {
          success: false,
          error: `old_text 在文档中未找到,请从当前文档中逐字复制待修改的原文(注意空格/标点)。文档开头附近是: "${probe}"`,
        }
      }
      const second = body.indexOf(oldText, first + oldText.length)
      if (second !== -1) {
        return {
          success: false,
          error: 'old_text 在文档中出现多次,请包含更多上下文让锚点唯一(比如加上前后句)',
        }
      }

      const newBody = body.slice(0, first) + newText + body.slice(first + oldText.length)
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
}
