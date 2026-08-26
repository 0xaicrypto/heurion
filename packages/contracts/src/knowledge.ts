/**
 * #744/#750 — Knowledge-base shared enums (single source of truth).
 *
 * The web client previously hand-maintained SOURCE_TYPES and drifted from the
 * server enum ("sidecar" existed server-side only): sidecar facts were
 * invisible in the Facts tab and editing one rewrote its sourceType to
 * "general". Import both sides from here — never re-declare locally.
 */

/** Fact source provenance, mirrored by `Fact.sourceType` / proposals. */
export const KB_SOURCE_TYPES = ['patient', 'doctor', 'research', 'general', 'sidecar'] as const
export type KbSourceType = (typeof KB_SOURCE_TYPES)[number]

/** Uploads extractable for fact/vector indexing must stay in sync with file-pipeline.service.ts. */
export const KB_EXTRACTABLE_MIME_PREFIX = 'text/'
export const KB_EXTRACTABLE_EXTENSIONS = ['.txt', '.md', '.csv', '.docx', '.pdf'] as const

/** File pipeline stages (#747) — server owns transitions; web renders them. */
export const FILE_PIPELINE_STAGES = ['queued', 'extracted', 'embedded', 'proposed', 'ingested', 'failed', 'skipped'] as const
export type FilePipelineStage = (typeof FILE_PIPELINE_STAGES)[number]
