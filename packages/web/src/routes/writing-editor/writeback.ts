/**
 * #837/#927/#989/#1041/#1060 拆分: AI 写回流水线 hook — doc_updated 消费、
 * 同轮合批、跨轮累计队列、刷新恢复审阅、diff 审阅落地（接受/放弃+回滚保存）。
 * 从 writing-editor.tsx 抽出（拆分记录: persistence / write-back / comments
 * 三块中的 write-back）。行为与抽出前逐行等价；评论关联经 commentsAi 的
 * 暴露点注入（指纹匹配），不 import 评论模块。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockProjection } from '@heurion/contracts';
import type { DiffReviewState } from '@/components/DocEditor';
import { api, ApiError } from '@/lib/api';
import { mergeThreeWay, describeConflictSections } from '@/lib/doc-merge';
import { diffProjectionSections } from '@/lib/block-projection';
import type { SectionLite } from '@/lib/block-projection';
import { lineDiffRows, extractSectionText, type SectionCardRow } from '@/lib/section-cards';
import { shouldApplyDocRev } from '@/lib/chat-reducer';
import { onChatTurnComplete } from '@/stores/chat';
import type { SessionState } from '@/stores/chat';
import type { CommentsAi } from './comments-ai';
import type { DocDetail } from './types';
import type { SaveConflictState, SaveDocResult, ServerDocState } from './persistence';

const BATCH_FALLBACK_MS = 60_000;

type WriteBackCommentsPort = Pick<
  CommentsAi,
  | 'diffPendingRef'
  | 'diffReviewKeyRef'
  | 'diffCommentSourcesRef'
  | 'currentTurnInstruction'
  | 'attachCommentSourcesToReview'
  | 'failCommentTurnsByFp'
  | 'settlePendingCommentTurns'
>;

export interface UseDocWriteBackInput {
  docId?: string;
  doc: DocDetail | null;
  title: string;
  chatSession: SessionState | undefined;
  chatLoading: boolean;
  bodyRef: MutableRefObject<string>;
  serverBodyRef: MutableRefObject<string | null>;
  lastSavedBody: MutableRefObject<string | null>;
  /** 已应用的 AI 写回正文基线 — 与注入/引用清除路径共用（路由持有）。 */
  appliedDocBodyRef: MutableRefObject<string | null>;
  dirtyRef: MutableRefObject<boolean>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  setBody: Dispatch<SetStateAction<string>>;
  setDoc: Dispatch<SetStateAction<DocDetail | null>>;
  setTitle: Dispatch<SetStateAction<string>>;
  setDiffReview: Dispatch<SetStateAction<DiffReviewState | null>>;
  restoreReview: { snapshotId: string; label: string } | null;  setRestoreReview: Dispatch<SetStateAction<{ snapshotId: string; label: string } | null>>;
  setChatSelection: Dispatch<SetStateAction<string>>;
  setViewMode: Dispatch<SetStateAction<'document' | 'deck'>>;
  applyServerDoc: (fresh: ServerDocState) => void;
  saveDoc: (title: string, body: string, opts?: { deck?: unknown; force?: boolean }) => Promise<SaveDocResult>;
  markSaveFailed: (err: unknown) => void;
  setSaveConflict: Dispatch<SetStateAction<SaveConflictState | null>>;
  setSaveFailure: Dispatch<SetStateAction<{ count: number; message: string } | null>>;
  extractConflictCurrent: (err: unknown) => ServerDocState | undefined;
  /** #927: 冲突「载入最新」挂起的服务端完整态 — persistence 写入、本 hook 消费。 */
  conflictLoadRef: MutableRefObject<DocDetail | null>;
  showNotice: (text: string, ttlMs?: number) => void;
  commentsAi: WriteBackCommentsPort;
  /** turn 收口副作用（画布整轮撤销边界前移）— 由路由注入 deck 域状态。 */
  onTurnComplete: () => void;
}

export interface DocWriteBackController {
  queuedRounds: number;
  editingSections: SectionLite[];
  sectionDiffRows: Record<string, SectionCardRow[]>;
  setEditingSections: Dispatch<SetStateAction<SectionLite[]>>;
  handleDiffResolve: (result: { md: string; accepted: number; rejected: number; cancelled: boolean }) => void;
}

export function useDocWriteBack(input: UseDocWriteBackInput): DocWriteBackController {
  const { docId, doc, title, chatSession, chatLoading, bodyRef, serverBodyRef, lastSavedBody,
    appliedDocBodyRef, dirtyRef, setDirty, setBody, setDoc, setTitle, setDiffReview, restoreReview,
    setRestoreReview, setChatSelection, setViewMode, applyServerDoc, saveDoc, markSaveFailed,
    setSaveConflict, setSaveFailure, extractConflictCurrent, conflictLoadRef, showNotice, onTurnComplete } = input;
  const { t } = useTranslation();

  // 评论-AI 暴露点经入参注入（成员身份稳定，与抽出前 deps 逐项对齐）。
  const {
    diffPendingRef, diffReviewKeyRef, diffCommentSourcesRef, currentTurnInstruction,
    attachCommentSourcesToReview, failCommentTurnsByFp, settlePendingCommentTurns,
  } = input.commentsAi;

  // §15.4 / #553: AI write-back 不再静默替换正文 — 进入审阅模式,用户
  // 逐条/全部接受或拒绝后由 onDiffResolve 落地。
  // appliedDocBodyRef 由路由持有（注入结果/引用清除路径共用同一幂等基线）。
  // #408-followup: AI 改名写回(doc_updated.title)的已应用基线 — 与 body 同理幂等。
  const appliedDocTitle = useRef<string | null>(null);
  // #927: 已应用的 doc_updated rev 基线(见下方消费 effect 的幂等防乱序)。
  const appliedDocRevRef = useRef<number | undefined>(undefined);
  // #1060: 队列项携带 fp = 该轮写回所属 turn 的指令指纹 — 队列重放时按它
  // 关联评论（重放发生在审阅结束后,此刻的最后一条 user 消息已不代表该轮）。
  const writeBackQueueRef = useRef<Array<{ base: string; next: string; fp: string | null }>>([]);
  // #1074-3: pendingWriteBackRef 上移 — useCommentsAi 的守卫入参在 hook 调用点
  // 同步求值;批次冲刷/合批逻辑(queuedRounds/editingSections 等)在本 hook。
  const pendingWriteBackRef = useRef<{ base: string; body: string; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  // 服务端基线初始化 + 切文档时清空队列/基线(单一 effect 保证顺序)。
  const queueDocIdRef = useRef(docId);
  // #837: 刷新恢复审阅 — 每文档只探测一次。
  const reviewResumeDoneRef = useRef(false);

  const [queuedRounds, setQueuedRounds] = useState(0);
  // #989 Phase 3: 批次基线投影 + 「正在编辑」节列表(流式可见,#987 —
  // 替代 60 秒黑盒缓冲:写回进行时画布实时展示节定位,turn 结束进审阅)。
  const batchBaseProjectionRef = useRef<BlockProjection | undefined>(undefined);
  const [editingSections, setEditingSections] = useState<SectionLite[]>([]);
  // #996/#1002: 流式迷你 diff 行（键 = section id；批结束随审阅清空）。
  const [sectionDiffRows, setSectionDiffRows] = useState<Record<string, SectionCardRow[]>>({});

  useEffect(() => {
    if (queueDocIdRef.current !== docId) {
      queueDocIdRef.current = docId;
      writeBackQueueRef.current = [];
      serverBodyRef.current = null;
      reviewResumeDoneRef.current = false;
      // #927: 切文档同时复位写回 rev 基线 — 旧文档的 rev 不得拦截新文档首笔写回。
      appliedDocRevRef.current = undefined;
      // #837-ux: 同轮合批评也要清(计时器一并撤销)。
      if (pendingWriteBackRef.current?.timer) clearTimeout(pendingWriteBackRef.current.timer);
      pendingWriteBackRef.current = null;
      setQueuedRounds(0);
      // #903: 切文档同时清保存基线与 dirty — 旧文档的 body/base 不得跨文档
      // 参与新文档的 dirty 判断(旧响应晚到时不再误标/误存)。
      lastSavedBody.current = null;
      dirtyRef.current = false;
      setDirty(false);
      // #408-followup: 切文档复位改名写回基线 — 旧文档的标题不得被新文档事件比对吞掉。
      appliedDocTitle.current = null;
    }
    if (doc && serverBodyRef.current === null) serverBodyRef.current = doc.body;
  }, [doc, docId, serverBodyRef, lastSavedBody, dirtyRef, setDirty]);

  // #837: 刷新恢复审阅 — 服务端最后一笔快照是「AI edit」且其正文就是当前
  // 正文时,说明上次审阅未完成(刷新/关闭丢失了客户端审阅态)。自动恢复:
  // old = 前一条快照,当前正文作为 next 重新进入审阅,用户无需重发指令。
  useEffect(() => {
    if (!docId || !doc || reviewResumeDoneRef.current) return;
    reviewResumeDoneRef.current = true;
    // #903: stale-response 守卫 — 切文档后晚到的快照探测不得给新文档恢复旧审阅。
    let cancelled = false;
    api.getDocSnapshots(docId).then(async ({ snapshots }) => {
      if (cancelled) return;
      if (snapshots.length < 2) return;
      // 服务端按 id desc 返回 — [0] 最新,[1] 上一条。
      const last = snapshots[0];
      const prev = snapshots[1];
      if (last.label !== 'AI edit') return;
      if ((last.body_preview ?? '') !== doc.body.slice(0, 80)) return;
      const [lastFull, prevFull] = await Promise.all([
        api.getSnapshotBody(docId, last.snapshot_id),
        api.getSnapshotBody(docId, prev.snapshot_id),
      ]);
      if (cancelled) return;
      if (lastFull.body !== doc.body) return;
      setDiffReview({ key: `resume_${Date.now()}`, old: prevFull.body, next: lastFull.body, source: 'ai_edit' });
    }).catch(() => { /* 恢复失败不打扰 — 行为与旧版一致 */ });
    // #903: cleanup 丢弃在途响应(切文档后晚到的快照探测不得给新文档恢复旧
    // 审阅);同时复位一次性探测标记 — StrictMode 首次挂载即被 cleanup 丢弃,
    // 不复位会让恢复探测在 dev 下永远缺席。误恢复由 label('AI edit')条件兜住。
    return () => { cancelled = true; reviewResumeDoneRef.current = false; };
  }, [doc, docId, setDiffReview]);

  /** 弹出下一轮写回:以「用户当前正文」为新基线做三路合并重放;冲突则丢弃并明示。 */
  const popNextWriteBack = useCallback((currentMd: string) => {
    const entry = writeBackQueueRef.current.shift();
    setQueuedRounds(writeBackQueueRef.current.length);
    if (!entry) return;
    const remaining = writeBackQueueRef.current.length;
    const merged = mergeThreeWay(entry.base, currentMd, entry.next);
    if (merged === null) {
      // #989 Phase 3: 冲突节归属(#986 块级收口)— 指名冲突落在哪些节。
      const sections = describeConflictSections(entry.base, currentMd, entry.next);
      if (sections.length > 0) {
        showNotice(t('writing.reviewConflictSections', 'AI 的下一轮修改与当前内容在「{{sections}}」重叠冲突，该轮已丢弃 — 请在聊天中重新描述该修改', { sections: sections.join('、') }), 6000);
      } else {
        showNotice(t('writing.reviewConflict', 'AI 的下一轮修改与当前内容有重叠冲突，该轮已丢弃 — 请在聊天中重新描述该修改'), 6000);
      }
      // #1060: 被丢弃的轮次不会再进审阅 — 其携带的评论关联随之清账
      // (登记+loading 收口+线程失败说明),否则 has() 守卫永久挡死重试。
      failCommentTurnsByFp(entry.fp);
      return;
    }
    // #1041: 队列重放同样关联评论来源（写回跨轮排队时的兜底路径）。
    // #1060: 按该轮写回自带的指纹关联,而非全量消费。
    const reviewKey = `rev_${Date.now()}`;
    attachCommentSourcesToReview(reviewKey, entry.fp);
    setDiffReview({ key: reviewKey, old: currentMd, next: merged });
    if (remaining > 0) showNotice(t('writing.reviewQueuedNext', '已呈现下一轮 AI 修改（队列中还有 {{n}} 轮）', { n: remaining }), 4000);
  }, [showNotice, t, attachCommentSourcesToReview, failCommentTurnsByFp, setDiffReview]);

  const flushPendingWriteBack = useCallback(() => {
    const pend = pendingWriteBackRef.current;
    if (!pend) return;
    if (pend.timer) clearTimeout(pend.timer);
    pendingWriteBackRef.current = null;
    // #989 Phase 3: 批结束 — 指示条让位于 diff 审阅。
    setEditingSections([]);
    // #996/#1002: 迷你 diff 同批结束清空（审阅即完整呈现）。
    setSectionDiffRows({});
    if (diffPendingRef.current) {
      // 跨轮:审阅未决 → 累计队列,审阅结束后依次呈现。
      // #1060: 携带本批写回的 turn 指令指纹 — 重放时按它关联评论。
      writeBackQueueRef.current.push({ base: pend.base, next: pend.body, fp: currentTurnInstruction() });
      setQueuedRounds(writeBackQueueRef.current.length);
      showNotice(t('writing.reviewQueued', 'AI 又完成了一轮修改 — 当前审阅结束后将依次呈现'), 5000);
      return;
    }
    appliedDocBodyRef.current = pend.body;
    serverBodyRef.current = pend.body;
    // #996/#998: AI 写回提议卡表头 — 批内最后 summary 无节信息,subject 留空。
    // #1041: 评论来源的写回到达 — 关联评论（AI 回复 + accept→resolved 的判定点）。
    // #1060: 指纹 = 本批写回所属 turn 的指令（会话最后一条非附件提示的
    // user 消息）— 冲刷时精确匹配,排队轮换/无关 turn 的写回不再误挂评论。
    const reviewKey = `rev_${Date.now()}`;
    attachCommentSourcesToReview(reviewKey, currentTurnInstruction());
    setDiffReview({ key: reviewKey, old: bodyRef.current, next: pend.body, source: 'ai_edit' });
    // #693: 审阅模式下编辑器选中的是 diff 内容,不再构成引用。
    setChatSelection('');
    // #837-ux: deck 视图下 markdown 审阅不可见 — 写回时自动切回文档视图。
    setViewMode((m) => (m === 'deck' ? 'document' : m));
  }, [showNotice, t, attachCommentSourcesToReview, currentTurnInstruction, diffPendingRef,
    bodyRef, serverBodyRef, appliedDocBodyRef, setDiffReview, setChatSelection, setViewMode]);

  const prevChatLoadingRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevChatLoadingRef.current === true && !chatLoading) {
      flushPendingWriteBack();
      // #1041: turn 收口 — 未产生写回的评论处理给失败/漂移 AI 回复；#1051 deck 评论在此判定成败。
      settlePendingCommentTurns();
    }
    // #989 Phase 3: turn 开始沿(false→true)冻结批次基线投影 — 此刻 store
    // 的投影仍是上一轮末态( consumption effect 消费事件后 store 已前移,
    // 批内首事件不可作基线)。上一轮无投影时回退文档加载时的服务端投影。
    if (prevChatLoadingRef.current === false && chatLoading) {
      batchBaseProjectionRef.current = chatSession?.lastDocProjection ?? doc?.block_projection ?? undefined;
      setEditingSections([]);
    }
    prevChatLoadingRef.current = chatLoading;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 沿检测仅依赖 chatLoading;doc/投影经 store 快照读取
  }, [chatLoading, flushPendingWriteBack, settlePendingCommentTurns]);

  // #1095: 多槽队列下，turn 结束与下一 turn 开始在同一同步块完成 — React
  // 渲染层看不到中间的 loading=false 沿，上面的边沿 effect 会漏掉中间 turn
  // 的收口。改为订阅 store 的 turn 完成事件逐 turn 触发（先于排队槽出队，
  // 指纹匹配不受下一 turn 的 user 消息污染）。边沿 effect 保留兜底（无队列
  // 的单 turn 场景事件与边沿等价，收口幂等）。
  useEffect(() => {
    return onChatTurnComplete((sid) => {
      if (!docId || sid !== `doc-${docId}`) return;
      flushPendingWriteBack();
      settlePendingCommentTurns();
      // #1113: turn 收口 — 画布的整轮撤销快照边界前移（下一轮 AI 写回新开快照）。
      onTurnComplete();
    });
  }, [docId, flushPendingWriteBack, settlePendingCommentTurns, onTurnComplete]);

  // #636 doc write-back diff 审阅 — 依赖 chatSession。
  // #837-ux: 同轮合批 — 写回到达只更新批次末值,turn 结束/兜底超时才进审阅。
  // #927: rev 幂等防乱序 — 服务端写回带单调 rev,已应用 rev 之后的旧事件
  // (SSE 重放/乱序)直接忽略;无 rev 的旧后端事件保持原行为。
  useEffect(() => {
    if (!docId || !chatSession?.lastDocBody) return;
    if (!shouldApplyDocRev(appliedDocRevRef.current, chatSession.lastDocRev)) return;
    if (appliedDocBodyRef.current === chatSession.lastDocBody) return;
    if (chatSession.lastDocBody === bodyRef.current) return;
    if (!pendingWriteBackRef.current) {
      // 批次起点:记录本批第一个写回的服务端基线。
      const base = serverBodyRef.current ?? bodyRef.current;
      pendingWriteBackRef.current = {
        base,
        body: chatSession.lastDocBody,
        timer: setTimeout(() => flushPendingWriteBack(), BATCH_FALLBACK_MS),
      };
      // #989 Phase 3: 批开始 — 清空上轮「正在编辑」残留(基线已在 turn
      // 开始沿冻结;批内 diff 在下方逐事件更新)。
      setEditingSections([]);
    } else {
      pendingWriteBackRef.current.body = chatSession.lastDocBody;
      // 活动重置兜底计时(纯流丢失保险,正常路径由 turn 结束冲刷)。
      if (pendingWriteBackRef.current.timer) clearTimeout(pendingWriteBackRef.current.timer);
      pendingWriteBackRef.current.timer = setTimeout(() => flushPendingWriteBack(), BATCH_FALLBACK_MS);
    }
    appliedDocBodyRef.current = chatSession.lastDocBody;
    serverBodyRef.current = chatSession.lastDocBody;
    if (typeof chatSession.lastDocRev === 'number') appliedDocRevRef.current = chatSession.lastDocRev;
    // #989 Phase 3: 流式可见 — 每笔写回到达即更新「正在编辑」节列表
    // (对照批次基线投影;无投影的旧后端事件不影响既有行为)。
    if (chatSession.lastDocProjection) {
      const dbg = diffProjectionSections(batchBaseProjectionRef.current, chatSession.lastDocProjection);
      setEditingSections(dbg);
      // #996/#1002: 流式迷你 diff — 编辑中的节,旧(基线 body+基线投影)/
      // 新(最新 body+最新投影)节文本的行级增删行,经装饰层显示在卡片内。
      const baseProj = batchBaseProjectionRef.current;
      const baseBodyStr = pendingWriteBackRef.current?.base ?? '';
      const rows: Record<string, SectionCardRow[]> = {};
      for (const sec of dbg) {
        const oldText = extractSectionText(baseBodyStr, baseProj, sec.id);
        const newText = extractSectionText(chatSession.lastDocBody, chatSession.lastDocProjection, sec.id);
        if (oldText === null || newText === null || oldText === newText) continue;
        rows[sec.id] = lineDiffRows(oldText, newText);
      }
      setSectionDiffRows(rows);
    }
  }, [chatSession?.lastDocBody, chatSession?.lastDocRev, chatSession?.lastDocProjection, docId, flushPendingWriteBack, bodyRef, serverBodyRef, appliedDocBodyRef]);

  // #408-followup: AI 改名写回(doc_updated.title)— 服务端已落库,本地同步
  // 输入框 state + doc.title 基线(单一数据源:title state 是唯一编辑源,
  // doc.title 只做服务端镜像),不标 dirty(服务端已是该值)。
  useEffect(() => {
    const next = chatSession?.lastDocTitle;
    if (!docId || !next || appliedDocTitle.current === next) return;
    appliedDocTitle.current = next;
    setTitle(next);
    setDoc((prev) => (prev ? { ...prev, title: next } : prev));
  }, [chatSession?.lastDocTitle, docId, setTitle, setDoc]);

  /**
   * 审阅结束:接受/拒绝结果落地,拒绝或放弃则保持原正文。#837: 结束后弹出队列中的下一轮写回。
   * #927: 冲突「载入最新」的确认审阅 — 接受 = 丢弃本地未保存修改、原样采用
   * 服务端最新(无需再保存,服务端已是该版本);取消 = 保留本地,冲突横幅仍在。
   */
  const handleDiffResolve = useCallback((result: { md: string; accepted: number; rejected: number; cancelled: boolean }) => {
    const fresh = conflictLoadRef.current;
    if (fresh) {
      conflictLoadRef.current = null;
      setDiffReview(null);
      if (result.cancelled) {
        showNotice(t('writing.conflictKeepLocal', '已保留本地未保存修改 — 可选择「保留我的版本」或重新载入最新'), 4000);
        return;
      }
      // review 复核(嵌套节批): 接受 = 应用服务端完整态(title/deck/投影
      // 一并到位,与「Use AI's version」同语义),不再只换 body。
      applyServerDoc(fresh);
      setSaveConflict(null);
      setSaveFailure(null); // #986: 已与服务端对齐,清常驻警示。
      showNotice(t('writing.conflictLoadedLatest', '已载入服务端最新内容'), 3000);
      return;
    }
    setDiffReview(null);
    // #1096 评论生命周期重构：accept = 采纳本轮修改 — **不再**自动 resolved。
    // 评论保持 open，用户可继续多轮交互；「标记已解决」（手动 PATCH）是唯一
    // 关闭路径。登记关联仍清账（diffCommentSourcesRef 用毕即清）。
    const commentSources = diffCommentSourcesRef.current;
    if (commentSources && commentSources.key === diffReviewKeyRef.current) {
      diffCommentSourcesRef.current = null;
    }
    // #720: 用显式 cancelled 字段区分"放弃"，不再用空串推断 — 全文删空的
    // 接受结果(空 md)应落地为空正文,而不是被当成放弃。
    if (result.cancelled) {
      if (restoreReview) { setRestoreReview(null); }
      showNotice(t('writing.reviewCancelled', '已放弃本次 AI 修改'), 3000);
      // #837: 放弃 = 明确拒绝 — 服务端仍持有 AI 写回的版本,必须回滚为
      // 用户正文(此前 DB 留着被拒绝的内容,用户下次保存/离开就污染)。
      if (docId && serverBodyRef.current !== null && serverBodyRef.current !== bodyRef.current) {
        const restoreBody = bodyRef.current;
        // #927: 落盘 title 用输入框当前值(state)而非 doc?.title — 本地
        // 标题编辑未保存时,doc.title 是旧值,会把改过的标题盖回去。
        saveDoc(title || 'Untitled', restoreBody)
          .then((updated) => {
            lastSavedBody.current = updated.body ?? restoreBody;
            serverBodyRef.current = updated.body ?? restoreBody;
          })
          .catch((err) => {
            if (err instanceof ApiError && err.status === 409 && err.code === 'stale_base') {
              setSaveConflict({ title: title || 'Untitled', body: restoreBody, current: extractConflictCurrent(err) });
              showNotice(t('writing.conflictDetected', '文档已在其他窗口被修改，当前窗口内容未保存'), 6000);
            } else {
              // #986: 回滚保存失败 → 常驻警示 + dirty 回灌(autosave 重试)。
              markSaveFailed(err);
            }
          });
      }
      // 放弃 → 正文保持原样,队列中的下一轮以当前正文为基线重放。
      popNextWriteBack(bodyRef.current);
      return;
    }
    setBody(result.md);
    setDoc((prev) => (prev ? { ...prev, body: result.md, updated_at: new Date().toISOString() } : prev));
    if (restoreReview) {
      showNotice(t('writing.restoreApplied', '已恢复到「{{label}}」：接受 {{a}} / 拒绝 {{r}} 处差异', { label: restoreReview.label, a: result.accepted, r: result.rejected }));
      setRestoreReview(null);
    } else {
      // #927: 硬编码文案 i18n 化(en/zh-CN 同步)。
      showNotice(t('writing.aiChangesApplied', '已采纳 AI 修改：接受 {{a}} / 拒绝 {{r}}', { a: result.accepted, r: result.rejected }));
    }
    // #598/#711: 落地后自动保存到服务端 — 失败必须可见,不能静默吞掉。
    if (docId) {
      // #927: 同上 — 落盘 title 用 state 当前值。
      saveDoc(title || 'Untitled', result.md)
        .then((updated) => {
          lastSavedBody.current = updated.body ?? result.md;
          serverBodyRef.current = updated.body ?? result.md;
          dirtyRef.current = false;
          setDirty(false);
          setSaveFailure(null); // #986: 保存成功清常驻警示。
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 409 && err.code === 'stale_base') {
            setSaveConflict({ title: title || 'Untitled', body: result.md, current: extractConflictCurrent(err) });
            showNotice(t('writing.conflictDetected', '文档已在其他窗口被修改，当前窗口内容未保存'), 6000);
          } else {
            // #986: 二次保存失败 → 常驻警示条 + dirty 回灌(autosave 自动
            // 重试),不再 6 秒 toast 后静默。
            markSaveFailed(err);
          }
        });
    }
    // #837: 弹出队列中的下一轮写回 — 以本轮接受后的正文为用户基线做三路合并
    // (bodyRef 同帧还未更新,显式传 result.md)。
    popNextWriteBack(result.md);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 引用稳定,避免抖动
  }, [docId, title, restoreReview, showNotice, popNextWriteBack, extractConflictCurrent, conflictLoadRef,
    applyServerDoc, setDiffReview, setBody, setDoc, setDirty, setSaveConflict,
    setSaveFailure, setRestoreReview, saveDoc, markSaveFailed, serverBodyRef, bodyRef, lastSavedBody, dirtyRef,
    diffCommentSourcesRef, diffReviewKeyRef]);

  return {
    queuedRounds,
    editingSections,
    sectionDiffRows,
    setEditingSections,
    handleDiffResolve,
  };
}
