/**
 * Render-content contracts — the single source of truth between the AI side
 * (server-ts: LLM → validated JSON) and the render side (worker: JSON →
 * .pptx/.docx/plot/table).
 *
 * Design (review 2026-08-09):
 * - AI produces content & structure ONLY (sections, titles, paragraphs,
 *   tables, image refs, styles) — never file formats.
 * - The generator is a pure executor: same input → same file.
 * - Input is a versioned, validate-able JSON content model:
 *   { schemaVersion: 1, ... }
 * - Binary (images/logos) travels as refs: { type: "image", ref: "asset://logo.png" }
 *   or inline base64 — the generator resolves and embeds.
 */
import { z } from 'zod'

export * from './chat.js'
export * from './jobs.js'
export * from './stats.js'
export * from './knowledge.js'

export const SCHEMA_VERSION = 1

/* ── shared blocks ─────────────────────────────────────────────── */

export const imageBlockSchema = z.object({
  type: z.literal('image'),
  /** "asset://name" (resolved from a configured asset dir) or an inline data/base64 string. */
  ref: z.string().min(1),
  caption: z.string().max(500).optional(),
  /** Inline base64 data (alternative to ref). */
  data: z.string().optional(),
})

export type ImageBlock = z.infer<typeof imageBlockSchema>

export const paragraphBlockSchema = z.object({
  type: z.literal('paragraph'),
  text: z.string().min(1).max(20000),
  style: z.enum(['normal', 'bullet', 'heading']).optional(),
})

export type ParagraphBlock = z.infer<typeof paragraphBlockSchema>

export const contentBlockSchema = z.union([paragraphBlockSchema, imageBlockSchema])

export type ContentBlock = z.infer<typeof contentBlockSchema>

/* ── presentation ──────────────────────────────────────────────── */

export const presentationSlideSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.array(contentBlockSchema).min(1).max(50),
})

export type PresentationSlide = z.infer<typeof presentationSlideSchema>

export const presentationContentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  title: z.string().min(1).max(500),
  subtitle: z.string().max(500).optional(),
  presenter: z.string().max(300).optional(),
  date: z.string().max(100).optional(),
  slides: z.array(presentationSlideSchema).min(1).max(30),
})

export type PresentationContent = z.infer<typeof presentationContentSchema>

/* ── document (docx) ───────────────────────────────────────────── */

export const documentSectionSchema = z.object({
  heading: z.string().min(1).max(500),
  paragraphs: z.array(contentBlockSchema).min(1).max(100),
})

export type DocumentSection = z.infer<typeof documentSectionSchema>

export const documentContentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  title: z.string().min(1).max(500),
  sections: z.array(documentSectionSchema).min(1).max(30),
})

export type DocumentContent = z.infer<typeof documentContentSchema>

/* ── table (pdf) ───────────────────────────────────────────────── */

export const tableContentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  title: z.string().min(1).max(500),
  headers: z.array(z.string().min(1).max(200)).min(1).max(30),
  rows: z.array(z.array(z.string().max(2000)).min(1).max(30)).min(1).max(200),
})

export type TableContent = z.infer<typeof tableContentSchema>

/* ── plot ──────────────────────────────────────────────────────── */

export const plotContentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  type: z.enum(['bar', 'line', 'pie']),
  title: z.string().min(1).max(500),
  x_label: z.string().max(200).optional(),
  y_label: z.string().max(200).optional(),
  series: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        x: z.array(z.number()).min(1).max(500),
        y: z.array(z.number()).min(1).max(500),
      }),
    )
    .min(1)
    .max(20),
})

export type PlotContent = z.infer<typeof plotContentSchema>

/* ── dispatch ──────────────────────────────────────────────────── */

/**
 * #652: single job-type namespace. Values are what the control plane sends
 * (plugin-capability.service maps heurion/* tool names onto these) and what
 * the worker registers. Keep in sync with worker/src/server.ts HANDLERS.
 * #771: `sidecar.preview_file` — LibreOffice 渲染产物/上传 pptx 的翻页预览
 * 图（worker 端 soffice → pdf → pdftoppm PNG）；payload 不走 render-content
 * 校验（data_base64 直传文件字节）。
 */
export const renderJobType = z.enum([
  'sidecar.generate_pptx',
  'sidecar.generate_docx',
  'sidecar.render_table',
  'sidecar.render_plot',
  'sidecar.convert_to_pdf',
  'sidecar.preview_file',
  // #825: 学术内容本地渲染 — mermaid 围栏/LaTeX 公式 → SVG(headless
  // Chromium + 本地 mermaid ESM/MathJax bundle,零外呼)。
  'sidecar.render_figure',
])

export type RenderJobType = z.infer<typeof renderJobType>

/**
 * #790: preview payload 单一形状来源 — 此前四份定义（contracts 注释 /
 * worker PreviewInput 手写接口 / server-ts 产出端内联字面量 / web 消费端
 * 手写类型），worker 端运行时靠 ad-hoc if 校验。data_base64 为文件字节
 * 直传，不经 render-content 契约（其余 jobType 的内容 schema 走
 * presentationContentSchema 等）。
 */
export const previewPayloadSchema = z.object({
  data_base64: z.string().min(1),
  file_name: z.string().optional(),
  max_pages: z.number().int().positive().max(60).optional(),
})
export type PreviewPayload = z.infer<typeof previewPayloadSchema>

/**
 * #825: render_figure payload 单一形状来源(与 preview 同构 — 输入是
 * 用户/文档源码而非 LLM 产物,不走 render-content 契约)。
 * source ≤ 32KB(设计 §5 安全约束);产物 SVG 为准,导出侧按需光栅化。
 */
export const figurePayloadSchema = z.object({
  kind: z.enum(['mermaid', 'latex_math']),
  source: z.string().min(1).max(32 * 1024),
  display: z.boolean().optional(),
  theme: z.string().max(50).optional(),
  scale: z.number().min(0.5).max(4).optional(),
})
export type FigurePayload = z.infer<typeof figurePayloadSchema>

/**
 * #825: render_figure 结果形状 — 对齐 worker saveFile 产物(job-runner
 * 按 file_id 索引,控制面 fetchFile 取字节后自行落盘 fig_*.svg)。
 */
export const figureResultSchema = z.object({
  file_id: z.string().min(1),
  file_name: z.string().min(1),
  mime_type: z.string().min(1),
  width: z.number().int().positive().max(10000).optional(),
  height: z.number().int().positive().max(10000).optional(),
  warnings: z.array(z.string().max(500)).max(10).optional(),
})
export type FigureResult = z.infer<typeof figureResultSchema>

const CONTENT_SCHEMAS: Record<RenderJobType, z.ZodType> = {
  'sidecar.generate_pptx': presentationContentSchema,
  'sidecar.generate_docx': documentContentSchema,
  'sidecar.render_table': tableContentSchema,
  'sidecar.render_plot': plotContentSchema,
  'sidecar.convert_to_pdf': documentContentSchema,
  // #790: preview payload 也收进 schema 表（此前 z.any() 恒真 no-op）。
  'sidecar.preview_file': previewPayloadSchema,
  // #825: figure payload 收进同一穷举表(编译期防漏)。
  'sidecar.render_figure': figurePayloadSchema,
}

export type RenderContent =
  | PresentationContent
  | DocumentContent
  | TableContent
  | PlotContent

/**
 * Validate an AI-produced content payload for a job type. Returns
 * { ok: true, data } or { ok: false, errors } — the caller must retry the
 * LLM or fall back before the generator ever sees invalid input.
 */
export function validateRenderContent(type: string, raw: unknown): { ok: true; data: RenderContent } | { ok: false; errors: string[] } {
  const schema = CONTENT_SCHEMAS[type as RenderJobType]
  if (!schema) return { ok: false, errors: [`unknown render type: ${type}`] }
  const result = schema.safeParse(raw)
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 8) }
  }
  return { ok: true, data: result.data as RenderContent }
}


/* ── BioScene (#408): molecular/schematic scene model ───────────── */

export const biosceneObjectSchema = z.object({
  icon: z.string().min(1).max(100), // id from the restricted icon catalog
  // Coordinates: 0-100 (percent) OR 0-1000 (pixels) — the renderer adapts.
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  scale: z.number().min(0.2).max(3).optional(),
  rotate: z.number().min(-180).max(180).optional(),
  label: z.string().max(100).optional(),
  colorize: z.string().max(50).optional(), // css color override
})
export type BioSceneObject = z.infer<typeof biosceneObjectSchema>

export const biosceneConnectionSchema = z.object({
  from: z.number().min(0), // object index
  to: z.number().min(0),
  kind: z.enum(['arrow', 'dashed', 'phosphorylation', 'inhibition']).optional(),
  bend: z.number().min(-50).max(50).optional(),
  label: z.string().max(80).optional(),
})
export type BioSceneConnection = z.infer<typeof biosceneConnectionSchema>

export const biosceneAnnotationSchema = z.object({
  type: z.enum(['text', 'bracket']),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  text: z.string().max(200),
})
export type BioSceneAnnotation = z.infer<typeof biosceneAnnotationSchema>

export const biosceneContentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  canvas: z.object({ width: z.number().min(100).max(2000).default(800), height: z.number().min(100).max(2000).default(600) }).optional(),
  objects: z.array(biosceneObjectSchema).min(1).max(30),
  connections: z.array(biosceneConnectionSchema).max(60).optional(),
  annotations: z.array(biosceneAnnotationSchema).max(20).optional(),
})
export type BioSceneContent = z.infer<typeof biosceneContentSchema>
