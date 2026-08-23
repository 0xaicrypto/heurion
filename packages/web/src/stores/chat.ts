import { create } from 'zustand';
import { batchChunks } from '@/lib/sse';import { api } from '@/lib/api';
import type { ChatStreamChunk, ChatContextUsage, SendChatOptions } from '@/lib/types';

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

interface SessionState {
  messages: ChatMessage[];
  abort: AbortController | null;
  loading: boolean;
  compacting: boolean;
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
}

interface ChatStore {
  sessions: Record<string, SessionState>;
  sendMessage: (sessionId: string, opts: SendChatOptions) => Promise<void>;
  /** §10.3 (#220): re-run the last user turn — drops its stale reply first. */
  regenerate: (sessionId: string, opts: SendChatOptions) => Promise<void>;
  stopStream: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
  setContextUsage: (sessionId: string, usage: NonNullable<SessionState['contextUsage']>) => void;
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  setMessages: (sessionId: string, msgs: ChatMessage[]) => void;
  /** #420: replace the text of one assistant message (deep-analysis stream). */
  updateMessageText: (sessionId: string, msgId: string, text: string) => void;
  /** #581/#582: 就地更新一条消息的任意字段（导出状态等）。 */
  patchMessage: (sessionId: string, msgId: string, patch: Partial<ChatMessage>) => void;
  /** #420: toggle the streaming flag of one message. */
  setStreaming: (sessionId: string, msgId: string, streaming: boolean) => void;
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
function applyChunkToSession(s: SessionState, chunk: ChatStreamChunk): SessionState {
  const next = applyChunkToSessionInner(s, chunk);
  return next === s ? next : withTouch(next);
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

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: {},

  sendMessage: async (sessionId: string, opts: SendChatOptions) => {
    const prev = get().sessions[sessionId] || { messages: [], abort: null, loading: false, compacting: false };
    // Cancel previous stream
    prev.abort?.abort();

    const abort = new AbortController();
    const now = Date.now();
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: opts.text, createdAt: now };
    const asstMsg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', text: '', isStreaming: true, createdAt: now };

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          messages: [...prev.messages, userMsg, asstMsg],
          abort,
          loading: true,
          compacting: false,
        },
      },
    }));

    try {
      // #660: coalesce SSE chunks into ~16ms windows — one set() per batch.
      for await (const batch of batchChunks(api.sendChatFull(opts, abort.signal))) {
        if (batch.length === 0) continue;
        set((state) => {
          const s = state.sessions[sessionId];
          if (!s) return state;
          const next = batch.reduce(applyChunkToSession, s);
          return { sessions: { ...state.sessions, [sessionId]: next } };
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      set((state) => {
        const s = state.sessions[sessionId];
        if (!s) return state;
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last?.role === 'assistant') {
          msgs[msgs.length - 1] = {
            ...last,
            isStreaming: false,
            failed: true,
            text: last.text || `Error: ${String(err)}`,
          };
        }
        return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
      });
    } finally {
      set((state) => {
        const s = state.sessions[sessionId];
        if (!s || s.abort !== abort) return state;
        return { sessions: { ...state.sessions, [sessionId]: { ...s, loading: false, compacting: false } } };
      });
    }
  },

  stopStream: (sessionId: string) => {
    const s = get().sessions[sessionId];
    s?.abort?.abort();
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      // #553: 停止后清理最后一条 assistant 消息的 isStreaming 标志,
      // 否则脉冲指示永久显示。
      const msgs = cur.messages.map((m) =>
        m.isStreaming ? { ...m, isStreaming: false } : m,
      );
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...cur, messages: msgs, abort: null, loading: false },
        },
      };
    });
  },

  regenerate: async (sessionId: string, opts: SendChatOptions) => {
    const s = get().sessions[sessionId];
    if (!s || s.loading || s.compacting) return;
    // Find the last user message; drop it and everything after (its stale
    // reply) — sendMessage re-appends a fresh user + assistant pair.
    const lastUserIdx = s.messages.map((m) => m.role).lastIndexOf('user');
    if (lastUserIdx === -1) return;
    const userMsg = s.messages[lastUserIdx];
    const prev: SessionState = {
      ...s,
      messages: s.messages.slice(0, lastUserIdx),
    };
    set((state) => ({
      sessions: { ...state.sessions, [sessionId]: prev },
    }));
    await get().sendMessage(sessionId, {
      ...opts,
      text: userMsg.text,
    });
  },

  clearSession: (sessionId: string) => {
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions };
    });
  },

  setContextUsage: (sessionId: string, usage) => {
    set((state) => {
      const s = state.sessions[sessionId] ?? { messages: [], abort: null, loading: false, compacting: false };
      return { sessions: { ...state.sessions, [sessionId]: { ...s, contextUsage: usage } } };
    });
  },

  appendMessage: (sessionId: string, msg: ChatMessage) => {
    set((state) => {
      const s = state.sessions[sessionId];
      const msgs = s ? [...s.messages, msg] : [msg];
      return { sessions: { ...state.sessions, [sessionId]: { messages: msgs, abort: null, loading: false, compacting: false } } };
    });
  },

  updateMessageText: (sessionId: string, msgId: string, text: string) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      const msgs = s.messages.map((m) => (m.id === msgId ? { ...m, text } : m));
      return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
    });
  },
  patchMessage: (sessionId: string, msgId: string, patch: Partial<ChatMessage>) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      const msgs = s.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m));
      return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
    });
  },
  setStreaming: (sessionId: string, msgId: string, streaming: boolean) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      const msgs = s.messages.map((m) => (m.id === msgId ? { ...m, isStreaming: streaming } : m));
      return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
    });
  },
  setMessages: (sessionId: string, msgs: ChatMessage[]) => {
    set((state) => {
      const s = state.sessions[sessionId] || { messages: [], abort: null, loading: false, compacting: false };
      const existing = s.messages;
      const touched = s.msgTouched ?? {};
      // #663: touch-tracker merge — live (SSE-touched or still-streaming)
      // messages win over the freshly loaded snapshot; everything else is
      // replaced by the server version.
      const keep = new Set<string>();
      for (const m of existing) {
        if (m.isStreaming || touched[m.id] !== undefined) keep.add(m.id);
      }
      const merged = msgs.map((m) => {
        if (!keep.has(m.id)) return m;
        const live = existing.find((e) => e.id === m.id);
        return live ?? m;
      });
      // Keep any live tail the snapshot does not know about yet.
      for (const m of existing) {
        if ((m.isStreaming || touched[m.id] !== undefined) && !merged.some((x) => x.id === m.id)) {
          merged.push(m);
        }
      }
      return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: merged } } };
    });
  },
}));
