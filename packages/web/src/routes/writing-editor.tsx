import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Eye, FilePlus, FileText, History, MessageSquare, Paperclip, RotateCcw, ShieldAlert, Sparkles, X } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SkillsBar } from '@/components/SkillsBar';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { DocEditor } from '@/components/DocEditor';
import { ChatMessages } from '@/components/chat/ChatMessages';
import { ChartLibrary } from '@/components/chat/ChartLibrary';
import { useChatStore } from '@/stores/chat';
import { Alert, Button, Skeleton, Textarea, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { mapWireMessages } from '@/lib/message-map';
import { cn } from '@/lib/utils';

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
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const [showHistory, setShowHistory] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);


  const [phiScanning, setPhiScanning] = useState(false);
  const [phiFindings, setPhiFindings] = useState<PhiFinding[] | null>(null);
  const [showPhiDialog, setShowPhiDialog] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ docx_path: string; size_bytes: number } | null>(null);

  const [polishOpen, setPolishOpen] = useState(false);
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

  const [chatOpen, setChatOpen] = useState(false);
  // #402-merge: the right panel hosts Doc Chat and the chart library.
  const [sidePanelTab, setSidePanelTab] = useState<'chat' | 'charts'>('chat');

  // #402-merge: append a library figure to the document body.
  const handleInsertChart = (markdown: string) => {
    setBody((prev) => `${prev || ''}\n\n${markdown}`);
    setDoc((prev) => (prev ? { ...prev, body: `${prev.body || ''}\n\n${markdown}`, updated_at: new Date().toISOString() } : prev));
  };
  const [chatInput, setChatInput] = useState('');
  const store = useChatStore();
  const chatSessionId = docId ? `doc-${docId}` : '';
  const chatSession = store.sessions[chatSessionId];
  const chatMessages = chatSession?.messages ?? [];
  const chatLoading = chatSession?.loading ?? false;
  const [aiEditNotice, setAiEditNotice] = useState('');

  // §15.4 / #553: apply AI write-backs — only when lastDocBody actually
  // changes. `body` must NOT be a dependency: it would re-apply the AI
  // version over the user's manual edits on every keystroke.
  const appliedDocBody = useRef<string | null>(null);
  useEffect(() => {
    if (!docId || !chatSession?.lastDocBody) return;
    if (appliedDocBody.current === chatSession.lastDocBody) return;
    appliedDocBody.current = chatSession.lastDocBody;
    setBody(chatSession.lastDocBody);
    setDoc((prev) => (prev ? { ...prev, body: chatSession.lastDocBody as string, updated_at: new Date().toISOString() } : prev));
    setAiEditNotice('文档已更新（AI 编辑）');
    const timer = setTimeout(() => setAiEditNotice(''), 4000);
    // #598: AI 写回自动保存到服务端 — 生成版本快照,用户可随时回退。
    api.updateDoc(docId, { title: (doc?.title) ?? 'Untitled', body: chatSession.lastDocBody }).catch(() => {});
    return () => clearTimeout(timer);
  }, [chatSession?.lastDocBody, docId]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [chatUploadingFile, setChatUploadingFile] = useState(false);
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
  const [refForm, setRefForm] = useState({ kind: 'guideline', content: '', label: '', source_patient_hash: '' });
  const [refSubmitting, setRefSubmitting] = useState(false);

  const [preview, setPreview] = useState(false);

  const polishRef = useRef<HTMLDivElement>(null);
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
    // #382: linked submission state (target journal / applied template).
    api.listSubmissionDrafts().then((r) => {
      const d = r.drafts[0];
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
    if (!chatSessionId) return;
    const existing = store.sessions[chatSessionId]?.messages?.length;
    if (existing) return;
    api.getMessages(chatSessionId, 50).then((r) => {
      // #461: single wire→UI mapper (restores download / knowledge payload).
      const msgs = mapWireMessages(r.messages);
      if (msgs.length > 0) store.setMessages(chatSessionId, msgs);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store excluded deliberately
  }, [chatSessionId]);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.style.height = 'auto';
      bodyRef.current.style.height = `${bodyRef.current.scrollHeight}px`;
    }
  }, [body]);

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
      if (updated.unchanged) {
        // #598: 内容未变化 — 提示且不刷新时间戳.
        setAiEditNotice('内容未变化，未创建新版本');
        setDoc((prev) => prev ? { ...prev, title: updated.title, body: updated.body } : prev);
        setTimeout(() => setAiEditNotice(''), 3000);
      } else {
        setDoc((prev) => prev ? { ...prev, title: updated.title, body: updated.body, updated_at: updated.updated_at } : prev);
        setTitle(updated.title);
        setBody(updated.body);
        setAiEditNotice('已保存并创建版本');
        setTimeout(() => setAiEditNotice(''), 3000);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (snapshotId: string) => {
    if (!docId) return;
    setRestoring(snapshotId);
    try {
      const restored = await api.restoreSnapshot(docId, snapshotId);
      setBody(restored.body);
      setDoc((prev) => prev ? { ...prev, body: restored.body, updated_at: new Date().toISOString() } : prev);
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
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setExporting(false);
    }
  };

  const handlePolish = async () => {
    if (!docId || !bodyRef.current) return;
    const ta = bodyRef.current;
    const selection = body.substring(ta.selectionStart, ta.selectionEnd);
    if (!selection) {
      setError('Select text in the editor first, then click Polish.');
      return;
    }
    setPolishOpen(true);
    setPolishStream('');
    setPolishInstruction('');
  };

  const handlePolishSubmit = async () => {
    if (!docId || !bodyRef.current) return;
    const ta = bodyRef.current;
    const selection = body.substring(ta.selectionStart, ta.selectionEnd);
    if (!selection) return;
    setPolishLoading(true);
    setPolishStream('');
    try {
      let result = '';
      for await (const chunk of api.polishDoc(docId, selection, polishInstruction || undefined)) {
        result += chunk.text;
        setPolishStream(result);
        if (chunk.done) break;
      }
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newBody = body.substring(0, start) + result + body.substring(end);
      setBody(newBody);
      setPolishOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setPolishLoading(false);
    }
  };

  const handleSendChat = () => {
    if (!docId || !chatInput.trim()) return;
    const text = chatInput.trim();
    setChatInput('');
    // §15.4: the writing chat runs through the unified pipeline (session
    // doc-{docId}); the doc context is injected via the docs/current source.
    store.sendMessage(`doc-${docId}`, {
      text,
      sessionId: `doc-${docId}`,
      patientHash: null,
      skills: activeSkills,
      // #516: writing chat is always the document scene (server also infers
      // from the doc- session id).
      scene: 'document',
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
          const result = await api.uploadFile(file);
          setChatAttachedFiles((prev) => [...prev, { name: result.name, fileId: result.file_id }]);
          if (docId) api.addDocReference(docId, { kind: 'file', content: result.name, label: result.name }).catch(() => {});
        } catch { /* ignore */ }
        finally { setChatUploadingFile(false); }
      }
    }
  };

  const handleChatFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setChatUploadingFile(true);
    try {
      const result = await api.uploadFile(f);
      setChatAttachedFiles((prev) => [...prev, { name: result.name, fileId: result.file_id }]);
      if (docId) api.addDocReference(docId, { kind: 'file', content: result.name, label: result.name }).catch(() => {});
    } catch { /* ignore */ }
    finally { setChatUploadingFile(false); }
  };

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !docId) return;
    try {
      await api.uploadFile(f);
      await api.addDocReference(docId, {
        kind: f.name.endsWith('.pdf') ? 'pdf' : f.name.endsWith('.docx') || f.name.endsWith('.doc') ? 'docx' : 'file',
        content: f.name,
        label: f.name,
      });
      setError(null);
      // Open chat panel with suggested prompt
      setChatOpen(true);
      setChatInput(`I uploaded "${f.name}". Please analyze it and draft content.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : 'Upload failed');
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
            <Button variant="ghost" size="sm" onClick={() => navigate('/app/writing')}>
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
            <Button variant="ghost" size="sm" onClick={() => navigate('/app/writing')}>
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
          <Button variant="ghost" size="sm" onClick={() => navigate('/app/writing')}>
            <ArrowLeft size={16} />
          </Button>
          <FileText size={18} className="text-text-tertiary" />
          <h1 className="font-semibold text-text-primary">{doc.title || 'Untitled'}</h1>
          {studyName && (
            <span className="hidden rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-xs text-accent sm:inline">
              {t('writing.studyBadge', '研究')}: {studyName}
            </span>
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
              Save
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
              onClick={handlePolish}
            >
              <Sparkles size={14} className="mr-1" /> AI Polish
            </Button>
            {polishOpen && (
              <div
                ref={polishRef}
                className="absolute left-0 right-0 top-full z-30 mt-1 w-auto max-w-full rounded-xl border border-border bg-surface-elevated p-4 shadow-lg sm:left-auto sm:right-auto sm:w-80"
              >
                <textarea
                  value={polishInstruction}
                  onChange={(e) => setPolishInstruction(e.target.value)}
                  placeholder="Optional instruction (e.g. make it more concise)"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none h-16"
                />
                {polishStream && (
                  <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-surface p-2 text-sm text-text-secondary whitespace-pre-wrap">
                    {polishStream}
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
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRefDialogOpen(true)}
          >
            <FilePlus size={14} className="mr-1" /> Reference
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChatOpen((v) => !v)}
          >
            <MessageSquare size={14} className="mr-1" /> Chat
          </Button>

          {exportResult && (
            <div className="ml-3 flex items-center gap-2 text-xs text-success">
              <span>Exported: {exportResult.docx_path} ({(exportResult.size_bytes / 1024).toFixed(1)} KB)</span>
              <button onClick={() => setExportResult(null)} className="text-text-tertiary hover:text-text-primary"><X size={12} /></button>
            </div>
          )}
        </div>

        <div className="flex flex-1 overflow-hidden">
          <main className={cn('flex-1 overflow-y-auto p-6', chatOpen ? 'border-r border-border' : '')}>
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
                    <DocEditor value={body} onChange={setBody} />
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
                {chatAttachedFiles.length > 0 && (
                  <div className="mb-2 flex gap-1 flex-wrap">
                    {chatAttachedFiles.map((f) => (
                      <span key={f.fileId} className="inline-flex items-center rounded-full bg-surface-elevated border border-border px-2 py-0.5 text-xs text-text-secondary">{f.name}</span>
                    ))}
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
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
                    onPaste={handleChatPaste}
                    placeholder="Ask a question..."
                    rows={1}
                    className="min-h-0 flex-1 resize-none py-1.5"
                    style={{ maxHeight: '120px' }}
                  />
                  <Button size="sm" onClick={handleSendChat} disabled={chatLoading || !chatInput.trim()} className="shrink-0">
                    Send
                  </Button>
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
                      <Button size="sm" variant="ghost" onClick={() => handleRestore(s.snapshot_id)} disabled={restoring === s.snapshot_id} isLoading={restoring === s.snapshot_id}>
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
    </AppShell>
  );
}
