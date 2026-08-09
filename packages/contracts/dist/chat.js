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
/**
 * Tool names that are pure retrieval (no side effects) — the UI collapses
 * consecutive retrieval calls into a single expandable row.
 */
export const RETRIEVAL_TOOLS = ['search_node', 'search_encounter', 'search_past_chats'];
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
    'turn_complete',
    'error',
    'plugin_selected',
    'payload_building',
    'job_enqueued',
    'job_status',
    'file_ready',
];
