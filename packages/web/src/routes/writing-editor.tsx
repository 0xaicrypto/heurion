import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import type { Editor } from '@tiptap/react';
import { ArrowLeft, Download, Eye, FilePlus, FileText, History, MessageSquare, Paperclip, Pencil, Presentation, ShieldAlert, Sparkles, X } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SkillsBar } from '@/components/SkillsBar';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { DocEditor, type DiffReviewState } from '@/components/DocEditor';
import { KbPicker } from '@/components/KbPicker';
import { SpotHint } from '@/components/SpotHint';
import { UploadProgressModal } from '@/components/UploadProgressModal';
import { ChatMessages } from '@/components/chat/ChatMessages';
import { ChartLibrary } from '@/components/chat/ChartLibrary';
import { chatFailureText } from '@/stores/chat';
import { Alert, Button, Skeleton, Textarea, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { sha1Hex } from '@/lib/hash';
import { cn } from '@/lib/utils';
// #837: AI 写回三路合并(审阅未决时的累计队列重放)。
import { mergeThreeWay } from '@/lib/doc-merge';
import { toSlides, type Slide } from '@/lib/deck';
import { isEnterSendKey } from '@/lib/chat-composer';
import type { DeckWire } from '@/lib/types';
// #696: 状态机全部下沉 hooks — 路由只保留编排与布局。
import { usePolishBubble } from './writing-editor/bubble';
import { useDeckAsset } from './writing-editor/deck-asset';
import { useDocChat } from './writing-editor/doc-chat';
import { useDocReferences } from './writing-editor/references';
import { HistoryDialog, PhiDialog, AddReferenceDialog, ReferenceListPopover, ExportDonePanel } from './writing-editor/dialogs';
import type { DocDetail, SnapshotEntry, PhiFinding } from './writing-editor/types';

export function WritingEditorPage() {
  const { t } = useTranslation();
  const { docId } = useParams<{ docId: string }>();
  const navigate = useNavigate();
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
  const [saveConflict, setSaveConflict] = useState<{ title: string; body: string; deck?: unknown } | null>(null);

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
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void handleSave();
    }, 2500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, title, docId, dirty]);

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
  const diffPendingRef = useRef(false);
  useEffect(() => {
    diffPendingRef.current = diffReview !== null;
  }, [diffReview]);

  // #837: AI 写回累计队列 — 审阅未决时的新写回不再被拒绝(丢弃),而是
  // 记录 { 服务端写回基线, 新正文 },当前审阅结束后重放。基线必须用
  // serverBodyRef(服务端视角的正文):上一轮写回未被接受时,服务端仍持有
  // 旧正文 — 若直接 diff「当前正文 → 新写回」,会把上一轮已接受的修改
  // 反转回去(生产事故:修改队列顺序乱)。
  const serverBodyRef = useRef<string | null>(null);
  const writeBackQueueRef = useRef<Array<{ base: string; next: string }>>([]);
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
      // #837-ux: 同轮合批评也要清(计时器一并撤销)。
      if (pendingWriteBackRef.current?.timer) clearTimeout(pendingWriteBackRef.current.timer);
      pendingWriteBackRef.current = null;
      setQueuedRounds(0);
    }
    if (doc && serverBodyRef.current === null) serverBodyRef.current = doc.body;
  }, [doc, docId]);

  // #837: 刷新恢复审阅 — 服务端最后一笔快照是「AI edit」且其正文就是当前
  // 正文时,说明上次审阅未完成(刷新/关闭丢失了客户端审阅态)。自动恢复:
  // old = 前一条快照,当前正文作为 next 重新进入审阅,用户无需重发指令。
  useEffect(() => {
    if (!docId || !doc || reviewResumeDoneRef.current) return;
    reviewResumeDoneRef.current = true;
    api.getDocSnapshots(docId).then(async ({ snapshots }) => {
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
      if (lastFull.body !== doc.body) return;
      setDiffReview({ key: `resume_${Date.now()}`, old: prevFull.body, next: lastFull.body });
    }).catch(() => { /* 恢复失败不打扰 — 行为与旧版一致 */ });
  }, [doc, docId]);

  /** 弹出下一轮写回:以「用户当前正文」为新基线做三路合并重放;冲突则丢弃并明示。 */
  const popNextWriteBack = useCallback((currentMd: string) => {
    const entry = writeBackQueueRef.current.shift();
    setQueuedRounds(writeBackQueueRef.current.length);
    if (!entry) return;
    const remaining = writeBackQueueRef.current.length;
    const merged = mergeThreeWay(entry.base, currentMd, entry.next);
    if (merged === null) {
      showNotice(t('writing.reviewConflict', 'AI 的下一轮修改与当前内容有重叠冲突，该轮已丢弃 — 请在聊天中重新描述该修改'), 6000);
      return;
    }
    setDiffReview({ key: `rev_${Date.now()}`, old: currentMd, next: merged });
    if (remaining > 0) showNotice(t('writing.reviewQueuedNext', '已呈现下一轮 AI 修改（队列中还有 {{n}} 轮）', { n: remaining }), 4000);
  }, [showNotice, t]);

  // #696: 参考材料管理下沉 useDocReferences。
  const references = useDocReferences({ docId, setError: (e) => setError(e ?? '') });

  // #696: doc-chat 面板逻辑下沉 useDocChat（发送/排队/附件/上传/pptx 轮询）。
  const polishEditorRef = useRef<Editor | null>(null);
  const chat = useDocChat<DocDetail>({
    docId,
    title,
    bodyRef,
    lastSavedBody,
    dirtyRef,
    diffReview,
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
  });
  const chatSession = chat.chatSession;
  const chatSessionId = docId ? `doc-${docId}` : '';

  // #837-ux: 同轮写回合批 — AI 一轮里逐节写回会连发多个 doc_updated,
  // 逐个进审阅 = "每次只能看到一个 diff"。正确交互:同一轮的全部变更
  // **一次性标记**在一个审阅里。触发时机:turn 结束(chatLoading true→false)
  // 或 60s 无新写回(流丢失兜底,每次新写回重置)。
  const pendingWriteBackRef = useRef<{ base: string; body: string; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const BATCH_FALLBACK_MS = 60_000;
  const [queuedRounds, setQueuedRounds] = useState(0);

  const flushPendingWriteBack = useCallback(() => {
    const pend = pendingWriteBackRef.current;
    if (!pend) return;
    if (pend.timer) clearTimeout(pend.timer);
    pendingWriteBackRef.current = null;
    if (diffPendingRef.current) {
      // 跨轮:审阅未决 → 累计队列,审阅结束后依次呈现。
      writeBackQueueRef.current.push({ base: pend.base, next: pend.body });
      setQueuedRounds(writeBackQueueRef.current.length);
      showNotice(t('writing.reviewQueued', 'AI 又完成了一轮修改 — 当前审阅结束后将依次呈现'), 5000);
      return;
    }
    appliedDocBody.current = pend.body;
    serverBodyRef.current = pend.body;
    setDiffReview({ key: `rev_${Date.now()}`, old: bodyRef.current, next: pend.body });
    // #693: 审阅模式下编辑器选中的是 diff 内容,不再构成引用。
    setChatSelection('');
    // #837-ux: deck 视图下 markdown 审阅不可见 — 写回时自动切回文档视图。
    setViewMode((m) => (m === 'deck' ? 'document' : m));
  }, [showNotice, t]);

  const prevChatLoadingRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevChatLoadingRef.current === true && !chat.chatLoading) flushPendingWriteBack();
    prevChatLoadingRef.current = chat.chatLoading;
  }, [chat.chatLoading, flushPendingWriteBack]);

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
  });

  // #636 doc write-back diff 审阅 — 依赖 chatSession。
  // #837-ux: 同轮合批 — 写回到达只更新批次末值,turn 结束/兜底超时才进审阅。
  useEffect(() => {
    if (!docId || !chatSession?.lastDocBody) return;
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
    } else {
      pendingWriteBackRef.current.body = chatSession.lastDocBody;
      // 活动重置兜底计时(纯流丢失保险,正常路径由 turn 结束冲刷)。
      if (pendingWriteBackRef.current.timer) clearTimeout(pendingWriteBackRef.current.timer);
      pendingWriteBackRef.current.timer = setTimeout(() => flushPendingWriteBack(), BATCH_FALLBACK_MS);
    }
    appliedDocBody.current = chatSession.lastDocBody;
    serverBodyRef.current = chatSession.lastDocBody;
  }, [chatSession?.lastDocBody, docId, flushPendingWriteBack]);

  // #773: AI deck 写回（edit_deck / organize 落 deck）— 页级小改直接应用
  // + 服务端快照回滚（deck 页是天然结构化单元，整篇 markdown diff 反而难读）。
  // 并发守卫：本地有未保存 deck 编辑时提示刷新，不直接覆盖。
  useEffect(() => {
    if (!docId || !chatSession?.lastDocDeck) return;
    const deckKey = JSON.stringify(chatSession.lastDocDeck);
    if (appliedDocDeck.current === deckKey) return;
    appliedDocDeck.current = deckKey;
    // 服务端已持久化该 deck — 同步"已保存"基线，本地无未保存编辑时直接换源。
    if (deckJson && deckJson !== lastSavedDeck.current && deckJson !== deckKey) {
      showNotice(t('writing.deckConflict', 'AI 已更新 deck，但你有未保存的 deck 编辑 — 请先 Save，再刷新页面获取 AI 版本'), 6000);
      return;
    }
    lastSavedDeck.current = deckKey;
    setDeckAsset(chatSession.lastDocDeck);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref 稳定(#696 hooks 下沉)
  }, [chatSession?.lastDocDeck, docId, deckJson]);

  /** 审阅结束:接受/拒绝结果落地,拒绝或放弃则保持原正文。#837: 结束后弹出队列中的下一轮写回。 */
  const handleDiffResolve = useCallback((result: { md: string; accepted: number; rejected: number; cancelled: boolean }) => {
    setDiffReview(null);
    // #720: 用显式 cancelled 字段区分"放弃"，不再用空串推断 — 全文删空的
    // 接受结果(空 md)应落地为空正文,而不是被当成放弃。
    if (result.cancelled) {
      if (restoreReview) { setRestoreReview(null); }
      showNotice(t('writing.reviewCancelled', '已放弃本次 AI 修改'), 3000);
      // #837: 放弃 = 明确拒绝 — 服务端仍持有 AI 写回的版本,必须回滚为
      // 用户正文(此前 DB 留着被拒绝的内容,用户下次保存/离开就污染)。
      if (docId && serverBodyRef.current !== null && serverBodyRef.current !== bodyRef.current) {
        const restoreBody = bodyRef.current;
        saveDoc((doc?.title) ?? 'Untitled', restoreBody)
          .then((updated) => {
            lastSavedBody.current = updated.body ?? restoreBody;
            serverBodyRef.current = updated.body ?? restoreBody;
          })
          .catch((err) => {
            if (err instanceof ApiError && err.status === 409 && err.code === 'stale_base') {
              setSaveConflict({ title: (doc?.title) ?? 'Untitled', body: restoreBody });
              showNotice(t('writing.conflictDetected', '文档已在其他窗口被修改，当前窗口内容未保存'), 6000);
            } else {
              showNotice(t('writing.reviewSaveFailed', 'AI 修改已应用，但保存失败 — 请点击 Save 重试'), 6000);
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
      showNotice(`已采纳 AI 修改：接受 ${result.accepted} / 拒绝 ${result.rejected}`);
    }
    // #598/#711: 落地后自动保存到服务端 — 失败必须可见,不能静默吞掉。
    if (docId) {
      saveDoc((doc?.title) ?? 'Untitled', result.md)
        .then((updated) => {
          lastSavedBody.current = updated.body ?? result.md;
          serverBodyRef.current = updated.body ?? result.md;
          dirtyRef.current = false;
          setDirty(false);
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 409 && err.code === 'stale_base') {
            setSaveConflict({ title: (doc?.title) ?? 'Untitled', body: result.md });
            showNotice(t('writing.conflictDetected', '文档已在其他窗口被修改，当前窗口内容未保存'), 6000);
          } else {
            setError(err instanceof ApiError ? err.messageText : String(err));
            showNotice(t('writing.reviewSaveFailed', 'AI 修改已应用，但保存失败 — 请点击 Save 重试'), 6000);
          }
        });
    }
    // #837: 弹出队列中的下一轮写回 — 以本轮接受后的正文为用户基线做三路合并
    // (bodyRef 同帧还未更新,显式传 result.md)。
    popNextWriteBack(result.md);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 引用稳定,避免抖动
  }, [docId, doc?.title, restoreReview, showNotice, popNextWriteBack]);

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
  const [viewMode, setViewMode] = useState<'document' | 'deck'>('document');
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

  const chatEndRef = chat.chatEndRef;
  const docUploadRef = chat.docUploadRef;

  // #383: generate the Methods draft from the linked study's protocol.
  const handleGenerateMethods = async () => {
    if (!docId) return;
    setMethodsLoading(true);
    setMethodsError(null);
    try {
      const res = await api.generateMethods(docId);
      setBody((prev) => `${prev}${prev ? '\n\n' : ''}## Methods\n\n${res.methods}\n`);
    } catch (err) {
      setMethodsError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setMethodsLoading(false);
    }
  };

  const handleInjectResults = async () => {
    if (!docId || !injectLabel.trim() || !injectResult.trim()) return;
    setInjecting(true);
    try {
      await api.injectResults(docId, injectLabel.trim(), injectResult.trim());
      const d = await api.getDoc(docId);
      setBody(d.body);
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
    setLoading(true);
    setError(null);
    // #382/#726: linked submission state (target journal / applied template).
    // #726: 按 docId 取对应投稿草稿,不再所有文档共享 drafts[0]。
    api.listSubmissionDrafts().then((r) => {
      // #726: 按 docId 取对应投稿草稿,不再所有文档共享 drafts[0]。
      const mine = docId ? r.drafts.find((d) => d.doc_id === docId) : undefined;
      const d = mine ?? r.drafts[0];
      if (d) {
        setLinkedJournal(d.target_journal || '');
        setLinkedTemplate(d.template_id || '');
      }
    }).catch(() => {});
    api.getDoc(docId)
      .then((d) => {
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
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref 稳定(#696 hooks 下沉)
  }, [docId]);

  const loadSnapshots = useCallback(() => {
    if (!docId) return;
    setSnapshotsLoading(true);
    api.getDocSnapshots(docId)
      .then((r) => setSnapshots(r.snapshots))
      .catch(() => {})
      .finally(() => setSnapshotsLoading(false));
  }, [docId]);

  const handleToggleHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) loadSnapshots();
  };

  // #882: 带 base_sha 的保存(服务端并发保护)— 指纹取服务端视角正文
  // (serverBodyRef),409 → 冲突横幅。force 跳过(「保留我的版本」)。
  const saveDoc = useCallback(async (title: string, body: string, opts: { deck?: unknown; force?: boolean } = {}) => {
    const base = serverBodyRef.current;
    const base_sha = !opts.force && base !== null ? await sha1Hex(base) : undefined;
    return api.updateDoc(docId!, {
      title, body,
      ...(opts.deck !== undefined ? { deck: opts.deck } : {}),
      ...(base_sha ? { base_sha } : {}),
      ...(opts.force ? { force: true } : {}),
    });
  }, [docId]);

  const handleSave = async () => {
    if (!docId) return;
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
        setSaveConflict({ title, body, deck: deckAsset ?? undefined });
        showNotice(t('writing.conflictDetected', '文档已在其他窗口被修改，当前窗口内容未保存'), 6000);
      } else {
        setError(err instanceof ApiError ? err.messageText : String(err));
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
      showNotice(t('writing.conflictKeptMine', '已保留当前窗口的版本'), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  const resolveConflictLoadLatest = async () => {
    if (!docId) return;
    try {
      const fresh = await api.getDoc(docId);
      setBody(fresh.body);
      lastSavedBody.current = fresh.body;
      serverBodyRef.current = fresh.body;
      setDoc((prev) => prev ? { ...prev, body: fresh.body, updated_at: fresh.updated_at } : prev);
      setSaveConflict(null);
      showNotice(t('writing.conflictLoadedLatest', '已载入服务端最新内容'), 3000);
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
    setRestoring(snapshotId);
    try {
      const snap = await api.getSnapshotBody(docId, snapshotId);
      setShowHistory(false);
      setRestoreReview({ snapshotId, label: snap.label });
      setDiffReview({ key: `restore-${snapshotId}`, old: body, next: snap.body });
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

  const { chatInput, setChatInput, chatMessages, chatLoading, chatPending } = chat;
  const { refDialogOpen, setRefDialogOpen, refForm, setRefForm, refSubmitting, refList, refListOpen, setRefListOpen, refDeleting, loadReferences, handleAddReference, handleKbPickConfirm, deleteReference } = references;
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
          <Button variant="ghost" size="sm" onClick={leaveEditor}>
            <ArrowLeft size={16} />
          </Button>
          <FileText size={18} className="text-text-tertiary" />
          <h1 className="font-semibold text-text-primary">{doc.title || 'Untitled'}</h1>
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPreview((v) => !v)}
            className="ml-3"
          >
            <Eye size={14} className="mr-1" /> {preview ? 'Edit' : 'Preview'}
          </Button>
          {/* #770: 文档 | 幻灯片视图切换 — deck 视图是 body 的只读投影。 */}
          <div className="ml-2 flex items-center overflow-hidden rounded-md border border-border" role="tablist" aria-label={t('writing.viewMode', '视图模式')}>
            <button
              role="tab"
              aria-selected={viewMode === 'document'}
              onClick={() => { setPreview(false); setViewMode('document'); }}
              className={cn('flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors', viewMode === 'document' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-elevated')}
            >
              <FileText size={13} className="mr-0.5" /> {t('writing.docView', '文档')}
            </button>
            <button
              role="tab"
              aria-selected={viewMode === 'deck'}
              onClick={() => setViewMode('deck')}
              className={cn('flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors', viewMode === 'deck' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-elevated')}
            >
              <Presentation size={13} className="mr-0.5" /> {t('writing.deckView', '幻灯片')} · {deck.slides.length}
            </button>
          </div>
          {aiEditNotice && (
            <span className="ml-3 rounded-full border border-success/30 bg-success/5 px-2 py-0.5 text-xs text-success">
              {aiEditNotice}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleToggleHistory}
            >
              <History size={14} className="mr-1" /> History
            </Button>
            <Button size="sm" onClick={handleSave} isLoading={saving} disabled={saving}>
              {dirty ? t('writing.unsaved', '● 未保存') : 'Save'}
            </Button>
            <Button size="sm" variant="secondary" onClick={handleExportDocx}>
              <Download size={14} className="mr-1" /> DOCX
            </Button>
          </div>
        </header>

        <div className="flex items-center gap-1 border-b border-border bg-surface px-6 py-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handlePhiScan}
            disabled={phiScanning}
            isLoading={phiScanning}
            >
              <ShieldAlert size={14} className="mr-1" /> Scan PHI
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => docUploadRef.current?.click()}
            >
              <FileText size={14} className="mr-1" /> Upload
            </Button>
            <input
              ref={docUploadRef}
              type="file"
              accept=".pdf,.docx,.doc,.txt,.md"
              onChange={chat.handleDocUpload}
              className="hidden"
            />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExportDocx}
            disabled={exporting}
            isLoading={exporting}
          >
            <Download size={14} className="mr-1" /> Export DOCX
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleExportPdf()}
            disabled={exporting}
          >
            <FileText size={14} className="mr-1" /> Export PDF
          </Button>
          {studyId && (
            <>
              <Button variant="ghost" size="sm" onClick={handleGenerateMethods} isLoading={methodsLoading} disabled={!studyId}>
                <Sparkles size={14} className="mr-1" /> {t('writing.genMethods', '生成方法')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setInjectOpen((v) => !v)}>
                <FileText size={14} className="mr-1" /> {t('writing.injectResults', '注入结果')}
              </Button>
            </>
          )}
          {methodsError && (
            <span className="text-xs text-error">{methodsError}</span>
          )}
          {injectOpen && (
            <div className="absolute right-2 top-14 z-30 w-[min(92vw,420px)] rounded-xl border border-border bg-surface-elevated p-4 shadow-lg">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-text-secondary">{t('writing.injectResultsTitle', '注入统计结果')}</span>
                <button onClick={() => setInjectOpen(false)} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
              </div>
              <Input
                value={injectLabel}
                onChange={(e) => setInjectLabel(e.target.value)}
                placeholder={t('writing.injectLabel', '小节标题，如 Overall survival')}
                className="mb-2"
              />
              <textarea
                value={injectResult}
                onChange={(e) => setInjectResult(e.target.value)}
                rows={6}
                placeholder={t('writing.injectHint', '粘贴 #361 统计输出（JSON），如 {"method":"kaplan_meier_logrank","p_value":0.012}')}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setInjectOpen(false)}>Cancel</Button>
                <Button size="sm" onClick={handleInjectResults} isLoading={injecting} disabled={!injectLabel.trim() || !injectResult.trim()}>
                  {t('writing.injectNow', '注入')}
                </Button>
              </div>
            </div>
          )}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setRefListOpen((v) => !v); if (!refListOpen) void loadReferences(); }}
            >
              <FilePlus size={14} className="mr-1" /> Reference
              {refList.length > 0 && (
                <span className="ml-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">{refList.length}</span>
              )}
            </Button>
            {/* #757: 从知识库选择 — 同一文件不再重传,一次上传处处引用。 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setKbPickerOpen(true)}
              title={t('writing.pickFromKb', '从知识库选择总结/文件作为参考')}
            >
              📚 {t('writing.fromKb', '知识库')}
            </Button>
            {refListOpen && (
              <ReferenceListPopover list={refList} deleting={refDeleting} onClose={() => setRefListOpen(false)} onDelete={(id) => void deleteReference(id)} />
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChatOpen((v) => !v)}
          >
            <MessageSquare size={14} className="mr-1" /> Chat
          </Button>

          {/* #754: 导出完成态面板 — 取代路径字符串;api 层已触发下载,
              面板补齐确认感 + 历史入口。 */}
          {(exportResult || exportHistory.length > 0) && exportPanelOpen && (
            <ExportDonePanel exportResult={exportResult} exportHistory={exportHistory} onClose={() => setExportPanelOpen(false)} />
          )}
        </div>

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
              <div>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Document title"
                  className="w-full rounded-lg border border-border bg-surface-elevated px-4 py-2 text-lg font-semibold text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>

              <div>
                {preview ? (
                  <div className="min-h-[300px] rounded-lg border border-border bg-surface-elevated p-4">
                    <MarkdownRenderer content={body} />
                  </div>
                ) : viewMode === 'deck' ? (
                  /* #770: 幻灯片视图 — 16:9 卡片流。
                     #773: 双来源 — Doc.deck 存在时为可编辑 deck 卡片（写
                     Doc.deck，不动正文）；否则回落 body 的 markdown 投影
                     （只读 + 锚点跳回文档编辑）。 */
                  <div className="space-y-3">
                    {deckAsset ? (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2">
                        <span className="text-xs text-accent">
                          {t('writing.deckAssetBadge', 'AI 编排 deck 资产 — 卡片内可直接编辑（改标题/调要点/删页），保存不会改动文档正文。')}
                        </span>
                        <Button size="sm" variant="secondary" onClick={deckCtl.addDeckSlide}>
                          <FilePlus size={13} className="mr-1" /> {t('writing.deckAddSlide', '添加一页')}
                        </Button>
                      </div>
                    ) : deck.slides.length <= 1 && body.trim() && (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-surface-elevated px-4 py-2.5">
                        <span className="text-xs text-text-secondary">
                          {t('writing.deckSinglePageHint', '文档还没有 ## 分页结构，导出 PPT 只会有一页。可让 AI 按内容语义拆页。')}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void chat.sendChatText(t('writing.aiSplitPrompt', '请把当前稿件按内容语义拆成多页（每页一个 ## 二级标题），为生成 PPT 做准备。'))}
                        >
                          <Sparkles size={13} className="mr-1" /> {t('writing.aiSplitPages', 'AI 帮我拆页')}
                        </Button>
                      </div>
                    )}
                    {deckAsset ? (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        {deckAsset.slides.map((slide, i) => (
                          <div key={i} className="flex aspect-video flex-col overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-sm transition-shadow hover:shadow-md">
                            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                              <span className="shrink-0 text-[11px] font-semibold text-text-tertiary">{i + 1}.</span>
                              <input
                                value={slide.title}
                                onChange={(e) => deckCtl.updateDeckSlide(i, { title: e.target.value })}
                                className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-xs font-semibold text-text-primary outline-none focus:bg-surface focus:ring-1 focus:ring-ring"
                              />
                              <button
                                onClick={() => deckCtl.deleteDeckSlide(i)}
                                title={t('writing.deckDeleteSlide', '删除此页')}
                                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-error"
                              >
                                <X size={12} />
                              </button>
                            </div>
                            <div className="flex flex-1 flex-col gap-1 overflow-hidden px-3 py-2 text-xs leading-relaxed text-text-secondary">
                              {deckCtl.slideBullets(slide).map((b, j) => (
                                <div key={j} className="flex min-w-0 items-start gap-1.5">
                                  <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
                                  <input
                                    value={b}
                                    onChange={(e) => {
                                      const bullets = deckCtl.slideBullets(slide).map((x, k) => (k === j ? e.target.value : x));
                                      deckCtl.updateDeckSlide(i, { bullets });
                                    }}
                                    className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 outline-none focus:bg-surface focus:ring-1 focus:ring-ring"
                                  />
                                </div>
                              ))}
                              <button
                                onClick={() => deckCtl.updateDeckSlide(i, { bullets: [...deckCtl.slideBullets(slide), ''] })}
                                className="self-start rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
                              >
                                + {t('writing.deckAddBullet', '要点')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      {deck.slides.map((slide, i) => (
                        <div
                          key={i}
                          className="group relative flex aspect-video flex-col overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-sm transition-shadow hover:shadow-md"
                        >
                          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                            <span className="truncate text-xs font-semibold text-text-primary">
                              {i + 1}. {slide.title}
                            </span>
                            <button
                              onClick={() => handleDeckCardEdit(slide)}
                              title={t('writing.deckCardEdit', '跳回文档编辑此页')}
                              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-opacity hover:bg-surface hover:text-accent group-hover:opacity-100 md:opacity-0"
                            >
                              <Pencil size={11} /> {t('writing.deckCardEdit', '编辑')}
                            </button>
                          </div>
                          <div className="flex flex-1 flex-col gap-1.5 overflow-hidden px-3 py-2 text-xs leading-relaxed text-text-secondary">
                            {slide.blocks.slice(0, 8).map((b, j) =>
                              b.type === 'image' ? (
                                <img key={j} src={b.url} alt={b.caption || ''} className="max-h-[55%] w-auto self-start rounded border border-border object-contain" />
                              ) : b.type === 'bullet' ? (
                                <div key={j} className="flex min-w-0 items-start gap-1.5">
                                  <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
                                  <span className="line-clamp-2">{b.text}</span>
                                </div>
                              ) : (
                                <p key={j} className="line-clamp-2">{b.text}</p>
                              ),
                            )}
                            {slide.blocks.length > 8 && (
                              <span className="text-[11px] text-text-tertiary">…{t('writing.deckMoreBlocks', '还有 {{n}} 段', { n: slide.blocks.length - 8 })}</span>
                            )}
                          </div>
                        </div>
                      ))}
                      </div>
                    )}
                    {/* #770 设计更新 2：导出交互 = 预填 chat 消息发送，不新建旁路 API。
                        #773: deck 资产存在时导出内容源 = Doc.deck（所见即所导）。 */}
                    <div className="flex justify-end">
                      <Button size="sm" onClick={() => void chat.sendChatText(deckAsset
                        ? t('writing.aiExportDeckPrompt', '请把当前 deck 导出为 PPT（使用现有 deck 内容，不要重新编排）。')
                        : t('writing.aiExportPptPrompt', '请把当前稿件导出为 PPT。'))}>
                        <Presentation size={13} className="mr-1" /> {t('writing.aiExportPpt', 'AI 导出 PPT')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border bg-surface-elevated">
                    {saveConflict && (
                      /* #882: 并发保存冲突横幅 — 用户决策,不静默覆盖另一窗口的修改 */
                      <div className="flex items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-text-primary">
                        <span>⚠ {t('writing.conflictDetected', '文档已在其他窗口被修改，当前窗口内容未保存')}</span>
                        <div className="flex shrink-0 gap-1">
                          <Button size="sm" variant="ghost" onClick={() => void resolveConflictLoadLatest()}>{t('writing.conflictLoadLatest', '载入最新')}</Button>
                          <Button size="sm" onClick={() => void resolveConflictKeepMine()}>{t('writing.conflictKeepMine', '保留我的版本')}</Button>
                        </div>
                      </div>
                    )}
                    <DocEditor value={body} onChange={setBody} editorRef={polishEditorRef} diffReview={diffReview} onDiffResolve={handleDiffResolve} onSelectionChange={setChatSelection}
                      queuedRounds={queuedRounds}
                      reviewTitle={restoreReview ? t('writing.restoreReviewTitle', '审阅版本恢复') : undefined}
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

          {chatOpen && (
            <>
              {/* #351: tap the scrim to close the mobile chat drawer */}
              <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setChatOpen(false)} />
              <aside
                style={{ ['--chatw' as string]: `${chatWidth}px` }}
                className="fixed inset-y-0 right-0 z-40 flex w-[85vw] max-w-sm flex-col border-l border-border bg-surface shadow-xl md:static md:inset-auto md:z-auto md:w-[var(--chatw)] md:max-w-none md:shrink-0 md:border-l-0 md:shadow-none"
              >
                {/* #382: desktop resize handle — drag to change chat width */}
                <div
                  onMouseDown={(e) => {
                    resizingRef.current = true;
                    e.preventDefault();
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                  }}
                  className="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize bg-transparent hover:bg-accent/40 md:block"
                  style={{ width: 5 }}
                />
              <div className="flex h-10 items-center justify-between border-b border-border px-3">
                <div className="flex gap-1">
                  <button
                    onClick={() => setSidePanelTab('chat')}
                    className={cn('rounded-lg px-2.5 py-1 text-xs font-medium transition-colors', sidePanelTab === 'chat' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary')}
                  >Chat</button>
                  <button
                    onClick={() => setSidePanelTab('charts')}
                    className={cn('rounded-lg px-2.5 py-1 text-xs font-medium transition-colors', sidePanelTab === 'charts' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary')}
                  >Charts</button>
                </div>
                <button onClick={() => setChatOpen(false)} className="text-text-tertiary hover:text-text-primary">
                  <X size={14} />
                </button>
              </div>
              {sidePanelTab === 'chat' && (
                <>
              <SkillsBar active={chat.activeSkills} onToggle={(name) => chat.setActiveSkills((prev) => prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name])} />
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                <ChatMessages
                  variant="compact"
                  messages={chatMessages}
                  streamNote={chatSession?.streamNote}
                  stallSince={chatSession?.stallSince}
                  bottomRef={chatEndRef}
                  emptyState={
                    <p className="text-sm text-text-tertiary text-center mt-4 leading-relaxed">
                      Ask the AI to write or research content.<br />
                      It will update this document automatically.<br />
                      <span className="text-xs">e.g. "Write a clinical review on..."</span>
                    </p>
                  }
                />
              </div>
              <div className="border-t border-border p-3">
                {chat.kbDedupNotice && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-text-secondary">{chat.kbDedupNotice}</div>
            )}
            {chat.chatAttachedFiles.length > 0 && (
                  <div className="mb-2 flex gap-1 flex-wrap">
                    {chat.chatAttachedFiles.map((f) => (
                      <span key={f.fileId} className="inline-flex items-center rounded-full bg-surface-elevated border border-border px-2 py-0.5 text-xs text-text-secondary">{f.name}</span>
                    ))}
                  </div>
                )}
                {/* #fix: 追加问题排队提示 — 回复完成后自动发送,不打断。 */}
                {chatPending && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">已排队 — 当前回复完成后自动发送</span>
                  </div>
                )}
                {/* #693: 选中即引用 — 当前编辑器选中文本将随下一条消息发送。 */}
                {chatSelection && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                      {chatSelection.length > 48 ? `${chatSelection.slice(0, 48)}…` : chatSelection}
                    </span>
                    <button
                      onClick={() => setChatSelection('')}
                      className="shrink-0 text-text-tertiary hover:text-text-primary"
                      title="Clear selection reference"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                <div className="flex gap-2">
                  <input ref={chat.chatFileRef} type="file" onChange={chat.handleChatFile} className="hidden" disabled={chat.chatUploadingFile} />
                  <Button variant="ghost" size="sm" onClick={() => chat.chatFileRef.current?.click()} disabled={chatLoading || chat.chatUploadingFile} isLoading={chat.chatUploadingFile} className="shrink-0">
                    <Paperclip size={16} />
                  </Button>
                  <Textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (!isEnterSendKey(e)) return; e.preventDefault(); void chat.handleSendChat(); }}
                    onPaste={chat.handleChatPaste}
                    placeholder="Ask a question..."
                    rows={1}
                    className="min-h-0 flex-1 resize-none py-1.5"
                    style={{ maxHeight: '120px' }}
                  />
                  {/* #fix: 回复进行中显示 Stop(停止分析,含排队消息);平时发送=排队。 */}
                  {chatLoading ? (
                    <Button size="sm" variant="secondary" onClick={() => chat.stopStream(chatSessionId)} className="shrink-0">
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => void chat.handleSendChat()} disabled={!chatInput.trim()} className="shrink-0">
                      Send
                    </Button>
                  )}
                </div>
              </div>
                </>
              )}
              {sidePanelTab === 'charts' && (
                <ChartLibrary onInsert={handleInsertChart} />
              )}
              </aside>
            </>
          )}
        </div>

        {/* #fix: 上传进度 Modal — 上传中显示进度条,导入阶段不确定进度。 */}
        <UploadProgressModal state={chat.uploadState} onCancel={chat.cancelUpload} />

        {/* #598: History 版本列表(#696: 对话框组件化) */}
        {showHistory && (
          <HistoryDialog snapshots={snapshots} snapshotsLoading={snapshotsLoading} restoring={restoring} onClose={() => setShowHistory(false)} onRestore={(id) => void handleRestoreRequest(id)} />
        )}

        {/* PHI Findings Dialog(#696: HighlightedBody 组件化) */}
        {showPhiDialog && phiFindings && (
          <PhiDialog body={body} findings={phiFindings} onClose={() => setShowPhiDialog(false)} />
        )}

        {/* Add Reference Dialog(#696: 从路由拆出) */}
        {refDialogOpen && (
          <AddReferenceDialog form={refForm} setForm={setRefForm} submitting={refSubmitting} onClose={() => setRefDialogOpen(false)} onSubmit={() => void handleAddReference()} />
        )}
      </div>
      {/* #757: 共享知识库选择器 */}
      <KbPicker open={kbPickerOpen} onClose={() => setKbPickerOpen(false)} onConfirm={handleKbPickConfirm} max={5} />
    </AppShell>
  );
}
