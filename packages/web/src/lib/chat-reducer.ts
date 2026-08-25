/**
 * #685 — pure chat SSE chunk → session state reducer.
 *
 * Extracted from stores/chat.ts so the chunk-reduction logic is unit-
 * testable without a zustand store. `applyChunkToSession` is a pure
 * function: one chunk (or a batch reduced left-to-right) in, one new
 * SessionState out.
 */
import type { ChatStreamChunk, ChatContextUsage, SendChatOptions } from './types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  isStreaming?: boolean;
  tier?: string;
  citations?: Array<{ text: string; source?: string }>;
  /** #418: memory-search hits backing this answer. */
  memoryHits?: Array<{ content: string; type: string; id: string }>;
  /** #419: generated image to render in the stream. */
  imageUrl?: string;
  download?: {
    fileId: string;
    fileName: string;
    mimeType: string;
    url: string;
    expiresIn: number;
  };
  knowledgePayload?: {
    title: string;
    content: string;
  };
  addedToKnowledge?: boolean;
  _compactionStream?: boolean;
  /** #612: 上下文压缩摘要消息(可折叠展示)。 */
  compactionSummary?: boolean;
  /** #662: 4-state tool entries — running until a newer call / the answer
   *  or an error supersedes it (the wire has no tool.done event). */
  toolCalls?: Array<{ tool: string; argsPreview: string; status: 'running' | 'done' | 'error' }>;
  chart?: { url: string; chartType?: string };
  /** #455: plugin invocation trail (plugin_selected / payload_building / job_enqueued). */
  pluginCalls?: Array<{ pluginId: string; tool: string; intent: string; confidence: number }>;
  /** Epoch ms — powers timestamps + grouping (§10.3 #220). */
  createdAt?: number;
  /** Set when the turn failed — renders a retry affordance. */
  failed?: boolean;
  /** #548: answer was cut off by the output token budget. */
  truncated?: boolean;
  /** #582: 通用会话编辑附件的结果落地出口（保存为文档/导出PDF/继续讨论）。 */
  exportOptions?: Array<'save_as_document' | 'export_pdf' | 'continue_discussion'>;
  /** #582: 导出动作的进行/完成状态。 */
  exportState?: 'saving' | 'saved';
}

export interface SessionState {
  messages: ChatMessage[];
  abort: AbortController | null;
  loading: boolean;
  compacting: boolean;
  /** #fix: 回复进行中用户追加的消息 — 当前 turn 完成后自动发送(排队,
   *  不打断正在执行的工具/写回,避免文档状态不一致)。 */
  pending?: { text: string; opts: SendChatOptions } | null;
  lastDocBody?: string;
  /** #459: shared UI shape (ChatContextUsage in lib/types). */
  contextUsage?: ChatContextUsage;
  /** #298: skill-capture suggestion shown after a procedural reply. */
  skillCapture?: { text: string };
  /** #350: sub-agent activity indicator (delegate/spawn_subagent). */
  subagents?: Array<{ task: string; status: 'running' | 'done' | 'failed' }>;
  /** #663: message ids touched by live SSE chunks — history snapshots must
   *  never clobber the in-flight versions (touch-tracker merge). */
  msgTouched?: Record<string, number>;
  /** #fix: 前置阶段进度提示(context_info) — 等待期实时反馈。 */
  streamNote?: string;
}

export function emptySession(): SessionState {
  return { messages: [], abort: null, loading: false, compacting: false };
}

function applyChunk(msg: ChatMessage, chunk: ChatStreamChunk): ChatMessage {
  switch (chunk.type) {
    case 'tier_classified':
      return { ...msg, tier: chunk.tier };
    case 'reasoning_chunk':
    case 'thought':
      return { ...msg, reasoning: (msg.reasoning || '') + chunk.text };
    case 'final_answer_chunk':
      return {
        ...msg,
        text: msg.text + chunk.text,
        // #662: the answer starting means every tool finished.
        toolCalls: msg.toolCalls?.map((tc) => (tc.status === 'running' ? { ...tc, status: 'done' as const } : tc)),
      };
    case 'citations':
      return { ...msg, citations: chunk.items };
    case 'sidecar_file':
      return {
        ...msg,
        download: {
          fileId: chunk.file_id,
          fileName: chunk.file_name,
          mimeType: chunk.mime_type,
          url: chunk.download_url,
          expiresIn: chunk.expires_in,
        },
        knowledgePayload: chunk.knowledge_payload,
      };
    case 'turn_complete':
      return { ...msg, isStreaming: false };
    case 'truncated':
      return { ...msg, truncated: true, isStreaming: false };
    case 'error':
      return {
        ...msg,
        text: msg.text || `Error: ${chunk.message}`,
        isStreaming: false,
        toolCalls: msg.toolCalls?.map((tc) => (tc.status === 'running' ? { ...tc, status: 'error' as const } : tc)),
      };
    // #455: plugin pipeline visibility — collect the trail on the message.
    case 'plugin_selected':
      return {
        ...msg,
        pluginCalls: [
          ...(msg.pluginCalls || []),
          { pluginId: chunk.plugin_id, tool: chunk.tool, intent: chunk.intent, confidence: chunk.confidence },
        ],
      };
    // #582: 附件编辑结果落地出口。
    case 'attachment_export_option':
      return { ...msg, exportOptions: chunk.options };
    default:
      return msg;
  }
}

/** #660: pure per-chunk session reducer — one batch = one set(). */
function withTouch(s: SessionState): SessionState {
  const last = s.messages[s.messages.length - 1];
  if (!last) return s;
  return {
    ...s,
    msgTouched: { ...(s.msgTouched ?? {}), [last.id]: Date.now() },
  };
}

function applyChunkToSessionInner(s: SessionState, chunk: ChatStreamChunk): SessionState {
  switch (chunk.type) {
    case 'context_usage':
      return {
        ...s,
        contextUsage: {
          historyTokens: chunk.history_tokens,
          historyBudget: chunk.history_budget,
          historyTurns: chunk.history_turns,
          omittedTurns: chunk.omitted_turns,
          willCompact: chunk.will_compact,
        },
      };
    case 'context_info': {
      // #fix: 前置阶段进度提示(路由/上下文组装) — 等待期实时反馈。
      // 只透传用户可读的 kind(projection/patient_roster 等内部日志忽略)。
      const kind = (chunk as { kind?: string }).kind;
      if (kind !== 'router' && kind !== 'attachment' && kind !== 'file_context' && kind !== 'plugin') return s;
      return { ...s, streamNote: chunk.text };
    }
    case 'turn_complete': {
      // #fix: 清 streamNote 的同时必须保留消息级 isStreaming 清理
      // (applyChunk 的 turn_complete 分支被本 case 截获,不会执行)。
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, isStreaming: false };
      }
      return { ...s, messages: msgs, streamNote: undefined };
    }
    case 'chart_created': {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, chart: { url: chunk.url, chartType: chunk.chart_type } };
      }
      return { ...s, messages: msgs };
    }
    case 'doc_updated':
      return { ...s, lastDocBody: chunk.body };
    case 'skill_capture_suggest':
      return { ...s, skillCapture: { text: chunk.text } };
    case 'tool_call': {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        let argsPreview = '';
        try { argsPreview = JSON.stringify(chunk.args ?? {}).slice(0, 120); } catch { /* ignore */ }
        const prev = (last.toolCalls ?? []).map((tc) => (tc.status === 'running' ? { ...tc, status: 'done' as const } : tc));
        msgs[msgs.length - 1] = {
          ...last,
          toolCalls: [...prev, { tool: chunk.tool, argsPreview, status: 'running' as const }],
        };
      }
      return { ...s, messages: msgs };
    }
    case 'image_attached': {
      if (!chunk.url) return s;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, imageUrl: chunk.url };
      }
      return { ...s, messages: msgs };
    }
    case 'memory_hits': {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, memoryHits: chunk.hits };
      }
      return { ...s, messages: msgs };
    }
    case 'subagent_started':
    case 'subagent_done': {
      const entry = {
        task: chunk.task,
        status: chunk.type === 'subagent_started' ? 'running' as const : (chunk.success ? 'done' as const : 'failed' as const),
      };
      const existing = s.subagents ?? [];
      const idx = existing.findIndex((e) => e.task === chunk.task);
      const next = idx >= 0 ? existing.map((e, i) => (i === idx ? entry : e)) : [...existing, entry];
      return { ...s, subagents: next };
    }
    case 'compaction_chunk': {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant' && last._compactionStream) {
        msgs[msgs.length - 1] = { ...last, text: last.text + chunk.text };
      } else {
        msgs.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          text: chunk.text,
          isStreaming: true,
          _compactionStream: true,
        });
      }
      return { ...s, messages: msgs };
    }
    case 'compaction_summary':
      return {
        ...s,
        messages: [
          ...s.messages,
          {
            id: crypto.randomUUID(), role: 'assistant', text: chunk.text,
            createdAt: Date.now(), compactionSummary: true,
          },
        ],
      };
    case 'compaction_started':
    case 'compaction_completed': {
      const patch: Partial<SessionState> = { compacting: chunk.type === 'compaction_started' };
      if (chunk.type === 'compaction_completed') {
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last?.role === 'assistant' && last._compactionStream) {
          msgs[msgs.length - 1] = { ...last, isStreaming: false };
          patch.messages = msgs;
        }
        if (typeof chunk.history_tokens === 'number') {
          patch.contextUsage = {
            historyTokens: chunk.history_tokens,
            historyBudget: chunk.history_budget ?? 0,
            historyTurns: chunk.history_turns ?? 20,
            omittedTurns: 0,
            willCompact: false,
          };
        }
      }
      return { ...s, ...patch };
    }
    default: {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = applyChunk(last, chunk);
      }
      return { ...s, messages: msgs };
    }
  }
}

/** Apply one chunk to a session; touches the last message when it changed. */
export function applyChunkToSession(s: SessionState, chunk: ChatStreamChunk): SessionState {
  const next = applyChunkToSessionInner(s, chunk);
  return next === s ? next : withTouch(next);
}
