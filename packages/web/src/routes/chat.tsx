import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Paperclip, Copy, Check, Download, FileText, Plus, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
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
import { Alert, Button, Textarea } from '@/components/ui';


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
  const { isAuthenticated, clearSession, userId } = useAuthStore();
  const store = useChatStore();
  const defaultSessionId = `global-${userId || 'anonymous'}`;
  const [sessionId, setSessionId] = useState<string>(defaultSessionId);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const session = store.sessions[sessionId];
  const [globalSessions, setGlobalSessions] = useState<ChatSessionItem[]>([]);
  const [defaultClosed, setDefaultClosed] = useState(false);
  const currentSessionTitle =
    sessionId === defaultSessionId
      ? t('chat.defaultSession', '默认会话')
      : (globalSessions.find((s) => s.id === sessionId)?.title ?? t('chat.defaultSession', '默认会话'));

  const [input, setInput] = useState('');
  // Per-session drafts: switching sessions must never leak half-typed text
  // into another conversation.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<Array<{name: string; fileId: string}>>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
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
      .then((r) => setGlobalSessions(r.sessions.map((s) => ({ id: s.id, title: s.title, status: s.status, created_at: s.created_at, message_count: s.message_count }))))
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

  const createSessionWithTitle = async (title: string) => {
    const res = await api.createSession(title, { scope: 'global' });
    insertSession(res);
    return res;
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
      if (closingId === defaultSessionId) setDefaultClosed(true);
      setGlobalSessions((prev) => prev.filter((s) => s.id !== closingId));
      store.clearSession(closingId);
      setDrafts((prev) => { const next = { ...prev }; delete next[closingId]; return next; });
      // Pick the next open session; if none remains, start a fresh one so
      // the chat stays usable (all sessions can be closed).
      const next = globalSessions.find((s) => s.id !== closingId && s.status === 'open');
      if (next) {
        setSessionId(next.id);
      } else {
        await createSessionWithTitle(t('chat.newSession', 'New Session'));
      }
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

  useEffect(() => {
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
  }, [sessionId, store]);

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

  const messages = session?.messages || [];

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <div className="flex items-center gap-3">
            <h1 className="font-semibold text-text-primary">{t('chat.title')}</h1>
              <select
              value={sessionId}
              onChange={(e) => {
                // Save the draft of the session we are leaving, restore the
                // draft of the one we enter.
                setDrafts((prev) => ({ ...prev, [sessionId]: input }));
                setInput(drafts[e.target.value] ?? '');
                setSessionId(e.target.value);
              }}
              className="h-8 max-w-[220px] rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('chat.selectSession', 'Session')}
            >
              {(defaultClosed ? [] : [{ id: defaultSessionId, title: t('chat.defaultSession', '默认会话'), status: 'open' as const }] as ChatSessionItem[])
                .concat(globalSessions.filter((s) => s.status !== 'closed'))
                .map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
            </select>
            <button
              onClick={handleNewSession}
              className="rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary hover:bg-surface"
              title={t('chat.newSession', 'New Session')}
            >
              <Plus size={13} className="mr-1 inline" />
              {t('chat.newSession', 'New Session')}
            </button>            <button
              onClick={handleCloseSession}
              className="rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary hover:bg-error/10 hover:text-error"
              title={t('chat.closeSession', 'Close Session')}
            >
              {t('chat.closeSession', 'Close')}
            </button>
            {llmStatus && (
              <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary border border-border">
                {llmStatus.provider}/{llmStatus.model}
              </span>
            )}
            {llmStatus && (
              <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary border border-border">
                {llmStatus.provider}/{llmStatus.model}
              </span>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.length === 0 && (
              <div className="py-20 text-center text-text-tertiary">
                <p className="text-lg">{t('chat.startConversation')}</p>
                <p className="text-sm">{t('chat.contextHint')}</p>
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`group relative max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-accent text-white'
                      : 'border border-border bg-surface-elevated text-text-primary shadow-sm'
                  }`}
                >
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
                  <StreamingLlmContent content={m.text || ''} isStreaming={m.isStreaming} className={m.role === 'user' ? 'prose-invert' : undefined} />
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
                  {m.isStreaming ? <span className="animate-pulse" role="status" aria-label={t('chat.streaming')}>●</span> : null}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </main>

        {error && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        <footer className="border-t border-border bg-surface px-4 py-4">
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
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
                placeholder={`${t('chat.placeholder')} — ${currentSessionTitle}`}
                disabled={session?.loading || false}
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
              {t('chat.confirmCloseBody', '关闭「{title}」后，该会话的聊天记录将被清除且无法恢复。确定关闭吗？', { title: currentSessionTitle })}
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


