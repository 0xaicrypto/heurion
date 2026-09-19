import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { findSectionAtOffset, type BlockProjection } from '@heurion/contracts';
import type { Editor } from '@tiptap/react';
import { ArrowLeft, FileText, MessageSquare, Presentation } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { useSessionSuggestions } from './writing-editor/suggestions';
import { SuggestedReferenceBanner } from '@/components/SuggestedReferenceBanner';
import { DocEditor, selectionWithinSingleBlock, type DiffReviewState } from '@/components/DocEditor';
import { ProposalCard } from '@/components/ProposalCard';
import { KbPicker } from '@/components/KbPicker';
import { SpotHint } from '@/components/SpotHint';
import { UploadProgressModal } from '@/components/UploadProgressModal';
// #1060: onChatPendingDropped — 排队指令被覆盖/清理事件（评论登记解除卡死）。
import { chatFailureText, onChatPendingDropped, useChatStore } from '@/stores/chat';
import { Alert, Button, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { sha1Hex } from '@/lib/hash';
import { cn } from '@/lib/utils';
// #837: AI 写回三路合并(审阅未决时的累计队列重放)。
import { mergeThreeWay, describeConflictSections } from '@/lib/doc-merge';
// #989 Phase 3: 块投影前端消费 — 批内节 diff(编辑过程流式可见,#987)。
import { diffProjectionSections, type SectionLite } from '@/lib/block-projection';
// #996/#1002: 节卡片化数据流 — 流式迷你 diff 行（编辑中的节）。
import { lineDiffRows, extractSectionText, type SectionCardRow } from '@/lib/section-cards';
// #1021: 稳定 section id 的跳转定位（重名标题按出现序 + 回退提示）。
import { resolveSectionJumpTarget } from '@/lib/section-jump';
// #927: doc_updated rev 幂等防乱序(与 chat-reducer 同源判定)。
import { shouldApplyDocRev } from '@/lib/chat-reducer';
import { toSlides, type Slide } from '@/lib/deck';
import type { DeckWire } from '@/lib/types';
// #696: 状态机全部下沉 hooks — 路由只保留编排与布局。
import { usePolishBubble, conflictSavedPreview } from './writing-editor/bubble';
import { useDeckAsset } from './writing-editor/deck-asset';
import { useDocChat } from './writing-editor/doc-chat';
import { useDocReferences } from './writing-editor/references';
import { HistoryDialog, PhiDialog, AddReferenceDialog, DeckConflictConfirmDialog } from './writing-editor/dialogs';
// #688: 渲染块拆出 — deck 网格 / 右侧聊天面板 / 工具栏。
import { DeckView } from './writing-editor/deck-view';
import { ChatPanel } from './writing-editor/chat-panel';
// #1040: 侧边栏评论面板 + 评论创建弹窗(选区高亮标注线程列表)。
import { AddCommentModal, CommentsPanel } from './writing-editor/comments-panel';
import type { DocCommentWire } from '@/lib/api';
// #996/#1000: 共享 SegmentedControl（视图胶囊）/页头 Toolbar 收敛。
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Toolbar } from './writing-editor/toolbar';
import type { DocDetail, SnapshotEntry, PhiFinding } from './writing-editor/types';

export function WritingEditorPage() {
  const { t } = useTranslation();
  const { docId } = useParams<{ docId: string }>();
  const navigate = useNavigate();
  // #996/#1000: 工作台 Slides tab 直达 — ?view=deck 初始化幻灯片视图（仅挂载时读一次）。
  const [viewMode, setViewMode] = useState<'document' | 'deck'>(() =>
    new URLSearchParams(window.location.search).get('view') === 'deck' ? 'deck' : 'document');
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  // #696: 统一轻提示通道 — 此前 14 处 setAiEditNotice+setTimeout 手写。
  const [aiEditNotice, setAiEditNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((text: string, ttlMs = 4000) => {
    setAiEditNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setAiEditNotice(''), ttlMs);
  }, []);

  const [showHistory, setShowHistory] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const [phiScanning, setPhiScanning] = useState(false);
  const [phiFindings, setPhiFindings] = useState<PhiFinding[] | null>(null);
  const [showPhiDialog, setShowPhiDialog] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ docx_path: string; size_bytes: number } | null>(null);
  // #754: 导出完成态面板 — 下载反馈取代服务器路径字符串;记录本会话导出历史。
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [exportHistory, setExportHistory] = useState<Array<{ format: 'docx' | 'pdf'; filename: string; size: number; at: number }>>([]);

  // #382: linked submission state (target journal / applied template).
  const [linkedJournal, setLinkedJournal] = useState('');
  const [linkedTemplate, setLinkedTemplate] = useState('');
  // #383: linked study (methods generation) + results injection.
  const [studyId, setStudyId] = useState('');
  const [studyName, setStudyName] = useState('');
  const [methodsLoading, setMethodsLoading] = useState(false);
  const [methodsError, setMethodsError] = useState<string | null>(null);
  const [injectOpen, setInjectOpen] = useState(false);
  const [injectLabel, setInjectLabel] = useState('');
  const [injectResult, setInjectResult] = useState('');
  const [injecting, setInjecting] = useState(false);

  const [chatOpen, setChatOpen] = useState(false);
  // #402-merge: the right panel hosts Doc Chat and the chart library.
  const [sidePanelTab, setSidePanelTab] = useState<'chat' | 'charts'>('chat');
  // #402/#382: chat panel width — draggable resize, persisted (default 360px).
  const [chatWidth, setChatWidth] = useState(() => {
    try { return Number(localStorage.getItem('nexus.docchat.width')) || 360; } catch { return 360; }
  });
  const chatWidthRef = useRef(chatWidth);
  chatWidthRef.current = chatWidth;
  const resizingRef = useRef(false);

  const [chatSelection, setChatSelection] = useState('');
  const [diffReview, setDiffReview] = useState<DiffReviewState | null>(null);
  // #764: 标记当前审阅是「恢复历史版本」——通知文案与 AI 润色区分。
  const [restoreReview, setRestoreReview] = useState<{ snapshotId: string; label: string } | null>(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  // #fix: 最近一次已保存的正文 — 发送 chat 前对比,内容有变化才先保存。
  const lastSavedBody = useRef<string | null>(null);
  useEffect(() => {
    if (lastSavedBody.current === null && doc) lastSavedBody.current = doc.body;
  }, [doc]);

  // #773: deck 资产状态下沉 useDeckAsset。
  const deckCtl = useDeckAsset();
  const { deckAsset, setDeckAsset, lastSavedDeck, appliedDocDeck, deckJson } = deckCtl;

  // #705: 自动保存（debounce）+ 未保存离开保护 + Cmd/Ctrl+S。
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveConfirmed = useRef(false);
  const [dirty, setDirty] = useState(false);
  // #882: 并发保存冲突 — 409(stale_base) 时记录待保存内容,横幅供用户选择
  // (载入最新/保留我的版本),绝不静默覆盖另一窗口的修改。
  // #996/#997: current = 409 payload 携带的服务端当前完整态 — 双栏对照
  // (Yours/AI's)零额外请求;旧后端无 payload 时走 getDoc 兜底。
  const [saveConflict, setSaveConflict] = useState<{
    title: string; body: string; deck?: unknown;
        current?: { title: string; body: string; deck?: unknown; block_projection?: BlockProjection | null; updated_at: string };
  } | null>(null);
  // #1043: deck 与正文分叉冲突 — 服务端 AI deck 写回到达而本地有未保存
  // deck 编辑时置位;常驻提示条 + 二选一(保留我的编辑/使用 AI 的版本),
  // 未决策前 autosave/手动保存暂停。此前仅 6 秒 toast 无操作出口,谁生效
  // 完全不确定(#910 遗留半成品)。
  const [deckConflict, setDeckConflict] = useState<{ serverDeck: DeckWire; serverDeckKey: string } | null>(null);
  const [deckConflictConfirm, setDeckConflictConfirm] = useState<'keep' | 'use-ai' | null>(null);
  const [deckConflictResolving, setDeckConflictResolving] = useState(false);
  // #986: 保存失败常驻警示 — 二次保存(diff 落地/回滚)失败且非 409 时,
  // 失败内容回灌 dirty 并进入 autosave 重试;横幅常驻直至保存成功,不再
  // 只弹 6 秒 toast(#920 静默失败家族)。
  const [saveFailure, setSaveFailure] = useState<{ count: number; message: string } | null>(null);
  // #1040: 评论状态 — 线程列表(挂载/切文档拉取)、侧边栏开关、激活线程、
  // 选区评论草稿(气泡「添加评论」→ 弹窗提交)。
  // #1051: 草稿来源扩展判别联合 — 正文选区 { text, from, to } |
  // deck slide { target:'deck_slide', slideIndex0(0-based), anchorText=页标题 }。
  const [docComments, setDocComments] = useState<DocCommentWire[]>([]);
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState<
    { text: string; from: number; to: number } | { target: 'deck_slide'; slideIndex0: number; anchorText: string } | null
  >(null);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  /** 保存失败统一处置:回灌 dirty(autosave 重试)+ 常驻警示条。 */
  const markSaveFailed = useCallback((err: unknown) => {
    const message = err instanceof ApiError ? err.messageText : String(err);
    dirtyRef.current = true;
    setDirty(true);
    setSaveFailure((prev) => ({ count: (prev?.count ?? 0) + 1, message }));
  }, []);
  // #927: 「载入最新」确认审阅挂起的服务端最新内容 — handleDiffResolve 据此
  // 分流(接受 = 原样采用服务端版本,不走常规落地保存路径)。
  const conflictLoadRef = useRef<DocDetail | null>(null);

  const markDirty = useCallback((nextBody: string, nextTitle: string) => {
    if (!docId) return;
    // #773: deck 变更同样计入 dirty（deckJson 由 useMemo 派生，与 lastSavedDeck 比较）。
    const nextDirty = nextBody !== (lastSavedBody.current ?? '')
      || nextTitle !== (doc?.title ?? '')
      || deckJson !== lastSavedDeck.current;
    dirtyRef.current = nextDirty;
    setDirty(nextDirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref 稳定(#696 hooks 下沉)
  }, [docId, doc?.title, deckJson]);

  useEffect(() => {
    if (!docId || doc === null) return;
    markDirty(bodyRef.current, title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, title, deckJson, docId]);

  useEffect(() => {
    if (!docId || doc === null || !dirty) return;
    // #895: 审阅未决(diffReview)或 AI 写回批次待冲刷(pendingWriteBack)时
    // 暂停 autosave — 此时 serverBodyRef 已指向 AI 版本,自动保存会把审阅前
    // 的正文盖回服务端(覆盖 AI 写回)。不排下一次定时器;守卫解除后由
    // dirty 机制自然恢复(effect 依赖 diffReview)。
    // #927: 保存冲突横幅打开期间同样暂停 — 冲突未决时自动保存必然再 409,
    // 由用户决策(载入最新/保留我的版本)后再恢复。
    // #1043: deck 冲突未决时同样暂停 — 自动保存会以本地 deck 静默覆盖
    // 服务端 AI deck,谁生效不再由定时器决定,由冲突提示条明示决策。
    if (diffReview !== null || pendingWriteBackRef.current !== null || saveConflict !== null || deckConflict !== null) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void handleSave();
    }, 2500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // #986: saveFailure 计数入依赖 — 保存失败后自动重试(重试仍失败则继续,
    // 直至成功清警示)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, title, docId, dirty, diffReview, saveConflict, deckConflict, saveFailure]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current || leaveConfirmed.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('keydown', onKeyDown);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  /** #705: 有未保存修改时拦截返回，确认后再离开。 */
  const leaveEditor = () => {
    if (!dirtyRef.current) { navigate('/app/writing'); return; }
    const ok = window.confirm(t('writing.unsavedLeave', '文档有未保存的修改，确定离开吗？'));
    if (ok) {
      leaveConfirmed.current = true;
      dirtyRef.current = false;
      navigate('/app/writing');
    }
  };

  // §15.4 / #553: AI write-back 不再静默替换正文 — 进入审阅模式,用户
  // 逐条/全部接受或拒绝后由 onDiffResolve 落地。
  const appliedDocBody = useRef<string | null>(null);
  // #408-followup: AI 改名写回(doc_updated.title)的已应用基线 — 与 body 同理幂等。
  const appliedDocTitle = useRef<string | null>(null);
  // #408-followup: 页头标题点击 → 聚焦正文区标题输入框(页头是入口,唯一编辑源是输入框)。
  const titleInputRef = useRef<HTMLInputElement>(null);
  // #927: 已应用的 doc_updated rev 基线(见下方消费 effect 的幂等防乱序)。
  const appliedDocRevRef = useRef<number | undefined>(undefined);
  const diffPendingRef = useRef(false);
  useEffect(() => {
    diffPendingRef.current = diffReview !== null;
    // #1041: 审阅 key — 评论来源关联（diffCommentSourcesRef）的比对依据。
    diffReviewKeyRef.current = diffReview?.key ?? null;
  }, [diffReview]);

  // #837: AI 写回累计队列 — 审阅未决时的新写回不再被拒绝(丢弃),而是
  // 记录 { 服务端写回基线, 新正文 },当前审阅结束后重放。基线必须用
  // serverBodyRef(服务端视角的正文):上一轮写回未被接受时,服务端仍持有
  // 旧正文 — 若直接 diff「当前正文 → 新写回」,会把上一轮已接受的修改
  // 反转回去(生产事故:修改队列顺序乱)。
  const serverBodyRef = useRef<string | null>(null);
  // #1060: 队列项携带 fp = 该轮写回所属 turn 的指令指纹 — 队列重放时按它
  // 关联评论（重放发生在审阅结束后,此刻的最后一条 user 消息已不代表该轮）。
  const writeBackQueueRef = useRef<Array<{ base: string; next: string; fp: string | null }>>([]);
  // 服务端基线初始化 + 切文档时清空队列/基线(单一 effect 保证顺序)。
  const queueDocIdRef = useRef(docId);
  // #837: 刷新恢复审阅 — 每文档只探测一次。
  const reviewResumeDoneRef = useRef(false);
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
  }, [doc, docId]);

  /** #996/#997 + review 复核(嵌套节批): 应用服务端当前完整态 — title/
   *  body/deck/块投影一次到位,并同步已保存基线与 dirty。「Use AI's
   *  version」与旧后端「载入最新」确认路径共用;此前只换 body/updated_at,
   *  用户采纳后标题/幻灯片/投影基线仍停在本地旧值(视图只换了一半)。 */
  const applyServerDoc = useCallback((fresh: {
    title: string; body: string; deck?: unknown;
    block_projection?: BlockProjection | null; updated_at: string;
  }) => {
    setBody(fresh.body);
    setTitle(fresh.title);
    lastSavedBody.current = fresh.body;
    serverBodyRef.current = fresh.body;
    const freshDeck = (fresh.deck ?? null) as DeckWire | null;
    setDeckAsset(freshDeck);
    const freshDeckKey = freshDeck ? JSON.stringify(freshDeck) : '';
    lastSavedDeck.current = freshDeckKey;
    appliedDocDeck.current = freshDeckKey;
    setDoc((prev) => (prev ? {
      ...prev,
      title: fresh.title,
      body: fresh.body,
      deck: freshDeck,
      ...(fresh.block_projection ? { block_projection: fresh.block_projection } : {}),
      updated_at: fresh.updated_at,
    } : prev));
    dirtyRef.current = false;
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref/setter 稳定(#696 hooks 下沉)
  }, []);

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
  }, [doc, docId]);

  // #882: 带 base_sha 的保存(服务端并发保护)— 指纹取服务端视角正文
  // (serverBodyRef),409 → 冲突横幅。force 跳过(「保留我的版本」)。
  // #896: 前移到 useDocChat 之前 — doc-chat 发送前预保存复用同一语义。
  const saveDoc = useCallback(async (title: string, body: string, opts: { deck?: unknown; force?: boolean } = {}) => {
    const base = serverBodyRef.current;
    const base_sha = !opts.force && base !== null ? await sha1Hex(base) : undefined;
    const updated = await api.updateDoc(docId!, {
      title, body,
      ...(opts.deck !== undefined ? { deck: opts.deck } : {}),
      ...(base_sha ? { base_sha } : {}),
      ...(opts.force ? { force: true } : {}),
    });
    // review 复核#8a: 手动保存后同步服务端最新块投影 — 此前 doc.block_projection
    // 停留在文档加载时的值,「AI 正在编辑哪个节」的批次基线(line 409 fallback)
    // 在"保存后才发起 AI 轮次"的顺序下取到过期投影,指示器可能标错节。
    // 仅在服务端返回有效投影时覆盖(存量文档首次保存前为 null,不冲掉本地值)。
    if (updated.block_projection) {
      setDoc((prev) => (prev ? { ...prev, block_projection: updated.block_projection! } : prev));
    }
    // #996/#999: 保存响应携带节级元数据 — 作者轴(human)/可信度轴即时同步。
    if (updated.section_meta) {
      setDoc((prev) => (prev ? { ...prev, section_meta: updated.section_meta } : prev));
    }
    return updated;
  }, [docId]);

  // #996/#997: 从 409 响应体提取服务端当前完整态(current) — 双栏对照
  // 数据源;旧后端无 payload 时返回 undefined(前端 getDoc 兜底)。
  const extractConflictCurrent = useCallback((err: unknown) => {
    if (!(err instanceof ApiError) || err.status !== 409) return undefined;
    try {
      const parsed = JSON.parse(err.body) as {
    current?: { title: string; body: string; deck?: unknown; block_projection?: BlockProjection | null; updated_at: string };
      };
      if (parsed.current && typeof parsed.current.body === 'string') return parsed.current;
    } catch { /* 非 JSON body — 无 current,走兜底 */ }
    return undefined;
  }, []);

  // #896: doc-chat 发送前预保存 — 复用 saveDoc 完整语义(带 base_sha 并发
  // 保护),成功后同步服务端基线(serverBodyRef/lastSavedBody);此前裸 PUT
  // 不带 base_sha,多窗口/审阅场景下必然假 409。失败由 hook 侧吞掉(不阻断发送)。
  const presaveForChat = useCallback(async () => {
    const updated = await saveDoc(title, bodyRef.current);
    lastSavedBody.current = updated.body ?? bodyRef.current;
    serverBodyRef.current = updated.body ?? bodyRef.current;
    return updated;
  }, [saveDoc, title]);

  // ── #1041: 「请AI处理」评论驱动 AI 编辑闭环 ──────────────────────────
  // pendingCommentTurnsRef: 点击时同步登记(防同帧双击并发,issue 用例 6)。
  // 收口分两条路:正文评论的写回进 diff 审阅时消费(flushPendingWriteBack /
  // popNextWriteBack);deck 评论(#1051)无 diff 审阅(edit_deck 直接落画布),
  // 在 turn 收口时比对 Doc.deck 变化判定成败。
  // #1060: 关联改为「单评论单 turn + 指令指纹匹配」— 登记携带完整指令文本
  // 作为指纹;冲刷/收口只消费「本 turn 实际发出其指令」的评论(并发/排队
  // 下不再误归属),排队单槽被覆盖/Stop 清空时经 store 事件清理登记(可重试)。
  const pendingCommentTurnsRef = useRef<Map<string, { target: 'section' | 'deck_slide'; deckKeyAtStart?: string; instruction: string }>>(new Map());
  // #1041: 当前 diff 审阅 ← 评论来源关联(accept → 评论自动 resolved)。
  const diffCommentSourcesRef = useRef<{ key: string; ids: string[] } | null>(null);
  const diffReviewKeyRef = useRef<string | null>(null);
  // #1041: 处理中按钮态(commentId → loading)。#1060: loading 与 turn 真实
  // 边界对齐 — 指令排队等待期间保持 loading,由消费点(attach/settle)或
  // pending 丢弃事件收口,不再随 send promise(入队即 resolve)提前消失。
  const [commentProcessing, setCommentProcessing] = useState<Record<string, boolean>>({});
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
   *  role 服务端固定 'ai'，通用 replies 端点已拒绝自封；本地按时间序并入）。 */
  const appendAiReply = useCallback(async (commentId: string, text: string) => {
    if (!docId || !text.trim()) return;
    try {
      const reply = await api.createDocCommentAiReply(docId, commentId, text);
      setDocComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c)));
    } catch { /* 回复失败不阻断主流程 — 线程少一条说明,不产生数据歧义 */ }
  }, [docId]);

  /** #1041: 评论自动 resolved（diff 被接受 / #1051 deck 写回落地）。 */
  const resolveCommentById = useCallback(async (commentId: string) => {
    if (!docId) return;
    try {
      const updated = await api.updateDocComment(docId, commentId, 'resolved');
      setDocComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, status: updated.status, resolved_at: updated.resolved_at } : c)));
    } catch { /* 状态更新失败保持 open — 用户可手动标记 */ }
  }, [docId]);

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
   * #1041: 评论处理 turn 收口 — 产生 diff 的正文评论已由 attach 消费；剩余：
   * - 正文评论未产生写回（edit_document 定位失败/模型未动文档）→ AI 回复失败
   *   说明与候选（用例 5），评论保持 open 可重触发；
   * - #1051 deck 评论：deck 无 diff 审阅（edit_deck 写回直接落画布）→ turn 期间
   *   Doc.deck 有变化 = 修改已生效（AI 回复 + 自动 resolved），无变化则失败说明。
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
        void resolveCommentById(id);
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
  }, [docId, currentTurnInstruction, clearCommentProcessing, appendAiReply, lastAssistantAnswer, resolveCommentById, commentFailReply, t]);

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
  }, [showNotice, t, attachCommentSourcesToReview, failCommentTurnsByFp]);

  // #696: 参考材料管理下沉 useDocReferences。
  // #930: onImportedBody — 文件库/知识库登记触发空文档自动导入时回填编辑器。
  const references = useDocReferences({
    docId,
    setError: (e) => setError(e ?? ''),
    onImportedBody: (importedBody) => {
      setBody(importedBody);
      setDoc((prev) => (prev ? { ...prev, body: importedBody, updated_at: new Date().toISOString() } : prev));
      lastSavedBody.current = importedBody;
      showNotice(t('writing.importedBody', '已导入原文，可直接编辑草稿，或在右侧与 AI 对话调整内容'), 6000);
    },
    // #1010: 引用池"当前场景相关"上下文 = 文档标题。
    poolContext: () => (doc as { title?: string } | null)?.title || '',
  });

  // #1008: 写作会话（doc-<docId>）开局检测 — 弹层建议区展示，采纳后刷新正式引用。
  const {
    suggestions: refSuggestions,
    resolving: refSuggestionResolving,
    resolve: resolveRefSuggestion,
    scan: scanRefSuggestions,
  } = useSessionSuggestions({
    sessionId: docId ? `doc-${docId}` : undefined,
    setError: (e) => setError(e ?? ''),
    onAccepted: () => void references.loadReferences(),
  });
  const refScannedRef = useRef<string>('');
  useEffect(() => {
    const sid = docId ? `doc-${docId}` : '';
    if (!sid || refScannedRef.current === sid) return;
    const ctx = String((doc as { title?: string } | null)?.title || '').trim();
    if (!ctx) return;
    refScannedRef.current = sid;
    void scanRefSuggestions(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, (doc as { title?: string } | null)?.title, scanRefSuggestions]);

  // #696: doc-chat 面板逻辑下沉 useDocChat（发送/排队/附件/上传/pptx 轮询）。
  const polishEditorRef = useRef<Editor | null>(null);
  const chat = useDocChat<DocDetail>({
    docId,
    bodyRef,
    lastSavedBody,
    dirtyRef,
    diffReview,
    // #896: 预保存走 saveDoc 完整语义(base_sha + 服务端基线同步)。
    presave: presaveForChat,
    chatSelection,
    setChatSelection,
    setBody,
    setDoc,
    setError: (e) => setError(e),
    onNotice: showNotice,
    loadReferences: async () => { await references.loadReferences(); },
    lastSavedDeck,
    appliedDocDeck,
    setDeckAsset,
    setViewMode: (m) => setViewMode(m),
    editorSelection: () => {
      const editor = polishEditorRef.current;
      if (!editor) return '';
      const { from, to } = editor.state.selection;
      return editor.state.doc.textBetween(from, to, '\n').trim();
    },
    // #996/#1003: 选中即引用 → 投影反查节引用(节跳转标签持久化)。
    // 投影经 store getState 读(chatSession 声明在本 hook 之后,不可闭包引用)。
    resolveSection: (sel) => {
      if (!sel || !docId) return null;
      const sess = useChatStore.getState().sessions[`doc-${docId}`];
      const proj = sess?.lastDocProjection ?? doc?.block_projection;
      if (!proj) return null;
      const offset = bodyRef.current.indexOf(sel.slice(0, 80));
      if (offset < 0) return null;
      // review 复核(嵌套节): span 大纲语义下取最深层匹配节 — 此前 find()
      // 从文档序首个匹配返回,选中嵌套子节文字永远先命中外层父节。
      const sec = findSectionAtOffset(proj, offset);
      return sec ? { id: sec.id, heading: sec.heading || '' } : null;
    },
  });

  // #408-followup: 弹窗互斥 — history / PHI / 引用 / 上传 四类模态同一时刻
  // 只允许一个可见(最后打开者胜)。此前各自独立 boolean,保存触发的 PHI
  // 检测可与已打开的历史/引用弹层叠加,两层遮罩层层堆叠。
  useEffect(() => {
    if (showHistory) { setShowPhiDialog(false); references.setRefDialogOpen(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setter 稳定,避免 references 对象身份触发重跑
  }, [showHistory]);
  useEffect(() => {
    if (showPhiDialog) { setShowHistory(false); references.setRefDialogOpen(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setter 稳定
  }, [showPhiDialog]);
  useEffect(() => {
    if (references.refDialogOpen) { setShowHistory(false); setShowPhiDialog(false); }
  }, [references.refDialogOpen]);
  useEffect(() => {
    if (chat.uploadState) { setShowHistory(false); setShowPhiDialog(false); references.setRefDialogOpen(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 上传态驱动
  }, [chat.uploadState]);

  const chatSession = chat.chatSession;
  const chatSessionId = docId ? `doc-${docId}` : '';
  // #996/#1003: 聊天 → 文档跳转 — 按节 id 反查标题,编辑器内定位滚动
  // (复用 deck 卡片锚点定位的同款机制),打开聊天面板/文档视图。
  // #1021: 以稳定 section id 为第一入口;重名标题按出现序落位,文本对不上
  // 时给最接近标题 + 可见提示,不再静默跳错/不动。
  const jumpToSection = useCallback((sectionId: string) => {
    const proj = chatSession?.lastDocProjection ?? doc?.block_projection;
    const sections = (proj?.nodes ?? []).filter((n) => n.kind === 'section');
    if (!sections.some((s) => s.id === sectionId)) {
      showNotice(t('writing.sectionGone', '该节已不存在（文档可能已重构），未跳转'), 4000);
      return;
    }
    setPreview(false);
    if (viewMode !== 'document') setViewMode('document');
    const timer = setTimeout(() => {
      const editor = polishEditorRef.current;
      if (!editor) return;
      const headings: Array<{ text: string; level: number; pos: number }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') headings.push({ text: node.textContent, level: Number(node.attrs.level ?? 2), pos });
        return true;
      });
      const target = resolveSectionJumpTarget(sections, headings, sectionId);
      if (!target) {
        showNotice(t('writing.sectionJumpNotFound', '未能在编辑器中定位该节（可能正在同步），请稍后重试'), 4000);
        return;
      }
      if (!target.exact) {
        showNotice(t('writing.sectionJumpApprox', '未精确定位到该节，已跳转到最接近位置'), 4000);
      }
      const hit = headings[target.index];
      if (!hit) return;
      editor.commands.setTextSelection(hit.pos + 1);
      editor.commands.scrollIntoView();
      editor.commands.focus();
    }, 120);
    void timer;
  }, [chatSession?.lastDocProjection, doc?.block_projection, viewMode, setViewMode, showNotice, t]);

  // #837-ux: 同轮写回合批 — AI 一轮里逐节写回会连发多个 doc_updated,
  // 逐个进审阅 = "每次只能看到一个 diff"。正确交互:同一轮的全部变更
  // **一次性标记**在一个审阅里。触发时机:turn 结束(chatLoading true→false)
  // 或 60s 无新写回(流丢失兜底,每次新写回重置)。
  const pendingWriteBackRef = useRef<{ base: string; body: string; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const BATCH_FALLBACK_MS = 60_000;
  const [queuedRounds, setQueuedRounds] = useState(0);
  // #989 Phase 3: 批次基线投影 + 「正在编辑」节列表(流式可见,#987 —
  // 替代 60 秒黑盒缓冲:写回进行时画布实时展示节定位,turn 结束进审阅)。
  const batchBaseProjectionRef = useRef<import('@heurion/contracts').BlockProjection | undefined>(undefined);
  const [editingSections, setEditingSections] = useState<SectionLite[]>([]);
  // #996/#1002: 流式迷你 diff 行（键 = section id；批结束随审阅清空）。
  const [sectionDiffRows, setSectionDiffRows] = useState<Record<string, SectionCardRow[]>>({});


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
    appliedDocBody.current = pend.body;
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
  }, [showNotice, t, attachCommentSourcesToReview, currentTurnInstruction]);

  const prevChatLoadingRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevChatLoadingRef.current === true && !chat.chatLoading) {
      flushPendingWriteBack();
      // #1041: turn 收口 — 未产生写回的评论处理给失败/漂移 AI 回复；#1051 deck 评论在此判定成败。
      settlePendingCommentTurns();
    }
    // #989 Phase 3: turn 开始沿(false→true)冻结批次基线投影 — 此刻 store
    // 的投影仍是上一轮末态( consumption effect 消费事件后 store 已前移,
    // 批内首事件不可作基线)。上一轮无投影时回退文档加载时的服务端投影。
    if (prevChatLoadingRef.current === false && chat.chatLoading) {
      batchBaseProjectionRef.current = chatSession?.lastDocProjection ?? doc?.block_projection ?? undefined;
      setEditingSections([]);
    }
    prevChatLoadingRef.current = chat.chatLoading;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 沿检测仅依赖 chatLoading;doc/投影经 store 快照读取
  }, [chat.chatLoading, flushPendingWriteBack, settlePendingCommentTurns]);

  // #696: 润色气泡状态机下沉 usePolishBubble（#797: rAF 合帧）。
  const bubble = usePolishBubble({
    docId,
    editorRef: polishEditorRef,
    onNotice: showNotice,
    // #871: 气泡「在聊天中继续」— 选区文本走聊天上下文通道,指令预填
    // 聊天输入,打开聊天面板由用户确认发送。
    onSendToChat: (selection, instruction) => {
      setChatSelection(selection);
      setChatInput(instruction);
      setChatOpen(true);
    },
    // #1029: 服务端基线 + 冲突「插入到最新版本」落地 — 与 AI 写回同语义
    // （应用后服务端基线前移，本地内容标 dirty 待保存）。
    serverBodyRef,
    onApplyExternalBody: (md, freshServerBody) => {
      setBody(md);
      lastSavedBody.current = freshServerBody;
      serverBodyRef.current = freshServerBody;
      setDoc((prev) => (prev ? { ...prev, body: freshServerBody, updated_at: new Date().toISOString() } : prev));
      dirtyRef.current = true;
      setDirty(true);
    },
  });

  // #636 doc write-back diff 审阅 — 依赖 chatSession。
  // #837-ux: 同轮合批 — 写回到达只更新批次末值,turn 结束/兜底超时才进审阅。
  // #927: rev 幂等防乱序 — 服务端写回带单调 rev,已应用 rev 之后的旧事件
  // (SSE 重放/乱序)直接忽略;无 rev 的旧后端事件保持原行为。
  useEffect(() => {
    if (!docId || !chatSession?.lastDocBody) return;
    if (!shouldApplyDocRev(appliedDocRevRef.current, chatSession.lastDocRev)) return;
    if (appliedDocBody.current === chatSession.lastDocBody) return;
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
    appliedDocBody.current = chatSession.lastDocBody;
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
  }, [chatSession?.lastDocBody, chatSession?.lastDocRev, chatSession?.lastDocProjection, docId, flushPendingWriteBack]);

  // #408-followup: AI 改名写回(doc_updated.title)— 服务端已落库,本地同步
  // 输入框 state + doc.title 基线(单一数据源:title state 是唯一编辑源,
  // doc.title 只做服务端镜像),不标 dirty(服务端已是该值)。
  useEffect(() => {
    const next = chatSession?.lastDocTitle;
    if (!docId || !next || appliedDocTitle.current === next) return;
    appliedDocTitle.current = next;
    setTitle(next);
    setDoc((prev) => (prev ? { ...prev, title: next } : prev));
  }, [chatSession?.lastDocTitle, docId]);

  // #773: AI deck 写回（edit_deck / organize 落 deck）— 页级小改直接应用
  // + 服务端快照回滚（deck 页是天然结构化单元，整篇 markdown diff 反而难读）。
  // 并发守卫：本地有未保存 deck 编辑时不直接覆盖 — #1043: 常驻冲突提示条
  // (非 6 秒 toast),由用户在「保留我的编辑/使用 AI 的版本」中明示决策。
  useEffect(() => {
    if (!docId || !chatSession?.lastDocDeck) return;
    const deckKey = JSON.stringify(chatSession.lastDocDeck);
    if (appliedDocDeck.current === deckKey) return;
    appliedDocDeck.current = deckKey;
    // 本地有未保存编辑且与服务端 AI deck 分叉 → 挂起冲突,等用户决策。
    if (deckJson && deckJson !== lastSavedDeck.current && deckJson !== deckKey) {
      setDeckConflict({ serverDeck: chatSession.lastDocDeck, serverDeckKey: deckKey });
      return;
    }
    // 无分叉(本地无未保存编辑) — 静默换源并同步"已保存"基线。
    setDeckConflict(null);
    lastSavedDeck.current = deckKey;
    setDeckAsset(chatSession.lastDocDeck);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref 稳定(#696 hooks 下沉)
  }, [chatSession?.lastDocDeck, docId, deckJson]);

  // #1043: 「保留我的编辑」— 本地 deck 为权威:force 落盘一次(语义同
  // #882 saveConflict 的 KeepMine),覆盖服务端 AI deck;appliedDocDeck
  // 不动(仍指向已消费的服务端事件 key,幂等守卫不得被破坏)。
  const resolveDeckConflictKeepMine = async () => {
    if (!docId || !deckConflict || deckConflictResolving) return;
    // #895 同款守卫:正文审阅未决时 body 处于审阅前状态,连带 force 落盘
    // 会把审阅前的正文盖回服务端 — 先让用户处理审阅,横幅保留。
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      setDeckConflictConfirm(null);
      showNotice(t('writing.reviewFirstForDeckConflict', '请先处理当前的 AI 修改审阅，再解决画布冲突'));
      return;
    }
    setDeckConflictResolving(true);
    try {
      const updated = await saveDoc(title, body, { deck: deckAsset ?? undefined, force: true });
      lastSavedBody.current = updated.body ?? body;
      serverBodyRef.current = updated.body ?? body;
      lastSavedDeck.current = deckAsset ? JSON.stringify(deckAsset) : lastSavedDeck.current;
      setDeckConflict(null);
      setDeckConflictConfirm(null);
      setSaveFailure(null);
      showNotice(t('writing.deckConflictKeptMine', '已保留本地画布编辑（已成为权威版本）'), 3000);
    } catch (err) {
      // #986 同款:落盘失败 → 常驻警示 + dirty 回灌,横幅保留可重试。
      markSaveFailed(err);
    } finally {
      setDeckConflictResolving(false);
    }
  };

  // #1043: 「使用 AI 的版本」— 丢弃本地未保存编辑,采用服务端 AI deck。
  // 服务端已是权威,无需再保存;dirty 随基线同步自动消除。
  const resolveDeckConflictUseAI = () => {
    if (!deckConflict) return;
    setDeckAsset(deckConflict.serverDeck);
    lastSavedDeck.current = deckConflict.serverDeckKey;
    setDeckConflict(null);
    setDeckConflictConfirm(null);
    setSaveFailure(null);
    showNotice(t('writing.deckConflictUsedAI', '已采用 AI 的画布版本'), 3000);
  };

  /**
   * 审阅结束:接受/拒绝结果落地,拒绝或放弃则保持原正文。#837: 结束后弹出队列中的下一轮写回。
   * #927: 冲突「载入最新」的确认审阅 — 接受 = 丢弃本地未保存修改、原样采用
   * 服务端最新(无需再保存,服务端已是该版本);取消 = 保留本地,冲突横幅仍在。
   */
  const handleDiffResolve = useCallback((result: { md: string; accepted: number; rejected: number; cancelled: boolean }) => {
    if (conflictLoadRef.current) {
      const fresh = conflictLoadRef.current;
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
    // #1041: 评论来源的审阅收口 — accept → 评论自动 resolved（用例 3）；
    // 放弃/拒绝 → 保持 open 可重新编辑后再触发（用例 4）。
    const commentSources = diffCommentSourcesRef.current;
    if (commentSources && commentSources.key === diffReviewKeyRef.current) {
      diffCommentSourcesRef.current = null;
      if (!result.cancelled) {
        for (const id of commentSources.ids) void resolveCommentById(id);
      }
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
  }, [docId, title, restoreReview, showNotice, popNextWriteBack, extractConflictCurrent, resolveCommentById]);

  // #402-merge: append a library figure to the document body.
  const handleInsertChart = (markdown: string) => {
    // #720: 审阅未决时插入图表会被编辑器吞掉(审阅内容由 diffReview 驱动) — 明示。
    if (diffReview) {
      showNotice(t('writing.reviewFirstForChart', '请先完成当前 AI 修改的审阅，再插入图表'));
      return;
    }
    setBody((prev) => `${prev || ''}\n\n${markdown}`);
    setDoc((prev) => (prev ? { ...prev, body: `${prev.body || ''}\n\n${markdown}`, updated_at: new Date().toISOString() } : prev));
  };

  const [preview, setPreview] = useState(false);

  // #770: 画布视图模式 — body 仍是唯一数据源，幻灯片视图 = toSlides(body) 投影；
  // AI 写回（doc_updated → setBody）与文档视图编辑自动同步到卡片，零额外状态。
  // #773: Doc.deck 存在时 deck 视图切换为 deck 资产来源（可编辑，独立于 body）。
  // #996/#1000: viewMode 初始化上移（?view=deck 直达 Slides tab）。
  const pendingDeckAnchorRef = useRef<string | null>(null);

  // #770: 幻灯片卡片 = body 派生（useMemo），doc_updated / 手动编辑即时反映。
  const deck = useMemo(() => toSlides(body), [body]);

  // #770: 卡片「编辑」→ 切回文档视图并锚定对应 ## 段（复用编辑器实例定位）。
  // DocEditor 重新挂载后编辑器实例才可用 — 短暂重试等挂载完成。
  useEffect(() => {
    if (viewMode !== 'document') return;
    const anchor = pendingDeckAnchorRef.current;
    if (!anchor) return;
    const timer = setTimeout(() => {
      const editor = polishEditorRef.current;
      if (!editor) return;
      pendingDeckAnchorRef.current = null;
      let target: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (target !== null) return false;
        if (node.type.name === 'heading' && node.textContent.trim() === anchor.trim()) {
          target = pos;
          return false;
        }
        return true;
      });
      if (target !== null) {
        editor.commands.setTextSelection((target as number) + 1);
        editor.commands.scrollIntoView();
        editor.commands.focus();
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [viewMode]);

  const handleDeckCardEdit = (slide: Slide) => {
    pendingDeckAnchorRef.current = slide.headingRaw ? slide.title : '';
    setPreview(false);
    setViewMode('document');
  };

  const handleGenerateMethods = async () => {
    if (!docId) return;
    // #983: 生成 Methods 不再 setBody 直写 — 与 AI 编辑同一确认通道
    // （diff-review,接受后经 handleDiffResolve → saveDoc 带 base_sha 冲突
    // 检测）。此前是全应用唯一「无确认直接写文档」的 AI 路径,与 autosave/
    // AI 写回并发时可能静默吞掉未保存修改。
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      showNotice(t('writing.reviewFirstForMethods', '请先完成当前 AI 修改的审阅，再生成内容'));
      return;
    }
    setMethodsLoading(true);
    setMethodsError(null);
    try {
      const res = await api.generateMethods(docId);
      const next = `${bodyRef.current}${bodyRef.current ? '\n\n' : ''}## Methods\n\n${res.methods}\n`;
      if (next === bodyRef.current) return;
      // #996/#998: methods 提议卡表头("Drafted from the linked study protocol")。
      setDiffReview({ key: `methods_${Date.now()}`, old: bodyRef.current, next, source: 'methods', subject: 'Methods' });
      // deck 视图下 markdown 审阅不可见 — 自动切回文档视图(同写回路径)。
      setViewMode((m) => (m === 'deck' ? 'document' : m));
    } catch (err) {
      setMethodsError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setMethodsLoading(false);
    }
  };

  const handleInjectResults = async () => {
    if (!docId || !injectLabel.trim() || !injectResult.trim()) return;
    // #983: 审阅未决时注入会与 diffReview 驱动的编辑器内容互相踩踏 — 同
    // handleInsertChart 守卫,明示先完成当前审阅。
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      showNotice(t('writing.reviewFirstForMethods', '请先完成当前 AI 修改的审阅，再生成内容'));
      return;
    }
    setInjecting(true);
    try {
      const res = await api.injectResults(docId, injectLabel.trim(), injectResult.trim());
      const subject = injectLabel.trim();
      // #996/#997: 服务端返回写回后的新正文 + 同帧投影 — 注入结果直接路由进
      // 统一提议卡(#998: results 表头),与 AI 写回同语义(先落库后审阅,
      // 放弃 = 反向保存回滚);此前 {ok} 后自行 GET 全文三路合并/静默应用。
      if (typeof res.body === 'string') {
        serverBodyRef.current = res.body;
        appliedDocBody.current = res.body;
        if (res.body !== bodyRef.current) {
          setDiffReview({ key: `inject_${Date.now()}`, old: bodyRef.current, next: res.body, source: 'results', subject });
          setViewMode((m) => (m === 'deck' ? 'document' : m));
          setChatSelection('');
        }
      } else {
        // 旧后端兜底(响应无 body):沿用 getDoc + 三路合并路径。
        const d = await api.getDoc(docId);
        // #983: 服务端已在「服务端正文 + 注入块」上落库（writeDocVersion 单点）。
        // 本地改用三路合并应用增量 — 此前「拉最新 body 整篇覆盖」会静默吞掉
        // 本地未保存修改。base = 最后同步的服务端正文,ours = 本地(可能含
        // 未保存编辑),theirs = 注入后的服务端正文。
        const base = serverBodyRef.current ?? bodyRef.current;
        const merged = mergeThreeWay(base, bodyRef.current, d.body);
        if (merged === null) {
          // 注入块与本地未保存修改在基线坐标上重叠 → 三路合并不安全:
          // 进冲突确认审阅（接受 = 采用服务端版本,不再保存;取消 = 保留本地,
          // 后续保存经 base_sha 失配 409 走冲突横幅），绝不静默覆盖任一侧。
          conflictLoadRef.current = d;
          setDiffReview({ key: `inject_${Date.now()}`, old: bodyRef.current, next: d.body, source: 'results', subject });
          setViewMode((m) => (m === 'deck' ? 'document' : m));
          showNotice(t('writing.injectConflictReview', '结果注入与本地未保存修改冲突 — 已进入审阅确认'), 6000);
        } else {
          // 服务端视角基线推进到注入后的正文 — 后续保存的 base_sha 指纹正确。
          serverBodyRef.current = d.body;
          if (merged !== bodyRef.current) setBody(merged);
          setDoc((prev) => (prev ? { ...prev, body: merged, updated_at: d.updated_at } : prev));
        }
      }
      setInjectOpen(false);
      setInjectLabel('');
      setInjectResult('');
    } catch (err) {
      setMethodsError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setInjecting(false);
    }
  };

  // #382: drag the chat panel edge to resize (desktop); width persists.
  const handleChatResizeStart = (e: React.MouseEvent<HTMLDivElement>) => {
    resizingRef.current = true;
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const width = Math.min(720, Math.max(280, window.innerWidth - e.clientX));
      setChatWidth(width);
    };
    const onUp = () => {
      if (resizingRef.current) {
        resizingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try { localStorage.setItem('nexus.docchat.width', String(chatWidthRef.current)); } catch { /* ignore */ }
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    if (!docId) return;
    // #903: stale-response 守卫 — 切文档后,上一个 docId 的晚到响应不得覆盖
    // 新文档状态(cancelled 由 cleanup 置位,effect 闭包内的 docId 即本次请求目标)。
    let cancelled = false;
    setLoading(true);
    setError(null);
    // #903: 立即清空旧文档 — 阻断旧 body/title 参与新文档的 dirty/autosave 判断。
    setDoc(null);
    // #382/#726: linked submission state (target journal / applied template).
    // #726: 按 docId 取对应投稿草稿,不再所有文档共享 drafts[0]。
    api.listSubmissionDrafts().then((r) => {
      if (cancelled) return;
      // #726: 按 docId 取对应投稿草稿。
      // #927: 不再回退 r.drafts[0] — 未命中即视为无关联草稿,避免其他
      // 文档的期刊/模板串台到当前文档头部(消费点仅有 header 徽标,
      // 空串安全)。
      const mine = docId ? r.drafts.find((d) => d.doc_id === docId) : undefined;
      if (mine) {
        setLinkedJournal(mine.target_journal || '');
        setLinkedTemplate(mine.template_id || '');
      }
    }).catch(() => {});
    api.getDoc(docId)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setTitle(d.title);
        setBody(d.body);
        // #773: deck 资产装载（服务端返回已解析对象）。
        const deck = (d.deck && typeof d.deck === 'object' ? d.deck : null) as DeckWire | null;
        setDeckAsset(deck);
        lastSavedDeck.current = deck ? JSON.stringify(deck) : '';
        appliedDocDeck.current = lastSavedDeck.current;
        setStudyId(d.study_id || '');
        setStudyName(d.study_name || '');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.messageText : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref 稳定(#696 hooks 下沉)
  }, [docId]);

  // #979: 双保险 — 路由层 key={docId}（App.tsx WritingEditorRoute）已让切
  // 文档重挂清零;本 effect 防未来路由重构回归:key 失效时切文档仍强制清空
  // 核心写状态,防 A 文档的审阅/冲突/PHI/导出态串染到 B 文档（历史上
  // #902/#903 的 reset 清单漂移教训:逐项补不可靠,这里一次性全清）。
  useEffect(() => {
    setDiffReview(null);
    setRestoreReview(null);
    conflictLoadRef.current = null;
    setSaveConflict(null);
    // #989 Phase 3: 切文档同时清「正在编辑」指示状态。
    setEditingSections([]);
    setPhiFindings(null);
    setShowPhiDialog(false);
    setExportResult(null);
    setExportPanelOpen(false);
    setMethodsError(null);
    setShowHistory(false);
    // #1040: 切文档清评论态 — 旧文档线程/激活态/草稿不得串染新文档。
    setDocComments([]);
    setActiveCommentId(null);
    setCommentDraft(null);
    // #1041: 评论处理在途状态一并清 — 旧文档的 pending turn/审阅关联不得串染。
    pendingCommentTurnsRef.current.clear();
    diffCommentSourcesRef.current = null;
    setCommentProcessing({});
  }, [docId]);

  const loadSnapshots = useCallback(() => {
    if (!docId) return;
    setSnapshotsLoading(true);
    api.getDocSnapshots(docId)
      .then((r) => setSnapshots(r.snapshots))
      .catch(() => {})
      .finally(() => setSnapshotsLoading(false));
  }, [docId]);

  // #1040: 评论列表 — 文档挂载后拉取(resolved/漂移诊断都以服务端为准)。
  // 拉取失败不打扰(侧边栏空态),下次操作后重拉。
  const loadComments = useCallback(() => {
    if (!docId) return;
    // #1064: 诊断懒计算 — 评论面板需要锚点定位状态,显式 with_anchor=1。
    api.listDocComments(docId, { with_anchor: true })
      .then((r) => setDocComments(r.comments))
      .catch(() => {});
  }, [docId]);
  useEffect(() => {
    loadComments();
  }, [loadComments]);

  // #1040: 提交选区评论 — 选区文字作 anchorText,节引用反查与「选中即引用」
  // 同口径(投影缺失降级 'doc');本地乐观插入(located=true,刚创建必可定位)。
  // #1051: deck slide 评论 — anchorText=页标题,锚点判别字段 target/slide_index
  // (1-based)随创建请求上行,走同一套侧边栏线程(不建两套评论 UI)。
  const submitComment = async (text: string) => {
    if (!docId || !commentDraft) return;
    setCommentSubmitting(true);
    try {
      let created: DocCommentWire;
      if ('target' in commentDraft) {
        created = await api.createDocComment(docId, {
          target: 'deck_slide',
          slide_index: commentDraft.slideIndex0 + 1,
          anchor_text: commentDraft.anchorText,
          text,
        });
      } else {
        const anchorText = commentDraft.text;
        const proj = chatSession?.lastDocProjection ?? doc?.block_projection;
        const offset = bodyRef.current.indexOf(anchorText.slice(0, 80));
        const sec = proj && offset >= 0 ? findSectionAtOffset(proj, offset) : null;
        created = await api.createDocComment(docId, { section_id: sec?.id ?? 'doc', anchor_text: anchorText, text });
      }
      setDocComments((prev) => [...prev, { ...created, anchor: { located: true } }]);
      setActiveCommentId(created.id);
      setCommentsPanelOpen(true);
      setCommentDraft(null);
    } catch {
      showNotice(t('writing.commentCreateFailed', '评论提交失败，请重试'), 4000);
    } finally {
      setCommentSubmitting(false);
    }
  };

  // #1040: 追加回复 — 本地按时间序插入线程。
  const replyToComment = async (commentId: string, text: string) => {
    if (!docId) return;
    try {
      const reply = await api.createDocCommentReply(docId, commentId, { role: 'user', text });
      setDocComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c)));
    } catch {
      showNotice(t('writing.commentReplyFailed', '回复发送失败，请重试'), 4000);
    }
  };

  // #1040: resolved/reopen — PATCH 后重拉列表(锚点诊断以服务端为准)。
  const toggleCommentResolved = async (c: DocCommentWire) => {
    if (!docId) return;
    const next = c.status === 'resolved' ? 'open' : 'resolved';
    try {
      await api.updateDocComment(docId, c.id, next);
      const r = await api.listDocComments(docId, { with_anchor: true });
      setDocComments(r.comments);
    } catch {
      showNotice(t('writing.commentUpdateFailed', '评论状态更新失败，请重试'), 4000);
    }
  };

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
   */
  const handleCommentAiProcess = useCallback((c: DocCommentWire) => {
    if (!docId || c.status === 'resolved') return;
    if (pendingCommentTurnsRef.current.has(c.id)) return;
    if (pendingCommentTurnsRef.current.size > 0) return;
    // 与生成 Methods 同一互斥纪律：审阅未决/写回批次待冲刷时先完成审阅。
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      showNotice(t('writing.reviewFirstForComment', '请先完成当前的 AI 修改审阅，再处理评论'));
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
    pendingCommentTurnsRef.current.set(c.id, {
      target: isDeck ? 'deck_slide' : 'section',
      ...(isDeck ? { deckKeyAtStart: JSON.stringify(useChatStore.getState().sessions[`doc-${docId}`]?.lastDocDeck ?? null) } : {}),
      instruction,
    });
    setCommentProcessing((prev) => ({ ...prev, [c.id]: true }));
    // #1060: loading 与 turn 真实边界对齐 — 不再在 send promise 的 finally
    // 收口（排队时入队即 resolve，按钮会提前复活而 turn 尚未运行）。改由
    // 消费点（attach/settle）或 pending 覆盖/清理事件统一收口。
    void chat.sendChatText(instruction);
  }, [docId, diffReview, showNotice, t, chat]);

  // #1060: 排队指令被覆盖/Stop/regenerate 清空 — store 单槽只保留最后一条,
  // 被静默丢弃的评论指令此前永久滞留登记表（has() 守卫反把合法重试挡死,
  // 仅切文档才清）。订阅丢弃事件:匹配指令指纹的登记即清（登记+按钮
  // loading 收口+线程补失败说明），被覆盖的评论可立即重试。
  useEffect(() => {
    if (!docId) return;
    const sid = `doc-${docId}`;
    return onChatPendingDropped((e) => {
      if (e.sessionId !== sid) return;
      failCommentTurnsByFp(e.text);
    });
  }, [docId, failCommentTurnsByFp]);

  const handleToggleHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) loadSnapshots();
  };

  const handleSave = async () => {
    if (!docId) return;
    // #895: 审阅未决或写回批次待冲刷时禁止保存 — 防止把审阅前的正文盖回
    // 服务端(覆盖 AI 写回)。接受/放弃落地路径(handleDiffResolve)直连
    // saveDoc,不经过本守卫,落地不受影响。
    // #1043: deck 冲突未决时同样禁止 — 手动保存会以本地 deck 静默覆盖
    // 服务端 AI deck,决策必须经冲突提示条明示。
    // #1066-3: 冲突未决时保存此前静默 return 无反馈 — 明确提示走横幅决策。
    // 此态下 markSaveFailed 回灌的 dirty 无 autosave 消费(autosave 暂停),
    // 兜底路径即横幅按钮本身:「保留我的编辑」force 落盘不依赖 autosave,
    // 失败再回灌 dirty 且横幅保留可重试,无死路。
    if (diffReview !== null || pendingWriteBackRef.current !== null) return;
    if (deckConflict !== null) {
      showNotice(t('writing.deckConflictBanner', '画布冲突 — AI 已更新服务端画布，本地有未保存的画布编辑，请选择保留哪个版本'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // #773: deck 一并保存（deckAsset 为 null 时不触碰服务端 deck）。
      const updated = await saveDoc(title, body, { deck: deckAsset ?? undefined });
      lastSavedBody.current = updated.body ?? body;
      serverBodyRef.current = updated.body ?? body;
      lastSavedDeck.current = deckAsset ? JSON.stringify(deckAsset) : lastSavedDeck.current;
      dirtyRef.current = false;
      setDirty(false);
      setSaveFailure(null); // #986: 保存成功清常驻警示。
      if (updated.unchanged) {
        // #598: 内容未变化 — 提示且不刷新时间戳.
        showNotice(t('writing.unchanged', '内容未变化，未创建新版本'), 3000);
        setDoc((prev) => prev ? { ...prev, title: updated.title, body: updated.body } : prev);
      } else {
        setDoc((prev) => prev ? { ...prev, title: updated.title, body: updated.body, updated_at: updated.updated_at } : prev);
        setTitle(updated.title);
        setBody(updated.body);
        showNotice(t('writing.savedVersion', '已保存并创建版本'), 3000);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'stale_base') {
        // #882: 视图过期(僵尸 tab) — 弹冲突横幅由用户决策。
        // #996/#997: 409 payload 的 current 随行 — 双栏对照零额外请求。
        setSaveConflict({ title, body, deck: deckAsset ?? undefined, current: extractConflictCurrent(err) });
        showNotice(t('writing.conflictDetected', '文档已在其他窗口被修改，当前窗口内容未保存'), 6000);
      } else {
        // #986: 非冲突失败 → 回灌 dirty + 常驻警示条(autosave 自动重试)。
        markSaveFailed(err);
      }
    } finally {
      setSaving(false);
    }
  };

  // #882: 冲突横幅动作。
  const resolveConflictKeepMine = async () => {
    if (!docId || !saveConflict) return;
    try {
      const updated = await saveDoc(saveConflict.title, saveConflict.body, { deck: saveConflict.deck, force: true });
      lastSavedBody.current = updated.body ?? saveConflict.body;
      serverBodyRef.current = updated.body ?? saveConflict.body;
      setDoc((prev) => prev ? { ...prev, body: updated.body } : prev);
      setSaveConflict(null);
      setSaveFailure(null); // #986: 保存成功清常驻警示。
      showNotice(t('writing.conflictKeptMine', '已保留当前窗口的版本'), 3000);
    } catch (err) {
      // #986: KeepMine 保存失败 → 常驻警示 + dirty 回灌(横幅保留可重试)。
      markSaveFailed(err);
    }
  };

  // #996/#997: 「Use AI's version」— 直接采用 409 payload 携带的服务端当前
  // 态(语义同旧「载入最新」确认审阅的接受分支:服务端已是该版本,无需再保存)。
  // review 复核(嵌套节批): current 是 #997 加的完整服务端态 — title/deck/
  // block_projection 必须一并应用,否则采纳后标题/幻灯片/AI 编辑批次基线
  // 仍停在本地旧值(弹窗显示"已载入"但视图只换了一半)。
  const resolveConflictUseSaved = () => {
    const fresh = saveConflict?.current;
    if (!fresh) return;
    applyServerDoc(fresh);
    setSaveConflict(null);
    setSaveFailure(null);
    showNotice(t('writing.conflictLoadedLatest', '已载入服务端最新内容'), 3000);
  };

  // #927: 「载入最新」改为 diff 审阅确认 — 本地未保存内容(old)与服务端
  // 最新(new)进 diffReview,用户看到将被丢弃的修改并逐条确认;不再直接
  // setBody 静默丢弃本地编辑。取消则保留本地,冲突横幅仍在。
  // #996/#997: 有 409 payload 时双栏卡的「Use AI's version」已覆盖此场景;
  // 本路径保留为旧后端(无 payload)的兜底。
  const resolveConflictLoadLatest = async () => {
    if (!docId || !saveConflict) return;
    try {
      const fresh = await api.getDoc(docId);
      if (fresh.body === bodyRef.current) {
        // 本地与服务端已一致 — 直接收口,无需审阅(完整态一并应用)。
        applyServerDoc(fresh);
        setSaveConflict(null);
        showNotice(t('writing.conflictLoadedLatest', '已载入服务端最新内容'), 3000);
        return;
      }
      conflictLoadRef.current = fresh;
      setDiffReview({ key: `conflict_${Date.now()}`, old: bodyRef.current, next: fresh.body, source: 'conflict', subject: fresh.title });
      // 审阅模式下 markdown diff 不可见 — deck 视图先切回文档视图(同写回路径)。
      setViewMode((m) => (m === 'deck' ? 'document' : m));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  /**
   * #764: Restore 先审阅 — 拉快照全文与当前正文进 diff 审阅模式(绿=恢复
   * 内容/红=当前内容),用户逐条确认后经 handleDiffResolve 落地并自动保存。
   */
  const handleRestoreRequest = async (snapshotId: string) => {
    if (!docId || !body) return;
    // #910: Restore × 审阅互斥 — diff 审阅未决或 AI 写回批次待冲刷时,
    // Restore 审阅会覆盖 diffReview 状态(正在审阅的 AI 修改/恢复内容互相
    // 顶掉,恢复与写回混在一个 diff 里无法分辨)。明示用户先完成当前审阅。
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      showNotice(t('writing.restoreBlockedByReview', '请先处理当前的 AI 修改审阅，再恢复历史版本'));
      return;
    }
    setRestoring(snapshotId);
    try {
      const snap = await api.getSnapshotBody(docId, snapshotId);
      setShowHistory(false);
      setRestoreReview({ snapshotId, label: snap.label });
      // #996/#998: restore 走 ProposalCard(restore 表头,reviewTitle 由下方传入)。
      setDiffReview({ key: `restore-${snapshotId}`, old: body, next: snap.body, source: 'restore' });
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setRestoring(null);
    }
  };

  const handlePhiScan = async () => {
    if (!docId) return;
    setPhiScanning(true);
    setError(null);
    try {
      const result = await api.runPhiScan(docId);
      setPhiFindings(result.findings);
      setShowPhiDialog(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setPhiScanning(false);
    }
  };

  const handleExportDocx = async () => {
    if (!docId) return;
    setExporting(true);
    setError(null);
    try {
      const result = await api.exportDocx(docId, doc?.title);
      setExportResult(result);
      // #754: 完成态面板 + 历史(blob 已在 api 层触发下载,这里补记录)。
      setExportHistory((prev) => [
        { format: 'docx' as const, filename: `${(doc?.title || 'document').replace(/[^a-z0-9\u4e00-\u9fa5_-]/gi, '_')}.docx`, size: result.size_bytes, at: Date.now() },
        ...prev.slice(0, 9),
      ]);
      setExportPanelOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setExporting(false);
    }
  };

  const handleExportPdf = async () => {
    if (!docId) return;
    setExporting(true);
    setError(null);
    try {
      const res = await api.exportDoc(docId, 'pdf', doc?.title);
      setExportHistory((prev) => [
        { format: 'pdf' as const, filename: res.path, size: res.size_bytes, at: Date.now() },
        ...prev.slice(0, 9),
      ]);
      setExportPanelOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : chatFailureText(err));
    } finally {
      setExporting(false);
    }
  };

  const { setChatInput } = chat;
  const { refDialogOpen, setRefDialogOpen, refForm, setRefForm, refSubmitting, handleAddReference, handleKbPickConfirm } = references;
  const [kbPickerOpen, setKbPickerOpen] = useState(false);

  if (loading) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6 gap-3">
            <Skeleton className="h-5 w-5" />
            <Skeleton className="h-5 w-48" />
          </div>
          <div className="p-6 space-y-4">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        </div>
      </AppShell>
    );
  }

  if (error && !doc) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6">
            <Button variant="ghost" size="sm" onClick={leaveEditor}>
              <ArrowLeft size={16} className="mr-1" /> Back
            </Button>
          </div>
          <div className="p-6">
            <Alert variant="error">{error}</Alert>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!doc) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6">
            <Button variant="ghost" size="sm" onClick={leaveEditor}>
              <ArrowLeft size={16} className="mr-1" /> Back
            </Button>
          </div>
          <div className="flex flex-1 items-center justify-center">
            <p className="text-text-tertiary">Document not found</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-hidden">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-surface px-6 shrink-0">
          <Button variant="ghost" size="sm" onClick={leaveEditor} className="shrink-0">
            <ArrowLeft size={16} />
          </Button>
          <FileText size={18} className="hidden shrink-0 text-text-tertiary sm:block" />
          {/* #408-followup: 页头标题从 title state 派生(单一数据源);点击
              聚焦唯一的标题编辑入口(正文区输入框),不再是不可交互的死文本。 */}
          <button
            type="button"
            onClick={() => { titleInputRef.current?.focus(); titleInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}
            title={t('writing.renameHint', '编辑标题')}
            className="min-w-0 flex-1 truncate text-left font-serif text-[17px] font-bold tracking-tight text-text-primary transition-colors hover:text-accent sm:flex-none"
          >
            {title || 'Untitled'}
          </button>
          {studyName && (
            <button
              onClick={() => studyId && navigate(`/app/research/${studyId}`)}
              className="hidden rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-xs text-accent transition-colors hover:bg-accent/10 sm:inline"
              title={t('writing.openStudy', '打开研究详情')}
            >
              {t('writing.studyBadge', '研究')}: {studyName} ↗
            </button>
          )}
          {linkedJournal && (
            <span className="hidden rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-xs text-accent sm:inline">
              {t('submission.targetJournalShort', '目标期刊')}: {linkedJournal}
            </span>
          )}
          {linkedTemplate && (
            <span className="hidden rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary sm:inline">
              {t('submission.templateAppliedShort', '已应用模板')}: {linkedTemplate}
            </span>
          )}
          {/* #996/#1000: Preview/History/DOCX 常驻按钮收进 ··· 菜单(Toolbar)。 */}
          {/* #770: 文档 | 幻灯片视图切换 — deck 视图是 body 的只读投影。
              #1000: 共享 SegmentedControl(窄屏隐藏,#1001 经 ··· 可达)。 */}
          <div className="ml-2 hidden sm:inline-flex">
            <SegmentedControl
              size="xs"
              ariaLabel={t('writing.viewMode', '视图模式')}
              value={viewMode}
              onChange={(next) => { if (next === 'document') setPreview(false); setViewMode(next); }}
              items={[
                { value: 'document', label: t('writing.docView', '文档'), icon: <FileText size={13} /> },
                { value: 'deck', label: `${t('writing.deckView', '幻灯片')} · ${deck.slides.length}`, icon: <Presentation size={13} /> },
              ]}
            />
          </div>
          {aiEditNotice && (
            <span className="ml-3 rounded-full border border-success/30 bg-success/5 px-2 py-0.5 text-xs text-success">
              {aiEditNotice}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {/* #1040: 评论面板开关 — 徽标数为 open 线程数。 */}
            <Button size="sm" variant="ghost" onClick={() => setCommentsPanelOpen((v) => !v)} aria-label={t('writing.commentsPanel', '评论')} title={t('writing.commentsPanel', '评论')} className={cn(commentsPanelOpen && 'bg-surface')}>
              <MessageSquare size={14} />
              {docComments.some((c) => c.status !== 'resolved') && (
                <span className="ml-0.5 text-xs">{docComments.filter((c) => c.status !== 'resolved').length}</span>
              )}
            </Button>
            <Button size="sm" onClick={handleSave} isLoading={saving} disabled={saving}>
              {dirty ? t('writing.unsaved', '● 未保存') : 'Save'}
            </Button>
            {/* #996/#1000: Export ▾ + ··· 更多菜单(工具栏收敛进页头)。 */}
            <Toolbar
              refSuggestions={refSuggestions}
              refSuggestionResolving={refSuggestionResolving}
              onAcceptRefSuggestion={(id) => void resolveRefSuggestion(id, true)}
              onDismissRefSuggestion={(id) => void resolveRefSuggestion(id, false)}
              chat={chat}
              references={references}
              phiScanning={phiScanning}
              onPhiScan={handlePhiScan}
              exporting={exporting}
              onExportDocx={handleExportDocx}
              onExportPdf={() => handleExportPdf()}
              studyId={studyId}
              methodsLoading={methodsLoading}
              methodsError={methodsError}
              onGenerateMethods={handleGenerateMethods}
              injectOpen={injectOpen}
              setInjectOpen={setInjectOpen}
              injectLabel={injectLabel}
              setInjectLabel={setInjectLabel}
              injectResult={injectResult}
              setInjectResult={setInjectResult}
              injecting={injecting}
              onInjectResults={handleInjectResults}
              onOpenKbPicker={() => setKbPickerOpen(true)}
              setChatOpen={setChatOpen}
              chatOpen={chatOpen}
              onToggleHistory={handleToggleHistory}
              previewing={preview}
              onTogglePreview={() => setPreview((v) => !v)}
              viewMode={viewMode}
              onToggleViewMode={() => setViewMode((m) => (m === 'deck' ? 'document' : 'deck'))}
              deckSlideCount={deck.slides.length}
              exportResult={exportResult}
              exportHistory={exportHistory}
              exportPanelOpen={exportPanelOpen}
              setExportPanelOpen={setExportPanelOpen}
            />
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <main className={cn('flex-1 overflow-y-auto p-6', chatOpen ? 'border-r border-border' : '')}>
          {/* #763: Selection Bubble 首次引导 — 一次性,dismiss 永久记住。 */}
          <div className="mx-auto mb-3 max-w-3xl">
            <SpotHint id="writing-selection-bubble" icon="✨">
              试试:<b>选中任意一段文字</b>,会出现润色菜单;不选中则润色全文。
            </SpotHint>
          </div>
          {error && (
              <div className="mb-4 max-w-3xl mx-auto">
                <Alert variant="error">{error}</Alert>
              </div>
            )}

            {phiFindings && phiFindings.length > 0 && (
              <div className="mb-4 max-w-3xl mx-auto">
                <Alert variant="warning">
                  Found {phiFindings.length} potential PHI instance{phiFindings.length !== 1 ? 's' : ''}.{' '}
                  <button className="underline font-medium" onClick={() => setShowPhiDialog(true)}>View details</button>
                </Alert>
              </div>
            )}

            <div className="mx-auto max-w-3xl space-y-4">
              {/* #1031: 建议态横幅 — 与主 chat 同一组件；不打断编辑，采纳才转正式引用。 */}
              <SuggestedReferenceBanner
                suggestions={refSuggestions}
                resolving={refSuggestionResolving}
                onAccept={(id) => void resolveRefSuggestion(id, true)}
                onDismiss={(id) => void resolveRefSuggestion(id, false)}
              />
              <div>
                <input
                  ref={titleInputRef}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Document title"
                  className="w-full rounded-lg border border-border bg-surface-elevated px-4 py-2 text-lg font-semibold text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>

              <div>
                {deckConflict && (
                  /* #1043: deck/正文分叉冲突 — 常驻提示条(不自动消失),
                     两个明确出口;未决策前 autosave/手动保存均暂停。 */
                  <div data-testid="deck-conflict-banner" role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-text-primary">
                    <span>⚠ {t('writing.deckConflictBanner', '画布冲突 — AI 已更新服务端画布，本地有未保存的画布编辑，请选择保留哪个版本')}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setDeckConflictConfirm('keep')}>{t('writing.deckConflictKeepMine', '保留我的编辑')}</Button>
                      <Button size="sm" variant="danger" onClick={() => setDeckConflictConfirm('use-ai')}>{t('writing.deckConflictUseAI', '使用 AI 的版本')}</Button>
                    </div>
                  </div>
                )}
                {preview ? (
                  <div className="min-h-[300px] rounded-lg border border-border bg-surface-elevated p-4">
                    <MarkdownRenderer content={body} />
                  </div>
                ) : viewMode === 'deck' ? (
                  /* #770: 幻灯片视图 — 16:9 卡片流。
                     #773: 双来源 — Doc.deck 存在时为可编辑 deck 卡片（写
                     Doc.deck，不动正文）；否则回落 body 的 markdown 投影
                     （只读 + 锚点跳回文档编辑）。 */
                  <DeckView
                    deckAsset={deckAsset}
                    slides={deck.slides}
                    body={body}
                    deckCtl={deckCtl}
                    sendChatText={chat.sendChatText}
                    onCardEdit={handleDeckCardEdit}
                    /* #1051: deck slide 评论 — 添加入口 + 卡片高亮/徽标与侧边栏联动
                       （deck 非 TipTap,不做 decoration,卡片文字高亮替代）。 */
                    deckComments={docComments
                      .filter((c) => c.target === 'deck_slide')
                      .map((c) => ({
                        commentId: c.id,
                        slideIndex: c.slide_index ?? 0,
                        anchorText: c.anchor_text,
                        status: c.status,
                        located: c.anchor?.located ?? true,
                        active: activeCommentId === c.id,
                      }))}
                    onAddSlideComment={(slideIndex0, anchorText) => setCommentDraft({ target: 'deck_slide', slideIndex0, anchorText })}
                    onCommentClick={(id) => { setActiveCommentId(id); setCommentsPanelOpen(true); }}
                  />
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border bg-surface-elevated">
                    {!diffReview && editingSections.length > 0 && (
                      /* #989 Phase 3: 编辑过程流式可见(#987)— 写回进行时
                         实时展示 AI 正在编辑的节,替代 60 秒黑盒缓冲;
                         turn 结束自动让位于 diff 审阅。 */
                      <div className="flex items-center gap-2 border-b border-accent/20 bg-accent/5 px-3 py-2 text-[12px] text-text-primary">
                        <span data-testid="editing-live">🛠 {t('writing.editingLive', 'AI 正在编辑')}</span>
                        <span className="truncate text-text-secondary">
                          {editingSections.map((s) => (s.heading || s.id)).join('、')}
                        </span>
                      </div>
                    )}
                    {bubble.bubbleConflict && (
                      /* #1029: 润色应用冲突 → 同一 ProposalCard(conflict 变体) —
                         润色结果 vs 文档当前内容双栏;可插入最新版本 / 转发到
                         聊天 / 丢弃(丢弃也自动带入聊天输入,结果不彻底丢失)。 */
                      <ProposalCard
                        source="conflict"
                        subject={t('writing.polishConflictSubject', '选区润色与文档更新冲突')}
                        note={t('writing.polishConflictNote', '润色基于旧版本生成；右侧为文档当前内容')}
                        conflict={{
                          yours: bubble.bubbleConflict.polishText,
                          saved: conflictSavedPreview(bubble.bubbleConflict),
                          onKeepMine: bubble.handleBubbleConflictInsert,
                          onUseSaved: bubble.handleBubbleConflictDiscard,
                          keepMineLabel: t('writing.polishConflictInsert', '插入到最新版本'),
                          useSavedLabel: t('writing.polishConflictDrop', '丢弃润色结果'),
                          forwardLabel: t('writing.polishConflictForward', '转发到聊天'),
                          onForward: bubble.handleBubbleConflictSendToChat,
                        }}
                      />
                    )}
                    {saveConflict && (
                      /* #996/#997: 并发保存冲突 → 统一提议卡(conflict 变体) —
                         Yours/AI's 双栏对照(409 payload 数据源),Keep mine /
                         View full diff / Use AI's version;旧后端无 payload 时
                         saved 为空串,「Use AI's version」自动落回旧「载入最新」流。 */
                      <ProposalCard
                        source="conflict"
                        subject={saveConflict.title}
                        note={saveConflict.current ? undefined : t('writing.conflictLegacyNotice', '服务端版本信息需重新载入')}
                        conflict={{
                          yours: saveConflict.body,
                          saved: saveConflict.current?.body ?? '',
                          onKeepMine: () => void resolveConflictKeepMine(),
                          onUseSaved: () => (saveConflict.current ? resolveConflictUseSaved() : void resolveConflictLoadLatest()),
                        }}
                      />
                    )}
                    {saveFailure && (
                      /* #986: 保存失败常驻警示条 — 保存成功自动消除;失败期间
                         dirty 保持、autosave 持续重试,内容不会静默丢失。 */
                      <div className="flex items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-text-primary">
                        <span>⚠ {t('writing.saveFailedBanner', '保存失败 — 修改仅在本窗口，系统持续自动重试中')}{saveFailure.message ? `：${saveFailure.message}` : ''}</span>
                      </div>
                    )}
                    <DocEditor value={body} onChange={setBody} editorRef={polishEditorRef} diffReview={diffReview} onDiffResolve={handleDiffResolve} onSelectionChange={setChatSelection}
                      queuedRounds={queuedRounds}
                      reviewTitle={restoreReview ? t('writing.restoreReviewTitle', '审阅版本恢复') : undefined}
                      /* #996/#1002: 节卡片化数据流 — 投影对位/节级徽标/AI 编辑高亮/流式迷你 diff。 */
                      sectionCards={{
                        projection: chatSession?.lastDocProjection ?? doc?.block_projection ?? undefined,
                        meta: chatSession?.lastDocSectionMeta ?? doc?.section_meta,
                        editingIds: editingSections.map((s) => s.id),
                        diffRows: sectionDiffRows,
                      }}
                      /* #1040: 评论锚点高亮 + 气泡「添加评论」入口 — 点击高亮
                          激活线程并展开侧边栏,双向联动。 */
                      comments={{
                        items: docComments.map((c) => ({
                          commentId: c.id,
                          anchorText: c.anchor_text,
                          status: c.status,
                          located: c.anchor?.located ?? true,
                          candidates: c.anchor?.candidates?.map((x) => ({ text: x.text, similarity: x.similarity })),
                        })),
                        activeCommentId: activeCommentId,
                        onAnchorClick: (id) => { setActiveCommentId(id); setCommentsPanelOpen(true); },
                      }}
                      onStartComment={(sel) => {
                        // #1070: 跨块选区不创建评论 — 锚点算法按块扫描,跨块
                        // 评论正文高亮永不出现且无提示（无痕第三态）。创建入口
                        // 拦截并经 showNotice 明确提示,不产生无痕评论。
                        const ed = polishEditorRef.current;
                        if (ed && !selectionWithinSingleBlock(ed, sel.from, sel.to)) {
                          showNotice(t('writing.commentCrossBlockUnsupported', '评论仅支持同一段落内的选区'), 4000);
                          return;
                        }
                        setCommentDraft(sel);
                      }}
                      onBubbleAction={bubble.handleBubbleAction}
                      bubble={{
                        run: bubble.bubbleRun,
                        onStart: (instruction) => void bubble.runPolish(instruction, 'polish'),
                        onApply: bubble.handleBubbleApply,
                        onDiscard: bubble.handleBubbleDiscard,
                        onRetry: bubble.handleBubbleRetry,
                        onRefine: bubble.handleBubbleRefine,
                        onSendToChat: bubble.handleSendToChat,
                      }}
                    />
                  </div>
                )}
              </div>

              {doc.updated_at && (
                <p className="text-xs text-text-tertiary">
                  Last updated: {new Date(doc.updated_at).toLocaleString()}
                </p>
              )}

            </div>
          </main>

          {/* #1040: 侧边栏评论面板 — 与 ChatPanel 并列(桌面右侧)。 */}
          {commentsPanelOpen && (
            <CommentsPanel
              comments={docComments}
              activeId={activeCommentId}
              onSelect={setActiveCommentId}
              onReply={replyToComment}
              onToggleResolve={(c) => void toggleCommentResolved(c)}
              onAiProcess={handleCommentAiProcess}
              processingCommentIds={commentProcessing}
            />
          )}

          {/* #688: 右侧 Doc Chat / Charts 面板 — UI 拆出;chat 状态经
              useDocChat 保持在路由,宽度/resize/标签/selection 经 props 透传。 */}
          {chatOpen && (
            <ChatPanel
              chat={chat}
              chatWidth={chatWidth}
              sidePanelTab={sidePanelTab}
              setSidePanelTab={setSidePanelTab}
              onClose={() => setChatOpen(false)}
              onResizeStart={handleChatResizeStart}
              chatSessionId={chatSessionId}
              onInsertChart={handleInsertChart}
              onJumpToSection={jumpToSection}
              attachmentPinning={references.filesLibAdding}
              onPinAttachment={(f) => void references.addFileLibraryRefs([{ file_id: f.fileId, name: f.name, mime: '', size_bytes: 0, created_at: '' }])}
            />
          )}
        </div>

        {/* #fix: 上传进度 Modal — 上传中显示进度条,导入阶段不确定进度。 */}
        <UploadProgressModal state={chat.uploadState} onCancel={chat.cancelUpload} />

        {/* #996/#1001: 移动端聊天悬浮按钮 — 窄屏无侧栏空间,FAB → 全屏抽屉。 */}
        {!chatOpen && (
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            aria-label={t('writing.openChat', 'Chat')}
            className="fixed bottom-5 right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-lg transition-colors hover:bg-accent-hover md:hidden"
          >
            <MessageSquare size={20} />
          </button>
        )}

        {/* #598: History 版本列表(#696: 对话框组件化)
            #910: 审阅未决/写回待冲刷时 Restore 按钮禁用 — 与 handleRestoreRequest
            的互斥守卫同步(UI 层同样不给入口)。 */}
        {showHistory && (
          <HistoryDialog snapshots={snapshots} snapshotsLoading={snapshotsLoading} restoring={restoring}
            reviewBlocked={diffReview !== null || pendingWriteBackRef.current !== null}
            onClose={() => setShowHistory(false)} onRestore={(id) => void handleRestoreRequest(id)} />
        )}

        {/* PHI Findings Dialog(#696: HighlightedBody 组件化) */}
        {showPhiDialog && phiFindings && (
          <PhiDialog body={body} findings={phiFindings} onClose={() => setShowPhiDialog(false)} />
        )}

        {/* Add Reference Dialog(#696: 从路由拆出) */}
        {refDialogOpen && (
          <AddReferenceDialog form={refForm} setForm={setRefForm} submitting={refSubmitting} onClose={() => setRefDialogOpen(false)} onSubmit={() => void handleAddReference()} />
        )}

        {/* #1043: deck 冲突二选一的二次确认 — 不可逆提示走 Modal 基础设施。 */}
        {deckConflict && deckConflictConfirm && (
          <DeckConflictConfirmDialog
            mode={deckConflictConfirm}
            resolving={deckConflictResolving}
            onConfirm={() => (deckConflictConfirm === 'keep' ? void resolveDeckConflictKeepMine() : resolveDeckConflictUseAI())}
            onClose={() => setDeckConflictConfirm(null)}
          />
        )}

        {/* #1040: 选区评论创建弹窗 — 气泡「添加评论」(选区文字作 anchorText)。
            #1051: deck slide 评论复用同一弹窗（anchorText=页标题）。 */}
        {commentDraft && (
          <AddCommentModal
            anchorText={'target' in commentDraft ? commentDraft.anchorText : commentDraft.text}
            submitting={commentSubmitting}
            onClose={() => setCommentDraft(null)}
            onSubmit={(text) => void submitComment(text)}
          />
        )}
      </div>
      {/* #757: 共享知识库选择器 */}
      <KbPicker open={kbPickerOpen} onClose={() => setKbPickerOpen(false)} onConfirm={handleKbPickConfirm} max={5} />
    </AppShell>
  );
}
