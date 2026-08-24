import { create } from 'zustand';
import { batchChunks } from '@/lib/sse';
import { api } from '@/lib/api';
import type { ChatStreamChunk, SendChatOptions } from '@/lib/types';
import { applyChunkToSession, emptySession, type ChatMessage, type SessionState } from '@/lib/chat-reducer';

export type { ChatMessage, SessionState };

interface ChatStore {
  sessions: Record<string, SessionState>;
  sendMessage: (sessionId: string, opts: SendChatOptions) => Promise<void>;
  /** §10.3 (#220): re-run the last user turn — drops its stale reply first. */
  regenerate: (sessionId: string, opts: SendChatOptions) => Promise<void>;
  /** #420: 并行深度分析 — 与 sendMessage 共用同一个 SSE reducer + 批处理。 */
  runDeepAnalysis: (sessionId: string, opts: { question: string; topics: string[]; patientHash?: string | null; context?: string }) => Promise<void>;
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

/**
 * #fix: fetch 级失败(连接被重置/服务器崩溃/重启)没有任何可用的服务端
 * 错误内容 — 渲染"网络连接中断"而不是裸的 "TypeError: network error"。
 * 服务端能捕获的错误(LLM 超时/上下文溢出/附件解析失败)会以 SSE error
 * 事件送达,走 `Error: ${msg}` 分支。
 */
export function chatFailureText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/network error|failed to fetch|fetch failed|load failed|net::/i.test(msg)) {
    return '网络连接中断（服务器可能已重启或网络不稳定），请重试。'
  }
  return `Error: ${msg}`
}

/** 与 sendMessage 相同的批处理循环 — 一个 set() 消费一批 chunk。 */
async function consumeStream(
  set: (fn: (state: { sessions: Record<string, SessionState> }) => { sessions: Record<string, SessionState> }) => void,
  sessionId: string,
  stream: AsyncIterable<ChatStreamChunk>,
): Promise<boolean> {
  let gotChunks = false;
  for await (const batch of batchChunks(stream)) {
    if (batch.length === 0) continue;
    gotChunks = true;
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      const next = batch.reduce(applyChunkToSession, s);
      return { sessions: { ...state.sessions, [sessionId]: next } };
    });
  }
  return gotChunks;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: {},

  sendMessage: async (sessionId: string, opts: SendChatOptions) => {
    const prev = get().sessions[sessionId] || emptySession();
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
        },      },
    }));

    try {
      // #660: coalesce SSE chunks into ~16ms windows — one set() per batch.
      await consumeStream(set, sessionId, api.sendChatFull(opts, abort.signal));
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
            text: last.text || chatFailureText(err),
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

  runDeepAnalysis: async (sessionId: string, opts) => {
    const s = get().sessions[sessionId];
    if (!s || s.loading) return;
    const now = Date.now();
    // Mirror the user question into the stream like a normal turn.
    set((state) => {
      const cur = state.sessions[sessionId] ?? emptySession();
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...cur,
            messages: [...cur.messages,
              { id: crypto.randomUUID(), role: 'user', text: `🔬 ${opts.question}`, createdAt: now },
              { id: crypto.randomUUID(), role: 'assistant', text: '', isStreaming: true, createdAt: now },
            ],
            loading: true,
          },
        },
      };
    });

    try {
      const gotChunks = await consumeStream(set, sessionId, api.deepAnalysis(opts));
      if (!gotChunks) {
        // #685: no chunks at all — surface a definitive state instead of a
        // blank message (previous component-level handler wrote a fallback).
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return state;
          const msgs = [...cur.messages];
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, text: last.text || '分析完成', isStreaming: false };
          }
          return { sessions: { ...state.sessions, [sessionId]: { ...cur, messages: msgs } } };
        });
      } else {
        // the reducer keeps isStreaming true until a terminal chunk — force
        // it off for the deep-analysis pseudo-turn.
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return state;
          const msgs = cur.messages.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
          return { sessions: { ...state.sessions, [sessionId]: { ...cur, messages: msgs } } };
        });
      }
    } catch (err) {
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const msgs = [...cur.messages];
        const last = msgs[msgs.length - 1];
        if (last?.role === 'assistant') {
          msgs[msgs.length - 1] = {
            ...last,
            isStreaming: false,
            text: last.text || (err instanceof Error ? err.message : String(err)),
          };
        }
        return { sessions: { ...state.sessions, [sessionId]: { ...cur, messages: msgs } } };
      });
    } finally {
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return { sessions: { ...state.sessions, [sessionId]: { ...cur, loading: false } } };
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
      const s = state.sessions[sessionId] ?? emptySession();
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
    get().patchMessage(sessionId, msgId, { text });
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
    get().patchMessage(sessionId, msgId, { isStreaming: streaming });
  },
  setMessages: (sessionId: string, msgs: ChatMessage[]) => {
    set((state) => {
      const s = state.sessions[sessionId] || emptySession();
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
