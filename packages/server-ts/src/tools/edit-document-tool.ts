import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { estimateTokens } from '../common/token-estimate.js'
import { resolveDefaultMaxTokens, resolveActiveModel } from '../common/llm-gateway.js'
import { resolveImportTargets, extractRefText, ensureDraftBody } from './doc-import.js'
import { writeDocVersion } from './doc-version-writer.js'
// #697: 匹配算法族下沉 lib(纯函数,可独立单测)。
import { normalizeForMatch, findNormalizedSpan, findFuzzySpan } from '../lib/document-span-match.js'
// #837: 写回卫生 — 双转义换行还原 + 块级边界空行分隔。
import { unescapeLiteralNewlines, ensureBlockBoundaries } from '../lib/document-span-match.js'
// #697: import 模式拆到 edit-import.ts。
import { executeImportReference } from './edit-import.js'
// #868: 落点章节透明化 + 焦点段定位提示类型。
import { nearestHeadingBefore } from '../lib/doc-sections.js'
import type { EditHint } from './tool-registry.js'
import { executeImportFromUrl } from './doc-import.js'

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
 * - full 模式(full_text):全量替换,受当前模型单次输出预算约束 — 预算内
 *   直接可用(#fix 2026-09,glm-5.3-flash 96000 预算下 7000+ token 文档
 *   实测可行);超预算时拒绝并引导逐段。
 *
 * 版本化 + 自动快照 + 前端 diff 审阅(doc_updated SSE)对三种模式一致。
 */
export class EditDocumentTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string; editHint?: EditHint }) {
    super()
  }

  get name(): string { return 'edit_document' }

  get description(): string {
    return [
      'Edit the current writing-session document. Three modes:',
      '- Import: pass `import_reference` (the reference-material name to import) when the document body is EMPTY and the user wants to work on an uploaded reference (PDF/DOCX/txt). This copies the reference text into the document. Alternatively pass `url` (+ optional `doi`) to download an OA full-text PDF directly into the reference library — use the URL from oa_pdf_lookup results (#875: closes the search→read→cite loop).',
      '- Range edit (preferred for polishing long documents): pass `old_text` (the original text to replace, copied from the current document — line breaks/whitespace differences are tolerated) and `new_text` (the replacement). One edit per call; make multiple calls to edit multiple parts. When the document body is EMPTY and exactly one reference exists, the tool auto-imports it before applying the edit (so you can polish an uploaded reference without a separate import call). To replace a figure/link, include its image markdown together with surrounding caption text — image URLs must match exactly, and an old_text that spans an image must include the image.',
      '- Full rewrite: pass `full_text` (complete new document in markdown). Allowed within the model single-response output budget (the main model budget is generous — full rewrites of multi-thousand-token documents work). If it exceeds the budget the tool refuses with guidance; for long-document cleanup/polish prefer range edits.',
      'Formatting: write-back content must arrive pre-structured in markdown — organize new content by its logic (### / ## headings for topics or steps, bullet/numbered lists for enumerations, bold for key conclusions, GFM pipe tables for comparisons). Never write back unstructured prose walls; match the heading level style already used in the document.',
      'Use this instead of explaining changes.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        import_reference: { type: 'string', description: 'Import mode: the label/name of the reference material to import into the empty document (e.g. the uploaded file name).' },
        url: { type: 'string', description: 'Import via URL: direct OA full-text PDF link (e.g. the url_for_pdf returned by oa_pdf_lookup). Downloads into the reference library and sets the extracted content as the document body.' },
        doi: { type: 'string', description: 'Optional DOI alongside url — enables Unpaywall OA verification (refuses paywalled / non-OA links).' },
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

    // #875: URL 导入 — OA 全文 PDF 直链入库(检索→阅读→引用闭环)。
    const importUrl = typeof args.url === 'string' ? args.url.trim() : ''
    if (importUrl) {
      const doi = typeof args.doi === 'string' ? args.doi.trim() : undefined
      const r = await executeImportFromUrl(this.ctx.userId, docId, importUrl, String(args.summary || 'imported from URL'), doi)
      if (r.error) return { success: false, error: r.error }
      return { success: true, output: r.output }
    }

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

  /** 局部编辑:在文档中精确匹配 oldText 并替换为 newText。
   *  #868: 焦点优先 — 先在用户选中文本/焦点段内匹配(位置必然正确),
   *  段内失败再全文匹配(带模糊锚点唯一性护栏,见 document-span-match)。 */
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

      // #868: 焦点优先区域 — 选中文本(最具体)→ 焦点段。在区域内命中后
      // 位置可信,直接写回;两处皆失配才走全文匹配。
      const hint = this.ctx.editHint
      const regions: Array<{ label: string; text: string }> = []
      if (hint?.selectionText) regions.push({ label: '用户选中文本', text: hint.selectionText })
      if (hint?.focusSectionContent) {
        regions.push({
          label: hint.focusIndex ? `第 ${hint.focusIndex} 段${hint.focusTitle ? `「${hint.focusTitle}」` : ''}` : '当前编辑段落',
          text: hint.focusSectionContent,
        })
      }
      for (const region of regions) {
        const regionSpan = findNormalizedSpan(body, region.text)
        if (!regionSpan || regionSpan.end <= regionSpan.start) continue
        const slice = body.slice(regionSpan.start, regionSpan.end)
        const local = findNormalizedSpan(slice, oldText) ?? findFuzzySpan(slice, oldText)
        if (!local) continue
        const heading = nearestHeadingBefore(body, regionSpan.start + local.start)
        const location = region.label === '用户选中文本'
          ? `用户选中文本${heading ? `（${heading} 内）` : ''}`
          : `${region.label}${heading ? `（${heading} 内）` : ''}`
        return await this.applySpan(body, docId, regionSpan.start + local.start, regionSpan.start + local.end, newText, summary, location)
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
        // 帮助模型修正锚点:给出可匹配片段(保留大小写与标题标记,便于逐字
        // 复制)。#868: 长文档模式模型只看到焦点段 — probe 从焦点段取,
        // 不再取文档头(复制了也违反焦点规则)。
        const probeSource = hint?.focusSectionContent || body
        const probeLine = probeSource.split('\n').map((l) => l.trim()).filter(Boolean)[0] || ''
        let probe = probeLine.slice(0, 300)
        if (probe.length > 120) {
          const cut = Math.max(
            probe.lastIndexOf('。'), probe.lastIndexOf('. '), probe.lastIndexOf('；'),
            probe.lastIndexOf('; '), probe.lastIndexOf('，'), probe.lastIndexOf(', '),
          )
          if (cut > 40) probe = probe.slice(0, cut + 1)
        }
        const probeLabel = hint?.focusSectionContent ? '当前编辑段落开头完整片段(可直接复制)' : '文档开头附近完整片段(可直接复制)'
        const guide = refMatchLabel
          ? `你复制的 old_text 与参考材料「${refMatchLabel}」一致,但与正文(## Current Document)不符 — 正文与参考材料来自不同文件格式/版本,提取的文本有差异。请先调用 edit_document 的 import_reference 导入「${refMatchLabel}」把该参考材料设为正文(覆盖后 old_text 即可匹配),或从 ## Current Document 逐字复制待修改的原文。`
          : '请从上方 ## Current Document 部分逐字复制待修改的原文,不要从「文档结构」清单复制(带序号),不要从 Reference Materials 复制。'
        return {
          success: false,
          error: `old_text 在文档中未找到(已忽略空格/换行/标题标记差异后仍不匹配)。${guide} ${probeLabel}: "${probe}"`,
        }
      }
      // 归一化匹配同样参与多次命中判定 — 两个片段仅空白不同也视为重复;
      // 模糊匹配跳过(锚点唯一性护栏已在 findFuzzySpan 内收口,#868)。
      if (!span.fuzzy && span.normBody.indexOf(span.normNeedle, span.k + span.normNeedle.length) !== -1) {
        return {
          success: false,
          error: 'old_text 在文档中出现多次,请包含更多上下文让锚点唯一(比如加上前后句)',
        }
      }

      const heading = nearestHeadingBefore(body, span.start)
      const location = heading ? `「${heading}」章节内` : '文档中'
      return await this.applySpan(body, docId, span.start, span.end, newText, summary, location)
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** #868: span 写回单点 — 区域命中与全文命中共用;输出带落点章节
   *  (location),模型与用户可核对修改是否落在预期位置。 */
  private async applySpan(body: string, docId: string, start: number, end: number, newText: string, summary: string, location: string): Promise<ToolResult> {
    // #837: 写回卫生 — ① 还原字面 \n 双转义;② 块级内容(标题/列表/
    // 表格)与前后正文之间补空行,杜绝 "population.## Introduction" 粘连。
    const cleanedNew = unescapeLiteralNewlines(newText)
    const boundedNew = ensureBlockBoundaries(body.slice(0, start), cleanedNew, body.slice(end))
    const newBody = body.slice(0, start) + boundedNew + body.slice(end)
    if (newBody === body) return { success: false, error: 'old_text 与 new_text 相同,没有任何变化' }

    // #789: 写回走 DocVersionWriter 单点(快照同帧带旧 deck + 事务)。
    const written = await writeDocVersion({ userId: this.ctx.userId, docId, body: newBody, snapshotLabel: 'AI edit' })
    if (written.error) return { success: false, error: written.error }

    return {
      success: true,
      output: JSON.stringify({ body: written.body, summary, location: `已修改:${location}附近` }),
    }
  }

  /** 全量替换(#fix 2026-09:护栏按真实输出预算动态判定)。 */
  private async fullReplace(docId: string, fullText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await prisma.doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }
      // #837: 字面 \n 双转义还原。
      fullText = unescapeLiteralNewlines(fullText)

      // #fix 2026-09: 旧硬编码 2000 token 是 deepseek-chat 8192 输出预算时代
      // 的产物 — 主模型切 glm-5.3-flash(输出预算 96000)后,7000+ token 文档
      // 全量重写完全可行,生产实测被误拦(2026-09-07)。真正的物理约束 =
      // 单次输出预算(思维链共享):重写文本 + 思维链预留 > 预算 → 必然截断,
      // 此时提前拒绝并引导;否则放行(写回有版本快照兜底,可一键回滚)。
      // 注:不再检查旧文档大小 — 真正决定截断风险的是【新文本】的输出量
      // (模型既然已把完整 full_text 作为工具参数生成出来,输出本身就装得下)。
      const budget = resolveDefaultMaxTokens(resolveActiveModel())
      const RESERVE = 8192 // 思维链预留(混合思考与可见输出共享预算)
      const limit = Math.max(0, budget - RESERVE)
      const fullTextTokens = estimateTokens(fullText)
      if (fullTextTokens > limit) {
        return {
          success: false,
          error: `当前模型输出预算不足以一次完成全量重写：预算约 ${budget} token（需预留 ${RESERVE} 给思维链），重写内容约 ${fullTextTokens} token。请改用 old_text/new_text 逐段编辑（每段一次调用），或在设置页切换输出预算更大的模型。文档未被修改。`,
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
