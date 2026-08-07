import { create } from 'zustand';
import { api } from '@/lib/api-client';
import type { ChatStreamChunk, SendChatOptions } from '@/lib/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  isStreaming?: boolean;
  tier?: string;
  citations?: Array<{ text: string; source?: string }>;
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
  toolCalls?: Array<{ tool: string; argsPreview: string }>;
  chart?: { url: string; chartType?: string };
  /** Epoch ms — powers timestamps + grouping (§10.3 #220). */
  createdAt?: number;
  /** Set when the turn failed — renders a retry affordance. */
  failed?: boolean;
}

interface SessionState {
  messages: ChatMessage[];
  abort: AbortController | null;
  loading: boolean;
  compacting: boolean;
  lastDocBody?: string;
  contextUsage?: {
    historyTokens: number;
    historyBudget: number;
    historyTurns: number;
    omittedTurns: number;
    willCompact: boolean;
  };
  /** #298: skill-capture suggestion shown after a procedural reply. */
  skillCapture?: { text: string };
}

interface ChatStore {
  sessions: Record<string, SessionState>;
  getOrCreate: (sessionId: string) => SessionState;
  sendMessage: (sessionId: string, opts: SendChatOptions) => Promise<void>;
  /** §10.3 (#220): re-run the last user turn — drops its stale reply first. */
  regenerate: (sessionId: string, opts: SendChatOptions) => Promise<void>;
  stopStream: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
  setContextUsage: (sessionId: string, usage: NonNullable<SessionState['contextUsage']>) => void;
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  setMessages: (sessionId: string, msgs: ChatMessage[]) => void;
}

function applyChunk(msg: ChatMessage, chunk: ChatStreamChunk): ChatMessage {
  switch (chunk.type) {
    case 'tier_classified':
      return { ...msg, tier: chunk.tier };
    case 'reasoning_chunk':
    case 'thought':
      return { ...msg, reasoning: (msg.reasoning || '') + chunk.text };
    case 'final_answer_chunk':
      return { ...msg, text: msg.text + chunk.text };
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
    case 'error':
      return { ...msg, text: msg.text || `Error: ${chunk.message}`, isStreaming: false };
    default:
      return msg;
  }
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: {},

  getOrCreate: (sessionId: string): SessionState => {
    const existing = get().sessions[sessionId];
    if (existing) return existing;
    const s: SessionState = { messages: [], abort: null, loading: false, compacting: false };
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: s } }));
    return s;
  },

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
      for await (const chunk of api.sendChatFull(opts, abort.signal)) {
        if (chunk.type === 'context_usage') {
          set((state) => {
            const s = state.sessions[sessionId];
            if (!s) return state;
            return {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...s,
                  contextUsage: {
                    historyTokens: chunk.history_tokens,
                    historyBudget: chunk.history_budget,
                    historyTurns: chunk.history_turns,
                    omittedTurns: chunk.omitted_turns,
                    willCompact: chunk.will_compact,
                  },
                },
              },
            };
          });
          continue;
        }
        if (chunk.type === 'chart_created') {
          set((state) => {
            const s = state.sessions[sessionId];
            if (!s) return state;
            const msgs = [...s.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === 'assistant') {
              msgs[msgs.length - 1] = { ...last, chart: { url: chunk.url, chartType: chunk.chart_type } };
            }
            return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
          });
          continue;
        }
        if (chunk.type === 'doc_updated') {
          set((state) => {
            const s = state.sessions[sessionId];
            if (!s) return state;
            return { sessions: { ...state.sessions, [sessionId]: { ...s, lastDocBody: chunk.body } } };
          });
          continue;
        }
        if (chunk.type === 'skill_capture_suggest') {
          set((state) => {
            const s = state.sessions[sessionId];
            if (!s) return state;
            return { sessions: { ...state.sessions, [sessionId]: { ...s, skillCapture: { text: chunk.text } } } };
          });
          continue;
        }
        if (chunk.type === 'tool_call') {
          set((state) => {
            const s = state.sessions[sessionId];
            if (!s) return state;
            const msgs = [...s.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === 'assistant') {
              let argsPreview = '';
              try { argsPreview = JSON.stringify(chunk.args ?? {}).slice(0, 120); } catch { /* ignore */ }
              msgs[msgs.length - 1] = {
                ...last,
                toolCalls: [...(last.toolCalls ?? []), { tool: chunk.tool, argsPreview }],
              };
            }
            return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
          });
          continue;
        }
        if (chunk.type === 'compaction_chunk') {
          set((state) => {
            const s = state.sessions[sessionId];
            if (!s) return state;
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
            return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
          });
          continue;
        }
        if (chunk.type === 'compaction_started' || chunk.type === 'compaction_completed') {
          set((state) => {
            const s = state.sessions[sessionId];
            if (!s) return state;
            const patch: Partial<SessionState> = { compacting: chunk.type === 'compaction_started' };
            if (chunk.type === 'compaction_completed') {
              // End any in-flight compaction stream message.
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === 'assistant' && last._compactionStream) {
                msgs[msgs.length - 1] = { ...last, isStreaming: false };
                patch.messages = msgs;
              }
            }
            if (chunk.type === 'compaction_completed' && typeof chunk.history_tokens === 'number') {
              patch.contextUsage = {
                historyTokens: chunk.history_tokens,
                historyBudget: chunk.history_budget ?? 0,
                historyTurns: chunk.history_turns ?? 20,
                omittedTurns: 0,
                willCompact: false,
              };
            }
            return { sessions: { ...state.sessions, [sessionId]: { ...s, ...patch } } };
          });
          continue;
        }
        set((state) => {
          const s = state.sessions[sessionId];
          if (!s) return state;
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') {
            msgs[msgs.length - 1] = applyChunk(last, chunk);
          }
          return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
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
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...(state.sessions[sessionId]),
          abort: null,
          loading: false,
        },
      },
    }));
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

  setMessages: (sessionId: string, msgs: ChatMessage[]) => {
    set((state) => {
      const s = state.sessions[sessionId] || { messages: [], abort: null, loading: false };
      return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
    });
  },
}));
