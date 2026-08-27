import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import type { Editor } from '@tiptap/react';
import { ArrowLeft, Check, Download, Eye, FilePlus, FileText, History, Loader2, MessageSquare, Paperclip, RotateCcw, ShieldAlert, Sparkles, X } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SkillsBar } from '@/components/SkillsBar';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { DocEditor, type DiffReviewState } from '@/components/DocEditor';
import { KbPicker } from '@/components/KbPicker';
import { SpotHint } from '@/components/SpotHint';
import { UploadProgressModal, type UploadProgressState } from '@/components/UploadProgressModal';
import { ChatMessages } from '@/components/chat/ChatMessages';
import { StreamingLlmContent } from '@/components/LlmContent';
import { ChartLibrary } from '@/components/chat/ChartLibrary';
import { useChatStore, chatFailureText } from '@/stores/chat';
import { Alert, Button, Skeleton, Textarea, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { mapWireMessages } from '@/lib/message-map';
import { cn } from '@/lib/utils';
import { markdownToHtml } from '@/lib/doc-convert';

interface DocDetail {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

interface SnapshotEntry {
  snapshot_id: string;
  created_at: string;
  body_preview: string;
}

interface PhiFinding {
  start: number;
  end: number;
  text: string;
  suggestion: string;
}



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

  const [polishOpen, setPolishOpen] = useState(false);
  // #752/#753: Polish 双模式 — bubble 按钮或工具栏触发的动作。
  // scope=selection(有选区)| full(全文);presets 一键直达,#753 定义。
  const [polishScope, setPolishScope] = useState<'selection' | 'full'>('selection');
  const POLISH_PRESETS: Array<{ id: string; icon: string; label: string; instruction: string }> = [
    { id: 'academic', icon: '🔬', label: '学术语气强化', instruction: '强化学术语气:使用正式、客观、精确的学术表达,避免口语化措辞。' },
    { id: 'concise', icon: '📐', label: '压缩至字数限制', instruction: '在保留全部关键信息的前提下压缩篇幅,删除冗余表述与重复论证。' },
    { id: 'terminology', icon: '🧪', label: '方法学术语统一', instruction: '统一方法学部分的术语与单位表达,确保同一概念前后用词一致。' },
    { id: 'hedging', icon: '⚖️', label: '结论弱化限定', instruction: '为结论添加适当的学术限定语(hedging),避免超出证据强度的断言。' },
    { id: 'proofread', icon: '✅', label: '语法标点检查', instruction: '只修正语法错误、标点与格式问题,不改写句子结构。' },
  ];
  // #752: Selection Bubble 待处理选区(bubble 点击时记录)。
  const [bubbleSel, setBubbleSel] = useState<{ text: string; from: number; to: number } | null>(null);
  // #382: linked submission state (target journal / applied template).
  const [linkedJournal, setLinkedJournal] = useState('');
  // Desktop chat width — draggable resize, persisted (default 360px).
  const [chatWidth, setChatWidth] = useState(() => {
    try { return Number(localStorage.getItem('nexus.docchat.width')) || 360; } catch { return 360; }
  });
  const chatWidthRef = useRef(chatWidth);
  chatWidthRef.current = chatWidth;
  const resizingRef = useRef(false);
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
  const [polishInstruction, setPolishInstruction] = useState('');
  const [polishStream, setPolishStream] = useState('');
  const [polishLoading, setPolishLoading] = useState(false);
  // #752-feedback: polish 执行错误 — 面板内可见(顶部 banner 在气泡场景不可达)。
  const [polishError, setPolishError] = useState<string | null>(null);

  const [chatOpen, setChatOpen] = useState(false);
  // #402-merge: the right panel hosts Doc Chat and the chart library.
  const [sidePanelTab, setSidePanelTab] = useState<'chat' | 'charts'>('chat');

  // #402-merge: append a library figure to the document body.
  const handleInsertChart = (markdown: string) => {
    // #720: 审阅未决时插入图表会被编辑器吞掉(审阅内容由 diffReview 驱动) — 明示。
    if (diffReview) {
      setAiEditNotice(t('writing.reviewFirstForChart', '请先完成当前 AI 修改的审阅，再插入图表'));
      setTimeout(() => setAiEditNotice(''), 4000);
      return;
    }
    setBody((prev) => `${prev || ''}\n\n${markdown}`);
    setDoc((prev) => (prev ? { ...prev, body: `${prev.body || ''}\n\n${markdown}`, updated_at: new Date().toISOString() } : prev));
  };
  const [chatInput, setChatInput] = useState('');
  const chatSessionId = docId ? `doc-${docId}` : '';
  // #693: 选中即引用 — 编辑器当前选中文本,发送消息时随消息携带。
  const [chatSelection, setChatSelection] = useState('');
  // #653/#462: scoped selectors — doc-chat chunks no longer re-render the
  // whole editor (was a full-store subscription).
  const chatSession = useChatStore((s) => (chatSessionId ? s.sessions[chatSessionId] : undefined));
  // #fix: 追加问题排队发送(回复进行中不打断,当前 turn 完成后自动执行)。
  const sendMessageQueued = useChatStore((s) => s.sendMessageQueued);
  const stopStream = useChatStore((s) => s.stopStream);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const setMessages = useChatStore((s) => s.setMessages);
  const chatMessages = chatSession?.messages ?? [];
  const chatLoading = chatSession?.loading ?? false;
  // #fix: 排队中的追加消息(回复完成后自动发送)。
  const chatPending = useChatStore((s) => (chatSessionId ? !!s.sessions[chatSessionId]?.pending : false));
  const [aiEditNotice, setAiEditNotice] = useState('');
  /** #diff-review: 待审阅的 AI 编辑(旧→新);null=无审阅。 */
  const [diffReview, setDiffReview] = useState<DiffReviewState | null>(null);
  // #764: 标记当前审阅是「恢复历史版本」——通知文案与 AI 润色区分。
  const [restoreReview, setRestoreReview] = useState<{ snapshotId: string; label: string } | null>(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  // #fix: 最近一次已保存的正文 — 发送 chat 前对比,内容有变化才先保存,
  // 保证服务端注入的上下文与用户编辑框看到的内容一致(否则模型基于旧
  // 内容编辑会覆盖用户的本地修改)。
  const lastSavedBody = useRef<string | null>(null);
  useEffect(() => {
    if (lastSavedBody.current === null && doc) lastSavedBody.current = doc.body;
  }, [doc]);

  // #705: 自动保存（debounce）+ 未保存离开保护 + Cmd/Ctrl+S。
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveConfirmed = useRef(false);
  const [dirty, setDirty] = useState(false);

  const markDirty = useCallback((nextBody: string, nextTitle: string) => {
    if (!docId) return;
    const nextDirty = nextBody !== (lastSavedBody.current ?? '') || nextTitle !== (doc?.title ?? '');
    dirtyRef.current = nextDirty;
    setDirty(nextDirty);
  }, [docId, doc?.title]);

  useEffect(() => {
    if (!docId || doc === null) return;
    markDirty(bodyRef.current, title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, title, docId]);

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
  useEffect(() => {
    if (!docId || !chatSession?.lastDocBody) return;
    if (appliedDocBody.current === chatSession.lastDocBody) return;
    if (chatSession.lastDocBody === bodyRef.current) return;
    // #720: 上一版审阅未决时拒绝新写回 — 提示先完成当前审阅,避免静默覆盖。
    if (diffPendingRef.current) {
      setAiEditNotice(t('writing.reviewPending', '有未完成的 AI 修改审阅 — 请先接受/拒绝后再继续'));
      setTimeout(() => setAiEditNotice(''), 5000);
      return;
    }
    appliedDocBody.current = chatSession.lastDocBody;
    setDiffReview({ key: `rev_${Date.now()}`, old: bodyRef.current, next: chatSession.lastDocBody });
    // #693: 审阅模式下编辑器选中的是 diff 内容,不再构成引用。
    setChatSelection('');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 引用稳定,避免抖动
  }, [chatSession?.lastDocBody, docId, diffReview]);

  /** 审阅结束:接受/拒绝结果落地,拒绝或放弃则保持原正文。 */
  const handleDiffResolve = useCallback((result: { md: string; accepted: number; rejected: number; cancelled: boolean }) => {
    setDiffReview(null);
    // #720: 用显式 cancelled 字段区分"放弃"，不再用空串推断 — 全文删空的
    // 接受结果(空 md)应落地为空正文,而不是被当成放弃。
    if (result.cancelled) {
      if (restoreReview) { setRestoreReview(null); }
      setAiEditNotice(t('writing.reviewCancelled', '已放弃本次 AI 修改'));
      setTimeout(() => setAiEditNotice(''), 3000);
      return;
    }
    setBody(result.md);
    setDoc((prev) => (prev ? { ...prev, body: result.md, updated_at: new Date().toISOString() } : prev));
    if (restoreReview) {
      setAiEditNotice(`已恢复到「${restoreReview.label}」：接受 ${result.accepted} / 拒绝 ${result.rejected} 处差异`);
      setRestoreReview(null);
    } else {
      setAiEditNotice(`已采纳 AI 修改：接受 ${result.accepted} / 拒绝 ${result.rejected}`);
    }
    setTimeout(() => setAiEditNotice(''), 4000);
    // #598/#711: 落地后自动保存到服务端 — 失败必须可见,不能静默吞掉。
    if (docId) {
      api.updateDoc(docId, { title: (doc?.title) ?? 'Untitled', body: result.md })
        .then((updated) => {
          lastSavedBody.current = updated.body ?? result.md;
          dirtyRef.current = false;
          setDirty(false);
        })
        .catch((err) => {
          setError(err instanceof ApiError ? err.messageText : String(err));
          setAiEditNotice(t('writing.reviewSaveFailed', 'AI 修改已应用，但保存失败 — 请点击 Save 重试'));
          setTimeout(() => setAiEditNotice(''), 6000);
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 引用稳定,避免抖动
  }, [docId, doc?.title]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [chatUploadingFile, setChatUploadingFile] = useState(false);
  // #fix: 上传进度 Modal — 上传中显示进度条,服务端导入阶段为不确定进度。
  const [uploadState, setUploadState] = useState<UploadProgressState | null>(null);
  const [kbDedupNotice, setKbDedupNotice] = useState<string | null>(null);
  const [chatAttachedFiles, setChatAttachedFiles] = useState<Array<{name: string; fileId: string}>>([]);

  // #553: 切换文档时重置聊天本地状态。
  const prevDocId = useRef(docId);
  useEffect(() => {
    if (prevDocId.current !== docId) {
      prevDocId.current = docId;
      setChatInput('');
      setChatAttachedFiles([]);
      setActiveSkills([]);
    }
  }, [docId]);

  const [refDialogOpen, setRefDialogOpen] = useState(false);
  // #757: 共享 KbPicker — 从知识库选文章/文件直接登记为参考(kind=article/file)。
  const [kbPickerOpen, setKbPickerOpen] = useState(false);
  const handleKbPickConfirm = async (items: Array<{ id: string; title: string; kind: 'article' | 'document' }>) => {
    if (!docId || items.length === 0) return;
    for (const it of items) {
      try {
        await api.addDocReference(docId, {
          kind: it.kind === 'document' ? 'file' : 'guideline',
          content: it.title,
          label: it.title,
        });
      } catch (err) {
        setError(err instanceof ApiError ? err.messageText : String(err));
      }
    }
    void loadReferences();
  };
  const [refForm, setRefForm] = useState({ kind: 'guideline', content: '', label: '', source_patient_hash: '' });
  const [refSubmitting, setRefSubmitting] = useState(false);
  // #711: 参考材料列表(可查看/删除) — 此前只能添加,AI 上下文对用户不可见。
  const [refList, setRefList] = useState<Array<{ reference_id: string; kind: string; label: string; content: string; created_at: string }>>([]);
  const [refListOpen, setRefListOpen] = useState(false);
  const [refDeleting, setRefDeleting] = useState<string | null>(null);

  const loadReferences = useCallback(async () => {
    if (!docId) return;
    try {
      const r = await api.getDocReferences(docId);
      setRefList(r.references);
    } catch { /* 列表加载失败不阻断编辑 */ }
  }, [docId]);

  const [preview, setPreview] = useState(false);

  const polishRef = useRef<HTMLDivElement>(null);
  const polishEditorRef = useRef<Editor | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatFileRef = useRef<HTMLInputElement>(null);
  const docUploadRef = useRef<HTMLInputElement>(null);

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
        setStudyId(d.study_id || '');
        setStudyName(d.study_name || '');
      })
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, [docId]);

  // #297: doc chat history lives on the server (event log under doc-<id>);
  // reload it on mount so a refresh doesn't lose the conversation. The
  // store must NOT be a dependency (same infinite-loop trap as #272).
  useEffect(() => {
    void loadReferences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useEffect(() => {
    if (!chatSessionId) return;
    const existing = useChatStore.getState().sessions[chatSessionId]?.messages?.length;
    if (existing) return;
    api.getMessages(chatSessionId, 50).then((r) => {
      // #461: single wire→UI mapper (restores download / knowledge payload).
      const msgs = mapWireMessages(r.messages);
      if (msgs.length > 0) setMessages(chatSessionId, msgs);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store excluded deliberately
  }, [chatSessionId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatSession?.messages]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (polishRef.current && !polishRef.current.contains(e.target as Node)) {
        setPolishOpen(false);
      }
    }
    if (polishOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [polishOpen]);

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

  const handleSave = async () => {
    if (!docId) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateDoc(docId, { title, body });
      lastSavedBody.current = updated.body ?? body;
      dirtyRef.current = false;
      setDirty(false);
      if (updated.unchanged) {
        // #598: 内容未变化 — 提示且不刷新时间戳.
        setAiEditNotice(t('writing.unchanged', '内容未变化，未创建新版本'));
        setDoc((prev) => prev ? { ...prev, title: updated.title, body: updated.body } : prev);
        setTimeout(() => setAiEditNotice(''), 3000);
      } else {
        setDoc((prev) => prev ? { ...prev, title: updated.title, body: updated.body, updated_at: updated.updated_at } : prev);
        setTitle(updated.title);
        setBody(updated.body);
        setAiEditNotice(t('writing.savedVersion', '已保存并创建版本'));
        setTimeout(() => setAiEditNotice(''), 3000);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * #764: Restore 先审阅 — 拉快照全文与当前正文进 diff 审阅模式(绿=恢复
   * 内容/红=当前内容),用户逐条确认后经 handleDiffResolve 落地并自动保存。
   * 不再直接调用 restore(旧契约前端按 {body} 解析、服务端却只回 restored,
   * 存在把正文刷成 undefined 的隐患)。
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

  // #753: Polish 提交 — 双模式。selection 模式需要真实选区;full 模式对
  // 全文执行(服务端 polish 接口接受任意文本,全文=正文整体传入)。
  // #752-feedback: 本函数是气泡/面板共用的执行体 — 任何失败都必须落进
  // polishError 并渲染在面板内(此前只写顶部 banner,气泡场景用户根本看不到)。
  const runPolish = async (mode: 'selection' | 'full', instruction: string) => {
    const editor = polishEditorRef.current;
    if (!docId || !editor) return;
    setPolishError(null);
    let from = 0; let to = 0; let selection = '';
    if (mode === 'selection') {
      const sel = editor.state.selection;
      from = sel.from; to = sel.to;
      selection = editor.state.doc.textBetween(from, to, '\n').trim();
      if (!selection) { setPolishScope('full'); setPolishError('没有选中文本 — 已切换到全文润色'); return; }
    } else {
      selection = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n').trim();
      if (!selection) { setPolishError('正文为空,无可润色内容'); return; }
    }
    setPolishLoading(true);
    setPolishStream('');
    try {
      let result = '';
      for await (const chunk of api.polishDoc(docId, selection.slice(0, 20000), instruction || undefined)) {
        // #752-feedback: 服务端错误事件(此前被静默拼进正文/丢弃)
        if ((chunk as any).type === 'error') {
          throw new Error(String((chunk as any).message || 'AI 服务返回错误'));
        }
        if (typeof chunk.text === 'string') result += chunk.text;
        setPolishStream(result);
        if (chunk.done) break;
      }
      if (!result.trim()) {
        setPolishError('AI 未返回内容,请重试或检查模型配置');
        return;
      }
      // #642: replace the polished range through TipTap — onUpdate round-trips
      // markdown → body state, so the doc and its versions stay in sync.
      if (mode === 'selection') {
        editor.chain().focus().insertContentAt({ from, to }, markdownToHtml(result)).run();
      } else {
        setBody(result);
      }
      setPolishOpen(false);
      setAiEditNotice(mode === 'selection' ? '✨ 已按 AI 结果替换选中文本' : '✨ 已按 AI 结果更新全文');
      setTimeout(() => setAiEditNotice(''), 3000);
    } catch (err) {
      // 面板内可见错误 — 不再依赖页面顶部 banner
      setPolishError(err instanceof ApiError ? err.messageText : String((err as Error)?.message || err));
    } finally {
      setPolishLoading(false);
    }
  };

  /** #752: Selection Bubble 动作分发 — 所有动作都打开面板跑流式,用户始终
   *  看得到生成过程与取消入口(此前一键预设后台静默执行,零反馈)。
   *  #752-feedback: 到达性 console 标记 — 若用户端仍"无响应",console 有
   *  [bubble] 日志即可区分「handler 未触发」与「下游失败」。 */
  const handleBubbleAction = (action: string, sel: { text: string; from: number; to: number }) => {
    console.info('[bubble] action=', action, 'selLen=', sel.text.length, 'from=', sel.from, 'to=', sel.to);
    setBubbleSel(sel);
    setPolishScope('selection');
    setPolishError(null);
    if (action === 'polish') {
      setPolishInstruction('');
      setPolishOpen(true);
      return;
    }
    const preset = POLISH_PRESETS.find((p) => p.id === action);
    const instruction = preset?.instruction ?? '';
    setPolishInstruction(instruction);
    setPolishOpen(true);
    void runPolish('selection', instruction);
  };

  // #753 兼容旧入口(工具栏 Polish 按钮):读当前 scope。
  const handlePolishSubmit = async () => {
    await runPolish(polishScope, polishInstruction);
  };

  const handleSendChat = async () => {
    if (!docId || !chatInput.trim()) return;
    const text = chatInput.trim();
    setChatInput('');
    // §15.4: the writing chat runs through the unified pipeline (session
    // doc-{docId}); the doc context is injected via the docs/current source.
    // #fix: 上传的 doc/pdf 必须随消息传给服务端 — 此前只传 text,附件
    // 从未到达 buildAttachmentParts,AI 读不到文件内容。
    // #693: 选中即引用 — 编辑器选中文本随消息携带,服务端注入上下文,
    // 模型 old_text 从选中逐字复制,同源保证锚点必然命中。
    let selection = '';
    if (!diffReview) {
      const editor = polishEditorRef.current;
      if (editor) {
        const { from, to } = editor.state.selection;
        selection = editor.state.doc.textBetween(from, to, '\n').trim();
      }
    }
    if (!selection) selection = chatSelection.trim();
    if (selection.length > 20000) selection = selection.slice(0, 20000);
    const attachments = chatAttachedFiles.map((a) => a.fileId);
    if (attachments.length > 0) setChatAttachedFiles([]);
    // #fix: 发送前总是把编辑框当前内容保存到服务端(内容有变化才 PUT) —
    // 上下文注入的是数据库 body,必须与用户看到的编辑框一致;否则模型
    // 基于旧内容编辑写回,会覆盖/丢失用户未保存的本地修改。
    if (lastSavedBody.current !== bodyRef.current) {
      try {
        const saved = await api.updateDoc(docId, { title, body: bodyRef.current });
        lastSavedBody.current = saved.body ?? bodyRef.current;
      } catch {
        // 保存失败仍继续发送 — 锚点不匹配时由服务端归一化兜底/报错引导。
      }
    }
    // #fix: 追加问题排队发送 — 回复进行中调用时不打断(工具写回中的
    // doc_updated 若被中断,前端与文档状态会不一致),由 store 在当前
    // turn 完成后自动发出;排队状态经 session.pending 在输入框上方提示。
    await sendMessageQueued(`doc-${docId}`, {
      text,
      sessionId: `doc-${docId}`,
      patientHash: null,
      skills: activeSkills,
      attachments,
      // #516: writing chat is always the document scene (server also infers
      // from the doc- session id).
      scene: 'document',
      selection: selection || undefined,
    });
  };

  const handleChatPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        setChatUploadingFile(true);
        try {
          const result = await uploadWithProgress(file);
          setChatAttachedFiles((prev) => [...prev, { name: result.name, fileId: result.file_id }]);
        if (result.dedup) {
          setKbDedupNotice(`📚 已在知识库,已加入上下文: ${result.name}`);
          setTimeout(() => setKbDedupNotice(null), 4000);
        }
          // #fix: 粘贴上传同样写入聊天记录。
          if (chatSessionId) {
            appendMessage(chatSessionId, { id: crypto.randomUUID(), role: 'user', text: `[📎 已上传] ${result.name}`, createdAt: Date.now() });
            api.logAttachments(chatSessionId, [{ name: result.name, file_id: result.file_id }]).catch(() => {});
          }
          if (docId) api.addDocReference(docId, { kind: 'file', content: result.name, label: result.name }).catch(() => {});
        } catch (err) {
          // #fix: 大文件/上传失败此前静默吞掉,用户以为传上了 — 现在明示。
          setError(err instanceof ApiError ? err.messageText : String(err));
        }
        finally {
          setChatUploadingFile(false);
          setUploadState(null);
        }
      }
    }
  };

  const handleChatFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setChatUploadingFile(true);
    try {
      const result = await uploadWithProgress(f);
      setChatAttachedFiles((prev) => [...prev, { name: result.name, fileId: result.file_id }]);
      // #fix: 上传即入聊天记录(与服务端 user_message 事件一致),刷新后仍可见。
      if (chatSessionId) {
        appendMessage(chatSessionId, { id: crypto.randomUUID(), role: 'user', text: `[📎 已上传] ${result.name}`, createdAt: Date.now() });
        api.logAttachments(chatSessionId, [{ name: result.name, file_id: result.file_id }]).catch(() => {});
      }
      if (docId) api.addDocReference(docId, { kind: 'file', content: result.name, label: result.name }).catch(() => {});
    } catch (err) {
      // #fix: 大文件/上传失败此前静默吞掉 — 现在明示。
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
    finally {
      setChatUploadingFile(false);
      setUploadState(null);
    }
  };

  // #fix: 统一上传入口 — 驱动进度 Modal(uploading → importing)。
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadWithProgress = async (f: File) => {
    setUploadState({ fileName: f.name, percent: 0, stage: 'uploading' });
    const abort = new AbortController();
    uploadAbortRef.current = abort;
    try {
      const result = await api.uploadFile(f, undefined, (p) => {
        setUploadState((prev) => (prev ? { ...prev, percent: p } : prev));
      });
      // 上传完成 → 服务端导入阶段(提取文字/图片/公式)。
      setUploadState((prev) => (prev ? { ...prev, percent: 100, stage: 'importing' } : prev));
      return result;
    } catch (err) {
      // #714: 主动取消不视为错误。
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      setUploadState((prev) => (prev ? { ...prev, error: err instanceof ApiError ? err.messageText : t('common.uploadFailed', '上传失败') } : prev));
      throw err;
    }
  };

  /** #714: 取消上传(分片场景服务端清理 upload-abort,单次场景中止 XHR)。 */
  const cancelUpload = () => {
    uploadAbortRef.current?.abort();
    setUploadState(null);
  };

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !docId) return;
    try {
      // #fix: 上传按钮的附件必须同时挂到聊天消息(attachments),否则首条
      // 消息只带"参考材料里的文件名",LLM 读不到正文。
      const result = await uploadWithProgress(f);
      setChatAttachedFiles((prev) => [...prev, { name: result.name, fileId: result.file_id }]);
      // #fix: 上传即草稿 — 空文档 + 文件类参考时服务端自动导入正文,
      // 响应携带 imported_body,前端立即刷新编辑框(用户马上看到原文)。
      // #714: 已存在的同名参考不重复写入(服务端 dedup 命中时 result.dedup)。
      let refResult: unknown = null;
      if (!result.dedup) {
        refResult = await api.addDocReference(docId, {
          kind: f.name.endsWith('.pdf') ? 'pdf' : f.name.endsWith('.docx') || f.name.endsWith('.doc') ? 'docx' : 'file',
          content: f.name,
          label: f.name,
        });
      }
      void loadReferences();
      if ((refResult as any)?.imported && !bodyRef.current.trim()) {
        const importedBody = (refResult as any)?.imported_body as string | undefined;
        if (importedBody) {
          setBody(importedBody);
          setDoc((prev) => (prev ? { ...prev, body: importedBody, updated_at: new Date().toISOString() } : prev));
          lastSavedBody.current = importedBody;
          // #fix: 引导 — 已导入原文,可直接编辑草稿或与 AI 对话调整。
          setAiEditNotice(t('writing.importedBody', '已导入原文，可直接编辑草稿，或在右侧与 AI 对话调整内容'));
          setTimeout(() => setAiEditNotice(''), 6000);
        }
      }
      setError(null);
      // #714: 不再强制打开 chat 面板 + 预填英文 prompt — 导入是独立动作,
      // 用 toast 引导即可;用户想对话时自己点开。
      setAiEditNotice(`已上传 ${f.name} 并挂为参考材料`);
      setTimeout(() => setAiEditNotice(''), 4000);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.messageText : 'Upload failed');
    } finally {
      // #fix: 导入完成(或失败)关闭进度 Modal。
      setUploadState(null);
    }
    if (e.target) e.target.value = '';
  };

  const handleAddReference = async () => {
    if (!docId || !refForm.content.trim() || !refForm.kind.trim()) return;
    setRefSubmitting(true);
    try {
      await api.addDocReference(docId, {
        kind: refForm.kind,
        content: refForm.content,
        label: refForm.label || undefined,
        source_patient_hash: refForm.source_patient_hash || undefined,
      });
      setRefDialogOpen(false);
      setRefForm({ kind: 'guideline', content: '', label: '', source_patient_hash: '' });
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setRefSubmitting(false);
    }
  };

  const highlightedBody = () => {
    if (!phiFindings || phiFindings.length === 0) return null;
    const sorted = [...phiFindings].sort((a, b) => a.start - b.start);
    const parts: JSX.Element[] = [];
    let cursor = 0;
    sorted.forEach((f, i) => {
      if (f.start > cursor) {
        parts.push(<span key={`txt-${i}`}>{body.slice(cursor, f.start)}</span>);
      }
      parts.push(
        <mark key={`phi-${i}`} className="bg-error/20 text-error rounded-sm px-0.5" title={f.suggestion}>
          {body.slice(f.start, f.end)}
        </mark>,
      );
      cursor = f.end;
    });
    if (cursor < body.length) {
      parts.push(<span key="txt-end">{body.slice(cursor)}</span>);
    }
    return parts;
  };

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
              onChange={handleDocUpload}
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
          {/* #752/#753: Polish 双模式 — 按钮文案随选区状态切换;无选区=
              全文润色,有选区=局部润色。永远不静默失败。 */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const editor = polishEditorRef.current;
              const sel = editor?.state.selection;
              const hasSel = !!sel && !sel.empty
                && editor.state.doc.textBetween(sel.from, sel.to, '\n').trim().length > 10;
              setPolishScope(hasSel ? 'selection' : 'full');
              setPolishInstruction('');
              setPolishOpen((v) => !v);
            }}
            disabled={polishLoading}
            title={t('writing.polishHint', '选中文字可局部润色;未选中则润色全文')}
          >
            <Sparkles size={14} className="mr-1" />
            {polishOpen ? t('writing.polish', '润色') : (t('writing.polishFull', '润色全文'))}
          </Button>
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
          {polishOpen && (
              <div
                ref={polishRef}
                className="absolute left-0 right-0 top-full z-30 mt-1 w-auto max-w-full rounded-xl border border-border bg-surface-elevated p-4 shadow-lg sm:left-auto sm:right-auto sm:w-80"
              >
                {/* #753: 作用范围自述 — 消除"作用于哪里"的歧义。 */}
                <div className="mb-2 rounded-lg bg-surface px-2 py-1.5 text-xs text-text-secondary">
                  {polishScope === 'full'
                    ? t('writing.polishScopeFull', '📄 将对全文进行润色 · 或先选中一段文字做局部调整')
                    : t('writing.polishScopeSel', `✨ 将润色选中的文字(${bubbleSel?.text.length ?? '选中部分'})`)}
                </div>
                {/* #753: 预设意图卡 — 点卡片即发,免学习成本。 */}
                <div className="mb-2 flex flex-wrap gap-1">
                  {POLISH_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      disabled={polishLoading}
                      onClick={() => { setPolishInstruction(p.instruction); void runPolish(polishScope, p.instruction); }}
                      className="flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-text-secondary hover:border-accent hover:text-accent disabled:opacity-50"
                    >
                      <span aria-hidden>{p.icon}</span>{p.label}
                    </button>
                  ))}
                </div>
                <textarea
                  value={polishInstruction}
                  onChange={(e) => setPolishInstruction(e.target.value)}
                  placeholder="Optional instruction (e.g. make it more concise)"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none h-16"
                />
                {polishLoading && !polishStream && (
                  /* #752 反馈:LLM 首包前的等待期也必须有可见状态 */
                  <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface p-2 text-xs text-text-secondary">
                    <Loader2 size={12} className="animate-spin" /> {t('writing.generating', 'AI 生成中,通常需要几秒…')}
                  </div>
                )}
                {polishError && (
                  /* #752-feedback: 执行失败必须在面板内立即可见 */
                  <div className="mt-2 rounded-lg border border-error/40 bg-error/5 p-2 text-xs text-error" role="alert">
                    ✗ {polishError}
                  </div>
                )}
                {polishStream && (
                  // #660/#661: streaming tail renders throttled + block-projected.
                  <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-surface p-2">
                    <StreamingLlmContent content={polishStream} isStreaming={polishLoading} />
                  </div>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setPolishOpen(false)}>Cancel</Button>
                  <Button size="sm" onClick={handlePolishSubmit} isLoading={polishLoading} disabled={polishLoading}>
                    Polish
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
              title={t('writing.pickFromKb', '从知识库选择文章/文件作为参考')}
            >
              📚 {t('writing.fromKb', '知识库')}
            </Button>
            {refListOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-[min(92vw,420px)] rounded-xl border border-border bg-surface-elevated p-3 shadow-lg">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-text-secondary">参考材料 ({refList.length})</span>
                  <button onClick={() => setRefListOpen(false)} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
                </div>
                {refList.length === 0 ? (
                  <p className="py-3 text-center text-xs text-text-tertiary">暂无参考材料 — 点击 Reference 添加，AI 将基于这些材料写作</p>
                ) : (
                  <ul className="max-h-72 space-y-1.5 overflow-y-auto">
                    {refList.map((r) => (
                      <li key={r.reference_id} className="flex items-start gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs">
                        <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[10px] text-accent">{r.kind}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-text-primary">{r.label || r.content.slice(0, 40)}</p>
                          <p className="truncate text-text-tertiary">{r.content.slice(0, 80)}</p>
                        </div>
                        <button
                          onClick={async () => {
                            if (!docId) return;
                            setRefDeleting(r.reference_id);
                            try {
                              await api.deleteDocReference(docId, r.reference_id);
                              setRefList((prev) => prev.filter((x) => x.reference_id !== r.reference_id));
                            } catch (err) {
                              setError(err instanceof ApiError ? err.messageText : String(err));
                            } finally {
                              setRefDeleting(null);
                            }
                          }}
                          disabled={refDeleting !== null}
                          className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-error"
                          aria-label="删除参考材料"
                        >
                          <X size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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
            <div className="relative ml-3">
              <div className="w-72 rounded-xl border border-border bg-surface-elevated p-3 shadow-lg">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-sm font-medium text-text-primary">
                    <Check size={14} className="text-success" /> {t('writing.exportDone', '导出完成')}
                  </span>
                  <button onClick={() => setExportPanelOpen(false)} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
                </div>
                {exportResult && (
                  <div className="mb-1 rounded-lg bg-surface px-2 py-1.5 text-xs text-text-secondary">
                    📄 DOCX · {(exportResult.size_bytes / 1024).toFixed(1)} KB · 已开始下载
                    <div className="mt-0.5 text-[11px] text-text-tertiary">✓ {t('writing.exportKbSync', '已同步知识库,可在聊天中引用')}</div>
                  </div>
                )}
                {exportHistory.length > 0 && (
                  <div className="mt-2 border-t border-border pt-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{t('writing.exportHistory', '本次导出历史')}</span>
                    <ul className="mt-1 space-y-0.5">
                      {exportHistory.map((h) => (
                        <li key={h.at} className="flex items-center justify-between text-xs text-text-secondary">
                          <span className="truncate">{h.format === 'docx' ? '📄' : '📕'} {h.filename}</span>
                          <span className="text-text-tertiary">{(h.size / 1024).toFixed(0)}KB</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
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
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border bg-surface-elevated">
                    <DocEditor value={body} onChange={setBody} editorRef={polishEditorRef} diffReview={diffReview} onDiffResolve={handleDiffResolve} onSelectionChange={setChatSelection}
                      reviewTitle={restoreReview ? '审阅版本恢复' : undefined}
                      onBubbleAction={handleBubbleAction}
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
              <SkillsBar active={activeSkills} onToggle={(name) => setActiveSkills((prev) => prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name])} />
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                <ChatMessages
                  variant="compact"
                  messages={chatMessages}
                  streamNote={chatSession?.streamNote}
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
                {kbDedupNotice && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-text-secondary">{kbDedupNotice}</div>
            )}
            {chatAttachedFiles.length > 0 && (
                  <div className="mb-2 flex gap-1 flex-wrap">
                    {chatAttachedFiles.map((f) => (
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
                  <input ref={chatFileRef} type="file" onChange={handleChatFile} className="hidden" disabled={chatUploadingFile} />
                  <Button variant="ghost" size="sm" onClick={() => chatFileRef.current?.click()} disabled={chatLoading || chatUploadingFile} isLoading={chatUploadingFile} className="shrink-0">
                    <Paperclip size={16} />
                  </Button>
                  <Textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
                    onPaste={handleChatPaste}
                    placeholder="Ask a question..."
                    rows={1}
                    className="min-h-0 flex-1 resize-none py-1.5"
                    style={{ maxHeight: '120px' }}
                  />
                  {/* #fix: 回复进行中显示 Stop(停止分析,含排队消息);平时发送=排队。 */}
                  {chatLoading ? (
                    <Button size="sm" variant="secondary" onClick={() => stopStream(chatSessionId)} className="shrink-0">
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" onClick={handleSendChat} disabled={!chatInput.trim()} className="shrink-0">
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
        <UploadProgressModal state={uploadState} onCancel={cancelUpload} />

        {/* #598: History 版本列表 — 悬浮窗选择 snapshot(无需滚动到底部) */}
        {showHistory && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowHistory(false)}>
            <div className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface-elevated p-6 shadow-xl m-4" onClick={(e) => e.stopPropagation()}>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-text-primary">历史版本 (Snapshots)</h2>
                <button onClick={() => setShowHistory(false)} className="text-text-tertiary hover:text-text-primary">
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto">
                {snapshotsLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-12 w-full rounded-lg" />
                    <Skeleton className="h-12 w-full rounded-lg" />
                  </div>
                ) : snapshots.length === 0 ? (
                  <p className="text-sm text-text-tertiary">No snapshots available</p>
                ) : (
                  snapshots.map((s) => (
                    <div key={s.snapshot_id} className="flex items-start justify-between rounded-lg border border-border p-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-text-tertiary">{new Date(s.created_at).toLocaleString()}</p>
                        <p className="mt-1 truncate text-sm text-text-secondary">{s.body_preview || '(empty)'}</p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => void handleRestoreRequest(s.snapshot_id)} disabled={restoring === s.snapshot_id} isLoading={restoring === s.snapshot_id}>
                        <RotateCcw size={14} className="mr-1" /> Restore
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* PHI Findings Dialog */}
        {showPhiDialog && phiFindings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowPhiDialog(false)}>
            <div className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-surface-elevated shadow-xl p-6 m-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-text-primary">PHI Findings</h2>
                <button onClick={() => setShowPhiDialog(false)} className="text-text-tertiary hover:text-text-primary">
                  <X size={18} />
                </button>
              </div>
              <p className="text-sm text-text-secondary mb-4">
                Found {phiFindings.length} potential PHI instance{phiFindings.length !== 1 ? 's' : ''} in the document. Review and manually redact as needed.
              </p>
              <div className="rounded-lg border border-border bg-surface p-4 mb-4 max-h-60 overflow-y-auto text-sm text-text-primary whitespace-pre-wrap">
                {highlightedBody()}
              </div>
              <div className="space-y-3">
                {phiFindings.map((f, i) => (
                  <div key={i} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-text-primary">&ldquo;{f.text}&rdquo;</p>
                        <p className="text-xs text-text-tertiary mt-0.5">
                          Position: {f.start}–{f.end}
                        </p>
                      </div>
                      <span className="text-xs text-warning bg-warning/10 rounded-full px-2 py-0.5 shrink-0">PHI</span>
                    </div>
                    <p className="mt-2 text-sm text-text-secondary">
                      <span className="font-medium">Suggestion:</span> {f.suggestion}
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowPhiDialog(false)}>Close</Button>
              </div>
            </div>
          </div>
        )}

        {/* Add Reference Dialog */}
        {refDialogOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setRefDialogOpen(false)}>
            <div className="w-full max-w-md rounded-xl border border-border bg-surface-elevated shadow-xl p-6 m-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-text-primary">Add Reference</h2>
                <button onClick={() => setRefDialogOpen(false)} className="text-text-tertiary hover:text-text-primary">
                  <X size={18} />
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Kind</label>
                  <select
                    value={refForm.kind}
                    onChange={(e) => setRefForm((p) => ({ ...p, kind: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="guideline">Guideline</option>
                    <option value="research">Research</option>
                    <option value="protocol">Protocol</option>
                    <option value="note">Note</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Label</label>
                  <input
                    type="text"
                    value={refForm.label}
                    onChange={(e) => setRefForm((p) => ({ ...p, label: e.target.value }))}
                    placeholder="e.g. WHO Guideline v3"
                    className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Content</label>
                  <textarea
                    value={refForm.content}
                    onChange={(e) => setRefForm((p) => ({ ...p, content: e.target.value }))}
                    placeholder="Paste or type reference content..."
                    rows={4}
                    className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Source Patient Hash (optional)</label>
                  <input
                    type="text"
                    value={refForm.source_patient_hash}
                    onChange={(e) => setRefForm((p) => ({ ...p, source_patient_hash: e.target.value }))}
                    placeholder="Optional patient hash"
                    className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setRefDialogOpen(false)}>Cancel</Button>
                <Button size="sm" onClick={handleAddReference} isLoading={refSubmitting} disabled={refSubmitting}>
                  Add
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
      {/* #757: 共享知识库选择器 */}
      <KbPicker open={kbPickerOpen} onClose={() => setKbPickerOpen(false)} onConfirm={handleKbPickConfirm} max={5} />
    </AppShell>
  );
}
