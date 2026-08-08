import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Paperclip, Copy, Check, Download, FileText, Plus, X, RefreshCw, RotateCcw, Quote } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { LlmStatus } from '@/lib/types';
import { useAuthStore } from '@/stores/auth';
import { useChatStore, type ChatMessage } from '@/stores/chat';
import { AppShell } from '@/components/layout/AppShell';
import { SkillsBar } from '@/components/SkillsBar';
import { StreamingLlmContent } from '@/components/LlmContent';
import { PluginExtensionPoint } from '@/components/plugins/PluginExtensionPoint';
import { NewSessionDialog } from '@/components/NewSessionDialog';
import { ContextUsageIndicator } from '@/components/ContextUsageIndicator';
import { ToolCalls } from '@/components/ToolCalls';
import { StatusDot } from '@/components/ui/StatusDot';
import { cn } from '@/lib/utils';
import { Radar } from 'lucide-react';
import { SkillCapturePrompt } from '@/components/SkillCapturePrompt';
import { Alert, Button, Textarea } from '@/components/ui';

/** §10.3 (#220): group separator when a gap exceeds this many minutes. */
const TIME_GROUP_GAP_MS = 5 * 60 * 1000;

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function needsDaySeparator(prev?: ChatMessage, cur?: ChatMessage): boolean {
  if (!cur?.createdAt) return false;
  if (!prev?.createdAt) return true;
  return new Date(cur.createdAt).toDateString() !== new Date(prev.createdAt).toDateString();
}

function needsTimeGroupSeparator(prev?: ChatMessage, cur?: ChatMessage): boolean {
  if (!cur?.createdAt || !prev?.createdAt) return false;
  return cur.createdAt - prev.createdAt > TIME_GROUP_GAP_MS;
}


interface ChatSessionItem {
  id: string;
  title: string;
  status: 'open' | 'closed' | undefined;
  created_at: string;
  message_count?: number;
}

export function ChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated, clearSession } = useAuthStore();
  const store = useChatStore();
  // No implicit default session — the user creates one explicitly.
  const [sessionId, setSessionId] = useState<string>('');
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const session = store.sessions[sessionId];
  const [globalSessions, setGlobalSessions] = useState<ChatSessionItem[]>([]);
  const currentSessionTitle =
    globalSessions.find((s) => s.id === sessionId)?.title ?? '';

  const [input, setInput] = useState('');
  // Per-session drafts: switching sessions must never leak half-typed text
  // into another conversation.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<Array<{name: string; fileId: string}>>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  // #420: parallel deep analysis entry.
  const [deepOpen, setDeepOpen] = useState(false);
  const [deepTopics, setDeepTopics] = useState<string[]>(['literature', 'clinical']);
  const [deepQuestion, setDeepQuestion] = useState('');
  const [deepBusy, setDeepBusy] = useState(false);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [kbChecked, setKbChecked] = useState<Record<string, boolean>>({});
  const [kbAdded, setKbAdded] = useState<Record<string, boolean>>({});
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({});
  const [downloadLoading, setDownloadLoading] = useState<Record<string, boolean>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadGlobalSessions = useCallback(() => {
    api.listSessions(false, 'global')
      .then((r) => {
        const sessions = r.sessions.map((s) => ({ id: s.id, title: s.title, status: s.status, created_at: s.created_at, message_count: s.message_count }));
        setGlobalSessions(sessions);
        // After a refresh / returning to the page, restore the most recent
        // open session so conversations don't appear to vanish (the
        // selector stays disabled while nothing is selected).
        setSessionId((prev) => {
          if (prev) return prev;
          const open = sessions.filter((s) => s.status !== 'closed');
          return open.length > 0 ? open[0].id : '';
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadGlobalSessions();
  }, [loadGlobalSessions]);

  const handleNewSession = () => {
    // User-initiated: let them name the session first.
    setNewSessionOpen(true);
  };

  const insertSession = (res: { id: string; title: string; created_at: string }) => {
    // Synchronously prepend the new session so the selector is immediately
    // consistent — no waiting on the async list refresh.
    setGlobalSessions((prev) => [
      { id: res.id, title: res.title, status: 'open', created_at: res.created_at, message_count: 0 },
      ...prev,
    ]);
    setSessionId(res.id);
    store.clearSession(res.id);
  };

  const handleSessionCreated = (session: { id: string; title: string; created_at: string }) => {
    insertSession(session);
  };

  const handleCloseSession = async () => {
    setConfirmCloseOpen(true);
  };

  const confirmCloseSession = async () => {
    const closingId = sessionId;
    setConfirmCloseOpen(false);
    try {
      await api.closeSession(closingId);
      // Remove the closed session from the selector and clean up local state.
      setGlobalSessions((prev) => prev.filter((s) => s.id !== closingId));
      store.clearSession(closingId);
      setDrafts((prev) => { const next = { ...prev }; delete next[closingId]; return next; });
      // Pick the next open session; if none remains, show the empty state
      // (no implicit default session).
      const next = globalSessions.find((s) => s.id !== closingId && s.status === 'open');
      setSessionId(next ? next.id : '');
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login', { replace: true });
      return;
    }
    api
      .getLlmStatus()
      .then(setLlmStatus)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) clearSession();
        else setError(err instanceof ApiError ? err.messageText : t('common.loading'));
      });
  }, [isAuthenticated, navigate, clearSession, t]);

  // Load history + context budget exactly once per session id. NOTE: the
  // store must NOT be a dependency here — setContextUsage below updates the
  // store, which would re-run this effect → an infinite request/render loop
  // (observed: first message in a brand-new session never got a reply).
  useEffect(() => {
    if (!sessionId) return; // no session selected — nothing to load
    const existing = store.sessions[sessionId]?.messages?.length;
    if (existing) return;
    api.getMessages(sessionId, 50).then((r) => {
      const msgs = r.messages.map((m) => ({
        id: crypto.randomUUID(),
        role: m.role,
        text: m.content,
        download:
          (m.metadata?.sidecar || m.metadata?.plugin) && (m.metadata?.file as any)
            ? {
                fileId: (m.metadata.file as any).fileId as string,
                fileName: (m.metadata.file as any).fileName as string,
                mimeType: (m.metadata.file as any).mimeType as string,
                url: '',
                expiresIn: 0,
              }
            : undefined,
        knowledgePayload: (m.metadata?.knowledgePayload as { title: string; content: string }) ?? undefined,
      }));
      if (msgs.length > 0) store.setMessages(sessionId, msgs);
    }).catch(() => {});
    // U3: show the context budget immediately for sessions with history.
    api.getContextUsage(sessionId).then((u) => {
      store.setContextUsage(sessionId, {
        historyTokens: u.history_tokens,
        historyBudget: u.history_budget,
        historyTurns: u.history_turns,
        omittedTurns: u.omitted_turns,
        willCompact: u.will_compact,
      });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store must not be a dependency (setContextUsage would re-trigger this effect forever).
  }, [sessionId]);

  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const isNearBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight < 150;
    if (isNearBottom) el.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages]);

  const handleSend = async () => {
    if (!input.trim() || session?.loading || session?.compacting) return;
    // No session? Require an explicit creation — never auto-create one
    // behind the user's back.
    if (!sessionId) {
      setNewSessionOpen(true);
      return;
    }
    const text = input.trim();
    setInput('');
    setDrafts((prev) => { const next = { ...prev }; delete next[sessionId]; return next; });
    setError(null);
    await store.sendMessage(sessionId, {
      text,
      sessionId,
      attachments: attachedFiles.map((a) => a.fileId),
      skills: activeSkills,
    });
  };

  const handleStop = () => store.stopStream(sessionId);

  /** #420: parallel deep analysis — topics spawn concurrently, results append. */
  const handleDeepAnalysis = async () => {
    if (!sessionId || deepBusy || deepTopics.length === 0) return;
    const question = deepQuestion.trim() || (session?.messages ?? []).slice().reverse().find((m) => m.role === 'user')?.text || '';
    if (!question) { setError(t('chat.deepNeedQuestion', '请输入分析问题')); return; }
    setDeepBusy(true);
    setDeepOpen(false);
    setError(null);
    // Mirror the user question into the stream like a normal turn.
    store.appendMessage(sessionId, { id: crypto.randomUUID(), role: 'user', text: `🔬 ${question}` });
    const assistantId = crypto.randomUUID();
    store.appendMessage(sessionId, { id: assistantId, role: 'assistant', text: '', isStreaming: true });
    let acc = '';
    try {
      for await (const chunk of api.deepAnalysis({ question, topics: deepTopics })) {
        if (chunk.type === 'subagent_started') {
          acc += `[${chunk.task} ⏳] `;
          store.updateMessageText(sessionId, assistantId, acc.trim());
        } else if (chunk.type === 'subagent_done') {
          acc = acc.replace(`[${chunk.task} ⏳] `, `[${chunk.task} ${chunk.success ? '✓' : '✗'}] `);
          store.updateMessageText(sessionId, assistantId, acc.trim());
        } else if (chunk.type === 'final_answer_chunk') {
          acc += chunk.text;
          store.updateMessageText(sessionId, assistantId, acc);
        }
      }
      store.updateMessageText(sessionId, assistantId, acc || t('chat.deepDone', '分析完成'));
    } catch (err) {
      store.updateMessageText(sessionId, assistantId, acc || (err instanceof ApiError ? err.messageText : String(err)));
    } finally {
      store.setStreaming(sessionId, assistantId, false);
      setDeepBusy(false);
      setDeepQuestion('');
    }
  };

  /** §10.3 (#220): re-run the last user turn. */
  const handleRegenerate = async () => {
    if (session?.loading || session?.compacting) return;
    setError(null);
    await store.regenerate(sessionId, {
      sessionId,
      text: '',
      attachments: [],
      skills: activeSkills,
    });
  };

  /** §10.3 (#220): retry a failed turn — same text as the last user message. */
  const handleRetry = async () => {
    const msgs = session?.messages ?? [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUser || session?.loading || session?.compacting) return;
    setError(null);
    await store.regenerate(sessionId, {
      sessionId,
      text: lastUser.text,
      attachments: [],
      skills: activeSkills,
    });
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // ignore
    }
  };

  const handleAddToKnowledge = async (msg: ChatMessage) => {
    if (!msg.knowledgePayload) return;
    await api.createKnowledgeArticle(msg.knowledgePayload).catch(() => {});
    setKbAdded(prev => ({ ...prev, [msg.id]: true }));
  };

  const resolveDownloadUrl = async (fileId: string) => {
    if (downloadUrls[fileId]) return downloadUrls[fileId];
    setDownloadLoading(prev => ({ ...prev, [fileId]: true }));
    try {
      const info = await api.getExecutionFileDownload(fileId);
      setDownloadUrls(prev => ({ ...prev, [fileId]: info.download_url }));
      return info.download_url;
    } catch {
      return '';
    } finally {
      setDownloadLoading(prev => ({ ...prev, [fileId]: false }));
    }
  };

  const handleDownloadClick = async (msg: ChatMessage) => {
    if (!msg.download) return;
    const url = msg.download.url || await resolveDownloadUrl(msg.download.fileId);
    if (url) window.open(url, '_blank');
  };

  const toggleSkill = (name: string) => {
    setActiveSkills((prev) => prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadingFile(true);
    try {
      const result = await api.uploadFile(f);
      setAttachedFiles((prev) => [...prev, { name: result.name, fileId: result.file_id }]);
    } catch (err) {
      // silently fail
    } finally {
      setUploadingFile(false);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const arr = Array.from(items);
    // Rich-text copies (Word / browser) attach a bitmap (image/png, image/emf)
    // for non-HTML targets in addition to the real text. When actual text is
    // present, those attached images are decorations — never treat them as a
    // pasted file (they would upload as phantom images and even trigger AI
    // analysis). Only pure file pastes (e.g. a .docx or a screenshot) upload.
    const hasRichText = arr.some((i) => i.type === 'text/plain' || i.type === 'text/html');
    for (const item of arr) {
      if (item.kind !== 'file') continue;
      if (hasRichText && (item.type.startsWith('image/') || item.type === 'image/emf')) {
        continue;
      }
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      setUploadingFile(true);
      try {
        const result = await api.uploadFile(file);
        setAttachedFiles((prev) => [...prev, { name: result.name, fileId: result.file_id }]);
      } catch { /* ignore */ }
      finally { setUploadingFile(false); }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const messages = sessionId ? (session?.messages || []) : [];

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 sm:px-6">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <h1 className="shrink-0 font-semibold text-text-primary">{t('chat.title')}</h1>
              <select
              value={sessionId}
              onChange={(e) => {
                // Save the draft of the session we are leaving, restore the
                // draft of the one we enter.
                setDrafts((prev) => ({ ...prev, [sessionId]: input }));
                setInput(drafts[e.target.value] ?? '');
                setSessionId(e.target.value);
              }}
              className="h-8 min-w-0 flex-1 max-w-[220px] rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              aria-label={t('chat.selectSession', 'Session')}
              disabled={!sessionId}
            >
              {sessionId === '' && <option value="">{t('chat.noSessionSelected', '未选择会话')}</option>}
              {globalSessions.filter((s) => s.status !== 'closed').map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
            </select>
            <button
              onClick={handleNewSession}
              className="shrink-0 rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary hover:bg-surface"
              title={t('chat.newSession', 'New Session')}
            >
              <Plus size={13} className="mr-1 inline" />
              {t('chat.newSession', 'New Session')}
            </button>
            <button
              onClick={handleCloseSession}
              className="shrink-0 rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary hover:bg-error/10 hover:text-error"
              title={t('chat.closeSession', 'Close Session')}
            >
              {t('chat.closeSession', 'Close')}
            </button>
            {llmStatus && (
              <span className="hidden shrink-0 rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary sm:inline">
                {llmStatus.provider}/{llmStatus.model}
              </span>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.length === 0 && (
              <div className="py-20 text-center text-text-tertiary">
                {sessionId ? (
                  <>
                    <p className="text-lg">{t('chat.startConversation')}</p>
                    <p className="text-sm">{t('chat.contextHint')}</p>
                  </>
                ) : (
                  <>
                    <p className="text-lg">{t('chat.noSession', '还没有会话')}</p>
                    <p className="text-sm mb-5">{t('chat.noSessionHint', '创建一个新会话开始对话，或直接在下方输入第一条消息。')}</p>
                    <Button onClick={handleNewSession} variant="secondary">
                      <Plus size={14} className="mr-1.5" />
                      {t('chat.newSession', 'New Session')}
                    </Button>
                  </>
                )}
              </div>
            )}
            {messages.map((m, idx) => {
              const prevMsg = idx > 0 ? messages[idx - 1] : undefined;
              const isLastAssistant = m.role === 'assistant' && idx === messages.length - 1 && !m.isStreaming;
              const isFailed = m.failed || (m.role === 'assistant' && !m.isStreaming && (m.text || '').startsWith('Error:'));
              return (
                <div key={m.id}>
                  {needsDaySeparator(prevMsg, m) && (
                    <div className="my-4 flex items-center justify-center">
                      <span className="rounded-full border border-border bg-surface-elevated px-3 py-0.5 text-xs text-text-tertiary">
                        {m.createdAt ? formatDay(m.createdAt) : ''}
                      </span>
                    </div>
                  )}
                  {needsTimeGroupSeparator(prevMsg, m) && !needsDaySeparator(prevMsg, m) && (
                    <div className="my-3 flex items-center gap-3">
                      <span className="h-px flex-1 bg-border/60" />
                      <span className="text-xs text-text-tertiary">{m.createdAt ? formatTime(m.createdAt) : ''}</span>
                      <span className="h-px flex-1 bg-border/60" />
                    </div>
                  )}
                  {m._compactionStream && (
                    <div className="my-3 flex items-center gap-3" aria-label={t('chat.compactionDivider', '压缩历史记录')}>
                      <span className="h-px flex-1 bg-border/60" />
                      <span className="text-xs text-text-tertiary">{t('chat.compactionDivider', '— 压缩历史记录 —')}</span>
                      <span className="h-px flex-1 bg-border/60" />
                    </div>
                  )}
                  <div className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} group`}>
                    <div
                      className={`relative max-w-[85%] rounded-md px-4 py-3 text-sm leading-relaxed ${
                        m.role === 'user'
                          ? 'bg-accent text-white'
                          : m._compactionStream
                            ? 'border border-border/50 bg-surface-elevated/60 text-xs text-text-tertiary'
                            : 'border border-border bg-surface-elevated text-text-primary shadow-sm'
                      }`}
                    >
                      {m.createdAt && (
                        <span className="pointer-events-none absolute -top-1.5 right-2 text-[10px] text-text-tertiary/70">
                          {formatTime(m.createdAt)}
                        </span>
                      )}
                      {!m.isStreaming && (
                    <button
                      onClick={() => handleCopy(m.id, m.text || '')}
                      className={`absolute -top-2 -right-2 rounded-full border border-border p-1 shadow-sm opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 ${
                        m.role === 'user'
                          ? 'bg-accent text-white'
                          : 'bg-surface text-text-secondary hover:text-text-primary'
                      }`}
                      title={t('common.copy', 'Copy')}
                      aria-label={t('common.copy', 'Copy')}
                    >
                      {copiedId === m.id ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  )}
                  {m.reasoning && (
                    <details className="mb-2" open>
                      <summary className="cursor-pointer text-xs text-text-tertiary">{t('chat.reasoning')}</summary>
                      <div className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-xs leading-relaxed text-text-secondary">
                        {m.reasoning.slice(0, 30000)}
                        {m.reasoning.length > 30000 ? '…' : ''}
                      </div>
                    </details>
                  )}
                  {m.toolCalls && m.toolCalls.length > 0 && <ToolCalls calls={m.toolCalls} />}
                  {m.chart && (
                    <img
                      src={m.chart.url}
                      alt="chart"
                      className="mt-2 max-h-72 rounded-lg border border-border"
                    />
                  )}
                  <StreamingLlmContent content={m.text || ''} isStreaming={m.isStreaming} className={m.role === 'user' ? 'prose-invert' : undefined} />
                  {m.citations && m.citations.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label={t('chat.citations', '引用')}>
                      {m.citations.map((c, i) => {
                        const isUrl = /^https?:\/\//i.test(c.source || '');
                        return (
                          <a
                            key={i}
                            href={isUrl ? c.source : undefined}
                            target={isUrl ? '_blank' : undefined}
                            rel={isUrl ? 'noreferrer' : undefined}
                            title={c.text}
                            className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-0.5 text-[11px] text-text-tertiary transition-colors hover:border-accent/50 hover:text-accent"
                          >
                            <Quote size={10} className="shrink-0" />
                            <span className="truncate">{c.text}</span>
                          </a>
                        );
                      })}
                    </div>
                  )}
                  {m.download && (
                    <div className="mt-3 rounded-lg border border-border bg-surface p-3">
                      <div className="flex items-center gap-2 text-sm text-text-primary">
                        <FileText size={16} className="text-text-tertiary shrink-0" />
                        <span className="truncate">{m.download.fileName}</span>
                        <span className="text-xs text-text-tertiary shrink-0">{m.download.mimeType}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <Button
                          size="sm"
                          isLoading={downloadLoading[m.download.fileId]}
                          onClick={() => handleDownloadClick(m)}
                        >
                          <Download size={14} className="mr-1" />
                          {t('common.download', 'Download')}
                        </Button>
                        {m.knowledgePayload && !kbAdded[m.id] && (
                          <>
                            <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer select-none">
                              <input
                                type="checkbox"
                                className="rounded border-border"
                                checked={kbChecked[m.id] || false}
                                onChange={(e) => setKbChecked(prev => ({ ...prev, [m.id]: e.target.checked }))}
                              />
                              Add to knowledge base
                            </label>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={!kbChecked[m.id]}
                              onClick={() => handleAddToKnowledge(m)}
                            >
                              确认
                            </Button>
                          </>
                        )}
                        {kbAdded[m.id] && (
                          <span className="flex items-center gap-1 text-xs text-success">
                            <Check size={12} />
                            已加入知识库
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {m.isStreaming ? <StatusDot tone="active" pulse title={t('chat.streaming')} className="ml-1" /> : null}
                  {isLastAssistant && !isFailed && (
                    <button
                      onClick={handleRegenerate}
                      className="absolute -bottom-2.5 left-2 flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-tertiary opacity-0 shadow-sm transition-opacity hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
                      title={t('chat.regenerate', '重新生成')}
                      aria-label={t('chat.regenerate', '重新生成')}
                    >
                      <RefreshCw size={11} />
                      {t('chat.regenerate', '重新生成')}
                    </button>
                  )}
                  {isLastAssistant && isFailed && (
                    <button
                      onClick={handleRetry}
                      className="absolute -bottom-2.5 left-2 flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-tertiary opacity-0 shadow-sm transition-opacity hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
                      title={t('chat.retry', '重试')}
                      aria-label={t('chat.retry', '重试')}
                    >
                      <RotateCcw size={11} />
                      {t('chat.retry', '重试')}
                    </button>
                  )}
                </div>
                </div>
                </div>
              );
            })}
            {session?.subagents && session.subagents.length > 0 && (
              <div className="space-y-1.5 px-4 pt-2">
                {session.subagents.map((sa, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-text-secondary">
                    <StatusDot
                      tone={sa.status === 'done' ? 'success' : sa.status === 'failed' ? 'error' : 'active'}
                      pulse={sa.status === 'running'}
                    />
                    <span className={sa.status === 'failed' ? 'text-error' : undefined}>
                      {sa.status === 'running' ? t('chat.subagentRunning', '正在分析') : sa.status === 'done' ? '✓' : '✗'}{' '}
                      {sa.task}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </main>

        {error && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        <footer className="border-t border-border bg-surface px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {/* #298: offer to capture a reusable procedure as a skill */}
            {session?.skillCapture && messages.length > 1 && (
              <SkillCapturePrompt
                conversation={messages.slice(-4).map((m) => `${m.role === 'user' ? '医生' : 'AI'}: ${m.text}`).join('\n')}
                sessionId={sessionId}
                onDone={() => {
                  useChatStore.setState((st) => {
                    const s = st.sessions[sessionId];
                    if (!s) return st;
                    return { sessions: { ...st.sessions, [sessionId]: { ...s, skillCapture: undefined } } };
                  });
                }}
              />
            )}
            {(session?.compacting || session?.contextUsage) && (
              <div className="flex items-center justify-between gap-2">
                {session?.compacting && (
                  <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-text-secondary">
                    <span className="animate-pulse">🧠</span>
                    {t('chat.compacting', '正在压缩会话历史，请稍候…')}
                  </div>
                )}
                <div className="ml-auto">
                  <ContextUsageIndicator usage={session?.contextUsage} />
                </div>
              </div>
            )}
            <SkillsBar active={activeSkills} onToggle={toggleSkill} />
            {attachedFiles.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {attachedFiles.map((f) => (
                  <span key={f.fileId} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary">
                    <FileText size={12} className="shrink-0" />
                    <span className="max-w-[180px] truncate">{f.name}</span>
                    <button
                      onClick={() => setAttachedFiles((prev) => prev.filter((a) => a.fileId !== f.fileId))}
                      className="rounded p-0.5 text-text-tertiary transition-colors hover:bg-surface hover:text-error"
                      aria-label={t('chat.removeAttachment', 'Remove attachment')}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {deepOpen && (
              <div className="rounded-xl border border-border bg-surface-elevated p-4 shadow-lg">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-text-secondary">{t('chat.deepAnalysis', '深度分析')}</span>
                  <button onClick={() => setDeepOpen(false)} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
                </div>
                <textarea
                  value={deepQuestion}
                  onChange={(e) => setDeepQuestion(e.target.value)}
                  rows={2}
                  placeholder={t('chat.deepQuestion', '分析问题（默认用最近一次提问）')}
                  className="mb-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {(['literature', 'stats', 'clinical'] as const).map((topic) => (
                    <button
                      key={topic}
                      onClick={() => setDeepTopics((prev) => (prev.includes(topic) ? prev.filter((t2) => t2 !== topic) : [...prev, topic]))}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                        deepTopics.includes(topic) ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text-secondary',
                      )}
                    >
                      {t(`chat.deepTopic_${topic}`, topic)}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setDeepOpen(false)}>{t('common.cancel', '取消')}</Button>
                  <Button size="sm" onClick={handleDeepAnalysis} isLoading={deepBusy} disabled={deepTopics.length === 0}>
                    {t('chat.deepRun', '并行分析')}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFile}
                className="hidden"
                disabled={uploadingFile}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setDeepOpen(true); setDeepQuestion(''); }}
                disabled={session?.loading || uploadingFile || !sessionId}
                className="shrink-0"
                title={t('chat.deepAnalysis', '深度分析（并行子任务）')}
              >
                <Radar size={14} className="mr-1" /> {t('chat.deepAnalysisShort', '深度分析')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={session?.loading || uploadingFile}
                isLoading={uploadingFile}
                className="shrink-0"
              >
                <Paperclip size={16} />
              </Button>
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={!sessionId
                  ? t('chat.needSession', '请先新建一个会话')
                  : (currentSessionTitle ? `${t('chat.placeholder')} — ${currentSessionTitle}` : t('chat.placeholder'))}
                disabled={session?.loading || !sessionId || false}
                rows={1}
                className="min-h-0 flex-1 resize-none py-3"
                style={{ maxHeight: '160px' }}
              />
              <PluginExtensionPoint
                point="chat_toolbar"
                context={{ sessionId }}
                layout="row"
                fallback={null}
              />
              {session?.loading ? (
                <Button onClick={handleStop} variant="secondary">
                  {t('common.stop')}
                </Button>
              ) : !sessionId ? (
                <Button onClick={handleNewSession}>
                  <Plus size={14} className="mr-1" />
                  {t('chat.newSession', 'New Session')}
                </Button>
              ) : (
                <Button onClick={handleSend} disabled={!input.trim() || !!session?.compacting}>
                  {session?.compacting ? t('chat.compactingShort', '压缩中…') : t('common.send')}
                </Button>
              )}
            </div>
          </div>
        </footer>
      </div>
      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        onCreated={handleSessionCreated}
      />
      {confirmCloseOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-lg">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-text-primary">{t('chat.confirmCloseTitle', '关闭会话')}</h2>
            </div>
            <p className="mb-4 text-sm text-text-secondary">
              {t('chat.confirmCloseBody', '关闭「{{title}}」后，该会话的聊天记录将被清除且无法恢复。确定关闭吗？', { title: currentSessionTitle || '?' })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmCloseOpen(false)}>
                {t('common.cancel', '取消')}
              </Button>
              <Button variant="danger" onClick={confirmCloseSession}>
                {t('chat.closeSession', 'Close')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}


