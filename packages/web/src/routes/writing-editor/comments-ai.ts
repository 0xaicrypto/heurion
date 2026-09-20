import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import type { DocCommentWire } from '@/lib/api';
import type { DeckWire } from '@/lib/types';
// #1074-4: 显式 turnId — 排队单槽入队 id;#1072-2 web 适配: SSE 服务端
// assistant 消息 id 的记录/读取（latestAssistantTurnId）。
import { latestAssistantTurnId, onChatPendingDropped, pendingTurnId, useChatStore, type ChatPendingDropped } from '@/stores/chat';

/**
 * #1074-3 — 评论-AI 状态机从 writing-editor 路由下沉（仿 bubble.ts/doc-chat.ts
 * 先例：hook + 参数对象 + 返回值；路由只留接线）。
 *
 * 职责（纯机械迁移 + #1074-4/#1072-2 适配，行为不变为验收线）：
 * - 「请AI处理」登记表（pendingCommentTurnsRef）+ 按钮 loading（commentProcessing）；
 * - 评论来源 ↔ diff 审阅关联（diffCommentSourcesRef/diffReviewKeyRef）；
 * - turn 收口/写回冲刷/排队丢弃三条清账路径；
 * - ai-replies 专用入口消费（#1064/#1064+#1072-2 turn_id 契约适配）；
 * - #1088: deck 评论写回的人工确认闭环（待确认态 + 确认/撤销动作）。
 */

/** #1041/#1060: 单条评论的处理登记 — instruction 即收口匹配用的指令指纹。 */
interface PendingCommentTurn {
  target: 'section' | 'deck_slide';
  deckKeyAtStart?: string;
  /**
   * #1088: 登记时捕获的画布快照（deckSnapshotNow()）— 撤销修改的恢复目标
   * （null = 画布无 deck，不提供撤销，同 #1071-1 的取舍）。
   */
  prevDeck?: DeckWire | null;
  instruction: string;
  /**
   * #1074-4: 指令排队时捕获的显式 turnId（sendMessageQueued 入队 uuid）。
   * 丢弃事件按它精确清账（指纹为二重校验）；直发（未排队）的轮次不带 —
   * 该轮不可能经排队丢弃路径清理，收口仍走指纹。
   */
  turnId?: string;
}

export interface CommentsAiInput {
  docId: string | undefined;
  /** 评论线程列表（路由态）— 乐观更新经 setDocComments 回写。 */
  docComments: DocCommentWire[];
  setDocComments: React.Dispatch<React.SetStateAction<DocCommentWire[]>>;
  /** 审阅未决守卫（与生成 Methods/Restore 同一互斥纪律）。 */
  diffReview: unknown;
  /** 写回批次待冲刷守卫（路由 doc-chat 管道所有）。 */
  pendingWriteBackRef: React.MutableRefObject<{ base: string; body: string; timer: ReturnType<typeof setTimeout> | null } | null>;
  /** #837: 累计写回队列（settle 判定「写回排队中」用，路由所有）。 */
  writeBackQueueRef: React.MutableRefObject<Array<{ base: string; next: string; fp: string | null }>>;
  /** 发送通道（doc-chat hook 的 sendChatText）。 */
  sendChatText: (text: string) => Promise<void>;
  /**
   * #1088: deck 撤销出口 — 路由接线 deck-conflict 的 restoreDeckSnapshot
   * （恢复写回前快照 + force 落盘；true = 已恢复并落盘成功）。useCommentsAi
   * 装配先于 useDeckConflict，路由经 ref 反向引用解耦装配顺序。
   */
  onRestoreDeckSnapshot: (prevDeck: DeckWire | null) => Promise<boolean>;
  /**
   * #1088: 撤销快照来源 — 登记时捕获当前画布 deck（deckAsset，含文档装载
   * 与本地编辑的最新状态；store 的 lastDocDeck 只在 doc_updated 事件更新，
   * 作撤销目标会回退到更早的版本）。
   */
  deckSnapshotNow: () => DeckWire | null;
  /** #696: 统一轻提示通道。 */
  onNotice: (text: string, ttlMs?: number) => void;
}

export interface CommentsAi {
  pendingCommentTurnsRef: React.MutableRefObject<Map<string, PendingCommentTurn>>;
  /** #1041: 当前 diff 审阅 ← 评论来源关联（handleDiffResolve accept 分支消费）。 */
  diffCommentSourcesRef: React.MutableRefObject<{ key: string; ids: string[] } | null>;
  /** #1041: 审阅 key 比对依据（与 diffCommentSourcesRef.key 同帧校验）。 */
  diffReviewKeyRef: React.MutableRefObject<string | null>;
  /** 审阅未决镜像（写回冲刷分流用 — 与 diffReview 同帧同步）。 */
  diffPendingRef: React.MutableRefObject<boolean>;
  commentProcessing: Record<string, boolean>;
  clearCommentProcessing: (id: string) => void;
  currentTurnInstruction: () => string | null;
  lastAssistantAnswer: () => string;
  appendAiReply: (commentId: string, text: string) => Promise<void>;
  resolveCommentById: (commentId: string) => Promise<void>;
  commentFailReply: (commentId: string, target: 'section' | 'deck_slide') => string;
  takeSectionCommentTurns: (fp: string | null) => string[];
  attachCommentSourcesToReview: (reviewKey: string, fp: string | null) => void;
  failCommentTurnsByFp: (fp: string | null) => void;
  /** #1041: turn 收口 — deck 评论成败判定 + 正文评论失败兜底。 */
  settlePendingCommentTurns: () => void;
  /**
   * #1088: deck 写回待确认态（commentId → { undoable }）— 线程级
   * 「确认修改/撤销修改」动作按钮的数据源（仅 target='deck_slide' 且
   * 写回落地后进入该态，长期可用、无 TTL）。
   */
  deckPendingConfirm: Record<string, { undoable: boolean }>;
  /** #1088: 「确认修改」— PATCH resolved（正文 diff accept 的对等语义）。 */
  confirmDeckWriteBack: (commentId: string) => Promise<void>;
  /** #1088: 「撤销修改」— 恢复写回前 deck 快照（force 落盘）+ 评论保持 open
   *  + 线程追加「已撤销」说明。 */
  undoDeckWriteBackForComment: (commentId: string) => Promise<void>;
  /** #1088: 8s 撤销横幅先行撤销时的收口联动 — 快照一致的待确认态清账并补
   *  「已撤销」说明（同一写回只有一个撤销出口，不重复）。 */
  settleDeckConfirmUndo: (prevDeck: DeckWire | null) => Promise<void>;
  /** #1041: 「请AI处理」入口（面板按钮）。 */
  handleCommentAiProcess: (c: DocCommentWire) => void;
  /** 切文档双保险 — 登记/审阅关联/按钮 loading 一次清空。 */
  resetForDocSwitch: () => void;
}

export function useCommentsAi(input: CommentsAiInput): CommentsAi {
  const { t } = useTranslation();
  const { docId, docComments, setDocComments, diffReview, pendingWriteBackRef, writeBackQueueRef, sendChatText, onNotice, onRestoreDeckSnapshot, deckSnapshotNow } = input;

  // ── #1041: 「请AI处理」评论驱动 AI 编辑闭环 ──────────────────────────
  // pendingCommentTurnsRef: 点击时同步登记(防同帧双击并发,issue 用例 6)。
  // 收口分两条路:正文评论的写回进 diff 审阅时消费(flushPendingWriteBack /
  // popNextWriteBack);deck 评论(#1051)无 diff 审阅(edit_deck 直接落画布),
  // 在 turn 收口时比对 Doc.deck 变化判定成败。
  // #1060: 关联改为「单评论单 turn + 指令指纹匹配」— 登记携带完整指令文本
  // 作为指纹;冲刷/收口只消费「本 turn 实际发出其指令」的评论(并发/排队
  // 下不再误归属),排队单槽被覆盖/Stop 清空时经 store 事件清理登记(可重试)。
  // #1074-4: 登记在入队后补记显式 turnId — 丢弃事件按 id 精确清账。
  const pendingCommentTurnsRef = useRef<Map<string, PendingCommentTurn>>(new Map());
  // #1041: 当前 diff 审阅 ← 评论来源关联(accept → 评论自动 resolved)。
  const diffCommentSourcesRef = useRef<{ key: string; ids: string[] } | null>(null);
  const diffReviewKeyRef = useRef<string | null>(null);
  // #927/#1041: 审阅未决镜像 + 审阅 key 比对依据(原路由 effect 下沉)。
  const diffPendingRef = useRef(false);
  useEffect(() => {
    diffPendingRef.current = diffReview !== null;
    diffReviewKeyRef.current = (diffReview as { key?: string } | null)?.key ?? null;
  }, [diffReview]);
  // #1041: 处理中按钮态(commentId → loading)。#1060: loading 与 turn 真实
  // 边界对齐 — 指令排队等待期间保持 loading,由消费点(attach/settle)或
  // pending 丢弃事件收口,不再随 send promise(入队即 resolve)提前消失。
  const [commentProcessing, setCommentProcessing] = useState<Record<string, boolean>>({});
  const docCommentsRef = useRef(docComments);
  docCommentsRef.current = docComments;

  /**
   * #1088: deck 写回待确认态 — 写回落地（deck 有变化）后评论不再自动
   * resolved，而是进入「确认修改/撤销修改」的待确认态（对齐正文评论的
   * diff accept/reject 审阅环节）。快照（写回前 deck）留在 ref 供撤销恢复，
   * 面板只需要 ids/undoable 布尔，走 state 镜像。无 TTL — 8s 撤销横幅
   * （#1071-1）超时后待确认态长期可用；8s 横幅先行撤销时经
   * settleDeckConfirmUndo 联动收口（同一写回不重复出口）。
   */
  const deckConfirmRef = useRef<Map<string, { prevDeck: DeckWire | null }>>(new Map());
  const [deckPendingConfirm, setDeckPendingConfirm] = useState<Record<string, { undoable: boolean }>>({});

  /** #1060: 收口单个评论的按钮 loading(消费点统一走这里)。 */
  const clearCommentProcessing = useCallback((id: string) => {
    setCommentProcessing((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  /**
   * #1060: 当前 turn 的指令指纹 — 会话最后一条「非附件提示」的 user 消息
   * 文本。附件上传可发生在 turn 期间(appendMessage 插入 [📎 提示] 消息),
   * 指纹读取须跳过,保证 turn 边界读取稳定。冲刷/收口以它与评论登记的
   * 指令精确匹配,只归属本 turn 实际发出的评论指令。
   */
  const currentTurnInstruction = useCallback((): string | null => {
    if (!docId) return null;
    const msgs = useChatStore.getState().sessions[`doc-${docId}`]?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'user') continue;
      if (m.text.startsWith('[📎')) continue;
      return m.text;
    }
    return null;
  }, [docId]);

  /** #1041: turn 的最终 AI 答复 — 评论线程 AI 回复的内容来源(说明做了什么)。 */
  const lastAssistantAnswer = useCallback((): string => {
    if (!docId) return '';
    const msgs = useChatStore.getState().sessions[`doc-${docId}`]?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        const text = String(msgs[i].text || '').trim();
        if (text) return text.slice(0, 500);
      }
    }
    return '';
  }, [docId]);

  /** #1041: 评论线程追加 AI 回复（#1064 集成收口 — 专用 ai-replies 入口，
   *  role 服务端固定 'ai'，通用 replies 端点已拒绝自封；本地按时间序并入）。
   *  #1072-2 web 适配: 契约要求 turn_id = 该用户该文档 doc_chat_messages 里
   *  真实存在的 assistant 消息 id。取数路径:SSE turn_complete.assistant_event_idx
   *  → store latestAssistantTurnId()。无 id（旧流/watchdog 中断等）不调用 —
   *  服务端必 400/403,线程补一条本地失败说明,不静默。 */
  const appendAiReply = useCallback(async (commentId: string, text: string) => {
    if (!docId || !text.trim()) return;
    const turnId = latestAssistantTurnId(`doc-${docId}`);
    if (!turnId) {
      setDocComments((prev) => prev.map((c) => (c.id === commentId ? {
        ...c,
        // 本地说明(不入库) — 服务端 turn_id 校验缺凭据,重试可恢复。
        replies: [...c.replies, { id: `local_ai_${Date.now()}`, role: 'ai', text: t('writing.commentAiTurnMissing', 'AI 回复未发送：本轮缺少服务端会话标识（turn_id），请稍后重试或手动处理。'), created_at: new Date().toISOString() }],
      } : c)));
      return;
    }
    try {
      const reply = await api.createDocCommentAiReply(docId, commentId, text, turnId);
      setDocComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c)));
    } catch { /* 回复失败不阻断主流程 — 线程少一条说明,不产生数据歧义 */ }
  }, [docId, setDocComments, t]);

  /** #1041: 评论自动 resolved（diff 被接受 / #1051 deck 写回落地）。 */
  const resolveCommentById = useCallback(async (commentId: string) => {
    if (!docId) return;
    try {
      const updated = await api.updateDocComment(docId, commentId, 'resolved');
      setDocComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, status: updated.status, resolved_at: updated.resolved_at } : c)));
    } catch { /* 状态更新失败保持 open — 用户可手动标记 */ }
  }, [docId, setDocComments]);

  /** #1041 用例 5: 失败/漂移的 AI 回复文案 — 附 anchor-diagnostics 候选,不静默。 */
  const commentFailReply = useCallback((commentId: string, target: 'section' | 'deck_slide'): string => {
    const c = docCommentsRef.current.find((x) => x.id === commentId);
    if (c?.anchor?.located !== false) {
      return t('writing.commentAiNoChange', 'AI 未能自动处理该评论：本轮没有产生文档修改。请检查评论内容后重试，或手动修改。');
    }
    const cands = (c.anchor.candidates ?? []).slice(0, 3).map((x) => `「${x.text.slice(0, 40)}」`).join('、');
    const where = target === 'deck_slide'
      ? t('writing.commentTargetSlide', '幻灯片第 {{n}} 页', { n: c.slide_index ?? '?' })
      : t('writing.commentTargetSection', '正文');
    return t('writing.commentAiLocateFail', 'AI 未能自动处理该评论：{{where}}的锚点片段「{{anchor}}」已无法定位（原文可能已改动）。最接近的候选：{{cands}}。请更新评论内容后重试，或手动处理。', {
      where,
      anchor: c.anchor_text,
      cands: cands || '（无）',
    });
  }, [t]);

  /** #1041: 消费待收口的正文评论来源（diff 审阅打开时调用）。
   *  #1060: 按指令指纹匹配消费 — 只挂「本 turn 发出其指令」的评论，不再
   *  全量消费（排队轮换/无关写回不再误关联到尚未处理的评论）。 */
  const takeSectionCommentTurns = useCallback((fp: string | null): string[] => {
    const ids: string[] = [];
    if (fp !== null) {
      for (const [id, meta] of pendingCommentTurnsRef.current) {
        if (meta.target === 'section' && meta.instruction === fp) ids.push(id);
      }
    }
    for (const id of ids) pendingCommentTurnsRef.current.delete(id);
    return ids;
  }, []);

  /** #1041: 评论来源的写回进入 diff 审阅 — 线程追加 AI 回复 + 记录审阅关联
   *  （handleDiffResolve accept 分支据此 PATCH resolved；拒绝/放弃保持 open）。
   *  #1060: fp = 写回所属 turn 的指令指纹；消费时同步收按钮 loading（与
   *  turn 真实边界对齐，替代 send promise 的提前 finally 收口）。 */
  const attachCommentSourcesToReview = useCallback((reviewKey: string, fp: string | null) => {
    const ids = takeSectionCommentTurns(fp);
    if (ids.length === 0) return;
    diffCommentSourcesRef.current = { key: reviewKey, ids };
    const aiText = lastAssistantAnswer()
      || t('writing.commentAiDiffReply', 'AI 已按评论意见生成修改建议 — 请审阅 diff；接受后将自动把该评论标记为已解决。');
    for (const id of ids) {
      clearCommentProcessing(id);
      void appendAiReply(id, aiText);
    }
  }, [takeSectionCommentTurns, lastAssistantAnswer, appendAiReply, clearCommentProcessing, t]);

  /** #1060: 按指纹清账 — 写回轮被丢弃（popNextWriteBack 冲突分支）/ 排队
   *  指令被覆盖·Stop·regenerate 清空时调用：清登记 + 按钮收口 + 线程补失败
   *  说明，评论保持 open 可重试，解除 has() 重试死锁。 */
  const failCommentTurnsByFp = useCallback((fp: string | null) => {
    if (fp === null) return;
    for (const [id, meta] of [...pendingCommentTurnsRef.current.entries()]) {
      if (meta.instruction !== fp) continue;
      pendingCommentTurnsRef.current.delete(id);
      clearCommentProcessing(id);
      void appendAiReply(id, commentFailReply(id, meta.target));
    }
  }, [clearCommentProcessing, appendAiReply, commentFailReply]);

  /**
   * #1074-4: 排队指令被丢弃事件清账 — 主键 turnId 精确匹配,指令指纹
   *  (原文)作二重校验(两者同中才清,不再以文本匹配为唯一依据)。turnId
   *  缺席(旧事件)或未命中登记(入队竞态未捕获)时回退指纹匹配 — 保持
   *  #1060 的可重试语义,不引入新死锁。
   */
  const failCommentTurnsByDrop = useCallback((e: ChatPendingDropped) => {
    let cleared = 0;
    if (e.turnId) {
      for (const [id, meta] of [...pendingCommentTurnsRef.current.entries()]) {
        if (meta.turnId !== e.turnId || meta.instruction !== e.text) continue;
        pendingCommentTurnsRef.current.delete(id);
        clearCommentProcessing(id);
        void appendAiReply(id, commentFailReply(id, meta.target));
        cleared++;
      }
      if (cleared > 0) return;
    }
    failCommentTurnsByFp(e.text);
  }, [clearCommentProcessing, appendAiReply, commentFailReply, failCommentTurnsByFp]);

  /**
   * #1091: 快照落库（fire-and-forget）— 写回落地时把写回前画布 deck PATCH
   * 到服务端（pending-confirm 态的持久化半步）。成功后把服务端回显并回灌
   * 本地 wire（listDocComments 下一次拉取即携带）；失败不阻断 — 撤销窗口
   * 仍以内存快照兜底，仅刷新后的恢复入口缺席。
   */
  const persistDeckSnapshot = useCallback(async (commentId: string, snapshot: string) => {
    if (!docId) return;
    try {
      const updated = await api.updateDocComment(docId, commentId, undefined, { deck_snapshot: snapshot });
      setDocComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, deck_snapshot: updated.deck_snapshot ?? snapshot } : c)));
    } catch { /* 落库失败不阻断主流程 — 内存快照仍可用 */ }
  }, [docId, setDocComments]);

  /**
   * #1041: 评论处理 turn 收口 — 产生 diff 的正文评论已由 attach 消费；剩余：
   * - 正文评论未产生写回（edit_document 定位失败/模型未动文档）→ AI 回复失败
   *   说明与候选（用例 5），评论保持 open 可重触发；
   * - #1051 deck 评论：deck 无 diff 审阅（edit_deck 写回直接落画布）→ turn 期间
   *   Doc.deck 有变化 = 修改已生效（AI 回复 + #1088 进入待确认态），无变化则
   *   失败说明（无修改失败路径维持现状，用例 4 回归）。
   * #1060: 只收口「本 turn 实际发出其指令」的评论（指纹 = 会话最后一条非附件
   * 提示的 user 消息）— 排队中/被覆盖的评论不被本 turn 误收口（此前扫全部
   * user 消息的 sent 判定会把排队评论一并冲掉，即误归属窗口之一）。
   * #1088: deck 写回不再自动 resolved — 线程进入待确认态（确认/撤销按钮），
   * 撤销快照 = 登记时的 deck 基线（deckKeyAtStart）。
   */
  const settlePendingCommentTurns = useCallback(() => {
    if (pendingCommentTurnsRef.current.size === 0) return;
    const fp = currentTurnInstruction();
    const matched = fp === null
      ? []
      : [...pendingCommentTurnsRef.current.entries()].filter(([, meta]) => meta.instruction === fp);
    if (matched.length === 0) return;
    // #1051: deck 评论独立收口 — deck 无 diff 审阅（edit_deck 写回直接落画布），
    // 不受正文审阅/写回队列状态影响。turn 期间 Doc.deck 有变化 = 修改已生效。
    const sess = docId ? useChatStore.getState().sessions[`doc-${docId}`] : undefined;
    const deckNow = JSON.stringify(sess?.lastDocDeck ?? null);
    for (const [id, meta] of matched) {
      pendingCommentTurnsRef.current.delete(id);
      clearCommentProcessing(id);
      if (meta.target !== 'deck_slide') continue;
      if (deckNow !== meta.deckKeyAtStart) {
        void appendAiReply(id, lastAssistantAnswer() || t('writing.commentAiDeckDone', 'AI 已按评论意见修改幻灯片（画布已更新）。'));
        // #1088: 不再自动 resolved — 进入待确认态，撤销快照 = 登记时的画布 deck。
        // #1091: 快照同步落库（写回落地处）— 撤销恢复点持久化，刷新后按钮态
        // 可恢复。覆盖策略：内存待确认态或 wire 快照任一在场即跳过（重复 AI
        // 处理不覆盖已有快照 — 栈式语义从简，撤销始终回到最初 pre-AI 态）。
        const prevDeck = meta.prevDeck ?? null;
        const wireHasSnapshot = !!docCommentsRef.current.find((c) => c.id === id)?.deck_snapshot;
        const hadPending = deckConfirmRef.current.has(id);
        deckConfirmRef.current.set(id, { prevDeck });
        setDeckPendingConfirm((prev) => ({ ...prev, [id]: { undoable: prevDeck !== null || wireHasSnapshot } }));
        if (prevDeck !== null && !hadPending && !wireHasSnapshot) {
          void persistDeckSnapshot(id, JSON.stringify(prevDeck));
        }
      } else {
        void appendAiReply(id, commentFailReply(id, 'deck_slide'));
      }
    }
    // #1041: 正文评论 — 写回排队中（审阅未决跨轮入队）→ 留待队列重放开审阅时
    // 关联（attachCommentSourcesToReview），不误报失败；否则 = 本 turn 未产生
    // 任何写回（edit_document 定位失败/模型未动文档）→ 失败 AI 回复（用例 5）。
    if (diffPendingRef.current || writeBackQueueRef.current.length > 0) return;
    for (const [id, meta] of matched) {
      if (meta.target !== 'section') continue;
      void appendAiReply(id, commentFailReply(id, 'section'));
    }
  }, [docId, currentTurnInstruction, clearCommentProcessing, appendAiReply, lastAssistantAnswer, commentFailReply, t, writeBackQueueRef, persistDeckSnapshot]);

  // ── #1088: deck 写回人工确认闭环 ────────────────────────────────────
  // 状态机：processing →（写回落地）pending-confirm → 确认（resolved）/
  // 撤销（恢复快照 + open + 线程补「已撤销」说明）。pending-confirm 无 TTL
  // （8s 撤销横幅是 #1071-1 的独立补救出口，超时不再强制收口本态）。
  // #1091: 态与快照双持久化 — pending-confirm 按钮态可从服务端快照恢复
  // （内存 map 或 wire.deck_snapshot 任一在场即渲染），撤销/确认成功后清
  // 服务端快照。

  /**
   * 撤销收口（共享）— 清待确认态 + #1091 服务端快照同步清除 + 线程追加
   * 「已撤销」说明；评论保持 open 可重新处理。清除失败不收口线程快照态
   * （wire.deck_snapshot 保留，按钮仍可重试）；落盘侧由调用方先行完成。
   */
  const finishDeckUndo = useCallback(async (commentId: string) => {
    deckConfirmRef.current.delete(commentId);
    setDeckPendingConfirm((prev) => {
      if (!prev[commentId]) return prev;
      const next = { ...prev };
      delete next[commentId];
      return next;
    });
    // #1091: 服务端快照清除（null 语义）— 撤销完成后服务端不再保留恢复点。
    if (docId) {
      try {
        const updated = await api.updateDocComment(docId, commentId, undefined, { deck_snapshot: null });
        setDocComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, deck_snapshot: updated.deck_snapshot ?? null } : c)));
      } catch { /* 清除失败 — 服务端快照保留，按钮态仍在（可重试） */ }
    }
    await appendAiReply(commentId, t('writing.commentAiDeckUndone', '已撤销本次 AI 的幻灯片修改，画布已恢复为处理前版本 — 评论保持打开，可重新处理。'));
  }, [docId, appendAiReply, setDocComments, t]);

  /**
   * #1088: 「确认修改」— PATCH resolved（正文 diff accept 的对等语义）。
   * #1091: 同一 PATCH 清服务端快照（status='resolved' + deck_snapshot=null，
   * 与 issue 定案一致）；入口兼容刷新后的纯服务端态 — 内存待确认或
   * wire.deck_snapshot 任一在场均可确认。
   */
  const confirmDeckWriteBack = useCallback(async (commentId: string) => {
    const wireHasSnapshot = !!docCommentsRef.current.find((c) => c.id === commentId)?.deck_snapshot;
    if (!deckConfirmRef.current.has(commentId) && !wireHasSnapshot) return;
    deckConfirmRef.current.delete(commentId);
    setDeckPendingConfirm((prev) => {
      if (!prev[commentId]) return prev;
      const next = { ...prev };
      delete next[commentId];
      return next;
    });
    if (docId) {
      try {
        const updated = await api.updateDocComment(docId, commentId, 'resolved', { deck_snapshot: null });
        setDocComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, status: updated.status, resolved_at: updated.resolved_at, deck_snapshot: updated.deck_snapshot ?? null } : c)));
      } catch { /* 状态更新失败保持 open — 用户可手动标记 */ }
    }
    onNotice(t('writing.commentDeckConfirmDone', '已确认修改 — 评论已标记解决'), 3000);
  }, [docId, setDocComments, onNotice, t]);

  /**
   * #1088: 「撤销修改」— 恢复写回前 deck 快照（经路由接线的
   * restoreDeckSnapshot：force 落盘覆盖服务端 AI 版本）+ 评论保持 open +
   * 线程追加「已撤销」说明 + #1091 服务端快照清除（finishDeckUndo）。
   * #1091: 恢复目标**服务端快照优先** — 刷新后内存快照丢失（或被重复处理
   * 覆盖）也能按 wire.deck_snapshot 回到最初 pre-AI 画布；wire 无快照才回退
   * 内存快照。互斥守卫同 #1043 KeepMine：正文审阅未决/写回批次待冲刷时
   * body 处于审阅前状态，连带 force 落盘会盖回审阅前正文 — 先让用户处理
   * 审阅，待确认态保留可重试。落盘失败同样保留待确认态（警示条已挂，
   * 重试撤销即可）。
   */
  const undoDeckWriteBackForComment = useCallback(async (commentId: string) => {
    // #1091: 服务端快照优先 — 解析失败/缺失回退内存登记的写回前画布。
    const wireSnapshot = docCommentsRef.current.find((c) => c.id === commentId)?.deck_snapshot ?? null;
    let target: DeckWire | null = null;
    if (wireSnapshot) {
      try {
        target = JSON.parse(wireSnapshot) as DeckWire;
      } catch {
        target = null;
      }
    }
    if (!target) target = deckConfirmRef.current.get(commentId)?.prevDeck ?? null;
    if (!target) return;
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      onNotice(t('writing.reviewFirstForDeckUndo', '请先处理当前的 AI 修改审阅，再撤销幻灯片修改'));
      return;
    }
    const ok = await onRestoreDeckSnapshot(target);
    if (!ok) return;
    await finishDeckUndo(commentId);
  }, [diffReview, pendingWriteBackRef, onNotice, t, onRestoreDeckSnapshot, finishDeckUndo]);

  /**
   * #1088: 8s 撤销横幅（#1071-1）先行撤销时的收口联动 — 快照一致（同一笔
   * 写回）的待确认态同步清账并补「已撤销」说明；画布已被横幅出口恢复，
   * 评论侧只做状态收口，不再重复落盘（不冲突：两个出口各自幂等）。
   */
  const settleDeckConfirmUndo = useCallback(async (prevDeck: DeckWire | null) => {
    if (!prevDeck) return;
    const key = JSON.stringify(prevDeck);
    for (const [id, entry] of [...deckConfirmRef.current.entries()]) {
      if (JSON.stringify(entry.prevDeck) !== key) continue;
      await finishDeckUndo(id);
    }
  }, [finishDeckUndo]);

  /**
   * #1041: 「请AI处理」— 评论正文（编辑指令）+ anchorText 定位上下文 +
   * sectionId/slideIndex 组装成指令文本，走现有 chat 驱动编辑管道
   * （sendChatText → doc- 工具循环）：正文评论 → edit_document（old_text
   * 用 anchorText）；#1051 deck 评论 → edit_deck。产出复用既有
   * doc_updated → diffReview → ProposalCard accept/reject 流，不做新 diff UI。
   * 用例 6：处理中二次点击忽略（同步登记 + 按钮 loading/禁用双保险）。
   * #1060: 单评论单 turn — 已有待收口评论时拒绝登记第二个（面板按钮禁用
   * 是 UX 层，此处 ref 级守卫兜底）：排队单槽同一时刻只容纳一条指令，
   * 第二条评论指令要么被覆盖丢弃（卡死源）要么与首条共享冲刷窗口（误
   * 归属源）。登记置于全部守卫之后，指令文本即收口匹配用的指纹。
   * #1074-4: 指令入队（排队等待真实 turn）后捕获排队槽的显式 turnId —
   * 丢弃事件按它精确清账;直发（未排队）无槽可读,登记保持无 turnId。
   */
  const handleCommentAiProcess = useCallback((c: DocCommentWire) => {
    if (!docId || c.status === 'resolved') return;
    if (pendingCommentTurnsRef.current.has(c.id)) return;
    if (pendingCommentTurnsRef.current.size > 0) return;
    // 与生成 Methods 同一互斥纪律：审阅未决/写回批次待冲刷时先完成审阅。
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      onNotice(t('writing.reviewFirstForComment', '请先完成当前的 AI 修改审阅，再处理评论'));
      return;
    }
    const instructionText = c.replies.filter((r) => r.role === 'user').map((r) => r.text.trim()).filter(Boolean).join('\n');
    if (!instructionText) return;
    const isDeck = c.target === 'deck_slide';
    // 用例 5：定位失败（located=false）时仍可发起，但指令注明锚点可能漂移。
    const driftNote = c.anchor?.located === false
      ? '- 注意：该锚点片段可能已在' + (isDeck ? '幻灯片' : '文档') + '中漂移，如无法精确定位，请基于最接近的原文处理，或在回复中说明定位失败与候选。\n'
      : '';
    const instruction = isDeck
      ? [
          '【评论处理】请按以下评论意见修改 deck（幻灯片）：',
          `- 目标位置：第 ${c.slide_index ?? '?'} 页（slide_index，1-based）`,
          `- 该页锚点片段（用于定位原文）：「${c.anchor_text}」`,
          driftNote,
          `- 评论意见（编辑指令）：${instructionText}`,
          '请直接调用 edit_deck 工具完成修改（action 用 update，slide_index 用上面的页码；删页/插页/调布局选合适的 action）。完成后请在回复中说明你做了什么修改。',
        ].filter(Boolean).join('\n')
      : [
          '【评论处理】请按以下评论意见修改文档正文：',
          `- 目标位置：section「${c.section_id}」`,
          `- 原文片段（edit_document 的 old_text）：「${c.anchor_text}」`,
          driftNote,
          `- 评论意见（编辑指令）：${instructionText}`,
          '请直接调用 edit_document 工具完成修改（old_text 用上面的原文片段，new_text 为按评论意见修改后的内容）。完成后请在回复中说明你做了什么修改。',
        ].filter(Boolean).join('\n');
    // 同步登记 — 防同帧双击并发（用例 6）；deck 评论记录起始 deck 基线用于收口判定。
    // #1088: 同时捕获画布快照（撤销修改的恢复目标 — 画布是含文档装载/本地
    // 编辑的最新 deck，比 store 的 lastDocDeck 更贴近「写回前」状态）。
    pendingCommentTurnsRef.current.set(c.id, {
      target: isDeck ? 'deck_slide' : 'section',
      ...(isDeck ? { deckKeyAtStart: JSON.stringify(useChatStore.getState().sessions[`doc-${docId}`]?.lastDocDeck ?? null) } : {}),
      ...(isDeck ? { prevDeck: deckSnapshotNow() } : {}),
      instruction,
    });
    setCommentProcessing((prev) => ({ ...prev, [c.id]: true }));
    // #1060: loading 与 turn 真实边界对齐 — 不再在 send promise 的 finally
    // 收口（排队时入队即 resolve，按钮会提前复活而 turn 尚未运行）。改由
    // 消费点（attach/settle）或 pending 覆盖/清理事件统一收口。
    void (async () => {
      await sendChatText(instruction);
      // #1074-4: 入队捕获 turnId — 与登记比对排队槽文本一致才记（槽已被
      // 覆盖/消费时不记,丢弃事件回退指纹路径）。
      const queued = docId ? useChatStore.getState().sessions[`doc-${docId}`]?.pending : undefined;
      const queuedTurnId = pendingTurnId(docId ? `doc-${docId}` : '');
      if (queued && queued.text === instruction && queuedTurnId) {
        const reg = pendingCommentTurnsRef.current.get(c.id);
        if (reg) pendingCommentTurnsRef.current.set(c.id, { ...reg, turnId: queuedTurnId });
      }
    })();
  }, [docId, diffReview, pendingWriteBackRef, onNotice, t, sendChatText, deckSnapshotNow]);

  // #1060: 排队指令被覆盖/Stop/regenerate 清空 — store 单槽只保留最后一条,
  // 被静默丢弃的评论指令此前永久滞留登记表（has() 守卫反把合法重试挡死,
  // 仅切文档才清）。订阅丢弃事件:按 turnId 精确清账（#1074-4,指纹为二重
  // 校验/回退路径）— 登记清空+按钮 loading 收口+线程补失败说明,被覆盖的
  // 评论可立即重试。
  useEffect(() => {
    if (!docId) return;
    const sid = `doc-${docId}`;
    return onChatPendingDropped((e) => {
      if (e.sessionId !== sid) return;
      failCommentTurnsByDrop(e);
    });
  }, [docId, failCommentTurnsByDrop]);

  /** 切文档双保险 — #1041: 旧文档的 pending turn/审阅关联/按钮 loading 不得串染。 */
  const resetForDocSwitch = useCallback(() => {
    pendingCommentTurnsRef.current.clear();
    diffCommentSourcesRef.current = null;
    // #1088: 待确认态（快照属于旧文档）一并清空。
    deckConfirmRef.current.clear();
    setDeckPendingConfirm({});
    setCommentProcessing({});
  }, []);

  return {
    pendingCommentTurnsRef,
    diffCommentSourcesRef,
    diffReviewKeyRef,
    diffPendingRef,
    commentProcessing,
    clearCommentProcessing,
    currentTurnInstruction,
    lastAssistantAnswer,
    appendAiReply,
    resolveCommentById,
    commentFailReply,
    takeSectionCommentTurns,
    attachCommentSourcesToReview,
    failCommentTurnsByFp,
    settlePendingCommentTurns,
    deckPendingConfirm,
    confirmDeckWriteBack,
    undoDeckWriteBackForComment,
    settleDeckConfirmUndo,
    handleCommentAiProcess,
    resetForDocSwitch,
  };
}
