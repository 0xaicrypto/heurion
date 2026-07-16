import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Paperclip } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import type { ChatStreamChunk, LlmStatus } from '@/lib/types';
import { useAuthStore } from '@/stores/auth';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Button, Badge, Textarea } from '@/components/ui';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  isStreaming?: boolean;
}

export function ChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated, clearSession } = useAuthStore();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<Array<{name: string; fileId: string}>>([]);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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
    api.getMessages('', 50).then((r) => {
      const msgs: Message[] = r.messages.map((m) => ({
        id: crypto.randomUUID(),
        role: m.role,
        text: m.content,
      }));
      if (msgs.length > 0) setMessages(msgs);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const isNearBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight < 150;
    if (isNearBottom) el.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userText = input.trim();
    setInput('');
    setError(null);
    setTimeout(() => inputRef.current?.focus(), 50);

    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', text: userText };
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '',
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setLoading(true);

    abortRef.current = new AbortController();
    try {
      for await (const chunk of api.sendChatFull({ text: userText, sessionId: '', attachments: attachedFiles.map((a) => ({ name: a.name, file_id: a.fileId })) }, abortRef.current.signal)) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          const next = applyChunk(last, chunk);
          return [...prev.slice(0, -1), next];
        });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.messageText);
      } else if (err instanceof Error && err.name !== 'AbortError') {
        setError(err.message);
      }
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, isStreaming: false }];
        }
        return prev;
      });
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-accent text-white'
                      : 'border border-border bg-surface-elevated text-text-primary shadow-sm'
                  }`}
                >
                  {m.text || (m.isStreaming ? <span className="animate-pulse" role="status" aria-label={t('chat.streaming')}>●</span> : null)}
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
                disabled={loading || uploadingFile}
                isLoading={uploadingFile}
                className="shrink-0"
              >
                <Paperclip size={16} />
              </Button>
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('chat.placeholder')}
                disabled={loading}
                rows={1}
                className="min-h-0 flex-1 resize-none py-3"
                style={{ maxHeight: '160px' }}
              />
              {loading ? (
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

function applyChunk(message: Message, chunk: ChatStreamChunk): Message {
  switch (chunk.type) {
    case 'final_answer_chunk':
      return { ...message, text: message.text + chunk.text };
    case 'turn_complete':
      return { ...message, isStreaming: false };
    case 'error':
      return { ...message, text: message.text || `Error: ${chunk.message}`, isStreaming: false };
    default:
      return message;
  }
}
