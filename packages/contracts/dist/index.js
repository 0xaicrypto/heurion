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
import { z } from 'zod';
export * from './chat.js';
export * from './jobs.js';
export * from './stats.js';
export * from './knowledge.js';
export const SCHEMA_VERSION = 1;
/* ── shared blocks ─────────────────────────────────────────────── */
export const imageBlockSchema = z.object({
    type: z.literal('image'),
    /** "asset://name" (resolved from a configured asset dir) or an inline data/base64 string. */
    ref: z.string().min(1),
    caption: z.string().max(500).optional(),
    /** Inline base64 data (alternative to ref). */
    data: z.string().optional(),
});
export const paragraphBlockSchema = z.object({
    type: z.literal('paragraph'),
    text: z.string().min(1).max(20000),
    style: z.enum(['normal', 'bullet', 'heading']).optional(),
});
export const contentBlockSchema = z.union([paragraphBlockSchema, imageBlockSchema]);
/* ── presentation ──────────────────────────────────────────────── */
export const presentationSlideSchema = z.object({
    title: z.string().min(1).max(500),
    content: z.array(contentBlockSchema).min(1).max(50),
});
export const presentationContentSchema = z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    title: z.string().min(1).max(500),
    subtitle: z.string().max(500).optional(),
    presenter: z.string().max(300).optional(),
    date: z.string().max(100).optional(),
    slides: z.array(presentationSlideSchema).min(1).max(30),
});
/* ── document (docx) ───────────────────────────────────────────── */
export const documentSectionSchema = z.object({
    heading: z.string().min(1).max(500),
    paragraphs: z.array(contentBlockSchema).min(1).max(100),
});
export const documentContentSchema = z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    title: z.string().min(1).max(500),
    sections: z.array(documentSectionSchema).min(1).max(30),
});
/* ── table (pdf) ───────────────────────────────────────────────── */
export const tableContentSchema = z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    title: z.string().min(1).max(500),
    headers: z.array(z.string().min(1).max(200)).min(1).max(30),
    rows: z.array(z.array(z.string().max(2000)).min(1).max(30)).min(1).max(200),
});
/* ── plot ──────────────────────────────────────────────────────── */
export const plotContentSchema = z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    type: z.enum(['bar', 'line', 'pie']),
    title: z.string().min(1).max(500),
    x_label: z.string().max(200).optional(),
    y_label: z.string().max(200).optional(),
    series: z
        .array(z.object({
        label: z.string().min(1).max(200),
        x: z.array(z.number()).min(1).max(500),
        y: z.array(z.number()).min(1).max(500),
    }))
        .min(1)
        .max(20),
});
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
]);
const CONTENT_SCHEMAS = {
    'sidecar.generate_pptx': presentationContentSchema,
    'sidecar.generate_docx': documentContentSchema,
    'sidecar.render_table': tableContentSchema,
    'sidecar.render_plot': plotContentSchema,
    'sidecar.convert_to_pdf': documentContentSchema,
    // #771: preview payload = { data_base64, file_name?, max_pages? } —
    // 字节直传，不经 render-content 契约校验。
    'sidecar.preview_file': z.any(),
};
/**
 * Validate an AI-produced content payload for a job type. Returns
 * { ok: true, data } or { ok: false, errors } — the caller must retry the
 * LLM or fall back before the generator ever sees invalid input.
 */
export function validateRenderContent(type, raw) {
    const schema = CONTENT_SCHEMAS[type];
    if (!schema)
        return { ok: false, errors: [`unknown render type: ${type}`] };
    const result = schema.safeParse(raw);
    if (!result.success) {
        return { ok: false, errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 8) };
    }
    return { ok: true, data: result.data };
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
});
export const biosceneConnectionSchema = z.object({
    from: z.number().min(0), // object index
    to: z.number().min(0),
    kind: z.enum(['arrow', 'dashed', 'phosphorylation', 'inhibition']).optional(),
    bend: z.number().min(-50).max(50).optional(),
    label: z.string().max(80).optional(),
});
export const biosceneAnnotationSchema = z.object({
    type: z.enum(['text', 'bracket']),
    x: z.number().min(0).max(1000),
    y: z.number().min(0).max(1000),
    text: z.string().max(200),
});
export const biosceneContentSchema = z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    canvas: z.object({ width: z.number().min(100).max(2000).default(800), height: z.number().min(100).max(2000).default(600) }).optional(),
    objects: z.array(biosceneObjectSchema).min(1).max(30),
    connections: z.array(biosceneConnectionSchema).max(60).optional(),
    annotations: z.array(biosceneAnnotationSchema).max(20).optional(),
});
