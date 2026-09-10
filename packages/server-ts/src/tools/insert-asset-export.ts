/**
 * insert_asset export executor (#789②) — faithful export (#767) and
 * AI-organized deck (#772), extracted from insert-asset-tool.ts. Owns the
 * EXPORT_FORMATS table, the two-phase organize protocol and the render →
 * store → download-card pipeline via asset-render-pipeline.
 */
import { validateRenderContent, SCHEMA_VERSION, slideLayoutSchema, deckThemeSchema, chartBlockSchema } from '@heurion/contracts'
import prisma from '../common/prisma.js'
import type { ToolResult } from './base-tool.js'
import type { ToolExecutionPlane } from './tool-registry.js'
import { ensureDraftBody } from './doc-import.js'
import { buildDocumentContent, buildPresentationContent, digestBody } from '../lib/asset-content.js'
import { embedContentImages, resolveLocalImageBlock } from './asset-embed.js'
import { runRenderJob } from './asset-render-pipeline.js'
import { chartSpecPng } from './deck-chart-embed.js'

/** #767 — 导出格式 → 插件 id / 契约 content_type / job type / 模板 / mime。 */
export const EXPORT_FORMATS: Record<string, { pluginId: string; contentType: 'sidecar.generate_docx' | 'sidecar.generate_pptx' | 'sidecar.convert_to_pdf'; templateId: string; ext: string; mime: string; label: string }> = {
  docx: { pluginId: 'heurion/docx', contentType: 'sidecar.generate_docx', templateId: 'case_summary', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  pptx: { pluginId: 'heurion/pptx', contentType: 'sidecar.generate_pptx', templateId: 'default', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PPT' },
  pdf: { pluginId: 'heurion/pdf', contentType: 'sidecar.convert_to_pdf', templateId: 'default', ext: 'pdf', mime: 'application/pdf', label: 'PDF' },
}

export interface ExportExecutorDeps {
  userId: string
  plane: ToolExecutionPlane
  isPluginInstalled?: (pluginId: string) => Promise<boolean>
  /** #939/#960: figure 渲染管线 port（modules/figures 注入，tools 零 modules import）。 */
  figurePipeline?: {
    resolveBody: (userId: string, body: string) => Promise<string>
    ensureFigure: (userId: string, source: string, kind: 'mermaid' | 'latex_math', caption?: string) => Promise<{ ref: string; caption?: string; data: string } | null>
  }
  /** 写回单点(工具类的 writeBlock,含 deck 同帧选项)。 */
  writeBlock: (docId: string, block: string, args: Record<string, unknown>, summaryBase: string, opts?: { deckJson?: string | null; snapshotLabel?: string }) => Promise<ToolResult>
}

export async function executeInsertExport(deps: ExportExecutorDeps, docId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { userId } = deps
  const format = String(args.format || '')
  const spec = EXPORT_FORMATS[format]
  if (!spec) return { success: false, error: 'export 需要 format: docx | pptx | pdf' }
  const organize = args.organize === true
  if (organize && spec.contentType !== 'sidecar.generate_pptx') {
    return { success: false, error: 'organize 仅支持 format=pptx（AI 编排做演示）；docx/pdf 请用 organize=false 保真导出。' }
  }
  if (deps.isPluginInstalled && !(await deps.isPluginInstalled(spec.pluginId))) {
    return { success: false, error: `导出 ${spec.label} 需要先在「插件市场」安装 ${spec.pluginId} 插件。` }
  }

  const existing = await prisma.doc.findFirst({ where: { id: docId, userId } })
  if (!existing) return { success: false, error: `Document not found: ${docId}` }
  let body = String(existing.body || '')

  // #772: organize=true — AI 编排做 PPT（主场景"把这篇文章做成 PPT"）。
  if (organize) return organizedExport(deps, docId, existing, body, args)

  // organize=false — 保真导出。#774: 草稿正文为空时不再直接拒绝:
  // 存在唯一参考材料则自动导入(与 edit_document range edit 的
  // auto-import 行为对齐)后继续本次导出;多参考/无参考报错引导。
  // #787: 编排收敛到 doc-import.ensureDraftBody(文案单点维护)。
  let autoImportNote = ''
  if (!body.trim()) {
    const ensured = await ensureDraftBody(userId, docId, { scenario: 'export' })
    if (ensured.error) return { success: false, error: ensured.error }
    body = ensured.body
    if (ensured.note) autoImportNote = `${ensured.note}，`
  }

  // 内容源 = 草稿正文本身（markdown → 契约模型），不重付 LLM 重编 —
  // 导出内容与草稿天然一致（epic #764 的"内容正确"目标）。
  // #769: 草稿内嵌图片行（plot/导入托管图）→ image block 随导出携带。
  // #821 管线 B: mermaid 围栏/公式行先 ensureFigure → 托管图片行
  // (embedContentImages 统一 base64,经 image block 通道绕开 paragraph
  // 20000 字符截断;失败降级原文本,不阻塞导出)。
  // #939: 管线经 figurePipeline port 注入（modules/figures 提供），
  // tools 层不再动态 import modules/*；port 缺失 ⇒ 原文本降级。
  if (deps.figurePipeline) {
    body = await deps.figurePipeline.resolveBody(userId, body)
  }
  let content = spec.contentType === 'sidecar.generate_pptx'
    ? buildPresentationContent(body, String(existing.title || 'Presentation'))
    : buildDocumentContent(body, String(existing.title || 'Document'))
  content = await ('slides' in content
    ? Promise.all(content.slides.map(async (s) => ({ ...s, content: await embedContentImages(userId, s.content) }))).then((slides) => ({ ...content, slides }))
    : Promise.all(content.sections.map(async (sec) => ({ ...sec, paragraphs: await embedContentImages(userId, sec.paragraphs) }))).then((sections) => ({ ...content, sections }))) as typeof content
  const check = validateRenderContent(spec.contentType, content)
  if (!check.ok) return { success: false, error: `导出内容未通过契约校验：${check.errors.join('；')}` }

  return renderExportFile(deps, docId, spec, content as { title: string }, args, `${autoImportNote}已导出 ${spec.label}`)
}

/**
 * #772 — organize 分支：模型直供 slides 生成 PPT。
 * 两段协议：草稿不在模型上下文（空正文 + 有参考）时第一次调用不带
 * slides → 自动导入并返回正文摘要（digestBody），报错文案引导第二次
 * 调用直供 slides。直供 slides 不强依赖正文（凭空做 PPT，素材=对话
 * 上下文）。bullets 里的 ![caption](托管URL) 解析回 uploads 文件转
 * 内嵌 base64 图片块（worker 零改动）。
 */
async function organizedExport(deps: ExportExecutorDeps, docId: string, existing: any, body: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { userId } = deps
  const rawSlides = Array.isArray(args.slides) ? args.slides : []

  // 两段协议第一段。success:false → 工具循环把完整文本按 Error 注入
  // （不会被 DOC_WRITE_TOOLS 的摘要替换截断），模型可见完整摘要。
  if (rawSlides.length === 0) {
    // #773: deck 已存在 → 直接以 Doc.deck 为内容源导出（所见即所导，
    // 不再重新编排 — deck 视图手动编辑后的再导出路径）。
    if (existing.deck) {
      try {
        const deckContent = JSON.parse(String(existing.deck))
        // #960: deck v2 chart/figure block → image block（所见即所导，
        // worker 零改动）。chart 走确定性 #176 管线；figure 走 figures 管道。
        const embedded = await embedDeckSpecialBlocks(deps, deckContent)
        const deckCheck = validateRenderContent('sidecar.generate_pptx', embedded.content)
        if (deckCheck.ok) {
          const deckSlides = (embedded.content as { slides: Array<{ title: string; content: Array<{ type: string; text?: string }> }> }).slides || []
          const deckKnowledge = {
            title: String((deckContent as { title?: string }).title || 'Presentation'),
            content: deckSlides.map((s) => `## ${s.title}\n${(s.content || []).filter((c) => c.type === 'paragraph').map((c) => `- ${c.text || ''}`).join('\n')}`).join('\n\n'),
          }
          return renderExportFile(deps, docId, EXPORT_FORMATS.pptx, embedded.content as { title: string }, args, `已从 deck 导出 PPT（${deckSlides.length} 页）${embedded.notes}`, deckKnowledge)
        }
      } catch {
        // deck 损坏 → 落回 digest 流程重新编排。
      }
    }
    let workingBody = body
    let importedNote = ''
    // #787: 编排收敛到 doc-import.ensureDraftBody(文案单点维护)。
    if (!workingBody.trim()) {
      const ensured = await ensureDraftBody(userId, docId, { scenario: 'organize' })
      if (ensured.error) return { success: false, error: ensured.error }
      workingBody = ensured.body
      if (ensured.note) importedNote = `${ensured.note}。`
    }
    return {
      success: false,
      error: `${importedNote}organize=true 需要提供 slides 参数：[{title, bullets[], layout?, chart?}]（建议 8–15 页，契约上限 30；封面由 title/subtitle 自动生成，不要自加封面页。layout 按内容语义选：title/section/bullets/bullets+image/chart-full/quote，数据页配 chart spec {chart_type: line|bar|dose_curve, data:[{label,value}], errors?, sig?, title?, x_label?, y_label?}，数值必须来自正文/统计结果，禁止编造）。请基于以下正文摘要提炼编排后再次调用：\n${digestBody(workingBody)}`,
    }
  }

  // 直供 slides → 契约内容。bullets 转 bullet 段；图片 markdown 转
  // 内嵌 base64 图片块（草稿已有的托管图不丢失）。
  // #963 v2：可选 layout（按内容语义选母版）与 chart spec（数据密集页
  // → chart-full；AI 只产结构化 spec，渲染确定性 #176 管线）。
  let skippedImages = 0
  const slides = await Promise.all(rawSlides.slice(0, 30).map(async (s: any) => {
    const title = String(s?.title || '').trim().slice(0, 500) || '未命名页'
    const layoutCheck = slideLayoutSchema.safeParse(String(s?.layout || ''))
    const layout = layoutCheck.success && layoutCheck.data !== 'bullets' ? layoutCheck.data : undefined
    const bullets = Array.isArray(s?.bullets) ? s.bullets : []
    const content: Array<Record<string, unknown>> = []
    const chart = (s?.chart ?? null) as Record<string, unknown> | null
    if (chart) {
      const blockCheck = chartBlockSchema.safeParse({ type: 'chart', spec: chart })
      if (blockCheck.success) {
        content.push({ type: 'chart', spec: chart })
      }
    }
    for (const b of bullets.slice(0, 50)) {
      const text = String(b ?? '').trim()
      if (!text) continue
      const img = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(text)
      if (img) {
        const block = await resolveLocalImageBlock(userId, img[2], img[1])
        if (block) {
          content.push(block)
        } else {
          skippedImages++
        }
        continue
      }
      content.push({ type: 'paragraph', text: text.slice(0, 2000), style: 'bullet' })
    }
    if (content.length === 0) content.push({ type: 'paragraph', text: '（本页待补充）', style: 'normal' })
    return { title, ...(layout ? { layout } : {}), content }
  }))
  if (slides.length === 0) return { success: false, error: 'slides 解析后为空 — organize=true 需要至少 1 页 [{title, bullets[]}]。' }

  const deckTitle = (String(args.title || '').trim() || String(existing.title || '').trim() || 'Presentation').slice(0, 500)
  const subtitle = String(args.subtitle || '').trim().slice(0, 500)
  // #963: deck 级主题可选（clinical | warm-paper）。
  const themeCheck = deckThemeSchema.safeParse(String(args.theme || ''))
  const content = {
    schemaVersion: SCHEMA_VERSION,
    title: deckTitle,
    ...(subtitle ? { subtitle } : {}),
    ...(themeCheck.success ? { theme: themeCheck.data } : {}),
    slides,
  }
  const check = validateRenderContent('sidecar.generate_pptx', content)
  if (!check.ok) {
    return { success: false, error: `slides 未通过契约校验：${check.errors.join('；')} — 请修正参数后重新调用（不会产生半截文件）。` }
  }

  const summaryBase = `已编排生成 PPT（${slides.length} 页${skippedImages > 0 ? `，${skippedImages} 张图片未能嵌入` : ''}）`
  const knowledge = {
    title: deckTitle,
    content: slides.map((s: any) => `## ${s.title}\n${(s.content as any[]).filter((c) => c.type === 'paragraph').map((c) => `- ${(c as any).text}`).join('\n')}`).join('\n\n'),
  }
  // #773: 编排产物落 Doc.deck（画布 deck 视图可编辑、再导出所见即所导）。
  return renderExportFile(deps, docId, EXPORT_FORMATS.pptx, content, args, summaryBase, knowledge, JSON.stringify(content))
}

/** 渲染 → 落盘 → 下载卡片写回（#767/#772 共用管道）。#773: deckJson 传入时同帧落 Doc.deck。 */
async function renderExportFile(deps: ExportExecutorDeps, docId: string, spec: typeof EXPORT_FORMATS[string], content: { title: string }, args: Record<string, unknown>, summaryBase: string, knowledge?: { title: string; content: string }, deckJson?: string): Promise<ToolResult> {
  const { userId, plane, writeBlock } = deps
  const payload = {
    template_id: spec.templateId,
    output_name: content.title.slice(0, 40).replace(/\s+/g, '_'),
    schema_version: SCHEMA_VERSION,
    content_type: spec.contentType,
    data: content,
  }
  const outcome = await runRenderJob({
    plane,
    userId,
    jobType: spec.contentType,
    payload,
    ext: spec.ext,
    prefix: 'export',
    docId,
    displayBase: content.title.slice(0, 40).replace(/[\\/:*?"<>|\s]+/g, '_'),
  })
  if (!outcome.ok) {
    if (outcome.kind === 'timeout') return { success: false, error: `导出超时（任务 ${outcome.jobId}），可稍后通过任务 ID 查询。` }
    if (outcome.kind === 'failed') return { success: false, error: `导出失败：${outcome.reason}` }
    if (outcome.kind === 'no_file') return { success: false, error: '导出任务完成但没有返回文件。' }
    return { success: false, error: '无法获取导出文件（fetchFile 为空）。' }
  }
  const { localFileId, fileName, url } = outcome.file

  // 下载卡片行写回草稿（快照 + doc_updated）— 渲染失败不会产生半截卡片。
  // #773: organize 时同帧写 deck，快照 label 'AI deck'（可追溯）。
  const card = `[下载 ${spec.label} 版（${fileName}）](${url})`
  const result = await writeBlock(
    docId, card, args, `${summaryBase}（${fileName}）`,
    deckJson !== undefined ? { deckJson, snapshotLabel: 'AI deck' } : {},
  )
  if (result.success && result.output) {
    const parsed = JSON.parse(result.output)
    parsed.file = { fileId: localFileId, fileName, mimeType: spec.mime, url }
    // #776: knowledge 平价迁移 — organize 产物正文可能为空，
    // 用 deck 大纲作为知识索引内容。
    if (knowledge) parsed.knowledge = knowledge
    result.output = JSON.stringify(parsed)
  }
  return result
}

/**
 * #960 — deck v2 特殊块（chart/figure）→ image block（导出边界）。
 * chart spec 走确定性 chart-renderer（#176 哲学：渲染零生成式模型）；
 * figure 源码走 figures #820 管道（三级缓存 + 溯源）。转换失败保留原块
 * （契约合法，worker 侧按 [图表] 文本摘要降级渲染），不阻塞导出。
 */
async function embedDeckSpecialBlocks(deps: ExportExecutorDeps, deckContent: any): Promise<{ content: unknown; notes: string }> {
  const { userId } = deps
  let converted = 0
  const slides = Array.isArray(deckContent?.slides) ? deckContent.slides : []
  for (const s of slides) {
    if (!Array.isArray(s.content)) continue
    const out: any[] = []
    for (const block of s.content) {
      if (block?.type === 'chart' && block.spec) {
        const data = await chartSpecPng({ ...block.spec, type: block.spec.chart_type } as never)
        if (data) {
          out.push({ type: 'image', ref: 'deck-chart', caption: block.caption, data })
          converted++
          continue
        }
        out.push(block)
        continue
      }
      if (block?.type === 'figure' && block.source) {
        const fig = deps.figurePipeline
          ? await deps.figurePipeline.ensureFigure(userId, String(block.source), block.kind === 'latex_math' ? 'latex_math' : 'mermaid', block.caption)
          : null
        if (fig) {
          out.push({ type: 'image', ref: fig.ref, caption: fig.caption, data: fig.data })
          converted++
          continue
        }
        out.push(block)
        continue
      }
      out.push(block)
    }
    s.content = out
  }
  return { content: deckContent, notes: converted > 0 ? `（含 ${converted} 个图表/图形）` : '' }
}
