import { create } from 'zustand';
import { batchChunks } from '@/lib/sse';
import { api } from '@/lib/api';
import type { ChatStreamChunk, SendChatOptions } from '@/lib/types';
import { applyChunkToSession, emptySession, type ChatMessage, type SessionState } from '@/lib/chat-reducer';

export type { ChatMessage, SessionState };

interface ChatStore {
  sessions: Record<string, SessionState>;
  sendMessage: (sessionId: string, opts: SendChatOptions) => Promise<void>;
  /** #fix: 回复进行中追加消息 → 排队,当前 turn 完成后自动发送(不打断
   *  正在执行的工具/写回,文档状态始终一致)。 */
  sendMessageQueued: (sessionId: string, opts: SendChatOptions) => Promise<void>;
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

/** #828: 距最近一条 SSE data 事件超过该阈值即标记会话停滞（心跳注释行
 *  让字节永远在流，必须基于 data 事件而非字节判断）。 */
const STALL_DETECT_MS = 90_000;

/** 与 sendMessage 相同的批处理循环 — 一个 set() 消费一批 chunk。
 *  #828: 手写消费循环以叠加停滞检测 — race 每个 next() 与剩余停滞窗口，
 *  停滞时记录 stallSince（供 UI 显示"已 Xs 无新进展"），流继续等待，
 *  下一事件到达即清除。pending 保存未完成的 next()，与 batchChunks 同
 *  约定：绝不丢弃 in-flight 的 chunk。 */
async function consumeStream(
  set: (fn: (state: { sessions: Record<string, SessionState> }) => { sessions: Record<string, SessionState> }) => void,
  sessionId: string,
  stream: AsyncIterable<ChatStreamChunk>,
): Promise<boolean> {
  let gotChunks = false;
  let lastEventAt = Date.now();
  let pending: Promise<IteratorResult<ChatStreamChunk[]>> | null = null;
  const iter = batchChunks(stream)[Symbol.asyncIterator]();
  const setStall = (since: number | null) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      if ((s.stallSince ?? null) === since) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...s, stallSince: since } } };
    });
  };
  // for(;;) — web eslint (v8) flags while(true) as constant condition.
  for (;;) {
    const nextP: Promise<IteratorResult<ChatStreamChunk[]>> = pending ?? iter.next();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const stallP = new Promise<'stall'>((resolve) => {
      const remain = STALL_DETECT_MS - (Date.now() - lastEventAt);
      stallTimer = setTimeout(() => resolve('stall'), Math.max(100, remain));
    });
    let r: IteratorResult<ChatStreamChunk[]> | 'stall';
    try {
      r = await Promise.race([nextP, stallP]);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
    if (r === 'stall') {
      pending = nextP;
      setStall(Date.now());
      continue;
    }
    pending = null;
    lastEventAt = Date.now();
    setStall(null);
    if (r.done) break;
    if (r.value.length === 0) continue;
    gotChunks = true;
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      const next = r.value.reduce(applyChunkToSession, s);
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
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: opts.text, createdAt: now, attachments: opts.attachments as string[] | undefined };
    const asstMsg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', text: '', isStreaming: true, createdAt: now };

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          // #fix: 必须 spread prev — 丢失 pending/lastDocBody/contextUsage
          // 等字段(排队消息会在 turn 完成后丢失)。
          ...prev,
          messages: [...prev.messages, userMsg, asstMsg],
          abort,
          loading: true,
          compacting: false,
          stallSince: null,
        },
      },
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
            // #708: 已有部分输出时也追加错误文案 — 用户看到"说到一半停了"要能知道是失败。
            text: last.text ? `${last.text}\n\n> ⚠️ ${chatFailureText(err)}` : chatFailureText(err),
            // #708: 网络失败把卡在 running 的工具徽章统一置 error。
            toolCalls: (last.toolCalls ?? []).map((tc) => (tc.status === 'running' ? { ...tc, status: 'error' as const } : tc)),
          };
        }
        return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
      });
    } finally {
      set((state) => {
        const s = state.sessions[sessionId];
        if (!s || s.abort !== abort) return state;
        return { sessions: { ...state.sessions, [sessionId]: { ...s, loading: false, compacting: false, stallSince: null } } };
      });
      // #fix: 排队消息在 turn 完成后自动发出(不 await — 避免嵌套状态
      // 竞争;新的 turn 会设置自己的 loading/abort)。
      const s2 = get().sessions[sessionId];
      if (s2?.pending && s2.abort === abort) {
        const queued = s2.pending;
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return state;
          return { sessions: { ...state.sessions, [sessionId]: { ...cur, pending: null } } };
        });
        void get().sendMessage(sessionId, queued.opts);
      }
    }
  },

  sendMessageQueued: async (sessionId: string, opts: SendChatOptions) => {
    const s = get().sessions[sessionId];
    if (s?.loading || s?.compacting) {
      // 回复进行中 → 排队;同一时刻只保留最后一条(用户可连续输入覆盖)。
      set((state) => {
        const cur = state.sessions[sessionId] ?? emptySession();
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...cur, pending: { text: opts.text, opts } },
          },
        };
      });
      return;
    }
    return get().sendMessage(sessionId, opts);
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
            stallSince: null,
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
        return { sessions: { ...state.sessions, [sessionId]: { ...cur, loading: false, stallSince: null } } };
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
          [sessionId]: {
            ...cur,
            messages: msgs,
            abort: null,
            loading: false,
            stallSince: null,
            // #fix: Stop = 停止一切(含排队中的追加消息) — 用户点停止
            // 就是不想继续了,排队消息不应在 turn 结束后自动发出。
            pending: null,
          },
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
      // #fix: 丢弃排队中的追加消息 — regenerate 语义是重跑上一条用户消息。
      pending: null,
    };
    set((state) => ({
      sessions: { ...state.sessions, [sessionId]: prev },
    }));
    await get().sendMessage(sessionId, {
      ...opts,
      text: userMsg.text,
      // #708: 恢复原消息附件与知识库引用 — 重试不应基于完全不同的输入。
      attachments: userMsg.attachments ?? [],
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
