import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Wand2, Copy, Check, Trash2, RotateCcw } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Badge, Button, Card, Skeleton, Textarea } from '@/components/ui';
import { ChatMessages } from '@/components/chat/ChatMessages';
import { useChatStore } from '@/stores/chat';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { mapWireMessages } from '@/lib/message-map';

/**
 * #402 — Chart Workbench: a focused surface for AI chart / schematic /
 * statistics generation. Reuses the chat pipeline (sendChatFull) and the
 * shared ChatMessages renderer, with a fixed workbench session.
 *
 * Requires the heurion/chart + heurion/bioscene plugins for render_chart /
 * render_scene (plugin-gated tools).
 */
export function ChartWorkbenchPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<'chat' | 'library'>('chat');
  const sessionId = 'chart-workbench';
  const session = useChatStore((s) => s.sessions[sessionId]);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopStream = useChatStore((s) => s.stopStream);
  const setMessages = useChatStore((s) => s.setMessages);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const messages = session?.messages || [];

  useEffect(() => {
    // Non-reactive read: session changes must not re-run this loader.
    const existing = useChatStore.getState().sessions[sessionId]?.messages?.length;
    if (existing) return;
    api.getMessages(sessionId, 50).then((r) => {
      const msgs = mapWireMessages(r.messages);
      if (msgs.length > 0) setMessages(sessionId, msgs);
    }).catch(() => {});
  }, [sessionId, setMessages]);

  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const nearBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight < 300;
    if (nearBottom) el.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages]);

  const handleSend = async () => {
    if (!input.trim() || session?.loading || session?.compacting) return;
    const text = input.trim();
    setInput('');
    setError(null);
    try {
      await sendMessage(sessionId, { text, sessionId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const examples = [
    { icon: '📊', zh: '画一张柱状图对比两组治疗有效率', en: 'Bar chart comparing response rates' },
    { icon: '🧬', zh: '画一下 EGFR 信号通路图', en: 'EGFR signaling pathway diagram' },
    { icon: '💊', zh: '示意 TKI 耐药机制', en: 'TKI resistance mechanism schematic' },
    { icon: '📈', zh: '对这两组数据做 t 检验', en: 'Run a t-test on these two groups' },
  ];

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-6">
          <BarChart3 size={18} className="text-accent" />
          <h1 className="font-semibold text-text-primary">{t('charts.title', '图表工作台')}</h1>
          <div className="ml-4 flex gap-1">
            <button
              onClick={() => setView('chat')}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', view === 'chat' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary')}
            >{t('charts.generate', '生成图表')}</button>
            <button
              onClick={() => setView('library')}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', view === 'library' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary')}
            >{t('charts.library', '我的图库')}</button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-6">
          {view === 'library' ? (
            <ChartLibrary />
          ) : (
          <div className="mx-auto max-w-3xl">
            {messages.length === 0 && (
              <div className="mb-6 rounded-xl border border-border bg-surface-elevated p-5">
                <h2 className="text-sm font-semibold text-text-primary">{t('charts.examples', '试试这样说')}</h2>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {examples.map((ex, i) => (
                    <button
                      key={i}
                      onClick={() => { setInput(ex.zh); }}
                      className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:border-accent/50 hover:text-text-primary"
                    >
                      <span>{ex.icon}</span>
                      <span className="truncate">{ex.zh}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-4 text-xs text-text-tertiary leading-relaxed">
                  {t('charts.pluginHint', '提示：图表与示意图由 render_chart / render_scene 工具生成，需在插件市场安装 heurion/chart 与 heurion/bioscene 插件。标准通路图（EGFR、PD-1/PD-L1 等）走 Reactome 官方整图。')}
                </p>
              </div>
            )}
            <ChatMessages
              variant="compact"
              messages={messages}
              bottomRef={bottomRef}
              emptyState={null}
            />
          </div>
          )}
        </main>

        {error && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <span className="text-xs text-error">{error}</span>
          </div>
        )}

        <footer className="border-t border-border bg-surface px-4 py-4">
          <div className="mx-auto flex max-w-3xl gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('charts.placeholder', '描述你想画的图，例如：画一张 EGFR 信号通路图…')}
              disabled={session?.loading}
              rows={1}
              className="min-h-0 flex-1 resize-none py-3"
              style={{ maxHeight: '160px' }}
            />
            {session?.loading ? (
              <Button onClick={() => stopStream(sessionId)} variant="secondary" className="shrink-0">{t('common.stop', '停止')}</Button>
            ) : (
              <Button onClick={handleSend} disabled={!input.trim() || !!session?.compacting} className="shrink-0">
                <Wand2 size={14} className="mr-1" />
                {t('common.send', '生成')}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </AppShell>
  );
}

/* #402-followup: my generated charts — Reactome originals + custom
 * bioscene / render_chart outputs, with copy-markdown and delete. */
interface LibraryEntry {
  file_id: string; url: string; title: string; tool: string;
  mode: 'reactome' | 'bioscene' | 'chart' | 'unknown';
  size_bytes: number; created_at: string; pathway_id?: string;
}

function ChartLibrary() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.listGeneratedCharts()
      .then(r => setEntries(r.charts as unknown as LibraryEntry[]))
      .catch(err => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const copyMarkdown = async (e: LibraryEntry) => {
    try {
      await navigator.clipboard.writeText(`![${e.title}](${e.url})`);
      setCopiedId(e.file_id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch { /* ignore */ }
  };

  const handleDelete = async (e: LibraryEntry) => {
    setDeleting(e.file_id);
    try {
      await api.deleteGeneratedChart(e.file_id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setDeleting(null);
    }
  };

  const modeLabel = (m: LibraryEntry['mode']) => m === 'reactome' ? 'Reactome' : m === 'chart' ? 'Chart' : m === 'bioscene' ? 'BioScene' : '—';

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-text-primary">{t('charts.library', '我的图库')}</h2>
          <p className="text-sm text-text-tertiary">{t('charts.libraryHint', 'AI 生成过的全部图表（Reactome 官方通路图 + 自定义示意图 + 统计图），可复制 markdown 或删除。')}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={load}><RotateCcw size={14} className="mr-1" /> {t('common.refresh', '刷新')}</Button>
      </div>

      {error && <div className="mb-4"><Alert variant="error">{error}</Alert></div>}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-48 rounded-xl" /><Skeleton className="h-48 rounded-xl" /><Skeleton className="h-48 rounded-xl" />
        </div>
      ) : entries.length === 0 ? (
        <Card className="p-10 text-center text-text-tertiary">
          <BarChart3 size={32} className="mx-auto mb-3" />
          <p className="text-sm">{t('charts.libraryEmpty', '还没有生成过图表。切换到「生成图表」，用一句话让 AI 画图吧。')}</p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((e) => (
            <Card key={e.file_id} className="flex flex-col overflow-hidden p-0">
              <div className="flex h-40 items-center justify-center overflow-hidden bg-white p-2">
                <img src={e.url} alt={e.title} className="max-h-full max-w-full object-contain" />
              </div>
              <div className="flex-1 p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="truncate text-sm font-medium text-text-primary" title={e.title}>{e.title}</h3>
                  <Badge variant={e.mode === 'reactome' ? 'success' : 'default'} className="shrink-0 text-[10px]">{modeLabel(e.mode)}</Badge>
                </div>
                <p className="mt-1 text-[11px] text-text-tertiary">
                  {new Date(e.created_at).toLocaleString()} · {(e.size_bytes / 1024).toFixed(0)}KB
                </p>
              </div>
              <div className="flex gap-2 border-t border-border p-2">
                <Button size="sm" variant="secondary" className="flex-1" onClick={() => copyMarkdown(e)}>
                  {copiedId === e.file_id ? <Check size={14} className="mr-1" /> : <Copy size={14} className="mr-1" />}
                  {copiedId === e.file_id ? t('common.copied', '已复制') : t('common.copyMd', '复制 Markdown')}
                </Button>
                <Button size="sm" variant="ghost" className="shrink-0 text-error" onClick={() => handleDelete(e)} isLoading={deleting === e.file_id}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
