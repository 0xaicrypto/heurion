import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Paperclip, Copy, Check, Download, FileText } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import type { LlmStatus } from '@/lib/types';
import { useAuthStore } from '@/stores/auth';
import { useChatStore, type ChatMessage } from '@/stores/chat';
import { AppShell } from '@/components/layout/AppShell';
import { SkillsBar } from '@/components/SkillsBar';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { PluginExtensionPoint } from '@/components/plugins/PluginExtensionPoint';
import { Alert, Button, Badge, Textarea } from '@/components/ui';

export function ChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated, clearSession, userId } = useAuthStore();
  const store = useChatStore();
  const sessionId = `global-${userId || 'anonymous'}`;
  const session = store.sessions[sessionId];

  const [input, setInput] = useState('');
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
          m.metadata?.sidecar && (m.metadata?.file as any)
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
    if (!input.trim() || session?.loading) return;
    const text = input.trim();
    setInput('');
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
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
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
                  <MarkdownRenderer content={m.text || ''} />
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
                              加入知识库
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
            <SkillsBar active={activeSkills} onToggle={toggleSkill} />
            {attachedFiles.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {attachedFiles.map((f) => (
                  <Badge key={f.fileId} variant="default">{f.name}</Badge>
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
                placeholder={t('chat.placeholder')}
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
                <Button onClick={handleSend} disabled={!input.trim()}>
                  {t('common.send')}
                </Button>
              )}
            </div>
          </div>
        </footer>
      </div>
    </AppShell>
  );
}


