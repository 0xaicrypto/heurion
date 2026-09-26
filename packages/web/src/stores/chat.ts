import { create } from 'zustand';
import i18n from '../i18n';
import { batchChunks } from '@/lib/sse';
import { api } from '@/lib/api';
import type { ChatStreamChunk, SendChatOptions } from '@/lib/types';
import { applyChunkToSession, emptySession, type ChatMessage, type PendingChatSlot, type SessionState } from '@/lib/chat-reducer';

export type { ChatMessage, SessionState, PendingChatSlot };

interface ChatStore {
  sessions: Record<string, SessionState>;
  sendMessage: (sessionId: string, opts: SendChatOptions) => Promise<void>;
  /**
   * #fix: 回复进行中追加消息 → 排队,当前 turn 完成后自动发送(不打断
   *  正在执行的工具/写回,文档状态始终一致)。
   * #1095: 多槽 FIFO 队列 — 排队不再互相覆盖（此前单槽覆盖即静默丢弃，
   *  是「请AI处理」多评论卡死的根因）。返回值：入队成功时返回该槽的
   *  显式 turnId（uuid）；未排队（直发）返回 undefined。
   */
  sendMessageQueued: (sessionId: string, opts: SendChatOptions) => Promise<string | undefined>;
  /** #1095 复审 #5: 撤回最后一条排队指令（排队提示的 ✕ 入口）。 */
  dropLastQueued: (sessionId: string) => void;
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
    // #947: 非 React 代码（zustand store）走 i18n 实例直取,英文用户不再看到中文原文。
    return i18n.t('chat.failureNetwork', '网络连接中断（服务器可能已重启或网络不稳定），请重试。')
  }
  return `Error: ${msg}`
}

/**
 * #1060: 排队指令被 Stop·regenerate 清空时的事件 — 被清掉的排队指令（如
 *  「请AI处理」的评论指令）据此解除路由层关联登记，保证可重试、不永久
 *  卡死。监听者须自行匹配 sessionId。
 * #1074-4: 事件携带显式 turnId（入队时生成、随排队槽存储）— 消费方按 id
 *  清账；text（指令原文）匹配降级为二重校验，不再是唯一关联依据。
 * #1095: 多槽队列下排队不再互相覆盖 — sendMessageQueued 的覆盖丢弃路径
 *  退役；丢弃事件只剩 Stop/regenerate 清队两个来源（每槽各发一条）。
 */
export interface ChatPendingDropped {
  sessionId: string;
  text: string;
  /** #1074-4: 被丢弃排队指令的显式 turn id（uuid；旧事件/无槽场景缺省）。 */
  turnId?: string;
}
const pendingDroppedListeners = new Set<(e: ChatPendingDropped) => void>();
/** 订阅 pending 丢弃事件，返回解绑函数。 */
export function onChatPendingDropped(fn: (e: ChatPendingDropped) => void): () => void {
  pendingDroppedListeners.add(fn);
  return () => { pendingDroppedListeners.delete(fn); };
}
function emitPendingDropped(sessionId: string, text: string, turnId?: string) {
  for (const fn of pendingDroppedListeners) fn({ sessionId, text, turnId });
}

/**
 * #1095: turn 完成事件 — sendMessage 的流收尾（finally）即发（先于排队
 *  槽出队）。多槽队列下 turn 结束与下一 turn 开始在同一个同步块里完成，
 *  React 渲染层看不到中间的 loading=false 沿 — 收口逻辑（写回冲刷/评论
 *  收口）改为订阅本事件，逐 turn 确定性触发，不再依赖 loading 边沿。
 */
const turnCompleteListeners = new Set<(sessionId: string) => void>();
/** 订阅 turn 完成事件，返回解绑函数。 */
export function onChatTurnComplete(fn: (sessionId: string) => void): () => void {
  turnCompleteListeners.add(fn);
  return () => { turnCompleteListeners.delete(fn); };
}
function emitTurnComplete(sessionId: string) {
  for (const fn of turnCompleteListeners) fn(sessionId);
}

/**
 * #1074-4: 排队槽形状即 PendingChatSlot（chat-reducer）— turnId 为一等
 * 字段（#1095 多槽队列：每槽独立身份）。
 */
function queueOf(pending: unknown): PendingChatSlot[] {
  const slots = pending as PendingChatSlot[] | null | undefined;
  return Array.isArray(slots) ? slots : [];
}
function pendingTurnIdOf(pending: unknown): string | undefined {
  const slots = queueOf(pending);
  const last = slots[slots.length - 1];
  return typeof last?.turnId === 'string' ? last.turnId : undefined;
}

/**
 * #1072-2（web 侧 turn_id 适配）— 每会话最近一次 SSE `turn_complete` 携带的
 * 服务端 assistant 消息 id（assistant_event_idx，事件日志序号 — 与
 * GET /agent/messages 的 sync_id = String(event idx) 同源）。ai-replies 契约
 * 要求 turn_id 为该用户该文档真实存在的 assistant 消息 id；web 侧唯一可得的
 * 服务端消息 id 即 SSE 事件里的这个序号。模块级记录（不进 SessionState —
 * chat-reducer 类型不动），供写作域 ai-replies 调用取用。
 */
const lastAssistantTurnIds = new Map<string, string>();
/** 该会话最近一次完成的 assistant turn 的服务端消息 id（无 → null）。 */
export function latestAssistantTurnId(sessionId: string): string | null {
  return lastAssistantTurnIds.get(sessionId) ?? null;
}
/** 测试隔离 — 清空模块级 turn id 记录。 */
export function resetAssistantTurnIdsForTests(): void {
  lastAssistantTurnIds.clear();
}
/** #1074-4: 读取某会话排队队列最后一槽的显式 turnId（未排队/已消费 → undefined）。 */
export function pendingTurnId(sessionId: string): string | undefined {
  return pendingTurnIdOf(useChatStore.getState().sessions[sessionId]?.pendingQueue);
}

/**
 * #1095: 读取某会话排队队列的快照（FIFO 顺序）— 评论并行处理的队列位次
 * 提示数据源。queuePosition(sessionId, turnId) 返回 1-based 位次（不在队
 * 列 → 0）。
 */
export function pendingQueueSnapshot(sessionId: string): PendingChatSlot[] {
  return queueOf(useChatStore.getState().sessions[sessionId]?.pendingQueue);
}
export function pendingQueuePosition(sessionId: string, turnId: string): number {
  const idx = queueOf(useChatStore.getState().sessions[sessionId]?.pendingQueue).findIndex((s) => s.turnId === turnId);
  return idx === -1 ? 0 : idx + 1;
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
  /** #严重-5: true when this stream's abort controller is no longer the
   *  session's current one (stop / next message / regenerate). Chunks already
   *  buffered in the reader must NOT be applied to the new turn's assistant
   *  message — previously only session existence was checked, so a stale
   *  failed/tool-call frame silently polluted the fresh reply. */
  isStale?: () => boolean,
): Promise<boolean> {
  let gotChunks = false;
  let lastEventAt = Date.now();
  // #fix 2026-09: 上次停滞触发时刻 — 下一次停滞探测必须从它起算满窗口。
  // 此前 stall 触发后 lastEventAt 不更新,remain = 90s - (now-lastEventAt)
  // ≤ 0 → Math.max(100, remain) = 100ms → 每 100ms 重复触发并把 stallSince
  // 重置为 now → UI"已 <1s 无新进展"永远不动(生产可见)。
  let lastStallAt = 0;
  let pending: Promise<IteratorResult<ChatStreamChunk[]>> | null = null;
  const iter = batchChunks(stream)[Symbol.asyncIterator]();
  /** 停滞置位 — 已停滞时保留最早起点(时长随 tick 增长,不重置)。 */
  const markStall = () => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s || isStale?.() || s.stallSince != null) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...s, stallSince: Date.now() } } };
    });
  };
  const clearStall = () => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s || isStale?.()) return state;
      if (s.stallSince == null) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...s, stallSince: null } } };
    });
  };
  // for(;;) — web eslint (v8) flags while(true) as constant condition.
  for (;;) {
    const nextP: Promise<IteratorResult<ChatStreamChunk[]>> = pending ?? iter.next();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const stallP = new Promise<'stall'>((resolve) => {
      const since = Math.max(lastEventAt, lastStallAt);
      const remain = STALL_DETECT_MS - (Date.now() - since);
      stallTimer = setTimeout(() => {
        lastStallAt = Date.now();
        resolve('stall');
      }, Math.max(100, remain));
    });
    let r: IteratorResult<ChatStreamChunk[]> | 'stall';
    try {
      r = await Promise.race([nextP, stallP]);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
    if (r === 'stall') {
      pending = nextP;
      markStall();
      continue;
    }
    pending = null;
    lastEventAt = Date.now();
    lastStallAt = 0;
    clearStall();
    if (r.done) break;
    // #严重-5: 停止/新 turn 已发生 → 丢弃缓冲中属于上一轮的 chunk，立即收口。
    if (isStale?.()) break;
    if (r.value.length === 0) continue;
    gotChunks = true;
    // #1072-2（web 侧 turn_id 适配）: 捕获 turn_complete 携带的服务端
    // assistant 消息 id（见 latestAssistantTurnId）。watchdog/中断等无
    // event_idx 的终止事件不记录（保留上一轮 id — 仍满足「真实存在」校验）。
    for (const chunk of r.value) {
      if (isStale?.()) break;
      if (chunk.type === 'turn_complete' && typeof chunk.assistant_event_idx === 'number') {
        lastAssistantTurnIds.set(sessionId, String(chunk.assistant_event_idx));
      }
    }
    set((state) => {
      const s = state.sessions[sessionId];
      // #严重-5: 只允许当前 controller 的 chunk 落到会话上。
      if (!s || isStale?.()) return state;
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
    // #996/#1003: 用户消息携带节引用(选中即引用→投影反查)— pill 跳转标签。
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: opts.text, createdAt: now, attachments: opts.attachments as string[] | undefined, ...(opts.sectionRef ? { sectionRef: opts.sectionRef } : {}) };
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
      // #严重-5: 传 abort 归属判定 — 停止/新 turn 后旧流的缓冲 chunk 不得落库。
      await consumeStream(set, sessionId, api.sendChatFull(opts, abort.signal), () => get().sessions[sessionId]?.abort !== abort);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      set((state) => {
        const s = state.sessions[sessionId];
        // #严重-5: 旧流迟到抛错不得把新一轮的回复标成 failed。
        if (!s || s.abort !== abort) return state;
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
      // #1095: turn 完成 — 先发事件再出队：收口逻辑（写回冲刷/评论收口）
      // 以「会话最后一条 user 消息 = 本 turn 指令」为指纹，下一 turn 的
      // user 消息此时尚未入列（还在排队槽里），指纹匹配不会被污染。
      if (get().sessions[sessionId]?.abort === abort) emitTurnComplete(sessionId);
      // #fix: 排队消息在 turn 完成后自动发出(不 await — 避免嵌套状态
      // 竞争;新的 turn 会设置自己的 loading/abort)。
      // #1095: 多槽 FIFO — 按序出队首条（此前单槽被覆盖即丢）。
      const s2 = get().sessions[sessionId];
      const queue = s2 ? queueOf(s2.pendingQueue) : [];
      if (queue.length > 0 && s2.abort === abort) {
        const [first, ...rest] = queue;
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return state;
          return { sessions: { ...state.sessions, [sessionId]: { ...cur, pendingQueue: rest } } };
        });
        void get().sendMessage(sessionId, first.opts);
      }
    }
  },

  sendMessageQueued: async (sessionId: string, opts: SendChatOptions) => {
    const s = get().sessions[sessionId];
    if (s?.loading || s?.compacting) {
      // 回复进行中 → 排队。
      // #1095: 多槽 FIFO — 追加到队尾，不再覆盖/丢弃任何已排队指令
      // （此前单槽覆盖即静默丢弃 + 发丢弃事件；多评论「请AI处理」依赖
      // 各自排队独立执行，覆盖路径退役）。turnId 入队即生成并返回。
      // #1095 复审 #5: 交互式输入可声明 'replace-last' — 覆盖队列里最后一条
      // **非评论**排队槽（用户改主意的「别管那条，改成 Y」语义保留）；评论/
      // 一键指令槽（queueTag:'comment'）不受交互覆盖。被覆盖槽照发丢弃事件。
      const turnId = crypto.randomUUID();
      const slot: PendingChatSlot = { text: opts.text, opts, turnId };
      // set() 回调内的赋值对 TS 控制流不可见 — 用持有对象避免 never 窄化。
      const droppedHolder: { slot: PendingChatSlot | null; idx: number } = { slot: null, idx: -1 };
      set((state) => {
        const cur = state.sessions[sessionId] ?? emptySession();
        // 复审 #4 修复: queueOf 不拷贝 — replace-last 的 queue[i] = slot 会
        // 原地改写数组（引用不变，按引用比较的订阅方跳过重渲染）。防御性拷贝。
        const queue = [...queueOf(cur.pendingQueue)];
        if (opts.queuePolicy === 'replace-last') {
          // 覆盖最后一条**非评论**槽（可位于评论槽之前 — 用户的交互改主意
          // 语义只作用于交互槽；评论/一键指令槽永远保留，逐条独立执行）。
          for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].opts.queueTag !== 'comment') {
              droppedHolder.slot = queue[i];
              droppedHolder.idx = i;
              queue[i] = slot;
              return {
                sessions: {
                  ...state.sessions,
                  [sessionId]: { ...cur, pendingQueue: queue },
                },
              };
            }
          }
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...cur, pendingQueue: [...queue, slot] },
          },
        };
      });
      if (droppedHolder.slot) emitPendingDropped(sessionId, droppedHolder.slot.text, droppedHolder.slot.turnId);
      return turnId;
    }
    await get().sendMessage(sessionId, opts);
    return undefined;
  },

  /**
   * #1095 复审 #5: 撤回最后一条排队指令（聊天面板排队提示的 ✕ 入口）—
   * 逐槽丢弃事件照发（评论槽经登记清理；交互槽无需清账）。
   */
  dropLastQueued: (sessionId: string) => {
    const s = get().sessions[sessionId];
    const queue = s ? queueOf(s.pendingQueue) : [];
    if (queue.length === 0) return;
    const dropped = queue[queue.length - 1];
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...cur, pendingQueue: queueOf(cur.pendingQueue).slice(0, -1) } } };
    });
    emitPendingDropped(sessionId, dropped.text, dropped.turnId);
  },

  runDeepAnalysis: async (sessionId: string, opts) => {
    const s = get().sessions[sessionId];
    if (!s || s.loading) return;
    const now = Date.now();
    // #严重-5: 与 sendMessage 同款归属控制 — deep analysis 也要能被 stop/
    // 新 turn 真正取消，旧流缓冲 chunk 不得污染新回复。
    const abort = new AbortController();
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
            abort,
            loading: true,
            stallSince: null,
          },
        },
      };
    });

    try {
      const gotChunks = await consumeStream(set, sessionId, api.deepAnalysis(opts, abort.signal), () => get().sessions[sessionId]?.abort !== abort);
      if (!gotChunks) {
        // #685: no chunks at all — surface a definitive state instead of a
        // blank message (previous component-level handler wrote a fallback).
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur || cur.abort !== abort) return state;
          const msgs = [...cur.messages];
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, text: last.text || i18n.t('chat.analysisComplete', '分析完成'), isStreaming: false };
          }
          return { sessions: { ...state.sessions, [sessionId]: { ...cur, messages: msgs } } };
        });
      } else {
        // the reducer keeps isStreaming true until a terminal chunk — force
        // it off for the deep-analysis pseudo-turn.
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur || cur.abort !== abort) return state;
          const msgs = cur.messages.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
          return { sessions: { ...state.sessions, [sessionId]: { ...cur, messages: msgs } } };
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur || cur.abort !== abort) return state;
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
        if (!cur || cur.abort !== abort) return state;
        return { sessions: { ...state.sessions, [sessionId]: { ...cur, loading: false, stallSince: null } } };
      });
    }
  },

  stopStream: (sessionId: string) => {
    const s = get().sessions[sessionId];
    s?.abort?.abort();
    // #1060: Stop 丢弃排队指令 — 先取引用再清理,发丢弃事件(路由层清理关联登记)。
    // #1074-4: 丢弃事件携带被清指令的入队 turnId。
    // #1095: 多槽队列 — 逐槽各发一条丢弃事件（每条排队指令独立清账）。
    const dropped = s ? queueOf(s.pendingQueue) : [];
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
            pendingQueue: [],
          },
        },
      };
    });
    for (const slot of dropped) emitPendingDropped(sessionId, slot.text, slot.turnId);
  },

  regenerate: async (sessionId: string, opts: SendChatOptions) => {
    const s = get().sessions[sessionId];
    if (!s || s.loading || s.compacting) return;
    // Find the last user message; drop it and everything after (its stale
    // reply) — sendMessage re-appends a fresh user + assistant pair.
    const lastUserIdx = s.messages.map((m) => m.role).lastIndexOf('user');
    if (lastUserIdx === -1) return;
    const userMsg = s.messages[lastUserIdx];
    // #1060: regenerate 丢弃排队中的追加消息 — 发丢弃事件(路由层清理关联登记)。
    // #1074-4: 丢弃事件携带被清指令的入队 turnId。
    // #1095: 多槽队列 — 逐槽各发一条丢弃事件。
    const dropped = s ? queueOf(s.pendingQueue) : [];
    const prev: SessionState = {
      ...s,
      messages: s.messages.slice(0, lastUserIdx),
      // #fix: 丢弃排队中的追加消息 — regenerate 语义是重跑上一条用户消息。
      pendingQueue: [],
    };
    set((state) => ({
      sessions: { ...state.sessions, [sessionId]: prev },
    }));
    for (const slot of dropped) emitPendingDropped(sessionId, slot.text, slot.turnId);
    await get().sendMessage(sessionId, {
      ...opts,
      text: userMsg.text,
      // #708: 恢复原消息附件与知识库引用 — 重试不应基于完全不同的输入。
      attachments: userMsg.attachments ?? [],
    });
  },

  clearSession: (sessionId: string) => {
    // #1072-2: 会话删除 → 其服务端 turn id 记录一并清（防串会话/内存滞留）。
    lastAssistantTurnIds.delete(sessionId);
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
      // #fix: 只追加,不重置会话 — 此前每次 append 都重建为
      // { messages, abort:null, loading:false, compacting:false }:
      // 流式回复期间上传附件(插入一条 [📎] 提示)会把 pendingQueue、
      // contextUsage、在飞消息状态全部清空,排队指令与后续流内容丢失。
      const s = state.sessions[sessionId] ?? emptySession();
      return { sessions: { ...state.sessions, [sessionId]: { ...s, messages: [...s.messages, msg] } } };
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
