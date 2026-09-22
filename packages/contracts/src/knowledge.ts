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

/**
 * 复审 #8: Facts tab 行形状 — server facts 路由的序列化输出（camelCase，
 * 时间戳为 epoch ms 数字）。此前 web 页面手写本地 interface，与服务端
 * 序列化无关联；收敛为单一契约类型，web 直接 import，禁止再手写。
 */
export interface KbFact {
  id: string
  category: string
  importance: number
  content: string
  count: number
  sourceType?: string
  patientHash?: string
  studyId?: string
  createdAt: number
  updatedAt: number
  lastSeenAt: number
}
