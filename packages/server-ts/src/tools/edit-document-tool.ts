import fs from 'fs'
import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { makeLogger } from '../common/logger.js'
import { estimateTokens } from '../common/token-estimate.js'
import { resolveDefaultMaxTokens, resolveActiveModel } from '../common/llm-gateway.js'
import { resolveImportTargets, ensureDraftBody } from './doc-import.js'
import { writeDocVersion } from './doc-version-writer.js'
// #697: 匹配算法族下沉 lib(纯函数,可独立单测)。
import { normalizeForMatch, findNormalizedSpan, findFuzzySpan } from '../lib/document-span-match.js'
// #837: 写回卫生 — 双转义换行还原 + 块级边界空行分隔。
import { unescapeLiteralNewlines, ensureBlockBoundaries } from '../lib/document-span-match.js'
// #697: import 模式拆到 edit-import.ts。
import { executeImportReference } from './edit-import.js'
// #868: 落点章节透明化 + 焦点段定位提示类型。
import { nearestHeadingBefore, splitDocumentSections } from '../lib/doc-sections.js'
import type { EditHint } from './tool-registry.js'
import { parseDocSessionId } from './tool-registry.js'
import { CONTEXT_CONFIG } from '../common/context-config.js'
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
const log = makeLogger('tools.edit-document')

/**
 * #989 Phase 2 验证标准 — target_section vs 锚点模式的 A/B 观测计数器
 * (进程内累计 + 结构化日志;生产事件日志 tool_call 事件亦含 args 可复核)。
 */
const sectionEditTelemetry = { attempts: 0, success: 0, idInvalid: 0 }
const anchorEditTelemetry = { attempts: 0, success: 0 }

export class EditDocumentTool extends BaseTool {
  /**
   * #906: 本轮最新正文缓存 — applySpan/fullReplace/import 写回成功后更新。
   * 组装期回填的 editHint(焦点段/选中文本)来自组装时的旧正文,同一回合
   * 连续编辑时已失配;区域定位改从最新正文取。每回合新建 ToolRegistry →
   * 新建本工具实例,缓存生命周期天然等于一回合,无需额外重置。
   */
  private latestBody: string | null = null

  constructor(private ctx: { userId: string; sessionId?: string; editHint?: EditHint }) {
    super()
  }

  get name(): string { return 'edit_document' }

  get description(): string {
    return [
      'Edit the current writing-session document. Four modes:',
      '- Section edit (preferred when section IDs are visible): pass `target_section` (the [sec:...] id from the injected document, e.g. s_xxx) + `section_action` (replace | append | prepend) + `content`. The server locates the section precisely by its structure projection — no fuzzy matching, deterministic. Use this for whole-section rewrites/appends; it never fails on anchor mismatch.',
      '- Import: pass `import_reference` (the reference-material name to import) when the document body is EMPTY and the user wants to work on an uploaded reference (PDF/DOCX/txt). This copies the reference text into the document. Alternatively pass `url` (+ optional `doi`) to download an OA full-text PDF directly into the reference library — use the URL from oa_pdf_lookup results (#875: closes the search→read→cite loop).',
      '- Range edit (preferred for polishing long documents without section IDs, or fine-grained in-section tweaks): pass `old_text` (the original text to replace, copied from the current document — line breaks/whitespace differences are tolerated; [sec:...] markers are stripped automatically) and `new_text` (the replacement). One edit per call; make multiple calls to edit multiple parts. When the document body is EMPTY and exactly one reference exists, the tool auto-imports it before applying the edit (so you can polish an uploaded reference without a separate import call). To replace a figure/link, include its image markdown together with surrounding caption text — image URLs must match exactly, and an old_text that spans an image must include the image.',
      '- Full rewrite: pass `full_text` (complete new document in markdown). Allowed within the model single-response output budget (the main model budget is generous — full rewrites of multi-thousand-token documents work). If it exceeds the budget the tool refuses with guidance; for long-document cleanup/polish prefer section edits or range edits.',
      'Formatting: write-back content must arrive pre-structured in markdown — organize new content by its logic (### / ## headings for topics or steps, bullet/numbered lists for enumerations, bold for key conclusions, GFM pipe tables for comparisons). Never write back unstructured prose walls; match the heading level style already used in the document.',
      'Use this instead of explaining changes.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        target_section: { type: 'string', description: 'Section-edit mode: the section id from [sec:...] markers in the injected document (e.g. s_xxx). Deterministic whole-section edit — preferred over old_text when visible.' },
        section_action: { type: 'string', enum: ['replace', 'append', 'prepend', 'delete'], description: 'Section-edit action: replace the section content / append after it / insert right after the heading / delete removes the ENTIRE section (heading + content, no content needed).' },
        content: { type: 'string', description: 'Section-edit payload: the markdown content for replace/append/prepend (alias: new_text is accepted).' },
        import_reference: { type: 'string', description: 'Import mode: the label/name of the reference material to import into the empty document (e.g. the uploaded file name).' },
        url: { type: 'string', description: 'Import via URL: direct OA full-text PDF link (e.g. the url_for_pdf returned by oa_pdf_lookup). Downloads into the reference library and sets the extracted content as the document body.' },
        doi: { type: 'string', description: 'Optional DOI alongside url — enables Unpaywall OA verification (refuses paywalled / non-OA links).' },
        old_text: { type: 'string', description: 'Range mode: the original text to replace (must match the current document — whitespace/line-break differences are tolerated).' },
        new_text: { type: 'string', description: 'Range mode: the replacement text (empty to delete).' },
        full_text: { type: 'string', description: 'Full mode: the complete new document content in markdown.' },
        summary: { type: 'string', description: 'A one-line summary of what changed.' },
        step_index: { type: 'number', description: 'When the task plan (set_task_plan) is active, the plan step number (1-based, from the injected checklist) this edit implements. Required while a plan is active — the system uses it to tick the correct step (out-of-order edits are recorded accurately). Omit when no plan exists.' },
      },
      required: [],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    // #905: docId 格式校验(对齐 documents.router 的 doc_+16hex)— 此前
    // slice(4) 盲取,任意 `doc-<x>` 会话都能拼出无效 docId 去查库。
    const docId = parseDocSessionId(this.ctx.sessionId)
    if (!docId) {
      return { success: false, error: 'edit_document is only available in a document writing session' }
    }

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

    // #989 Phase 2: 节引用模式 — target_section 优先(确定性,无模糊匹配)。
    const targetSection = typeof args.target_section === 'string' ? args.target_section.trim() : ''
    if (targetSection) {
      return this.sectionEdit(docId, targetSection, args)
    }

    const oldText = typeof args.old_text === 'string' ? args.old_text : ''
    const newText = typeof args.new_text === 'string' ? args.new_text : ''
    const fullText = typeof args.full_text === 'string' ? args.full_text : ''

    // #fix: 分步编辑 — 提供了 old_text 就走局部替换,不要求完整文档。
    if (oldText) {
      // #989 Phase 2: [sec:...] marker 剥离 — 模型从带 ID 的注入文本复制
      // old_text 时 marker 一并复制,剥离后锚点匹配不受影响。
      const cleanedOld = oldText.replace(/\s*\[sec:[^\]]*\]/g, '')
      if (!cleanedOld.trim()) return { success: false, error: 'old_text is empty' }
      if (!normalizeForMatch(cleanedOld)) {
        return {
          success: false,
          error: 'old_text 归一化后为空(仅含空白或 markdown 标记,没有可定位的文字或图片 URL)。请从 ## Current Document 复制包含实际文字的片段作为 old_text(替换图片时连同图题文字一起复制)。',
        }
      }
      return this.rangeEdit(docId, cleanedOld, newText, String(args.summary || 'range edit'))
    }

    if (!fullText.trim()) {
      // #978/#989: 空参形态 — 模型侧自认已构造参数,实际到达为空(传输丢参
      // 或模型空发)。复读用法无恢复价值,给可执行的纠偏:指认空参事实 +
      // 最简重试配方 + 明令禁止空参重发(doom-loop 家族的燃料)。
      return {
        success: false,
        error: '本次调用没有任何参数（参数在传输中丢失或未生成 — 若你确信已构造，请换一种构造方式重试）。最简重试配方二选一：① old_text（从 ## Current Document 逐字复制）+ new_text；② target_section + section_action + content（节 ID 见 [sec:...] 标注）。严禁重发空参数 {}。',
      }
    }
    return this.fullReplace(docId, fullText, String(args.summary || 'document updated'))
  }

  /**
   * #989 Phase 2: 确定性节编辑 — 按投影 span 精确改写节内容(锚点失配的
   * 根因治理路径)。投影缺失/过期时重建(确定性);section ID 失效 → 报错
   * 引导降级锚点模式(兜底)。写回仍走 DocVersionWriter 单点。
   */
  private async sectionEdit(docId: string, targetSection: string, args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.section_action === 'append' ? 'append'
      : args.section_action === 'prepend' ? 'prepend'
      : args.section_action === 'delete' ? 'delete'
      : 'replace'
    // #989 生产实例(2026-09-12):模型沿用 range 模式的参数习惯传 new_text
    // 而非 content → 节模式收到空 content 被拒。content 为空时接受
    // new_text 别名(与工具既有词表一致,杜绝参数名混用类失败)。
    const content = typeof args.content === 'string' && args.content.trim()
      ? args.content
      : (typeof args.new_text === 'string' ? args.new_text : '')
    try {
      const existing = await prisma.doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }
      const body = String(existing.body || '')
      if (!body.trim()) {
        // 空正文 — 无结构可引用;引导导入(空文档时 import_reference 才有意义)。
        return { success: false, error: '文档正文为空 — 节引用不可用;请先用 import_reference 导入参考材料,或改用 full_text 首写。' }
      }
      // 投影:存读校验 body_hash,不符/缺失重建(loadProjection 确定性)。
      const { loadProjection, applySectionEdit } = await import('../lib/block-projection.js')
      const projection = loadProjection(body, existing.blockProjection)
      const applied = applySectionEdit(body, projection, targetSection, action, content)
      if ('error' in applied) {
        // #989: A/B 观测 — ID 失效走锚点兜底的比例(Phase 2 验证标准)。
        sectionEditTelemetry.idInvalid++
        log.info(`[edit_document] target_section miss id=${targetSection} action=${action} (fallback to anchor) total={ok:${sectionEditTelemetry.success} miss:${sectionEditTelemetry.idInvalid}}`)
        return { success: false, error: applied.error }
      }
      if (applied.body === body) {
        return { success: false, error: '节内容与提供内容相同,没有任何变化' }
      }
      const summary = String(args.summary || `${action === 'delete' ? '删除' : action} section ${targetSection}`)
      // #789: 写回走 DocVersionWriter 单点(快照同帧带旧 deck + 事务 + 投影同帧)。
      const written = await writeDocVersion({ userId: this.ctx.userId, docId, body: applied.body, snapshotLabel: 'AI edit' })
      if (written.error) return { success: false, error: written.error }
      this.latestBody = written.body
      sectionEditTelemetry.attempts++
      sectionEditTelemetry.success++
      log.info(`[edit_document] target_section ok action=${action} id=${targetSection} total={ok:${sectionEditTelemetry.success} miss:${sectionEditTelemetry.idInvalid}}`)
      // #989 Phase 3: 输出携带块投影 — tool-loop 转 doc_updated.projection 推前端。
      return {
        success: true,
        output: JSON.stringify({ body: written.body, summary, location: `已${action === 'replace' ? '重写' : action === 'append' ? '追加' : action === 'prepend' ? '插入' : '删除'}:「${applied.location}」`, projection: written.projection }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** 导入模式:按 label 定位参考材料,把提取的正文写入文档(#697 拆到 edit-import.ts)。 */
  private async importReference(docId: string, reference: string, summary: string): Promise<ToolResult> {
    const result = await executeImportReference(this.ctx.userId, docId, reference, summary)
    // #906: 导入覆盖了整篇正文 — 同步本轮最新正文缓存,后续 rangeEdit
    // 的区域定位基于导入后的正文。
    if (result.success && typeof result.output === 'string') {
      try {
        const parsed = JSON.parse(result.output) as { body?: string }
        if (typeof parsed.body === 'string') this.latestBody = parsed.body
      } catch { /* 输出非 JSON — 不更新缓存 */ }
    }
    return result
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
      // #906: 区域定位源 — 组装期回填的 hint 区域来自组装时正文,同一
      // 回合前一次编辑成功后该区域可能已失配;定位源优先用本轮最新正文
      // (latestBody),无缓存时回退 DB 当前正文。span 定位与写回必须用
      // 同一份 body(applySpan 的 body 参数与定位源一致),否则索引错位。
      const hint = this.ctx.editHint
      const regions: Array<{ label: string; text: string }> = []
      if (hint?.selectionText) regions.push({ label: '用户选中文本', text: hint.selectionText })
      if (hint?.focusSectionContent) {
        regions.push({
          label: hint.focusIndex ? `第 ${hint.focusIndex} 段${hint.focusTitle ? `「${hint.focusTitle}」` : ''}` : '当前编辑段落',
          text: hint.focusSectionContent,
        })
      }
      const matchSource = this.latestBody ?? body
      for (const region of regions) {
        const regionSpan = findNormalizedSpan(matchSource, region.text)
        if (!regionSpan || regionSpan.end <= regionSpan.start) continue
        const slice = matchSource.slice(regionSpan.start, regionSpan.end)
        const local = findNormalizedSpan(slice, oldText) ?? findFuzzySpan(slice, oldText)
        if (!local) continue
        const heading = nearestHeadingBefore(matchSource, regionSpan.start + local.start)
        const location = region.label === '用户选中文本'
          ? `用户选中文本${heading ? `（${heading} 内）` : ''}`
          : `${region.label}${heading ? `（${heading} 内）` : ''}`
        return await this.applySpan(matchSource, docId, regionSpan.start + local.start, regionSpan.start + local.end, newText, summary, location)
      }

      // #906: 焦点段回合内失效兜底 — hint 焦点段在最新正文已失配(上一
      // 次编辑改写过该段)时,按 focusIndex 从本轮最新正文重新切分出该段
      // (区域内容来自新正文)再定位,区域优先级在回合内不失效。失败或
      // 局部仍失配 → 落到全文路径。跨回合不受影响(新实例无缓存)。
      if (this.latestBody && hint?.focusSectionContent && hint.focusIndex) {
        try {
          const fresh = splitDocumentSections(this.latestBody, CONTEXT_CONFIG.scene.docSectionTokens)
            .sections[hint.focusIndex - 1]
          if (fresh?.content) {
            const regionSpan = findNormalizedSpan(this.latestBody, fresh.content)
            if (regionSpan && regionSpan.end > regionSpan.start) {
              const slice = this.latestBody.slice(regionSpan.start, regionSpan.end)
              const local = findNormalizedSpan(slice, oldText) ?? findFuzzySpan(slice, oldText)
              if (local) {
                const heading = nearestHeadingBefore(this.latestBody, regionSpan.start + local.start)
                const regionLabel = `第 ${hint.focusIndex} 段${hint.focusTitle ? `「${hint.focusTitle}」` : ''}`
                return await this.applySpan(
                  this.latestBody, docId,
                  regionSpan.start + local.start, regionSpan.start + local.end,
                  newText, summary,
                  `${regionLabel}${heading ? `（${heading} 内）` : ''}`,
                )
              }
            }
          }
        } catch { /* 重切失败 → 走全文路径 */ }
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
            // #914: 探测走缓存提取(与 picked_kb/参考注入同一缓存面) —
            // 此前逐个走无缓存 extractRefText,大 PDF 失配报错路径可达分钟级。
            const text = await this.probeRefText(r)
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
        anchorEditTelemetry.attempts++
        log.info(`[edit_document] anchor-edit miss len=${oldText.length} total={ok:${anchorEditTelemetry.success} fail:${anchorEditTelemetry.attempts - anchorEditTelemetry.success}}`)
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
      anchorEditTelemetry.attempts++
      anchorEditTelemetry.success++
      log.info(`[edit_document] anchor-edit ok len=${oldText.length} total={ok:${anchorEditTelemetry.success} fail:${anchorEditTelemetry.attempts - anchorEditTelemetry.success}}`)
      return await this.applySpan(body, docId, span.start, span.end, newText, summary, location)
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** #868: span 写回单点 — 区域命中与全文命中共用;输出带落点章节
   *  (location),模型与用户可核对修改是否落在预期位置。#906: 写回成功
   *  后同步本轮最新正文缓存。 */
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

    this.latestBody = written.body
    // #989 Phase 3: 输出携带块投影 — tool-loop 转 doc_updated.projection 推前端。
    return {
      success: true,
      output: JSON.stringify({ body: written.body, summary, location: `已修改:${location}附近`, projection: written.projection }),
    }
  }

  /**
   * #914: 失配探测的参考材料文本提取 — 与注入/钉选同走缓存面
   * (cachedExtractDocumentMarkdownFromUpload)。薄适配:文件类引用按
   * 文件名定位上传记录(FileIndex 优先,目录扫描兜底 — 与
   * findUploadFileByName 同口径),非文件引用直接用 snapshot 文本;
   * 探测只需文本匹配,不需要图片托管/公式 LaTeX。
   */
  private async probeRefText(ref: { refType?: string | null; snapshot?: string | null }): Promise<string> {
    const kind = String(ref.refType || '')
    if (kind !== 'file' && kind !== 'pdf' && kind !== 'docx') {
      return String(ref.snapshot || '')
    }
    const name = String(ref.snapshot || '')
    if (!name) return ''
    const byIndex = await prisma.fileIndex.findFirst({
      where: { userId: this.ctx.userId, name, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    }).catch(() => null)
    let fileId = byIndex?.id || null
    if (!fileId) {
      // FileIndex 缺记录 → 按文件名扫描上传目录兜底(与 doc-import 同口径)。
      try {
        const { uploadsBaseDir } = await import('../lib/upload-path.js')
        const dir = uploadsBaseDir(this.ctx.userId)
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            const derived = f.split('_').slice(1).join('_') || f
            if (derived === name) { fileId = f; break }
          }
        }
      } catch { /* 目录不可读 — 探测按未命中处理 */ }
    }
    if (!fileId) return ''
    const { cachedExtractDocumentMarkdownFromUpload } = await import('../lib/document-extractor.js')
    return cachedExtractDocumentMarkdownFromUpload(this.ctx.userId, fileId)
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

      // #906: 全量重写同样推进本轮最新正文缓存 — 同回合后续 rangeEdit
      // 的区域定位基于重写后的正文。
      this.latestBody = written.body
      // #989 Phase 3: 输出携带块投影。
      return {
        success: true,
        output: JSON.stringify({ body: written.body, summary, projection: written.projection }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
