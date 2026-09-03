/**
 * #685 — pure chat SSE chunk → session state reducer.
 *
 * Extracted from stores/chat.ts so the chunk-reduction logic is unit-
 * testable without a zustand store. `applyChunkToSession` is a pure
 * function: one chunk (or a batch reduced left-to-right) in, one new
 * SessionState out.
 */
import type { ChatStreamChunk, ChatContextUsage, DeckWire, SendChatOptions } from './types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** #708: user 消息携带的附件 fileId — 重试/重新生成时恢复附件上下文。 */
  attachments?: string[];
  reasoning?: string;
  isStreaming?: boolean;
  tier?: string;
  citations?: Array<{ text: string; source?: string; kind?: 'fact' | 'knowledge' | 'document' | 'pinned' }>;
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
  /** #662: 4-state tool entries — #829: seq 精确闭合（并行执行时多个
   *  芯片同时 running），resultPreview/elapsedMs 支撑折叠行结果摘要；
   *  #832: round 支撑时间线轮次分组。 */
  toolCalls?: Array<{
    tool: string;
    argsPreview: string;
    status: 'running' | 'done' | 'error';
    seq?: number;
    round?: number;
    resultPreview?: string;
    elapsedMs?: number;
    startedAt?: number;
  }>;
  /**
   * #831: 子代理可见性 — 消息级（时间线渲染），按 id 聚合批量扇出；
   * 旧后端事件无 id 时以 task 兜底为 id。
   */
  subagents?: Array<{
    id: string;
    task: string;
    status: 'running' | 'done' | 'failed';
    phase?: 'thinking' | 'tool' | 'summarizing';
    currentTool?: string;
    toolArgsPreview?: string;
    turn?: number;
    maxTurns?: number;
    startedAt?: number;
    elapsedMs?: number;
    summaryPreview?: string;
    turns?: number;
    costTokens?: number;
  }>;
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
  /** #725: 保存为文档后的 docId — 消息内提供跳转链接。 */
  savedDocId?: string;
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
  /** #773: AI 写回同帧携带的 deck 资产（null = 无 deck 变更）。 */
  lastDocDeck?: DeckWire | null;
  /** #459: shared UI shape (ChatContextUsage in lib/types). */
  contextUsage?: ChatContextUsage;
  /** #298: skill-capture suggestion shown after a procedural reply. */
  skillCapture?: { text: string };
  /** #663: message ids touched by live SSE chunks — history snapshots must
   *  never clobber the in-flight versions (touch-tracker merge). */
  msgTouched?: Record<string, number>;
  /** #fix: 前置阶段进度提示(context_info) — 等待期实时反馈。 */
  streamNote?: string;
  /**
   * #828: 停滞检测 — 距最近一条 SSE data 事件超过阈值(90s)时记录起点。
   * 心跳保活让连接永不断开，前端必须区分"活着"与"有进展"。null/undefined
   * = 无停滞。UI 据此显示"仍在执行(已 Xs 无新进展)"而非无解释转圈。
   */
  stallSince?: number | null;
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
      // #773: deck 与 body 同帧到达 — lastDocDeck 供 deck 视图直apply
      // (AI 改页不走 markdown diffReview，页级小改直接应用 + 快照回滚)。
      return { ...s, lastDocBody: chunk.body, lastDocDeck: chunk.deck ?? null };
    case 'skill_capture_suggest':
      return { ...s, skillCapture: { text: chunk.text } };
    case 'tool_call': {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        let argsPreview = '';
        try { argsPreview = JSON.stringify(chunk.args ?? {}).slice(0, 120); } catch { /* ignore */ }
        const seq = chunk.seq;
        // #829: 携带 seq 的新协议下不再"下一个调用关闭上一个" — 并行执行
        // 时多个芯片同时 running，由 tool_result 按 seq 各自闭合。
        // 无 seq 的旧事件流保持原行为兜底。
        const prev = (last.toolCalls ?? []).map((tc) =>
          seq === undefined && tc.status === 'running' ? { ...tc, status: 'done' as const } : tc,
        );
        msgs[msgs.length - 1] = {
          ...last,
          toolCalls: [...prev, { tool: chunk.tool, argsPreview, status: 'running' as const, seq, round: chunk.round, startedAt: Date.now() }],
        };
      }
      return { ...s, messages: msgs };
    }
    // #829: 工具结果事件 — 按 seq 精确闭合芯片 + 结果摘要/耗时进折叠行。
    case 'tool_result': {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant' && (last.toolCalls ?? []).length > 0) {
        const status = chunk.success ? ('done' as const) : ('error' as const);
        const seq = chunk.seq;
        const toolCalls = (last.toolCalls ?? []).map((tc) => {
          if (seq !== undefined) {
            return tc.seq === seq
              ? { ...tc, status, resultPreview: chunk.preview, elapsedMs: chunk.elapsed_ms }
              : tc;
          }
          // legacy：无 seq 时关闭所有 running（旧行为等价）。
          return tc.status === 'running'
            ? { ...tc, status, resultPreview: chunk.preview, elapsedMs: chunk.elapsed_ms }
            : tc;
        });
        msgs[msgs.length - 1] = { ...last, toolCalls };
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
    // #831: 子代理可见性 — 事件附加到最后一条 assistant 消息（时间线渲染），
    // 按 id 聚合（批量扇出互不串组）；旧后端无 id 时以 task 兜底。
    case 'subagent_started':
    case 'subagent_progress':
    case 'subagent_done': {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role !== 'assistant') return s;
      const id = chunk.id || chunk.task;
      const list = last.subagents ?? [];
      const idx = list.findIndex((e) => e.id === id);
      if (chunk.type === 'subagent_started') {
        const entry = {
          id, task: chunk.task, status: 'running' as const,
          phase: undefined, startedAt: Date.now(),
        };
        const next = idx >= 0 ? list.map((e, i) => (i === idx ? { ...e, ...entry } : e)) : [...list, entry];
        msgs[msgs.length - 1] = { ...last, subagents: next };
      } else if (chunk.type === 'subagent_progress') {
        if (idx < 0) return s; // progress 只更新已 started 的条目
        const next = list.map((e, i) => (i === idx ? {
          ...e,
          phase: chunk.phase,
          currentTool: chunk.current_tool,
          toolArgsPreview: chunk.tool_args_preview,
          turn: chunk.turn,
          maxTurns: chunk.max_turns,
          elapsedMs: chunk.elapsed_ms,
        } : e));
        msgs[msgs.length - 1] = { ...last, subagents: next };
      } else {
        const entry = {
          status: (chunk.success ? 'done' : 'failed') as 'done' | 'failed',
          summaryPreview: chunk.summary_preview,
          turns: chunk.turns,
          costTokens: chunk.cost_tokens,
        };
        const next = idx >= 0 ? list.map((e, i) => (i === idx ? { ...e, ...entry } : e)) : [...list, { id, task: chunk.task, ...entry }];
        msgs[msgs.length - 1] = { ...last, subagents: next };
      }
      return { ...s, messages: msgs };
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
