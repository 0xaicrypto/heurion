/**
 * #637 阶段 5 — ChatEvent 判别联合。
 *
 * SSE 事件 payload 此前手写对齐前端(type 为自由字符串)。收敛为判别
 * 联合后,send 侧编译期保证事件形状正确;前端按 type 分支消费的行为
 * 不变(载荷结构保持兼容)。
 */

export type ContextInfoKind =
  | 'attachment' | 'patient_context' | 'patient_roster' | 'file_context'
  | 'projection' | 'router' | 'plugin'

export type ChatEvent =
  | { type: 'turn_started'; event_idx: number; patient_hash?: string | null }
  | { type: 'context_info'; text: string; kind: string }
  | { type: 'reasoning_chunk'; text: string }
  | { type: 'final_answer_chunk'; text: string }
  | { type: 'citations'; items: unknown[] }
  | { type: 'turn_complete'; assistant_event_idx?: number }
  | { type: 'error'; message: string }
  | {
      type: 'sidecar_file'
      file_id: string
      file_name: string
      mime_type: string
      download_url: string
      expires_in: number
      knowledge_payload: unknown
    }
  | {
      type: 'context_usage'
      history_tokens: number
      history_budget: number
      history_turns: number
      omitted_turns: number
      will_compact: boolean
      /** #630: system 侧统计(组装完成后补充发送)。 */
      system_tokens?: number
      system_budget?: number
      /** #635: 段级回退事件。 */
      dropped_segments?: string[]
    }
  | { type: 'truncated'; message: string }
  | { type: 'attachment_export_option'; options: string[] }
  | { type: 'skill_capture_suggest'; text: string }
  | { type: 'compaction_started' }
  | { type: 'compaction_completed'; history_tokens?: number; history_budget?: number; history_turns?: number }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'memory_hits'; count: number; hits: Array<{ content: string; type: string; id: string }> }
  | { type: 'subagent_started'; task: string; scope?: string }
  | { type: 'subagent_done'; task: string; success: boolean; cost_tokens?: number }
  | { type: 'image_attached'; url: string; caption?: string }
  | { type: 'doc_updated'; body: string; summary: string }
  | { type: 'chart_created'; url: string; markdown: string; chart_type: string }

export type SendEvent = (event: ChatEvent) => void
