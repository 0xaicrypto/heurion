import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { estimateTokens } from '../common/token-estimate.js'
import { resolveImportTargets, extractRefText, ensureDraftBody } from './doc-import.js'
import { writeDocVersion } from './doc-version-writer.js'
// #697: 匹配算法族下沉 lib(纯函数,可独立单测)。
import { normalizeForMatch, findNormalizedSpan, findFuzzySpan } from '../lib/document-span-match.js'
// #697: import 模式拆到 edit-import.ts。
import { executeImportReference } from './edit-import.js'

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
      '- Range edit (preferred for polishing long documents): pass `old_text` (the original text to replace, copied from the current document — line breaks/whitespace differences are tolerated) and `new_text` (the replacement). One edit per call; make multiple calls to edit multiple parts. When the document body is EMPTY and exactly one reference exists, the tool auto-imports it before applying the edit (so you can polish an uploaded reference without a separate import call). To replace a figure/link, include its image markdown together with surrounding caption text — image URLs must match exactly, and an old_text that spans an image must include the image.',
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
      // #fix: 空锚点守卫 — 纯空白/markdown 标记归一化后为空,此前会退化
      // 为 indexOf('') 恒命中并假报「出现多次」,模型反复补上下文重试
      // 进入死循环。此处直接给出可执行的修正方向。
      if (!normalizeForMatch(oldText)) {
        return {
          success: false,
          error: 'old_text 归一化后为空(仅含空白或 markdown 标记,没有可定位的文字或图片 URL)。请从 ## Current Document 复制包含实际文字的片段作为 old_text(替换图片时连同图题文字一起复制)。',
        }
      }
      return this.rangeEdit(docId, oldText, newText, String(args.summary || 'range edit'))
    }

    if (!fullText.trim()) {
      return { success: false, error: 'Provide import_reference (empty document), old_text+new_text (range edit), or full_text (full rewrite).' }
    }
    return this.fullReplace(docId, fullText, String(args.summary || 'document updated'))
  }

  /** 导入模式:按 label 定位参考材料,把提取的正文写入文档(#697 拆到 edit-import.ts)。 */
  private importReference(docId: string, reference: string, summary: string): Promise<ToolResult> {
    return executeImportReference(this.ctx.userId, docId, reference, summary)
  }

  /** 局部编辑:在文档中精确匹配 oldText 并替换为 newText。 */
  private async rangeEdit(docId: string, oldText: string, newText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await prisma.doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      let body = String(existing.body || '')
      // #fix: 正文为空时局部编辑必然失败 — 若存在唯一参考材料(用户上传
      // PDF/DOCX 后直接说"润色"的典型场景),自动导入后再执行本编辑,
      // 不依赖模型先单独调一次 import_reference;多参考/无参考才报错引导。
      // #787: 编排收敛到 doc-import.ensureDraftBody(文案单点维护)。
      if (!body.trim()) {
        const ensured = await ensureDraftBody(this.ctx.userId, docId, { scenario: 'import_reference' })
        if (ensured.error) return { success: false, error: ensured.error }
        body = ensured.body
      }
      // #fix: 三级匹配 — 空白归一化(换行/连续空格/软连字符/markdown
      // 标题标记/大小写)→ 完全忽略空白 → 模糊匹配(少量字符差异)。
      // 命中后替换原始 span,新正文不留空白残留。
      const span = findNormalizedSpan(body, oldText) ?? findFuzzySpan(body, oldText)
      if (!span) {
        // #fix: 检测 old_text 是否来自参考材料而非正文 — 同一篇稿件不同
        // 格式(PDF vs DOCX)提取的文本有差异,模型从参考材料复制必然失配
        // (生产事故:正文是 PDF 版,参考是 DOCX 版)。命中的话报错去向明确:
        // 先 import_reference 导入该参考材料覆盖正文,再编辑。
        let refMatchLabel = ''
        try {
          const targets = await resolveImportTargets(this.ctx.userId, docId)
          for (const { r, label } of targets.slice(0, 3)) {
            const { text } = await extractRefText(this.ctx.userId, docId, r, label)
            if (text && findNormalizedSpan(text, oldText)) { refMatchLabel = label; break }
          }
        } catch {
          // 检测失败不阻断 — 走普通提示
        }
        // 帮助模型修正锚点:给出文档开头附近的可匹配片段(保留大小写与
        // 标题标记,便于逐字复制)。
        // #fix: probe 取文档第一个非空行(通常是标题行)的完整内容 —
        // 模型会把 probe 直接复制成 old_text,按字符硬切在句子中间
        // (长标题 150+ 字符)必然失配;整行天然完整,复制即可命中。
        const probeLine = body.split('\n').map((l) => l.trim()).filter(Boolean)[0] || ''
        let probe = probeLine.slice(0, 300)
        if (probe.length > 120) {
          const cut = Math.max(
            probe.lastIndexOf('。'), probe.lastIndexOf('. '), probe.lastIndexOf('；'),
            probe.lastIndexOf('; '), probe.lastIndexOf('，'), probe.lastIndexOf(', '),
          )
          if (cut > 40) probe = probe.slice(0, cut + 1)
        }
        const guide = refMatchLabel
          ? `你复制的 old_text 与参考材料「${refMatchLabel}」一致,但与正文(## Current Document)不符 — 正文与参考材料来自不同文件格式/版本,提取的文本有差异。请先调用 edit_document 的 import_reference 导入「${refMatchLabel}」把该参考材料设为正文(覆盖后 old_text 即可匹配),或从 ## Current Document 逐字复制待修改的原文。`
          : '请从上方 ## Current Document 部分逐字复制待修改的原文,不要从「文档结构」清单复制(带序号),不要从 Reference Materials 复制。'
        return {
          success: false,
          error: `old_text 在文档中未找到(已忽略空格/换行/标题标记差异后仍不匹配)。${guide} 文档开头附近完整片段(可直接复制): "${probe}"`,
        }
      }
      // 归一化匹配同样参与多次命中判定 — 两个片段仅空白不同也视为重复;
      // 模糊匹配跳过(锚点窗口内已约束唯一性)。
      if (!span.fuzzy && span.normBody.indexOf(span.normNeedle, span.k + span.normNeedle.length) !== -1) {
        return {
          success: false,
          error: 'old_text 在文档中出现多次,请包含更多上下文让锚点唯一(比如加上前后句)',
        }
      }

      const newBody = body.slice(0, span.start) + newText + body.slice(span.end)
      if (newBody === body) return { success: false, error: 'old_text 与 new_text 相同,没有任何变化' }

      // #789: 写回走 DocVersionWriter 单点(快照同帧带旧 deck + 事务)。
      const written = await writeDocVersion({ userId: this.ctx.userId, docId, body: newBody, snapshotLabel: 'AI edit' })
      if (written.error) return { success: false, error: written.error }

      return {
        success: true,
        output: JSON.stringify({ body: written.body, summary }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** 全量替换(旧行为,仅短文档)。 */
  private async fullReplace(docId: string, fullText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await prisma.doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      // #fix: 长文档全量重写会超 LLM 输出预算(8192 token)→ 截断成半篇、
      // 长时间生成触发网关/Cloudflare 超时重置 SSE("网络连接中断")。
      // 硬约束不依赖模型自觉:现有文档超限即拒绝,引导逐段 range 编辑。
      const docTokens = estimateTokens(String(existing.body || ''))
      const fullTextTokens = estimateTokens(fullText)
      const FULL_REPLACE_MAX_TOKENS = 2000
      if (docTokens > FULL_REPLACE_MAX_TOKENS || fullTextTokens > FULL_REPLACE_MAX_TOKENS) {
        return {
          success: false,
          error: `full_text 全量重写仅适用于短文档（约 ${FULL_REPLACE_MAX_TOKENS} token 以内）；当前文档约 ${docTokens} token，重写输出会被截断并导致连接超时。请改用 old_text/new_text 逐段编辑（每段一次调用），或提示用户先选中要修改的文本再操作。`,
        }
      }

      // #789: 写回走 DocVersionWriter 单点(无变化不产生空版本)。
      const written = await writeDocVersion({ userId: this.ctx.userId, docId, body: fullText, snapshotLabel: 'AI edit' })
      if (written.error) return { success: false, error: written.error }

      return {
        success: true,
        output: JSON.stringify({ body: written.body, summary }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
