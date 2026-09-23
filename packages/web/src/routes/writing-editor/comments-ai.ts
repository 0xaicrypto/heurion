import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import type { DocCommentWire } from '@/lib/api';
// #1074-4: 显式 turnId — 排队槽入队 id;#1072-2 web 适配: SSE 服务端
// assistant 消息 id 的记录/读取（latestAssistantTurnId）。
// #1095: pending 多槽 FIFO 队列 — pendingQueuePosition 供「排队第 n 位」提示。
import { latestAssistantTurnId, onChatPendingDropped, pendingQueuePosition, useChatStore, type ChatPendingDropped } from '@/stores/chat';

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
  /**
   * #1113: 登记时的 deck 工件版本 — turn 收口按版本变化判定 deck 评论成败
   * （对齐 edit_deck_bytes 的工件真相源；撤销由画布的「整轮撤销」承接）。
   */
  deckVersionAtStart?: string | null;
  /**
   * #1095: 登记分两步 — 点击即登记（target 锁定防同评论双击），anchor
   * 重取后补齐 instruction（收口指纹）；发送通道异常时清理半登记。
   */
  instruction?: string;
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
  /**
   * 发送通道（doc-chat hook 的 sendChatText）。
   * #1095: 返回值 = 排队时该指令槽的显式 turnId（直发为 undefined）—
   * 评论并行处理以此登记/清账（丢弃事件按 id 精确匹配）。
   * 复审 #5: extra 透传 — 评论槽打 queueTag:'comment'（交互 replace-last
   * 覆盖语义不吃掉已排队评论指令）。
   */
  sendChatText: (text: string, extra?: { queueTag?: 'comment' }) => Promise<string | undefined>;
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
  /**
   * #1095: 排队位次镜像（commentId → 队列中位次，1-based）— 面板按钮
   * 「排队第 n 位」提示的数据源；不在队列（已执行/直发）为 0/缺省。
   */
  commentQueuePositions: Record<string, number>;
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
  /** #1041: 「请AI处理」入口（面板按钮）。 */
  handleCommentAiProcess: (c: DocCommentWire) => void;
  /** 切文档双保险 — 登记/审阅关联/按钮 loading 一次清空。 */
  resetForDocSwitch: () => void;
}

export function useCommentsAi(input: CommentsAiInput): CommentsAi {
  const { t } = useTranslation();
  const { docId, docComments, setDocComments, diffReview, pendingWriteBackRef, writeBackQueueRef, sendChatText, onNotice } = input;

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
  /** 复审 #6: 评论并行并发上限 — 队列过深时后排锚点失真 + 无告警；到顶明示。 */
  const MAX_CONCURRENT_COMMENT_TURNS = 5;
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
  /**
   * #1095: 排队位次镜像 — 已登记 turnId 的评论在 FIFO 队列中的位次。
   * store 订阅驱动（队列任意变化重算；值不变不触发渲染）。
   */
  const [commentQueuePositions, setCommentQueuePositions] = useState<Record<string, number>>({});
  const docCommentsRef = useRef(docComments);
  docCommentsRef.current = docComments;

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
   *  （#1096: accept = 采纳本轮修改，评论保持 open — 不再自动 resolved）。
   *  #1060: fp = 写回所属 turn 的指令指纹；消费时同步收按钮 loading（与
   *  turn 真实边界对齐，替代 send promise 的提前 finally 收口）。 */
  const attachCommentSourcesToReview = useCallback((reviewKey: string, fp: string | null) => {
    const ids = takeSectionCommentTurns(fp);
    if (ids.length === 0) return;
    diffCommentSourcesRef.current = { key: reviewKey, ids };
    const aiText = lastAssistantAnswer()
      || t('writing.commentAiDiffReply', 'AI 已按评论意见生成修改建议 — 请审阅 diff；接受后即采纳本轮修改，评论保持打开，可继续多轮交互。');
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
   * #1041: 评论处理 turn 收口 — 产生 diff 的正文评论已由 attach 消费；剩余：
   * - 正文评论未产生写回（edit_document 定位失败/模型未动文档）→ AI 回复失败
   *   说明与候选（用例 5），评论保持 open 可重触发；
   * - #1051/#1113 deck 评论：edit_deck_bytes 写回直接改工件版本 → 登记与
   *   turn 收口时的 lastDocDeckVersion 不同 = 修改已生效（AI 回复；撤销由
   *   画布的「整轮撤销」承接），相同则失败说明（用例 4 回归）。
   * #1060: 只收口「本 turn 实际发出其指令」的评论（指纹 = 会话最后一条非附件
   * 提示的 user 消息）— 排队中/被覆盖的评论不被本 turn 误收口（此前扫全部
   * user 消息的 sent 判定会把排队评论一并冲掉，即误归属窗口之一）。
   */
  const settlePendingCommentTurns = useCallback(() => {
    if (pendingCommentTurnsRef.current.size === 0) return;
    const fp = currentTurnInstruction();
    const matched = fp === null
      ? []
      : [...pendingCommentTurnsRef.current.entries()].filter(([, meta]) => meta.instruction === fp);
    if (matched.length === 0) return;
    // #1113: deck 评论独立收口 — 以工件版本变化为成败判定（无 diff 审阅，
    // 不受正文审阅/写回队列状态影响）。
    const sess = docId ? useChatStore.getState().sessions[`doc-${docId}`] : undefined;
    const deckVersionNow = sess?.lastDocDeckVersion ?? null;
    // #1041: 正文评论 — 写回排队中（审阅未决跨轮入队）→ **保留登记**留待队列
    // 重放开审阅时关联（attachCommentSourcesToReview 按该轮指纹消费），不误报
    // 失败；否则 = 本 turn 未产生任何写回（edit_document 定位失败/模型未动
    // 文档）→ 删除登记 + 失败 AI 回复（用例 5）。
    // #1095 修复：此前 matched 条目在此处**先删后判** — 未决跨轮时登记被
    // 静默清掉，队列重放时 attach 找不到条目 → 评论永久无回复（多评论排队
    // 下必现）。改为未决时只挂起（登记+loading 保留），仅失败路径才删除。
    const deferSection = diffPendingRef.current || writeBackQueueRef.current.length > 0;
    for (const [id, meta] of matched) {
      if (meta.target !== 'deck_slide') {
        if (deferSection) continue;
        pendingCommentTurnsRef.current.delete(id);
        clearCommentProcessing(id);
        void appendAiReply(id, commentFailReply(id, 'section'));
        continue;
      }
      pendingCommentTurnsRef.current.delete(id);
      clearCommentProcessing(id);
      if (deckVersionNow !== (meta.deckVersionAtStart ?? null)) {
        void appendAiReply(id, lastAssistantAnswer() || t('writing.commentAiDeckDone', 'AI 已按评论意见修改幻灯片（画布已更新，可在画布上整轮撤销）。'));
      } else {
        void appendAiReply(id, commentFailReply(id, 'deck_slide'));
      }
    }
  }, [docId, currentTurnInstruction, clearCommentProcessing, appendAiReply, lastAssistantAnswer, commentFailReply, t, writeBackQueueRef]);

  /**
   * #1041: 「请AI处理」— 评论正文（编辑指令）+ anchorText 定位上下文 +
   * sectionId/slideIndex 组装成指令文本，走现有 chat 驱动编辑管道
   * （sendChatText → doc- 工具循环）：正文评论 → edit_document（old_text
   * 用 anchorText）；#1051/#1113 deck 评论 → edit_deck_bytes（工件字节，
   * 画布实时落地 + 整轮撤销）。产出复用既有 doc_updated → diffReview →
   * ProposalCard accept/reject 流，不做新 diff UI。
   * 用例 6：同评论处理中二次点击忽略（同步登记 + 按钮 loading/禁用双保险）。
   * #1095（Phase 1 排队式并行）：放开单评论单 turn 守卫 — N 个评论可同时
   * 处于「已排队/处理中」，各自独立 turnId + 状态机；执行层仍串行（chat
   * 会话 FIFO 逐个 turn，同文档写回无并发竞争）。#1060 的"第二条登记被拒"
   * 守卫（size>0）随之退役；指纹收口仍按「本 turn 实际发出的指令」精确归属。
   * #1074-4: sendChatText 返回入队槽的显式 turnId — 丢弃事件按它精确清账；
   * 直发（未排队）返回 undefined，登记保持无 turnId（收口走指纹）。
   * #1095 漂移注意：串行执行时后排评论的指令基于前排修改后的正文 —
   * 登记前重取 anchor 诊断（列表接口 with_anchor 已有），最新锚点随指令发出。
   */
  const handleCommentAiProcess = useCallback((c: DocCommentWire) => {
    if (!docId || c.status === 'resolved') return;
    if (pendingCommentTurnsRef.current.has(c.id)) return;
    // 复审 #6: 并发上限 — 无界队列下 10+ 条评论连点会让后排指令的锚点随
    // 前排编辑落地逐渐失真且无降级。限深 5：到顶明示用户等待（不静默拒绝）。
    if (pendingCommentTurnsRef.current.size >= MAX_CONCURRENT_COMMENT_TURNS) {
      onNotice(t('writing.commentQueueFull', '已有 {{n}} 条评论在排队处理 — 请等待部分完成后再继续', { n: MAX_CONCURRENT_COMMENT_TURNS }));
      return;
    }
    // 与生成 Methods 同一互斥纪律：审阅未决/写回批次待冲刷时先完成审阅。
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      onNotice(t('writing.reviewFirstForComment', '请先完成当前的 AI 修改审阅，再处理评论'));
      return;
    }
    const sid = `doc-${docId}`;
    // #1095: 同评论防双击后，立刻乐观置 loading — 后续 anchor 重取/入队
    // 期间按钮即锁定（等待中的位次提示由订阅 effect 补齐）。
    pendingCommentTurnsRef.current.set(c.id, {
      target: c.target === 'deck_slide' ? 'deck_slide' : 'section',
    });
    setCommentProcessing((prev) => ({ ...prev, [c.id]: true }));
    void (async () => {
      try {
        // #1095: 处理前重取 anchor 诊断 — 排队执行时正文可能已被前排 turn
        // 修改；重取保证指令里的 old_text 尽量新鲜（漂移仍由 AI 回复带候选兜底）。
        let fresh: DocCommentWire = c;
        try {
          const listed = await api.listDocComments(docId, { with_anchor: true });
          const hit = listed.comments.find((x) => x.id === c.id);
          if (hit) fresh = hit;
        } catch { /* 重取失败用点击时的锚点（原行为） */ }
        const instructionText = fresh.replies.filter((r) => r.role === 'user').map((r) => r.text.trim()).filter(Boolean).join('\n');
        if (!instructionText) {
          pendingCommentTurnsRef.current.delete(c.id);
          clearCommentProcessing(c.id);
          return;
        }
        const isDeck = fresh.target === 'deck_slide';
        // 用例 5：定位失败（located=false）时仍可发起，但指令注明锚点可能漂移。
        const driftNote = fresh.anchor?.located === false
          ? '- 注意：该锚点片段可能已在' + (isDeck ? '幻灯片' : '文档') + '中漂移，如无法精确定位，请基于最接近的原文处理，或在回复中说明定位失败与候选。\n'
          : '';
        const instruction = isDeck
          ? [
              '【评论处理】请按以下评论意见修改 deck（幻灯片 pptx 画布）：',
              `- 目标位置：第 ${fresh.slide_index ?? '?'} 页（slide_index，1-based）`,
              `- 该页锚点片段（用于定位原文）：「${fresh.anchor_text}」`,
              driftNote,
              `- 评论意见（编辑指令）：${instructionText}`,
              // #1112/#1113: deck 编辑唯一路径 = edit_deck_bytes（工件字节）。修改会在用户画布上实时落地，用户可整轮撤销。
              '请直接调用 edit_deck_bytes 工具完成修改（按 slide_index 定位目标页；具体 action/参数以工具 schema 为准）。完成后请在回复中说明你做了什么修改。',
            ].filter(Boolean).join('\n')
          : [
              '【评论处理】请按以下评论意见修改文档正文：',
              `- 目标位置：section「${fresh.section_id}」`,
              `- 原文片段（edit_document 的 old_text）：「${fresh.anchor_text}」`,
              driftNote,
              `- 评论意见（编辑指令）：${instructionText}`,
              '请直接调用 edit_document 工具完成修改（old_text 用上面的原文片段，new_text 为按评论意见修改后的内容）。完成后请在回复中说明你做了什么修改。',
            ].filter(Boolean).join('\n');
        // 登记补全 — #1113: deck 评论记录登记时的工件版本，turn 收口按版本
        // 变化判定成败（撤销由画布「整轮撤销」承接，不再存每评论快照）。
        const reg = pendingCommentTurnsRef.current.get(c.id);
        if (reg) {
          pendingCommentTurnsRef.current.set(c.id, {
            ...reg,
            ...(isDeck ? { deckVersionAtStart: useChatStore.getState().sessions[sid]?.lastDocDeckVersion ?? null } : {}),
            instruction,
          });
        }
        // 复审 #5: 评论槽打 queueTag — 交互式输入的 replace-last 覆盖语义
        // 不会吃掉已排队的评论指令（评论并行批处理不受交互输入影响）。
        const queuedTurnId = await sendChatText(instruction, { queueTag: 'comment' });
        // #1095: 入队返回显式 turnId — 登记（丢弃事件按 id 精确清账）；
        // 直发（未排队）为 undefined，登记保持无 turnId（指纹收口兜底）。
        if (queuedTurnId) {
          const cur = pendingCommentTurnsRef.current.get(c.id);
          if (cur) pendingCommentTurnsRef.current.set(c.id, { ...cur, turnId: queuedTurnId });
        }
      } catch (err) {
        // #1095: 发送通道异常（网络等）— 不留死登记（has() 守卫会挡死重试）。
        pendingCommentTurnsRef.current.delete(c.id);
        clearCommentProcessing(c.id);
        void appendAiReply(c.id, t('writing.commentAiSendFail', 'AI 处理发起失败：{{msg}} — 评论保持打开，可重试。', { msg: err instanceof Error ? err.message : String(err) }));
      }
    })();
  }, [docId, diffReview, pendingWriteBackRef, onNotice, t, sendChatText, clearCommentProcessing, appendAiReply]);

  // #1060: 排队指令被 Stop/regenerate 清空 — 丢弃事件按 turnId 精确清账
  // （#1074-4,指纹为二重校验/回退路径）— 登记清空+按钮 loading 收口+线程补
  // 失败说明,被清的评论可立即重试。
  // #1095: 多槽队列下排队不再互相覆盖（覆盖丢弃路径退役）— 事件只剩
  // Stop/regenerate 清队两个来源。
  useEffect(() => {
    if (!docId) return;
    const sid = `doc-${docId}`;
    return onChatPendingDropped((e) => {
      if (e.sessionId !== sid) return;
      failCommentTurnsByDrop(e);
    });
  }, [docId, failCommentTurnsByDrop]);

  // #1095: 队列位次镜像 — 订阅 store 任意变化，重算已登记 turnId 的评论在
  // FIFO 队列中的位次（1-based；不在队列=0 即移除）。仅值变化时 setState。
  useEffect(() => {
    const recompute = () => {
      const sid = docId ? `doc-${docId}` : '';
      const entries = [...pendingCommentTurnsRef.current.entries()]
        .filter(([, meta]) => !!meta.turnId)
        .map(([id, meta]) => [id, pendingQueuePosition(sid, meta.turnId!)] as const)
        .filter(([, pos]) => pos > 0);
      setCommentQueuePositions((prev) => {
        const next: Record<string, number> = {};
        for (const [id, pos] of entries) next[id] = pos;
        const prevKeys = Object.keys(prev);
        if (prevKeys.length === entries.length && entries.every(([id, pos]) => prev[id] === pos)) return prev;
        return next;
      });
    };
    recompute();
    return useChatStore.subscribe(recompute);
  }, [docId]);

  /** 切文档双保险 — #1041: 旧文档的 pending turn/审阅关联/按钮 loading 不得串染。 */
  const resetForDocSwitch = useCallback(() => {
    pendingCommentTurnsRef.current.clear();
    diffCommentSourcesRef.current = null;
    setCommentProcessing({});
    setCommentQueuePositions({});
  }, []);

  return {
    pendingCommentTurnsRef,
    diffCommentSourcesRef,
    diffReviewKeyRef,
    diffPendingRef,
    commentProcessing,
    clearCommentProcessing,
    commentQueuePositions,
    currentTurnInstruction,
    lastAssistantAnswer,
    appendAiReply,
    resolveCommentById,
    commentFailReply,
    takeSectionCommentTurns,
    attachCommentSourcesToReview,
    failCommentTurnsByFp,
    settlePendingCommentTurns,
    handleCommentAiProcess,
    resetForDocSwitch,
  };
}
