import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, Download, FileText, Puzzle, Quote, RefreshCw, RotateCcw } from 'lucide-react';
import type { ChatMessage } from '@/stores/chat';
import { StreamingLlmContent } from '@/components/LlmContent';
import { ToolCalls } from '@/components/ToolCalls';
import { StatusDot } from '@/components/ui/StatusDot';
import { Alert, Button } from '@/components/ui';

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

export interface ChatMessagesProps {
  messages: ChatMessage[];
  /** Compact mode: no day/time separators, no copy / regenerate / retry /
   *  download / knowledge-base affordances (patient & doc chats). */
  variant?: 'full' | 'compact';
  onCopy?: (id: string, text: string) => void;
  onDownloadClick?: (m: ChatMessage) => void;
  onAddToKnowledge?: (m: ChatMessage) => void;
  onRegenerate?: () => void;
  onRetry?: () => void;
  onKbCheckedChange?: (id: string, checked: boolean) => void;
  copiedId?: string | null;
  downloadLoading?: Record<string, boolean>;
  kbChecked?: Record<string, boolean>;
  kbAdded?: Record<string, boolean>;
  emptyState?: React.ReactNode;
  subagents?: Array<{ task: string; status: 'running' | 'done' | 'failed' }>;
  bottomRef?: RefObject<HTMLDivElement>;
}

/**
 * #456 — the ONE chat message list. chat.tsx / PatientChatPage /
 * writing-editor doc-chat all render through this component; the per-page
 * differences are reduced to props (full vs compact variant).
 */
export function ChatMessages({
  messages,
  variant = 'full',
  onCopy,
  onDownloadClick,
  onAddToKnowledge,
  onRegenerate,
  onRetry,
  onKbCheckedChange,
  copiedId,
  downloadLoading,
  kbChecked,
  kbAdded,
  emptyState,
  subagents,
  bottomRef,
}: ChatMessagesProps) {
  const { t } = useTranslation();
  const compact = variant === 'compact';

  if (messages.length === 0 && emptyState) return <>{emptyState}</>;

  return (
    <div className="space-y-4">
      {messages.map((m, idx) => {
        const prevMsg = idx > 0 ? messages[idx - 1] : undefined;
        const isLastAssistant = m.role === 'assistant' && idx === messages.length - 1 && !m.isStreaming;
        const isFailed = m.failed || (m.role === 'assistant' && !m.isStreaming && (m.text || '').startsWith('Error:'));
        return (
          <div key={m.id}>
            {!compact && needsDaySeparator(prevMsg, m) && (
              <div className="my-4 flex items-center justify-center">
                <span className="rounded-full border border-border bg-surface-elevated px-3 py-0.5 text-xs text-text-tertiary">
                  {m.createdAt ? formatDay(m.createdAt) : ''}
                </span>
              </div>
            )}
            {!compact && needsTimeGroupSeparator(prevMsg, m) && !needsDaySeparator(prevMsg, m) && (
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
                {!compact && m.createdAt && (
                  <span className="pointer-events-none absolute -top-1.5 right-2 text-[10px] text-text-tertiary/70">
                    {formatTime(m.createdAt)}
                  </span>
                )}
                {!compact && !m.isStreaming && onCopy && (
                  <button
                    onClick={() => onCopy(m.id, m.text || '')}
                    className={`absolute -top-2 -right-2 rounded-full border border-border p-1 shadow-sm opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 ${
                      m.role === 'user' ? 'bg-accent text-white' : 'bg-surface text-text-secondary hover:text-text-primary'
                    }`}
                    title={t('common.copy', 'Copy')}
                    aria-label={t('common.copy', 'Copy')}
                  >
                    {copiedId === m.id ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                )}
                {m.tier && <div className="mb-1 text-xs opacity-70">Tier: {m.tier}</div>}
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
                {m.pluginCalls && m.pluginCalls.length > 0 && (
                  <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label={t('chat.pluginCalls', '插件调用')}>
                    {m.pluginCalls.map((pc, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-[11px] text-text-secondary"
                        title={`${pc.pluginId}.${pc.tool} — ${pc.intent} (${Math.round(pc.confidence * 100)}%)`}
                      >
                        <Puzzle size={10} className="shrink-0" />
                        <span className="truncate max-w-[160px]">{pc.pluginId}.{pc.tool}</span>
                      </span>
                    ))}
                  </div>
                )}
                {m.chart && (
                  <img src={m.chart.url} alt="chart" className="mt-2 max-h-72 rounded-lg border border-border" />
                )}
                <StreamingLlmContent content={m.text || ''} isStreaming={m.isStreaming} className={m.role === 'user' ? 'prose-invert' : undefined} />
                {m.reasoning && !m.text && m.isStreaming && (
                  <div className="mt-1 text-xs text-text-tertiary">{t('chat.thinking', '思考中…')}</div>
                )}
                {m.truncated && (
                  <div className="mt-2 flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs text-warning">
                    <AlertTriangle size={12} className="shrink-0" />
                    <span>{t('chat.truncated', '回答因输出长度限制被截断，请重试或简化问题')}</span>
                  </div>
                )}
                {m.imageUrl && (
                  <img
                    src={m.imageUrl}
                    alt="generated"
                    className="mt-3 max-h-80 rounded-xl border border-border"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                {m.memoryHits && m.memoryHits.length > 0 && (
                  <details className="mt-3 rounded-lg border border-border bg-surface px-3 py-2">
                    <summary className="cursor-pointer text-xs text-text-tertiary hover:text-text-secondary">
                      🔍 {t('chat.memoryHits', '已检索患者记忆')}（{m.memoryHits.length} {t('chat.memoryHitCount', '条命中')}）
                    </summary>
                    <ul className="mt-2 space-y-1.5">
                      {m.memoryHits.map((hit, i) => (
                        <li key={i} className="text-xs text-text-secondary">
                          <span className="mr-1 rounded border border-border px-1 text-[10px] text-text-tertiary">{hit.type}</span>
                          {hit.content}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
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
                {!compact && m.download && onDownloadClick && (
                  <div className="mt-3 rounded-lg border border-border bg-surface p-3">
                    <div className="flex items-center gap-2 text-sm text-text-primary">
                      <FileText size={16} className="text-text-tertiary shrink-0" />
                      <span className="truncate">{m.download.fileName}</span>
                      <span className="text-xs text-text-tertiary shrink-0">{m.download.mimeType}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <Button
                        size="sm"
                        isLoading={downloadLoading?.[m.download.fileId]}
                        onClick={() => onDownloadClick(m)}
                      >
                        <Download size={14} className="mr-1" />
                        {t('common.download', 'Download')}
                      </Button>
                      {m.knowledgePayload && !kbAdded?.[m.id] && onKbCheckedChange && onAddToKnowledge && (
                        <>
                          <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer select-none">
                            <input
                              type="checkbox"
                              className="rounded border-border"
                              checked={kbChecked?.[m.id] || false}
                              onChange={(e) => onKbCheckedChange(m.id, e.target.checked)}
                            />
                            {t('chat.addToKnowledge', 'Add to knowledge base')}
                          </label>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!kbChecked?.[m.id]}
                            onClick={() => onAddToKnowledge(m)}
                          >
                            {t('common.confirm', '确认')}
                          </Button>
                        </>
                      )}
                      {kbAdded?.[m.id] && (
                        <span className="flex items-center gap-1 text-xs text-success">
                          <Check size={12} />
                          {t('chat.addedToKnowledge', '已加入知识库')}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {m.isStreaming ? <StatusDot tone="active" pulse title={t('chat.streaming')} className="ml-1" /> : null}
                {!compact && isLastAssistant && !isFailed && onRegenerate && (
                  <button
                    onClick={onRegenerate}
                    className="absolute -bottom-2.5 left-2 flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-tertiary opacity-0 shadow-sm transition-opacity hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
                    title={t('chat.regenerate', '重新生成')}
                    aria-label={t('chat.regenerate', '重新生成')}
                  >
                    <RefreshCw size={11} />
                    {t('chat.regenerate', '重新生成')}
                  </button>
                )}
                {!compact && isLastAssistant && isFailed && onRetry && (
                  <button
                    onClick={onRetry}
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
      {subagents && subagents.length > 0 && (
        <div className="space-y-1.5 px-4 pt-2">
          {subagents.map((sa, i) => (
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
      {messages.length > 0 && bottomRef && <div ref={bottomRef} />}
    </div>
  );
}

export function ChatErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <Alert variant="error">{error}</Alert>
    </div>
  );
}
