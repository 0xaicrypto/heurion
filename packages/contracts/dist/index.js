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
export const renderJobType = z.enum([
    'sidecar.generate_pptx',
    'sidecar.generate_docx',
    'sidecar.render_table',
    'sidecar.render_plot',
]);
const CONTENT_SCHEMAS = {
    'sidecar.generate_pptx': presentationContentSchema,
    'sidecar.generate_docx': documentContentSchema,
    'sidecar.render_table': tableContentSchema,
    'sidecar.render_plot': plotContentSchema,
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
