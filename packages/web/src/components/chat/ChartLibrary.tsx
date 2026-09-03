import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Copy, Check, Trash2, RotateCcw, FilePlus2, Code2 } from 'lucide-react';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

export interface LibraryEntry {
  file_id: string; url: string; title: string; tool: string;
  mode: 'reactome' | 'bioscene' | 'chart' | 'figure' | 'unknown';
  size_bytes: number; created_at: string; pathway_id?: string;
}

interface FigureSource {
  kind: 'mermaid' | 'latex_math';
  source: string;
  options: Record<string, unknown>;
  rendered_ms?: number | null;
}

/**
 * #402 — Generated-chart library (Reactome originals + custom bioscene /
 * render_chart outputs): thumbnails, copy-markdown, insert-into-document
 * and delete. Shared by the writing workbench panel.
 */
export function ChartLibrary({ onInsert }: { onInsert?: (markdown: string, title: string) => void }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [sourceView, setSourceView] = useState<{ fileId: string; data: FigureSource } | null>(null);
  const [rerendering, setRerendering] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.listGeneratedCharts()
      .then(r => setEntries(r.charts))
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

  const modeLabel = (m: LibraryEntry['mode']) => m === 'reactome' ? 'Reactome' : m === 'chart' ? 'Chart' : m === 'bioscene' ? 'BioScene' : m === 'figure' ? '学术图' : '—';

  /** #822: 源码查看/重渲染 — fig_ 产物经 FigureRender 溯源。 */
  const toggleSource = async (e: LibraryEntry) => {
    if (sourceView?.fileId === e.file_id) { setSourceView(null); return; }
    try {
      const data = await api.getFigureSource(e.file_id);
      setSourceView({ fileId: e.file_id, data });
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  const handleRerender = async (e: LibraryEntry) => {
    setRerendering(e.file_id);
    try {
      await api.rerenderFigure(e.file_id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setRerendering(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium text-text-primary">{t('charts.library', '我的图库')}</span>
        <Button size="sm" variant="ghost" onClick={load}><RotateCcw size={14} className="mr-1" /> {t('common.refresh', '刷新')}</Button>
      </div>

      {error && <div className="px-3 pt-2"><Alert variant="error">{error}</Alert></div>}

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="space-y-2"><Skeleton className="h-40 w-full rounded-xl" /><Skeleton className="h-40 w-full rounded-xl" /></div>
        ) : entries.length === 0 ? (
          <div className="py-10 text-center text-text-tertiary">
            <BarChart3 size={28} className="mx-auto mb-2" />
            <p className="text-xs">{t('charts.libraryEmpty', '还没有生成过图表。在聊天里让 AI 画图，这里会自动收录。')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((e) => (
              <Card key={e.file_id} className="overflow-hidden p-0">
                <div className="flex h-32 items-center justify-center overflow-hidden bg-white p-2">
                  <img src={e.url} alt={e.title} className="max-h-full max-w-full object-contain" />
                </div>
                <div className="p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="truncate text-xs font-medium text-text-primary" title={e.title}>{e.title}</h3>
                    <Badge variant={e.mode === 'reactome' ? 'success' : 'default'} className="shrink-0 text-[10px]">{modeLabel(e.mode)}</Badge>
                  </div>
                  <p className="mt-0.5 text-[10px] text-text-tertiary">{new Date(e.created_at).toLocaleString()}</p>
                </div>
                {/* #822: fig_ 产物源码查看(渲染源码 + 参数溯源)。 */}
                {sourceView?.fileId === e.file_id && (
                  <div className="border-t border-border bg-surface px-3 py-2">
                    <p className="mb-1 text-[10px] text-text-tertiary">
                      {sourceView.data.kind === 'mermaid' ? 'Mermaid 源码' : `LaTeX(${sourceView.data.options?.display ? 'display' : 'inline'})`}
                      {sourceView.data.rendered_ms != null && ` · ${sourceView.data.rendered_ms}ms`}
                    </p>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px] text-text-primary">{sourceView.data.source}</pre>
                  </div>
                )}
                <div className="flex gap-1.5 border-t border-border p-2">
                  {e.mode === 'figure' && (
                    <>
                      <Button size="sm" variant="ghost" className="shrink-0" onClick={() => toggleSource(e)} title={t('charts.source', '查看源码')}>
                        <Code2 size={14} className={sourceView?.fileId === e.file_id ? 'text-accent' : ''} />
                      </Button>
                      <Button size="sm" variant="ghost" className="shrink-0" onClick={() => handleRerender(e)} isLoading={rerendering === e.file_id} title={t('charts.rerender', '重渲染')}>
                        <RotateCcw size={14} />
                      </Button>
                    </>
                  )}
                  {onInsert && (
                    <Button size="sm" variant="secondary" className="flex-1" onClick={() => onInsert(`![${e.title}](${e.url})`, e.title)}>
                      <FilePlus2 size={14} className="mr-1" />
                      {t('charts.insertDoc', '插入文档')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className={onInsert ? 'shrink-0' : 'flex-1'} onClick={() => copyMarkdown(e)}>
                    {copiedId === e.file_id ? <Check size={14} className="mr-1" /> : <Copy size={14} className="mr-1" />}
                    {copiedId === e.file_id ? t('common.copied', '已复制') : t('common.copyMd', '复制')}
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
    </div>
  );
}
