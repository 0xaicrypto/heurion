import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { Button, Card, Skeleton, Badge, Input, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
// #922: 三处重复的状态→Badge variant 映射收敛到 lib/status-variant(gaps fallback='default' 同旧 else)。
import { statusVariant as libStatusVariant } from '@/lib/status-variant';
import { EmptyState } from '@/components/ui/EmptyState';
// #922: 弹窗外壳收敛到共享 Modal。
import { Modal } from '@/components/ui/Modal';
import { NextBestActions } from '@/components/NextBestActions';
import type { Summary } from '@/lib/types';
import { KB_SOURCE_TYPES, type KbSourceType } from '@heurion/contracts'; // #744/#750 single source of truth
import { BookOpen, Brain, Lightbulb, Wrench, AlertTriangle, RotateCcw, Check, Clock, FileText, Trash2, Edit3, User, Stethoscope, FlaskConical, Globe, X, ChevronLeft, ChevronRight, GitGraph, Download, Image as ImageIcon } from 'lucide-react';

interface Fact {
  id: string; category: string; importance: number; content: string;
  count: number; sourceType?: string; patientHash?: string; studyId?: string;
  createdAt: number; updatedAt: number; lastSeenAt: number;
}
interface Gap {
  id: string; content: string; status: 'open' | 'answered' | 'ignored'; source: string; createdAt: string; updatedAt: string; answerText?: string;
}
interface Tool {
  id: string; name: string; description: string; language: string;
  enabled: boolean; createdAt: number;
}

interface UploadedFile {
  file_id: string; name: string; mime: string; size_bytes: number; created_at: string;
}

// #762: 文件管线状态(#747 FilePipelineJob)— Files 卡可见"为什么搜不到"。
type PipelineStage = 'queued' | 'extracted' | 'embedded' | 'proposed' | 'ingested' | 'failed' | 'skipped';
// #792: badge 文案走 i18n(key),cls 保留模块级。
const PIPELINE_BADGE: Record<PipelineStage, { key: string; cls: string }> = {
  queued: { key: 'kb.pipelineQueued', cls: 'bg-surface-muted text-text-secondary' },
  extracted: { key: 'kb.pipelineExtracted', cls: 'bg-surface-muted text-text-secondary' },
  embedded: { key: 'kb.pipelineEmbedded', cls: 'bg-success/10 text-success' },
  proposed: { key: 'kb.pipelineProposed', cls: 'bg-success/10 text-success' },
  ingested: { key: 'kb.pipelineIngested', cls: 'bg-success/10 text-success' },
  failed: { key: 'kb.pipelineFailed', cls: 'bg-error/10 text-error' },
  skipped: { key: 'kb.pipelineSkipped', cls: 'bg-warning/10 text-warning' },
};

type Tab = 'summaries' | 'facts' | 'gaps' | 'tools' | 'files';

// #918: tab 文案入 i18n — labelKey 在渲染时经 t() 解析。
const TABS: { key: Tab; labelKey: string; icon: typeof BookOpen }[] = [
  { key: 'summaries', labelKey: 'knowledge.tabSummaries', icon: BookOpen },
  { key: 'facts', labelKey: 'knowledge.tabFacts', icon: Brain },
  { key: 'gaps', labelKey: 'knowledge.tabGaps', icon: Clock },
  { key: 'tools', labelKey: 'knowledge.tabTools', icon: Wrench },
  { key: 'files', labelKey: 'knowledge.tabFiles', icon: FileText },
];

// #744/#750: enum imported from @heurion/contracts — server and client share
// one definition; local copies drifted before (sidecar missing → invisible
// facts + silent rewrite on edit).
const SOURCE_TYPES = KB_SOURCE_TYPES;
type SourceType = KbSourceType;

const PAGE_SIZE = 10;

function normalizeSearch(text: string): string {
  return text.toLowerCase().trim();
}

function usePagination<T>(items: T[], page: number, pageSize = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  return { page: safePage, totalPages, start, end: start + pageItems.length, pageItems };
}

export function KnowledgePage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // #761/#762: 支持 ?view=gaps|summaries 深链(NBA 卡跳转定位)。
  const [tab, setTabState] = useState<Tab>(() => {
    const v = new URLSearchParams(window.location.search).get('view');
    return (['summaries', 'facts', 'gaps', 'tools', 'files'] as const).includes(v as Tab) ? (v as Tab) : 'summaries';
  });
  const setTab = setTabState;
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  // #762: fileId → pipeline stage,Files 卡渲染状态徽章。
  const [pipelineStages, setPipelineStages] = useState<Record<string, PipelineStage>>({});
  // #811: 图库 — AI 生成产物(chart/scene/img)集中管理,支持预览/重下载/删除。
  const [charts, setCharts] = useState<Array<{ file_id: string; url: string; title: string; tool: string; size_bytes: number; created_at: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [editingFact, setEditingFact] = useState<Fact | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editSource, setEditSource] = useState<SourceType>('general');

  const [editingSummary, setEditingSummary] = useState<Summary | null>(null);
  const [editSummaryTitle, setEditSummaryTitle] = useState('');
  const [editSummaryContent, setEditSummaryContent] = useState('');
  const [summaryBusy, setSummaryBusy] = useState<Set<string>>(new Set());

  // Gap answering
  const [answeringGapId, setAnsweringGapId] = useState<string | null>(null);
  const [gapAnswer, setGapAnswer] = useState('');

  // Filters
  const [summaryFilter, setSummaryFilter] = useState('');
  const [factFilter, setFactFilter] = useState('');
  const [gapFilter, setGapFilter] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [fileFilter, setFileFilter] = useState('');

  // Pagination
  const [summaryPage, setSummaryPage] = useState(1);
  const [factPage, setFactPage] = useState(1);
  const [gapPage, setGapPage] = useState(1);
  const [toolPage, setToolPage] = useState(1);
  const [filePage, setFilePage] = useState(1);

  // Selections
  const [selectedSummaries, setSelectedSummaries] = useState<Set<string>>(new Set());
  const [selectedFacts, setSelectedFacts] = useState<Set<string>>(new Set());
  const [selectedGaps, setSelectedGaps] = useState<Set<string>>(new Set());
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // #743: observable failures — silent `.catch(() => {})` left users with
  // empty lists and no hint why. Errors surface in a dismissible banner.
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  // #792: useCallback 固定引用 — loadAll 的依赖数组需要稳定值,
  // 否则每渲染新建回调会让 useEffect 无限重跑。
  const recordLoadError = useCallback((what: string) => (err: unknown) => {
    setLoadErrors(prev => [...new Set([...prev, `${what}: ${(err as Error)?.message || t('kb.requestFailed', '请求失败')}`])].slice(-3));
  }, [t]);

  const loadAll = useCallback(() => {
    setLoading(true);
    setLoadErrors([]);
    Promise.all([
      api.getKnowledgeSummaries().then(r => setSummaries(r.summaries)).catch(recordLoadError(t('kb.loadSummaries', '总结加载失败'))),
      api.getFacts().then(r => setFacts(r.facts)).catch(recordLoadError(t('kb.loadFacts', '事实加载失败'))),
      api.getKnowledgeGaps().then(r => setGaps(r.gaps)).catch(recordLoadError(t('kb.loadGaps', 'Gaps 加载失败'))),
      api.getKnowledgeTools().then(r => setTools(r.tools)).catch(recordLoadError(t('kb.loadTools', '工具加载失败'))),
      api.listFiles().then(r => setFiles(r.files)).catch(recordLoadError(t('kb.loadFiles', '文件列表加载失败'))),
      // #920: 图库/管线状态此前 .catch(() => {}) 静默吞错 — 统一走 recordLoadError。
      api.listGeneratedCharts().then(r => setCharts(r.charts)).catch(recordLoadError(t('kb.loadCharts', '图库加载失败'))),
      api.getPipelineJobs().then(r => setPipelineStages(Object.fromEntries(r.jobs.map(j => [j.fileId, j.stage as PipelineStage])))).catch(recordLoadError(t('kb.loadPipeline', '文件管线状态加载失败'))),
    ]).finally(() => setLoading(false));
  }, [t, recordLoadError]);

  // #811: 重新下载 — Bearer mint 一次性带 token 的下载 URL。
  const downloadFile = useCallback(async (fileId: string) => {
    try {
      const r = await api.getDownloadUrl(fileId);
      window.open(r.url, '_blank');
    } catch { recordLoadError(t('knowledge.downloadFailed', '下载失败')); }
  }, [recordLoadError, t]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const staleCount = summaries.filter(a => a.status === 'stale').length;
  const pendingCount = gaps.filter(g => g.status === 'open').length;

  const filteredSummaries = useMemo(() => {
    const q = normalizeSearch(summaryFilter);
    if (!q) return summaries;
    return summaries.filter(a => normalizeSearch(a.title).includes(q) || normalizeSearch(a.content).includes(q));
  }, [summaries, summaryFilter]);

  const filteredFacts = useMemo(() => {
    const q = normalizeSearch(factFilter);
    if (!q) return facts;
    return facts.filter(f => normalizeSearch(f.content).includes(q));
  }, [facts, factFilter]);

  const filteredGaps = useMemo(() => {
    const q = normalizeSearch(gapFilter);
    if (!q) return gaps;
    return gaps.filter(g => normalizeSearch(g.content).includes(q));
  }, [gaps, gapFilter]);

  const filteredTools = useMemo(() => {
    const q = normalizeSearch(toolFilter);
    if (!q) return tools;
    return tools.filter(t => normalizeSearch(t.name).includes(q) || normalizeSearch(t.description).includes(q));
  }, [tools, toolFilter]);

  const filteredFiles = useMemo(() => {
    const q = normalizeSearch(fileFilter);
    if (!q) return files;
    return files.filter(f => normalizeSearch(f.name).includes(q));
  }, [files, fileFilter]);

  const summaryPagination = usePagination(filteredSummaries, summaryPage);
  const factPagination = usePagination(filteredFacts, factPage);
  const gapPagination = usePagination(filteredGaps, gapPage);
  const toolPagination = usePagination(filteredTools, toolPage);
  const filePagination = usePagination(filteredFiles, filePage);

  const resolveGap = async (gapId: string) => {
    try { await api.resolveKnowledgeGap(gapId); } catch (err) { setActionError(t('knowledge.resolveFailed', '标记失败：{{msg}}', { msg: (err as Error)?.message || t('kb.requestFailed', '请求失败') })); return; }
    loadAll();
  };

  const answerGap = async (gapId: string) => {
    const text = gapAnswer.trim();
    if (!text) return;
    try { await api.answerKnowledgeGap(gapId, text); } catch (err) { setActionError(t('knowledge.answerFailed', '提交回答失败：{{msg}}', { msg: (err as Error)?.message || t('kb.requestFailed', '请求失败') })); return; }
    setAnsweringGapId(null);
    setGapAnswer('');
    loadAll();
  };

  const ignoreGap = async (gapId: string) => {
    try { await api.ignoreKnowledgeGap(gapId); } catch (err) { setActionError(t('knowledge.ignoreFailed', '忽略失败：{{msg}}', { msg: (err as Error)?.message || t('kb.requestFailed', '请求失败') })); return; }
    loadAll();
  };

  const deleteFact = async (id: string) => {
    try { await api.deleteFact(id); } catch (err) { setActionError(t('knowledge.deleteFailed', '删除失败：{{msg}}', { msg: (err as Error)?.message || t('kb.requestFailed', '请求失败') })); return; }
    loadAll();
  };

  const saveFact = async () => {
    if (!editingFact) return;
    try { await api.updateFact(editingFact.id, { content: editContent, sourceType: editSource }); } catch (err) { setActionError(t('knowledge.saveFailed', '保存失败：{{msg}}', { msg: (err as Error)?.message || t('kb.requestFailed', '请求失败') })); return; }
    setEditingFact(null);
    loadAll();
  };

  const regenerateSummary = async (id: string) => {
    setSummaryBusy(prev => new Set(prev).add(id));
    try { await api.regenerateKnowledgeSummary(id); } catch (err) { setSummaryBusy(prev => { const next = new Set(prev); next.delete(id); return next; }); setActionError(t('knowledge.regenerateFailed', '重新生成失败：{{msg}}', { msg: (err as Error)?.message || t('kb.requestFailed', '请求失败') })); return; }
    setSummaryBusy(prev => { const next = new Set(prev); next.delete(id); return next; });
    loadAll();
  };

  const saveSummary = async () => {
    if (!editingSummary) return;
    const patch: {title?: string; content?: string} = {};
    if (editSummaryTitle.trim()) patch.title = editSummaryTitle.trim();
    if (editSummaryContent.trim()) patch.content = editSummaryContent.trim();
    try {
      await api.updateKnowledgeSummary(editingSummary.id, patch);
    } catch (err) {
      // #920: 保存失败此前被 .catch(() => {}) 吞掉 — 用户以为改成功了。
      // 失败时保留弹窗以便重试。
      setActionError(t('knowledge.saveSummaryFailed', '保存总结失败：{{msg}}', { msg: (err as Error)?.message || t('kb.requestFailed', '请求失败') }));
      return;
    }
    setEditingSummary(null);
    loadAll();
  };

  const toggleSelection = (set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => {
    set(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllOnPage = (ids: string[], set: React.Dispatch<React.SetStateAction<Set<string>>>, checked: boolean) => {
    set(prev => {
      const next = new Set(prev);
      ids.forEach(id => {
        if (checked) next.add(id);
        else next.delete(id);
      });
      return next;
    });
  };

  const handleBulkDelete = async (label: string, ids: string[], deleteFn: (ids: string[]) => Promise<{deleted: number}>) => {
    if (ids.length === 0) return;
    if (!confirm(t('knowledge.bulkDeleteConfirm', '删除选中的 {{count}} 条{{label}}？', { count: ids.length, label }))) return;
    try {
      const result = await deleteFn(ids);
      console.log(`[KB] Deleted ${result.deleted} ${label}`, ids);
      await loadAll();
    } catch (err) {
      console.error(`Failed to delete ${label}:`, err);
      // #920: 失败走 actionError 通道，不再 alert。
      setActionError(t('knowledge.bulkDeleteFailed', '删除{{label}}失败，详情见控制台', { label }));
    }
  };

  const renderPagination = (
    page: number,
    totalPages: number,
    setPage: (p: number) => void,
    start: number,
    total: number,
  ) => (
    <div className="flex items-center justify-between border-t border-border pt-3">
      <p className="text-xs text-text-tertiary">
        {t('knowledge.showing', '显示 {{from}}–{{to}} 条，共 {{total}} 条', { from: total === 0 ? 0 : start + 1, to: Math.min(start + PAGE_SIZE, total), total })}
      </p>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPage(page - 1)}
          disabled={page <= 1}
        ><ChevronLeft size={14} /></Button>
        <span className="text-sm text-text-secondary px-2">{page} / {totalPages}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPage(page + 1)}
          disabled={page >= totalPages}
        ><ChevronRight size={14} /></Button>
      </div>
    </div>
  );

  const renderToolbar = (
    filter: string,
    setFilter: (v: string) => void,
    setPage: (p: number) => void,
    selected: Set<string>,
    setSelected: React.Dispatch<React.SetStateAction<Set<string>>>,
    pageIds: string[],
    label: string,
    deleteFn: (ids: string[]) => Promise<{deleted: number}>,
    placeholder: string,
  ) => {
    const allSelected = pageIds.length > 0 && pageIds.every(id => selected.has(id));
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Input
          type="text"
          placeholder={placeholder}
          value={filter}
          onChange={e => { setFilter(e.target.value); setPage(1); }}
          className="sm:w-80"
        />
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <span className="text-xs text-text-secondary">{t('knowledge.selectedCount', '已选 {{n}} 项', { n: selected.size })}</span>
          )}
          <Button
            size="sm"
            variant="danger"
            disabled={selected.size === 0}
            onClick={() => handleBulkDelete(label, Array.from(selected), deleteFn).then(() => setSelected(new Set()))}
          ><Trash2 size={14} className="mr-1" /> {t('knowledge.deleteSelected', '删除所选')}</Button>
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              className="rounded border-border"
              checked={allSelected}
              onChange={() => selectAllOnPage(pageIds, setSelected, !allSelected)}
            />
            {t('knowledge.selectAllOnPage', '全选本页')}
          </label>
        </div>
      </div>
    );
  };

  const content = (
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 sm:px-6">
          <div className="flex items-center gap-3">
            <BookOpen size={20} className="text-accent" />
            <h1 className="font-semibold text-text-primary">{t('knowledge.title', '知识库')}</h1>
            {staleCount > 0 && (
              <Badge variant="warning"><AlertTriangle size={12} className="mr-1" /> {t('knowledge.staleCount', '{{n}} 篇过期', { n: staleCount })}</Badge>
            )}
            {pendingCount > 0 && (
              <Badge variant="default"><Clock size={12} className="mr-1" /> {t('knowledge.pendingCount', '{{n}} 个待补', { n: pendingCount })}</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => navigate('/app/memory-graph')}>
              <GitGraph size={14} className="mr-1" /> {t('knowledge.graph', '图谱')}
            </Button>
            <Button size="sm" variant="ghost" onClick={loadAll}><RotateCcw size={14} className="mr-1" /> {t('common.refresh', '刷新')}</Button>
          </div>
        </header>

        {/* #743: surfaced load/action failures — no more silent empty lists. */}
        {(loadErrors.length > 0 || actionError) && (
          <div className="mx-3 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" role="alert">
            {loadErrors.map((e, i) => (<div key={i}>⚠ {e}</div>))}
            {actionError && (
              <div className="flex items-center justify-between gap-2">
                <span>⚠ {actionError}</span>
                <button onClick={() => setActionError(null)} aria-label="dismiss"><X size={14} /></button>
              </div>
            )}
          </div>
        )}

        <nav className="flex border-b border-border bg-surface px-6">
          {TABS.map(({ key, labelKey, icon: Icon }) => (
            <button
              key={key}
              onClick={() => { setTab(key); }}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 -mb-px transition-colors',
                tab === key
                  ? 'border-accent text-accent font-medium'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              )}
            >
              <Icon size={14} />
              {t(labelKey)}
            </button>
          ))}
        </nav>

        <main className="p-6 space-y-4">
          {/* #761: 知识库视角的下一步建议(gaps/stale/新文件) */}
          <NextBestActions />
          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          ) : (
            <>
              {/* ── Summaries ── */}
              {tab === 'summaries' && (
                <div className="space-y-4">
                  {renderToolbar(
                    summaryFilter,
                    setSummaryFilter,
                    setSummaryPage,
                    selectedSummaries,
                    setSelectedSummaries,
                    summaryPagination.pageItems.map(a => a.id),
                    t('knowledge.bulkSummaries', '总结'),
                    (ids: string[]) => api.deleteKnowledgeSummaries(ids),
                    t('knowledge.filterSummaries', '按标题或内容筛选总结…'),
                  )}
                  {summaryPagination.pageItems.length === 0 && (
                    <EmptyState
                      icon={<BookOpen size={24} />}
                      title={t('knowledge.emptySummaries', '暂无知识总结')}
                      hint={t('knowledge.emptySummariesHint', '相关事实积累到 3 条以上时会自动生成总结。')}
                    />
                  )}
                  {summaryPagination.pageItems.map(a => (
                    <Card key={a.id} className={cn('p-4', a.status === 'stale' && 'border-warning/50')}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              className="rounded border-border mr-2"
                              checked={selectedSummaries.has(a.id)}
                              onChange={() => toggleSelection(setSelectedSummaries, a.id)}
                            />
                            <h3 className="font-medium text-text-primary truncate">{a.title || t('knowledge.untitled', '未命名')}</h3>
                            <Badge variant="default">v{a.version || 1}</Badge>
                            {a.status === 'stale' && <Badge variant="warning"><AlertTriangle size={10} className="mr-1" /> {t('knowledge.stale', '已过期')}</Badge>}
                          </div>
                          {a.content && <p className="mt-1 text-xs text-text-tertiary line-clamp-2">{a.content.slice(0, 200)}</p>}
                          <p className="mt-1 text-xs text-text-tertiary">
                            {new Date(a.updatedAt || a.createdAt).toLocaleDateString()}
                            {a.sources?.length > 0 && ` · ${t('knowledge.sourcesCount', '{{n}} 个来源', { n: a.sources.length })}`}
                          </p>
                          {a.status === 'stale' && a.impact && a.impact.length > 0 && (
                            <div className="mt-2 space-y-1">
                              {a.impact.map((impact, idx) => (
                                <p key={idx} className="text-xs text-warning">{impact.message}</p>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 ml-3 shrink-0">
                          <button
                            className="p-1.5 rounded hover:bg-surface-elevated text-text-tertiary hover:text-text-primary"
                            onClick={() => { setEditingSummary(a); setEditSummaryTitle(a.title || ''); setEditSummaryContent(a.content || ''); }}
                            title={t('knowledge.editSummary', '编辑总结')}
                          ><Edit3 size={14} /></button>
                          {a.status === 'stale' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              isLoading={summaryBusy.has(a.id)}
                              onClick={() => regenerateSummary(a.id)}
                            ><RotateCcw size={14} className="mr-1" /> {t('knowledge.regenerate', '重新生成')}</Button>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))}

                  {/* Summary edit modal */}
                  {/* #922: 弹窗外壳收敛到共享 Modal(原行为:无 backdrop 关、无 Esc;Card 直挂面板) */}
                  {editingSummary && (
                    <Modal open backdropClassName="bg-black/40 p-4">
                      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5">
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-lg font-semibold text-text-primary">{t('knowledge.editSummary', '编辑总结')}</h3>
                          <button onClick={() => setEditingSummary(null)}><X size={18} className="text-text-tertiary" /></button>
                        </div>
                        <div className="space-y-3">
                          <div>
                            <label className="block text-sm font-medium text-text-secondary mb-1">{t('knowledge.titleLabel', '标题')}</label>
                            <Input value={editSummaryTitle} onChange={e => setEditSummaryTitle(e.target.value)} />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-text-secondary mb-1">{t('knowledge.contentLabel', '内容')}</label>
                            <Textarea value={editSummaryContent} onChange={e => setEditSummaryContent(e.target.value)} rows={12} />
                          </div>
                          <div className="flex gap-2 pt-2">
                            <Button size="sm" onClick={saveSummary}><Check size={14} className="mr-1" /> {t('common.save', '保存')}</Button>
                            <Button size="sm" variant="secondary" onClick={() => setEditingSummary(null)}>{t('common.cancel', '取消')}</Button>
                          </div>
                        </div>
                      </Card>
                    </Modal>
                  )}
                  {renderPagination(summaryPagination.page, summaryPagination.totalPages, setSummaryPage, summaryPagination.start, filteredSummaries.length)}
                </div>
              )}

              {/* ── Facts ── */}
              {tab === 'facts' && (
                <div className="space-y-6">
                  {renderToolbar(
                    factFilter,
                    setFactFilter,
                    setFactPage,
                    selectedFacts,
                    setSelectedFacts,
                    factPagination.pageItems.map(f => f.id),
                    t('knowledge.bulkFacts', '事实'),
                    (ids: string[]) => api.deleteFacts(ids),
                    t('knowledge.filterFacts', '按内容筛选事实…'),
                  )}
                  {SOURCE_TYPES.map(sourceType => {
                    const groupFacts = factPagination.pageItems.filter(f => f.sourceType === sourceType || (!f.sourceType && sourceType === 'general'));
                    if (groupFacts.length === 0) return null;
                    // #744: sidecar now has its own group (was invisible/absorbed into general).
                    const Icon = sourceType === 'patient' ? User : sourceType === 'doctor' ? Stethoscope : sourceType === 'research' ? FlaskConical : sourceType === 'sidecar' ? GitGraph : Globe;
                    const label = sourceType === 'patient' ? t('knowledge.groupPatient', '患者事实')
                      : sourceType === 'doctor' ? t('knowledge.groupDoctor', '医生与偏好')
                      : sourceType === 'research' ? t('knowledge.groupResearch', '研究与课题')
                      : sourceType === 'sidecar' ? t('knowledge.groupSidecar', '工具与旁路事实')
                      : t('knowledge.groupGeneral', '通用');
                    return (
                      <div key={sourceType}>
                        <h3 className="flex items-center gap-2 mb-3 text-sm font-semibold text-text-secondary">
                          <Icon size={16} /> {label} ({groupFacts.length})
                        </h3>
                        <div className="space-y-2">
                          {groupFacts.map(f => (
                            <Card key={f.id} className="p-3">
                              {editingFact?.id === f.id ? (
                                <div className="space-y-3">
                                  <div className="flex items-center justify-between">
                                    <h4 className="text-sm font-medium text-text-primary">{t('knowledge.editFact', '编辑事实')}</h4>
                                    <button onClick={() => setEditingFact(null)}><X size={16} className="text-text-tertiary" /></button>
                                  </div>
                                  <textarea
                                    className="w-full rounded-lg border border-border bg-surface-elevated p-2 text-sm h-20"
                                    value={editContent}
                                    onChange={e => setEditContent(e.target.value)}
                                  />
                                  <div className="flex flex-wrap items-center gap-3">
                                    {SOURCE_TYPES.map(s => (
                                      <label key={s} className="flex items-center gap-1 text-xs text-text-secondary">
                                        <input type="radio" name="sourceType" value={s} checked={editSource === s} onChange={() => setEditSource(s)} />
                                        {s}
                                      </label>
                                    ))}
                                  </div>
                                  <div className="flex gap-2">
                                    <Button size="sm" onClick={saveFact}><Check size={14} className="mr-1" /> {t('common.save', '保存')}</Button>
                                    <Button size="sm" variant="secondary" onClick={() => setEditingFact(null)}>{t('common.cancel', '取消')}</Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-start gap-3">
                                  <input
                                    type="checkbox"
                                    className="rounded border-border mt-1.5"
                                    checked={selectedFacts.has(f.id)}
                                    onChange={() => toggleSelection(setSelectedFacts, f.id)}
                                  />
                                  <div className={cn(
                                    'mt-0.5 px-1.5 py-0.5 rounded text-xs font-medium shrink-0',
                                    f.category === 'fact' ? 'bg-blue-500/10 text-blue-500' :
                                    f.category === 'preference' ? 'bg-purple-500/10 text-purple-500' :
                                    f.category === 'constraint' ? 'bg-orange-500/10 text-orange-500' :
                                    f.category === 'goal' ? 'bg-green-500/10 text-green-500' :
                                    'bg-slate-500/10 text-slate-500'
                                  )}>{f.category}</div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm text-text-primary">{f.content}</p>
                                    <p className="mt-1 text-xs text-text-tertiary">
                                      {t('knowledge.importance', '重要度：{{n}} · 出现 {{count}} 次', { n: f.importance, count: f.count })} · {new Date(f.updatedAt).toLocaleDateString()}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      className="p-1 rounded hover:bg-surface-elevated text-text-tertiary hover:text-text-primary"
                                      onClick={() => { setEditingFact(f); setEditContent(f.content); setEditSource((f.sourceType as SourceType) || 'general'); }}
                                    ><Edit3 size={14} /></button>
                                    <button
                                      className="p-1 rounded hover:bg-surface-elevated text-text-tertiary hover:text-error"
                                      onClick={() => deleteFact(f.id)}
                                    ><Trash2 size={14} /></button>
                                  </div>
                                </div>
                              )}
                            </Card>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {filteredFacts.length === 0 && (
                    <EmptyState
                      icon={<Brain size={24} />}
                      title={t('knowledge.emptyFacts', '暂无事实')}
                      hint={t('knowledge.emptyFactsHint', '事实会从对话与导入数据中自动提取。')}
                    />
                  )}
                  {filteredFacts.length > 0 && renderPagination(factPagination.page, factPagination.totalPages, setFactPage, factPagination.start, filteredFacts.length)}
                </div>
              )}

              {/* ── Gaps / Pending ── */}
              {tab === 'gaps' && (
                <div className="space-y-4">
                  {renderToolbar(
                    gapFilter,
                    setGapFilter,
                    setGapPage,
                    selectedGaps,
                    setSelectedGaps,
                    gapPagination.pageItems.map(g => g.id),
                    t('knowledge.bulkGaps', '待补'),
                    (ids: string[]) => api.deleteKnowledgeGaps(ids),
                    t('knowledge.filterGaps', '按问题或上下文筛选待补…'),
                  )}
                  {gapPagination.pageItems.length === 0 && (
                    <EmptyState
                      icon={<Lightbulb size={24} />}
                      title={t('knowledge.emptyGaps', '暂无待补知识缺口')}
                      hint={t('knowledge.emptyGapsHint', '当提问没有命中已有知识时会出现缺口。')}
                    />
                  )}
                  {gapPagination.pageItems.map(g => {
                    const statusLabel = g.status === 'open' ? t('knowledge.gapPending', '待处理') : g.status === 'answered' ? t('knowledge.gapAnswered', '已回答') : t('knowledge.gapIgnored', '已忽略');
                    const statusVariant = libStatusVariant(g.status);
                    return (
                      <Card key={g.id} className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                className="rounded border-border mr-2"
                                checked={selectedGaps.has(g.id)}
                                onChange={() => toggleSelection(setSelectedGaps, g.id)}
                              />
                              <h3 className="font-medium text-sm text-text-primary truncate">{g.content}</h3>
                              <Badge variant={statusVariant}>{statusLabel}</Badge>
                            </div>
                            <p className="mt-1 text-xs text-text-tertiary">{new Date(g.createdAt).toLocaleDateString()}</p>
                          </div>
                          {g.status === 'open' && answeringGapId !== g.id && (
                            <div className="ml-3 flex flex-shrink-0 items-center gap-2">
                              <Button size="sm" variant="secondary" onClick={() => { setAnsweringGapId(g.id); setGapAnswer(''); }}>
                                <Edit3 size={14} className="mr-1" /> {t('knowledge.answer', '回答')}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => ignoreGap(g.id)}>
                                {t('knowledge.ignore', '忽略')}
                              </Button>
                              <Button size="sm" variant="ghost" className="border border-border" onClick={() => resolveGap(g.id)}>
                                <Check size={14} className="mr-1" /> {t('knowledge.markResolved', '标记已解决')}
                              </Button>
                            </div>
                          )}
                        </div>
                        {g.status === 'open' && answeringGapId === g.id && (
                          <div className="mt-3 space-y-2 border-t border-border pt-3">
                            <Textarea
                              placeholder={t('knowledge.answerPlaceholder', '在此输入答案或缺失信息…')}
                              value={gapAnswer}
                              onChange={(e) => setGapAnswer(e.target.value)}
                              rows={3}
                              className="w-full text-sm"
                            />
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="ghost" onClick={() => { setAnsweringGapId(null); setGapAnswer(''); }}>
                                {t('common.cancel', '取消')}
                              </Button>
                              <Button size="sm" variant="secondary" disabled={!gapAnswer.trim()} onClick={() => answerGap(g.id)}>
                                {t('knowledge.saveAnswer', '保存答案')}
                              </Button>
                            </div>
                          </div>
                        )}
                        {g.status === 'answered' && g.answerText && (
                          <div className="mt-2 rounded-lg bg-surface-elevated p-2 text-xs text-text-secondary">
                            <span className="font-medium text-text-primary">{t('knowledge.answerLabel', '答案：')}</span> {g.answerText}
                          </div>
                        )}
                      </Card>
                    );
                  })}
                  {renderPagination(gapPagination.page, gapPagination.totalPages, setGapPage, gapPagination.start, filteredGaps.length)}
                </div>
              )}

              {/* ── Tools ── */}
              {tab === 'tools' && (
                <div className="space-y-4">
                  {renderToolbar(
                    toolFilter,
                    setToolFilter,
                    setToolPage,
                    selectedTools,
                    setSelectedTools,
                    toolPagination.pageItems.map(t => t.id),
                    t('knowledge.bulkTools', '工具'),
                    (ids: string[]) => api.deleteKnowledgeTools(ids),
                    t('knowledge.filterTools', '按名称或描述筛选工具…'),
                  )}
                  {toolPagination.pageItems.length === 0 && (
                    <EmptyState
                      icon={<Wrench size={24} />}
                      title={t('knowledge.emptyTools', '暂无自动生成的工具')}
                      hint={t('knowledge.emptyToolsHint', '工具会从知识模式中自动生成。')}
                    />
                  )}
                  {toolPagination.pageItems.map(tool => (
                    <Card key={tool.id} className={cn('p-4', !tool.enabled && 'opacity-60')}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              className="rounded border-border mr-2"
                              checked={selectedTools.has(tool.id)}
                              onChange={() => toggleSelection(setSelectedTools, tool.id)}
                            />
                            <h3 className="font-medium text-sm text-text-primary">{tool.name}</h3>
                            <Badge variant="default">{tool.language}</Badge>
                            {!tool.enabled && <Badge>{t('knowledge.disabled', '已停用')}</Badge>}
                          </div>
                          {tool.description && <p className="mt-1 text-xs text-text-tertiary line-clamp-2">{tool.description}</p>}
                          <p className="mt-1 text-xs text-text-tertiary">{new Date(tool.createdAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                    </Card>
                  ))}
                  {renderPagination(toolPagination.page, toolPagination.totalPages, setToolPage, toolPagination.start, filteredTools.length)}
                </div>
              )}

              {/* ── Files ── */}
              {tab === 'files' && (
                <div className="space-y-4">
                  {renderToolbar(
                    fileFilter,
                    setFileFilter,
                    setFilePage,
                    selectedFiles,
                    setSelectedFiles,
                    filePagination.pageItems.map(f => f.file_id),
                    t('knowledge.bulkFiles', '文件'),
                    (ids: string[]) => api.deleteFiles(ids),
                    t('knowledge.filterFiles', '按名称筛选文件…'),
                  )}
                  {filePagination.pageItems.length === 0 && (
                    <Card className="p-8 text-center">
                      <FileText size={32} className="mx-auto mb-3 text-text-tertiary" />
                      <p className="text-text-secondary">{t('knowledge.emptyFiles', '暂无上传文件。')}</p>
                      <p className="mt-1 text-sm text-text-tertiary">{t('knowledge.emptyFilesHint', '可在对话或文件页上传。')}</p>
                    </Card>
                  )}
                  {filePagination.pageItems.map(f => (
                    <Card key={f.file_id} className="p-4">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          className="rounded border-border"
                          checked={selectedFiles.has(f.file_id)}
                          onChange={() => toggleSelection(setSelectedFiles, f.file_id)}
                        />
                        <FileText size={18} className="text-text-tertiary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-text-primary truncate">{f.name}</p>
                          <p className="text-xs text-text-tertiary">
                            {f.mime} · {(f.size_bytes / 1024).toFixed(1)} KB · {new Date(f.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        {/* #762: 管线状态徽章 — 让"为什么搜不到"可见可诊断。 */}
                        {(() => {
                          const stage = pipelineStages[f.file_id];
                          if (!stage) return null;
                          const badge = PIPELINE_BADGE[stage];
                          return (
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${badge.cls}`} title={stage}>
                              {t(badge.key)}
                            </span>
                          );
                        })()}
                        {/* #811: 知识库文件重新下载入口。 */}
                        <button
                          className="p-1.5 rounded hover:bg-surface-elevated text-text-tertiary hover:text-text-primary"
                          title={t('knowledge.download', '下载')}
                          onClick={() => downloadFile(f.file_id)}
                        ><Download size={14} /></button>
                        <button
                          className="p-1.5 rounded hover:bg-surface-elevated text-text-tertiary hover:text-error"
                          onClick={async () => {
                            if (confirm(t('knowledge.deleteFileConfirm', '删除 {{name}}？', { name: f.name }))) {
                              // #920: 删除失败此前静默吞掉仍刷新列表 — 现在提示且不刷新。
                              try {
                                await api.deleteFile(f.file_id);
                                loadAll();
                              } catch (err) {
                                setActionError(t('knowledge.deleteFailed', '删除失败：{{msg}}', { msg: (err as Error)?.message || t('kb.requestFailed', '请求失败') }));
                              }
                            }
                          }}
                        ><Trash2 size={14} /></button>
                      </div>
                    </Card>
                  ))}
                   {renderPagination(filePagination.page, filePagination.totalPages, setFilePage, filePagination.start, filteredFiles.length)}
                 </div>
               )}

               {/* #811: 图库 — AI 生成产物（图表/示意图/插图）集中管理，与知识库文件分离。
                   支持：预览（带 token 的签名 URL）/ 重新下载 / 删除。 */}
               {charts.length > 0 && (
                 <div className="mt-8">
                   <div className="flex items-center gap-2 mb-3">
                     <ImageIcon size={16} className="text-text-tertiary" />
                     <h2 className="text-sm font-medium text-text-secondary">
                       {t('kb.gallery', '图库')} · {charts.length}
                     </h2>
                   </div>
                   <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                     {charts.map(c => (
                       <Card key={c.file_id} className="p-3">
                         <div className="flex items-center gap-2 mb-2">
                           <div className="flex-1 min-w-0">
                             <p className="text-sm text-text-primary truncate" title={c.title}>{c.title}</p>
                             <p className="text-xs text-text-tertiary">
                               {c.tool} · {(c.size_bytes / 1024).toFixed(1)} KB · {new Date(c.created_at).toLocaleDateString()}
                             </p>
                           </div>
                         </div>
                         {c.url && (
                           <div className="rounded bg-surface-elevated p-2 mb-2 flex items-center justify-center h-36 overflow-hidden">
                             <img src={c.url} alt={c.title} className="max-h-full max-w-full object-contain" loading="lazy" />
                           </div>
                         )}
                          <div className="flex items-center gap-1">
                            <button
                              className="p-1.5 rounded hover:bg-surface-elevated text-text-tertiary hover:text-text-primary"
                              title={t('knowledge.download', '下载')}
                              onClick={() => downloadFile(c.file_id)}
                            ><Download size={14} /></button>
                            <button
                              className="p-1.5 rounded hover:bg-surface-elevated text-text-tertiary hover:text-error"
                              title={t('common.delete', '删除')}
                              onClick={async () => {
                                if (confirm(t('knowledge.deleteFileConfirm', '删除 {{name}}？', { name: c.title }))) {
                                  // #920: 删除失败不再静默。
                                  try {
                                    await api.deleteGeneratedChart(c.file_id);
                                    setCharts(prev => prev.filter(x => x.file_id !== c.file_id));
                                  } catch (err) {
                                    setActionError(t('knowledge.deleteFailed', '删除失败：{{msg}}', { msg: (err as Error)?.message || t('kb.requestFailed', '请求失败') }));
                                  }
                                }
                              }}
                            ><Trash2 size={14} /></button>
                          </div>
                       </Card>
                     ))}
                   </div>
                 </div>
               )}
             </>
           )}
         </main>
      </div>
  );

  // #230: embedded mode drops the AppShell for the unified tab view.
  if (embedded) return content;
  return <AppShell>{content}</AppShell>;
}
