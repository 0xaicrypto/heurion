import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Wand2 } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Textarea } from '@/components/ui';
import { ChatMessages } from '@/components/chat/ChatMessages';
import { useChatStore } from '@/stores/chat';
import { api } from '@/lib/api';
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
          <span className="hidden text-xs text-text-tertiary sm:inline">
            {t('charts.hint', '用自然语言生成图表 / 信号通路图 / 统计检验')}
          </span>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-6">
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
