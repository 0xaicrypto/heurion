import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api-client';
import { Button, Card, Skeleton, Badge, Input, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Article } from '@/lib/types';
import { BookOpen, Brain, Lightbulb, Wrench, AlertTriangle, RotateCcw, Check, Clock, FileText, Trash2, Edit3, User, Stethoscope, FlaskConical, Globe, X, ChevronLeft, ChevronRight, GitGraph } from 'lucide-react';

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

type Tab = 'articles' | 'facts' | 'gaps' | 'tools' | 'files';

const TABS: { key: Tab; label: string; icon: typeof BookOpen }[] = [
  { key: 'articles', label: 'Articles', icon: BookOpen },
  { key: 'facts', label: 'Facts', icon: Brain },
  { key: 'gaps', label: 'Pending', icon: Clock },
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'files', label: 'Files', icon: FileText },
];

const SOURCE_TYPES = ['patient', 'doctor', 'research', 'general'] as const;
type SourceType = typeof SOURCE_TYPES[number];

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
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('articles');
  const [articles, setArticles] = useState<Article[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingFact, setEditingFact] = useState<Fact | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editSource, setEditSource] = useState<SourceType>('general');

  const [editingArticle, setEditingArticle] = useState<Article | null>(null);
  const [editArticleTitle, setEditArticleTitle] = useState('');
  const [editArticleContent, setEditArticleContent] = useState('');
  const [articleBusy, setArticleBusy] = useState<Set<string>>(new Set());

  // Gap answering
  const [answeringGapId, setAnsweringGapId] = useState<string | null>(null);
  const [gapAnswer, setGapAnswer] = useState('');

  // Filters
  const [articleFilter, setArticleFilter] = useState('');
  const [factFilter, setFactFilter] = useState('');
  const [gapFilter, setGapFilter] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [fileFilter, setFileFilter] = useState('');

  // Pagination
  const [articlePage, setArticlePage] = useState(1);
  const [factPage, setFactPage] = useState(1);
  const [gapPage, setGapPage] = useState(1);
  const [toolPage, setToolPage] = useState(1);
  const [filePage, setFilePage] = useState(1);

  // Selections
  const [selectedArticles, setSelectedArticles] = useState<Set<string>>(new Set());
  const [selectedFacts, setSelectedFacts] = useState<Set<string>>(new Set());
  const [selectedGaps, setSelectedGaps] = useState<Set<string>>(new Set());
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      api.getKnowledgeArticles().then(r => setArticles(r.articles)).catch(() => {}),
      api.getFacts().then(r => setFacts(r.facts)).catch(() => {}),
      api.getKnowledgeGaps().then(r => setGaps(r.gaps)).catch(() => {}),
      api.getKnowledgeTools().then(r => setTools(r.tools)).catch(() => {}),
      api.listFiles().then(r => setFiles(r.files)).catch(() => {}),
    ]).finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, []);

  const staleCount = articles.filter(a => a.status === 'stale').length;
  const pendingCount = gaps.filter(g => g.status === 'open').length;

  const filteredArticles = useMemo(() => {
    const q = normalizeSearch(articleFilter);
    if (!q) return articles;
    return articles.filter(a => normalizeSearch(a.title).includes(q) || normalizeSearch(a.content).includes(q));
  }, [articles, articleFilter]);

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

  const articlePagination = usePagination(filteredArticles, articlePage);
  const factPagination = usePagination(filteredFacts, factPage);
  const gapPagination = usePagination(filteredGaps, gapPage);
  const toolPagination = usePagination(filteredTools, toolPage);
  const filePagination = usePagination(filteredFiles, filePage);

  const resolveGap = async (gapId: string) => {
    await api.resolveKnowledgeGap(gapId).catch(() => {});
    loadAll();
  };

  const answerGap = async (gapId: string) => {
    const text = gapAnswer.trim();
    if (!text) return;
    await api.answerKnowledgeGap(gapId, text).catch(() => {});
    setAnsweringGapId(null);
    setGapAnswer('');
    loadAll();
  };

  const ignoreGap = async (gapId: string) => {
    await api.ignoreKnowledgeGap(gapId).catch(() => {});
    loadAll();
  };

  const deleteFact = async (id: string) => {
    await api.deleteFact(id).catch(() => {});
    loadAll();
  };

  const saveFact = async () => {
    if (!editingFact) return;
    await api.updateFact(editingFact.id, { content: editContent, sourceType: editSource }).catch(() => {});
    setEditingFact(null);
    loadAll();
  };

  const regenerateArticle = async (id: string) => {
    setArticleBusy(prev => new Set(prev).add(id));
    await api.regenerateKnowledgeArticle(id).catch(() => {});
    setArticleBusy(prev => { const next = new Set(prev); next.delete(id); return next; });
    loadAll();
  };

  const saveArticle = async () => {
    if (!editingArticle) return;
    const patch: {title?: string; content?: string} = {};
    if (editArticleTitle.trim()) patch.title = editArticleTitle.trim();
    if (editArticleContent.trim()) patch.content = editArticleContent.trim();
    await api.updateKnowledgeArticle(editingArticle.id, patch).catch(() => {});
    setEditingArticle(null);
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
    if (!confirm(`Delete ${ids.length} selected ${label}?`)) return;
    try {
      const result = await deleteFn(ids);
      console.log(`[KB] Deleted ${result.deleted} ${label}`, ids);
      await loadAll();
    } catch (err) {
      console.error(`Failed to delete ${label}:`, err);
      alert(`Failed to delete ${label}. See console for details.`);
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
        Showing {total === 0 ? 0 : start + 1}–{Math.min(start + PAGE_SIZE, total)} of {total}
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
            <span className="text-xs text-text-secondary">{selected.size} selected</span>
          )}
          <Button
            size="sm"
            variant="danger"
            disabled={selected.size === 0}
            onClick={() => handleBulkDelete(label, Array.from(selected), deleteFn).then(() => setSelected(new Set()))}
          ><Trash2 size={14} className="mr-1" /> Delete selected</Button>
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              className="rounded border-border"
              checked={allSelected}
              onChange={() => selectAllOnPage(pageIds, setSelected, !allSelected)}
            />
            Select all on page
          </label>
        </div>
      </div>
    );
  };

  const content = (
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <div className="flex items-center gap-3">
            <BookOpen size={20} className="text-accent" />
            <h1 className="font-semibold text-text-primary">Knowledge Base</h1>
            {staleCount > 0 && (
              <Badge variant="warning"><AlertTriangle size={12} className="mr-1" /> {staleCount} stale</Badge>
            )}
            {pendingCount > 0 && (
              <Badge variant="default"><Clock size={12} className="mr-1" /> {pendingCount} pending</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => navigate('/app/memory-graph')}>
              <GitGraph size={14} className="mr-1" /> Graph
            </Button>
            <Button size="sm" variant="ghost" onClick={loadAll}><RotateCcw size={14} className="mr-1" /> Refresh</Button>
          </div>
        </header>

        <nav className="flex border-b border-border bg-surface px-6">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 -mb-px transition-colors',
                tab === key
                  ? 'border-accent text-accent font-medium'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>

        <main className="p-6 space-y-4">
          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          ) : (
            <>
              {/* ── Articles ── */}
              {tab === 'articles' && (
                <div className="space-y-4">
                  {renderToolbar(
                    articleFilter,
                    setArticleFilter,
                    setArticlePage,
                    selectedArticles,
                    setSelectedArticles,
                    articlePagination.pageItems.map(a => a.id),
                    'articles',
                    (ids: string[]) => api.deleteKnowledgeArticles(ids),
                    'Filter articles by title or content...',
                  )}
                  {articlePagination.pageItems.length === 0 && (
                    <EmptyState
                      icon={<BookOpen size={24} />}
                      title="No knowledge articles yet"
                      hint="Articles are auto-generated when 3+ related facts accumulate."
                    />
                  )}
                  {articlePagination.pageItems.map(a => (
                    <Card key={a.id} className={cn('p-4', a.status === 'stale' && 'border-warning/50')}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              className="rounded border-border mr-2"
                              checked={selectedArticles.has(a.id)}
                              onChange={() => toggleSelection(setSelectedArticles, a.id)}
                            />
                            <h3 className="font-medium text-text-primary truncate">{a.title || 'Untitled'}</h3>
                            <Badge variant="default">v{a.version || 1}</Badge>
                            {a.status === 'stale' && <Badge variant="warning"><AlertTriangle size={10} className="mr-1" /> Stale</Badge>}
                          </div>
                          {a.content && <p className="mt-1 text-xs text-text-tertiary line-clamp-2">{a.content.slice(0, 200)}</p>}
                          <p className="mt-1 text-xs text-text-tertiary">
                            {new Date(a.updatedAt || a.createdAt).toLocaleDateString()}
                            {a.sources?.length > 0 && ` · ${a.sources.length} sources`}
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
                            onClick={() => { setEditingArticle(a); setEditArticleTitle(a.title || ''); setEditArticleContent(a.content || ''); }}
                            title="Edit article"
                          ><Edit3 size={14} /></button>
                          {a.status === 'stale' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              isLoading={articleBusy.has(a.id)}
                              onClick={() => regenerateArticle(a.id)}
                            ><RotateCcw size={14} className="mr-1" /> Regenerate</Button>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))}

                  {/* Article edit modal */}
                  {editingArticle && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5">
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-lg font-semibold text-text-primary">Edit Article</h3>
                          <button onClick={() => setEditingArticle(null)}><X size={18} className="text-text-tertiary" /></button>
                        </div>
                        <div className="space-y-3">
                          <div>
                            <label className="block text-sm font-medium text-text-secondary mb-1">Title</label>
                            <Input value={editArticleTitle} onChange={e => setEditArticleTitle(e.target.value)} />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-text-secondary mb-1">Content</label>
                            <Textarea value={editArticleContent} onChange={e => setEditArticleContent(e.target.value)} rows={12} />
                          </div>
                          <div className="flex gap-2 pt-2">
                            <Button size="sm" onClick={saveArticle}><Check size={14} className="mr-1" /> Save</Button>
                            <Button size="sm" variant="secondary" onClick={() => setEditingArticle(null)}>Cancel</Button>
                          </div>
                        </div>
                      </Card>
                    </div>
                  )}
                  {renderPagination(articlePagination.page, articlePagination.totalPages, setArticlePage, articlePagination.start, filteredArticles.length)}
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
                    'facts',
                    (ids: string[]) => api.deleteFacts(ids),
                    'Filter facts by content...',
                  )}
                  {SOURCE_TYPES.map(sourceType => {
                    const groupFacts = factPagination.pageItems.filter(f => f.sourceType === sourceType || (!f.sourceType && sourceType === 'general'));
                    if (groupFacts.length === 0) return null;
                    const Icon = sourceType === 'patient' ? User : sourceType === 'doctor' ? Stethoscope : sourceType === 'research' ? FlaskConical : Globe;
                    const label = sourceType === 'patient' ? 'Patient Facts' : sourceType === 'doctor' ? 'Doctor & Preferences' : sourceType === 'research' ? 'Research & Studies' : 'General';
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
                                    <h4 className="text-sm font-medium text-text-primary">Edit Fact</h4>
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
                                    <Button size="sm" onClick={saveFact}><Check size={14} className="mr-1" /> Save</Button>
                                    <Button size="sm" variant="secondary" onClick={() => setEditingFact(null)}>Cancel</Button>
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
                                      Importance: {f.importance} · Seen {f.count}x · {new Date(f.updatedAt).toLocaleDateString()}
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
                      title="No facts stored yet"
                      hint="Facts are extracted from conversations and imported data."
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
                    'gaps',
                    (ids: string[]) => api.deleteKnowledgeGaps(ids),
                    'Filter gaps by query or context...',
                  )}
                  {gapPagination.pageItems.length === 0 && (
                    <EmptyState
                      icon={<Lightbulb size={24} />}
                      title="No pending knowledge gaps"
                      hint="Gaps appear when queries don't match existing knowledge."
                    />
                  )}
                  {gapPagination.pageItems.map(g => {
                    const statusLabel = g.status === 'open' ? 'Pending' : g.status === 'answered' ? 'Answered' : 'Ignored';
                    const statusVariant = g.status === 'open' ? 'warning' : g.status === 'answered' ? 'success' : 'default';
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
                                <Edit3 size={14} className="mr-1" /> Answer
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => ignoreGap(g.id)}>
                                Ignore
                              </Button>
                              <Button size="sm" variant="ghost" className="border border-border" onClick={() => resolveGap(g.id)}>
                                <Check size={14} className="mr-1" /> Mark resolved
                              </Button>
                            </div>
                          )}
                        </div>
                        {g.status === 'open' && answeringGapId === g.id && (
                          <div className="mt-3 space-y-2 border-t border-border pt-3">
                            <Textarea
                              placeholder="Type the answer or missing information here..."
                              value={gapAnswer}
                              onChange={(e) => setGapAnswer(e.target.value)}
                              rows={3}
                              className="w-full text-sm"
                            />
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="ghost" onClick={() => { setAnsweringGapId(null); setGapAnswer(''); }}>
                                Cancel
                              </Button>
                              <Button size="sm" variant="secondary" disabled={!gapAnswer.trim()} onClick={() => answerGap(g.id)}>
                                Save answer
                              </Button>
                            </div>
                          </div>
                        )}
                        {g.status === 'answered' && g.answerText && (
                          <div className="mt-2 rounded-lg bg-surface-elevated p-2 text-xs text-text-secondary">
                            <span className="font-medium text-text-primary">Answer:</span> {g.answerText}
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
                    'tools',
                    (ids: string[]) => api.deleteKnowledgeTools(ids),
                    'Filter tools by name or description...',
                  )}
                  {toolPagination.pageItems.length === 0 && (
                    <EmptyState
                      icon={<Wrench size={24} />}
                      title="No auto-generated tools yet"
                      hint="Tools are created automatically from knowledge patterns."
                    />
                  )}
                  {toolPagination.pageItems.map(t => (
                    <Card key={t.id} className={cn('p-4', !t.enabled && 'opacity-60')}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              className="rounded border-border mr-2"
                              checked={selectedTools.has(t.id)}
                              onChange={() => toggleSelection(setSelectedTools, t.id)}
                            />
                            <h3 className="font-medium text-sm text-text-primary">{t.name}</h3>
                            <Badge variant="default">{t.language}</Badge>
                            {!t.enabled && <Badge>Disabled</Badge>}
                          </div>
                          {t.description && <p className="mt-1 text-xs text-text-tertiary line-clamp-2">{t.description}</p>}
                          <p className="mt-1 text-xs text-text-tertiary">{new Date(t.createdAt).toLocaleDateString()}</p>
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
                    'files',
                    (ids: string[]) => api.deleteFiles(ids),
                    'Filter files by name...',
                  )}
                  {filePagination.pageItems.length === 0 && (
                    <Card className="p-8 text-center">
                      <FileText size={32} className="mx-auto mb-3 text-text-tertiary" />
                      <p className="text-text-secondary">No uploaded files.</p>
                      <p className="mt-1 text-sm text-text-tertiary">Upload files via chat or the Files page.</p>
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
                        <button
                          className="p-1.5 rounded hover:bg-surface-elevated text-text-tertiary hover:text-error"
                          onClick={async () => {
                            if (confirm(`Delete ${f.name}?`)) {
                              await api.deleteFile(f.file_id).catch(() => {});
                              loadAll();
                            }
                          }}
                        ><Trash2 size={14} /></button>
                      </div>
                    </Card>
                  ))}
                  {renderPagination(filePagination.page, filePagination.totalPages, setFilePage, filePagination.start, filteredFiles.length)}
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
