import { create } from 'zustand';
import { api } from '@/lib/api-client';
import type { ChatStreamChunk, SendChatOptions } from '@/lib/types';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  isStreaming?: boolean;
  tier?: string;
  citations?: Array<{ text: string; source?: string }>;
}

interface SessionState {
  messages: ChatMessage[];
  abort: AbortController | null;
  loading: boolean;
}

interface ChatStore {
  sessions: Record<string, SessionState>;
  getOrCreate: (sessionId: string) => SessionState;
  sendMessage: (sessionId: string, opts: SendChatOptions) => Promise<void>;
  stopStream: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  setMessages: (sessionId: string, msgs: ChatMessage[]) => void;
}

function applyChunk(msg: ChatMessage, chunk: ChatStreamChunk): ChatMessage {
  switch (chunk.type) {
    case 'tier_classified':
      return { ...msg, tier: chunk.tier };
    case 'reasoning_chunk':
      return { ...msg, reasoning: (msg.reasoning || '') + chunk.text };
    case 'final_answer_chunk':
      return { ...msg, text: msg.text + chunk.text };
    case 'citations':
      return { ...msg, citations: chunk.items };
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
    const s: SessionState = { messages: [], abort: null, loading: false };
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: s } }));
    return s;
  },

  sendMessage: async (sessionId: string, opts: SendChatOptions) => {
    const prev = get().sessions[sessionId] || { messages: [], abort: null, loading: false };
    // Cancel previous stream
    prev.abort?.abort();

    const abort = new AbortController();
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: opts.text };
    const asstMsg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', text: '', isStreaming: true };

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          messages: [...prev.messages, userMsg, asstMsg],
          abort,
          loading: true,
        },
      },
    }));

    try {
      for await (const chunk of api.sendChatFull(opts, abort.signal)) {
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
          msgs[msgs.length - 1] = { ...last, isStreaming: false, text: last.text || `Error: ${String(err)}` };
        }
        return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
      });
    } finally {
      set((state) => {
        const s = state.sessions[sessionId];
        if (!s || s.abort !== abort) return state;
        return { sessions: { ...state.sessions, [sessionId]: { ...s, loading: false } } };
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

  clearSession: (sessionId: string) => {
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions };
    });
  },

  appendMessage: (sessionId: string, msg: ChatMessage) => {
    set((state) => {
      const s = state.sessions[sessionId];
      const msgs = s ? [...s.messages, msg] : [msg];
      return { sessions: { ...state.sessions, [sessionId]: { messages: msgs, abort: null, loading: false } } };
    });
  },

  setMessages: (sessionId: string, msgs: ChatMessage[]) => {
    set((state) => {
      const s = state.sessions[sessionId] || { messages: [], abort: null, loading: false };
      return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: msgs } } };
    });
  },
}));
