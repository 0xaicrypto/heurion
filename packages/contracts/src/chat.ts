/**
 * Chat wire contracts — SSE event stream + message shapes shared by
 * server-ts (producer), web (consumer) and any future client.
 *
 * Single source of truth (#438). Field names are snake_case and mirror
 * the wire format EXACTLY — do not rename unless the producer changes.
 *
 * Events listed here are the ones the backend actually emits
 * (chat-handler.ts / deep-analysis.router.ts / plugin-chat-handler.ts).
 */

/** Context-budget snapshot sent at the start of a turn (U3). */
export interface ContextUsage {
  history_tokens: number
  history_budget: number
  history_turns: number
  omitted_turns: number
  will_compact: boolean
}

/** A memory-search hit attached to an answer (#418). */
export interface MemoryHit {
  content: string
  type: string
  id: string
}

/** Citation attached to an answer. */
export interface Citation {
  text: string
  source?: string
}

/** Tool invocation record surfaced to the UI (badge/折叠展示). */
export interface ToolCallRecord {
  tool: string
  args: Record<string, unknown>
}

/** Plugin file ready for download (sidecar/plugin path). */
export interface SidecarFileInfo {
  file_id: string
  file_name: string
  mime_type: string
  download_url: string
  expires_in: number
  knowledge_payload?: { title: string; content: string }
}

/** One chunk of the chat SSE stream. */
export type ChatStreamChunk =
  | { type: 'turn_started'; event_idx: number; patient_hash: string | null }
  | ({ type: 'context_usage' } & ContextUsage)
  | { type: 'compaction_started' }
  | { type: 'compaction_chunk'; text: string }
  | { type: 'compaction_completed'; history_tokens?: number; history_budget?: number; history_turns?: number }
  | { type: 'doc_updated'; body: string; summary?: string }
  | { type: 'chart_created'; url: string; markdown?: string; chart_type?: string }
  | { type: 'tier_classified'; tier: 'T1' | 'T2' | 'T3'; view_kind?: string; anchor?: string }
  | { type: 'context_info'; text: string; kind?: string }
  | { type: 'reasoning_chunk'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'subagent_started'; task: string; scope?: string }
  | { type: 'subagent_done'; task: string; success: boolean; cost_tokens?: number }
  | { type: 'memory_hits'; count: number; hits: MemoryHit[] }
  | { type: 'image_attached'; url?: string; study_id?: string; caption?: string }
  | ({ type: 'sidecar_file' } & SidecarFileInfo)
  | { type: 'final_answer_chunk'; text: string }
  | { type: 'citations'; items: Citation[] }
  | { type: 'skill_capture_suggest'; text: string }
  | { type: 'truncated'; message: string }
  | { type: 'turn_complete'; assistant_event_idx?: number }
  | { type: 'error'; message: string }
  // ── plugin pipeline events (plugin-chat-handler.ts) ──
  | { type: 'plugin_selected'; plugin_id: string; tool: string; intent: string; confidence: number }
  | { type: 'payload_building'; plugin_id: string; tool: string }
  | { type: 'job_enqueued'; plugin_id: string; tool: string; job_type: string }
  | { type: 'job_status'; job_id: string; status: string }
  | { type: 'file_ready'; file_id: string; file_name: string; mime_type: string }

/** Historical chat message as persisted & returned by the backend. */
export interface ChatWireMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  sync_id?: string
  attachments?: unknown[]
  message_kind?: string
  metadata?: Record<string, unknown>
}

/**
 * Tool names that are pure retrieval (no side effects) — the UI collapses
 * consecutive retrieval calls into a single expandable row.
 */
export const RETRIEVAL_TOOLS = ['search_node', 'search_encounter', 'search_past_chats'] as const
export type RetrievalTool = (typeof RETRIEVAL_TOOLS)[number]

/** Every SSE event type the backend can emit. */
export const CHAT_EVENT_TYPES = [
  'turn_started',
  'context_usage',
  'compaction_started',
  'compaction_chunk',
  'compaction_completed',
  'doc_updated',
  'chart_created',
  'tier_classified',
  'context_info',
  'reasoning_chunk',
  'thought',
  'tool_call',
  'subagent_started',
  'subagent_done',
  'memory_hits',
  'image_attached',
  'sidecar_file',
  'final_answer_chunk',
  'citations',
  'skill_capture_suggest',
  'truncated',
  'turn_complete',
  'error',
  'plugin_selected',
  'payload_building',
  'job_enqueued',
  'job_status',
  'file_ready',
] as const
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number]
