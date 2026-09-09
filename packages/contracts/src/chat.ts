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
import { z } from 'zod'

/** Context-budget snapshot sent at the start of a turn (U3). */
export interface ContextUsage {
  history_tokens: number
  history_budget: number
  history_turns: number
  omitted_turns: number
  will_compact: boolean
  /** #630: system 侧统计（组装完成后补充发送，仅 producer 侧）。 */
  system_tokens?: number
  system_budget?: number
  /** #635: 段级回退事件。 */
  dropped_segments?: string[]
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
  /** #756: provenance flavor — 📄 文件 / 🧠 事实 / 📖 文章 / 📌 钉选。 */
  kind?: 'fact' | 'knowledge' | 'document' | 'pinned'
}

/**
 * #773: deck 资产的线上形状（presentationContentSchema 的结构化子集 —
 * 与 Doc.deck 存储同构）。deck 与 body 同源同帧（doc_updated 一次到达），
 * 避免双事件乱序。#790: zod schema 同步落地 — 此前只写 interface，产出端
 * JSON.parse 后原样塞进 doc_updated.deck 无任何形状检查，pptx-extractor
 * 已实际漂移过一次（schemaVersion）。
 */
export interface DeckWire {
  title: string
  subtitle?: string
  slides: Array<{
    title: string
    content: Array<{ type: string; text?: string; style?: string; url?: string; caption?: string; data?: string; ref?: string }>
  }>
}

const deckSlideContentSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  style: z.string().optional(),
  url: z.string().optional(),
  caption: z.string().optional(),
  data: z.string().optional(),
  ref: z.string().optional(),
})

export const deckWireSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  slides: z.array(z.object({
    title: z.string(),
    content: z.array(deckSlideContentSchema),
  })),
})

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

/**
 * #797 — One chunk of the polish SSE stream (POST /api/v1/docs/:docId/polish).
 * Server emission shapes (documents.router + document-writing.service):
 * `{text}`, `{type:'reasoning',text}`, `{done:true}`, `{type:'error',message}`.
 * The wire union below mirrors those exactly so web consumption can narrow
 * instead of casting `as any`.
 */
export type PolishStreamChunk =
  | { text: string; type?: undefined; done?: undefined; message?: undefined }
  | { type: 'reasoning'; text?: string; done?: undefined; message?: undefined }
  | { done: true; type?: undefined; text?: undefined; message?: undefined }
  | { type: 'error'; message?: string; text?: undefined; done?: undefined }

/**
 * #831: 子代理可见性事件流。id 由发起方生成（uuid）— 批量扇出时同 id
 * 聚合、跨子代理不串组。progress 在 thinking/tool/summarizing 阶段各发。
 */
export interface SubagentStartedEvent {
  type: 'subagent_started'
  id: string
  task: string
  scope?: string
}
export interface SubagentProgressEvent {
  type: 'subagent_progress'
  id: string
  task: string
  phase: 'thinking' | 'tool' | 'summarizing'
  current_tool?: string
  tool_args_preview?: string
  turn?: number
  max_turns?: number
  elapsed_ms?: number
}
export interface SubagentDoneEvent {
  type: 'subagent_done'
  id: string
  task: string
  success: boolean
  scope?: string
  cost_tokens?: number
  turns?: number
  tool_calls?: number
  /** ≤200 字摘要预览 — 完成即可读，无需等待主回答。 */
  summary_preview?: string
}
export type SubagentEvent = SubagentStartedEvent | SubagentProgressEvent | SubagentDoneEvent

/** One chunk of the chat SSE stream. */
export type ChatStreamChunk =
  | { type: 'turn_started'; event_idx: number; patient_hash: string | null }
  | ({ type: 'context_usage' } & ContextUsage)
  | { type: 'compaction_started' }
  | { type: 'compaction_chunk'; text: string }
  | { type: 'compaction_completed'; history_tokens?: number; history_budget?: number; history_turns?: number }
  | { type: 'compaction_summary'; text: string }
  /**
   * #927: rev = 服务端写回版本号（进程内单调递增），updatedAt = 写回时间
   * （ISO）— 前端消费方按 rev 幂等防乱序（rev ≤ 已应用值的写回直接忽略）。
   * 旧后端事件无此字段，消费方按无 rev 保持原行为。
   */
  | { type: 'doc_updated'; body: string; summary?: string; deck?: DeckWire | null; rev?: number; updatedAt?: string }
  | { type: 'chart_created'; url: string; markdown?: string; chart_type?: string }
  | { type: 'tier_classified'; tier: 'T1' | 'T2' | 'T3'; view_kind?: string; anchor?: string }
  | { type: 'context_info'; text: string; kind?: string }
  | { type: 'reasoning_chunk'; text: string }
  | { type: 'thought'; text: string }
  /**
   * #829: seq = per-session tool 序号 — 前端按 seq 精确闭合芯片（并行执行
   * 时多个工具同时 running，"下一个调用关闭上一个"不再成立）。
   * #832: round = 模型工具循环轮次（1-based，MAX_TOOL_ROUNDS 状态机同源）
   * — 前端时间线按轮分组。
   */
  | { type: 'tool_call'; tool: string; args: Record<string, unknown>; seq?: number; round?: number }
  /**
   * #829: 工具结果事件 — 每个工具执行完成（成功/失败）即发，前端据此
   * 关闭对应芯片并展示结果摘要。preview ≤80 字（命中数/页面标题/错误首行）。
   */
  | { type: 'tool_result'; seq?: number; tool?: string; success: boolean; elapsed_ms?: number; preview?: string; round?: number }
  | SubagentStartedEvent
  | SubagentProgressEvent
  | SubagentDoneEvent
  | { type: 'memory_hits'; count: number; hits: MemoryHit[] }
  | { type: 'image_attached'; url?: string; study_id?: string; caption?: string }
  | ({ type: 'sidecar_file' } & SidecarFileInfo)
  | { type: 'final_answer_chunk'; text: string }
  | { type: 'citations'; items: Citation[] }
  | { type: 'skill_capture_suggest'; text: string }
  | { type: 'truncated'; message: string }
  // #561/#581 — 意图不确定时反问确认：text 为提示文案，options 为可选项（前端渲染选择气泡）。
  | { type: 'intent_clarify'; text: string; options?: string[] }
  // #582 — 通用会话编辑附件（action=edit, target=attachment）的落地出口。
  | { type: 'attachment_export_option'; options: Array<'save_as_document' | 'export_pdf' | 'continue_discussion'> }
  // #839 — 记忆引用输出侧对账:输出引用未命中本轮注入集合时上报(前端可标记"含未溯源引用")。
  | { type: 'citation_audit'; total: number; verified: number; unverified: string[]; message: string }
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
  'compaction_summary',
  'doc_updated',
  'chart_created',
  'tier_classified',
  'context_info',
  'reasoning_chunk',
  'thought',
  'tool_call',
  'tool_result',
  'subagent_started',
  'subagent_progress',
  'subagent_done',
  'memory_hits',
  'image_attached',
  'sidecar_file',
  'final_answer_chunk',
  'citations',
  'skill_capture_suggest',
  'truncated',
  'intent_clarify',
  'attachment_export_option',
  'citation_audit',
  'turn_complete',
  'error',
  'plugin_selected',
  'payload_building',
  'job_enqueued',
  'job_status',
  'file_ready',
] as const
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number]

// ── Auth (migrated from @heurion/sdk — #668: sdk-client removed) ──
export interface UserProfile {
  user_id: string
  display_name: string
  created_at: string
  updated_at?: string
  role?: string
  email?: string
  /** #348: mirrors GET /user/profile — 1 when the email was verified. */
  email_verified?: boolean
  phone?: string
  organization?: string
  intended_use?: string
  status?: string
  tier?: string
}
