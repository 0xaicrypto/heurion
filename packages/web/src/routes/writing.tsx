import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, FileText, Send, Trash2, Loader2 , BarChart3, CheckSquare, X, Presentation, ChevronDown } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ChartLibrary } from '@/components/chat/ChartLibrary';
import { SubmissionWorkbench } from '@/routes/submission';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { BottomSheet } from '@/components/ui/Sheet';
import { Alert, Button, Input, Card, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { setPaperLink } from '@/lib/paper-link';

interface Doc {
  id: string;
  title: string;
  updated_at: string;
  ref_count: number;
  /** #996/#1000: 工作台 Slides tab — 有 deck 资产的文档标记。 */
  has_deck?: boolean;
}

type Tab = 'submission' | 'write' | 'slides' | 'library';

/** #362 合并决策: 论文工作台 — 写作 + 投稿一个入口多个 Tab。
 *  #996/#1000: SegmentedControl 收敛 + 新增 Slides tab（deck 库视图，
 *  设计稿口径；无 deck 文档时给引导空态）。 */
export function WritingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);

  // #382: 投稿在前、默认投稿 — 线性流程从选刊开始；?tab=write 直达写作。
  const tab: Tab = useMemo(() => {
    const p = new URLSearchParams(location.search).get('tab');
    return p === 'write' ? 'write' : p === 'slides' ? 'slides' : p === 'library' ? 'library' : 'submission';
  }, [location.search]);

  const switchTab = (next: Tab) => {
    const params = new URLSearchParams();
    if (next !== 'submission') params.set('tab', next);
    navigate({ pathname: '/app/writing', search: params.toString() });
  };

  const tabItems: Array<{ value: Tab; label: string; icon: React.ReactNode }> = [
    { value: 'submission', label: t('submission.title', '投稿'), icon: <Send size={15} /> },
    { value: 'write', label: t('writing.tabWrite', '写作'), icon: <FileText size={15} /> },
    { value: 'slides', label: t('writing.tabSlides', 'Slides'), icon: <Presentation size={15} /> },
    { value: 'library', label: t('charts.library', '图表图库'), icon: <BarChart3 size={15} /> },
  ];

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('writing.title', '论文工作台')}</h1>
          {/* #996/#1001: 桌面 = 胶囊分段控件;窄屏 = 单胶囊 + 底部弹层。 */}
          <div className="hidden md:inline-flex">
            <SegmentedControl
              ariaLabel={t('writing.viewSwitch', '切换视图')}
              value={tab}
              onChange={switchTab}
              items={tabItems}
            />
          </div>
          <div className="md:hidden">
            <Button
              size="sm"
              variant="secondary"
              aria-expanded={sheetOpen}
              onClick={() => setSheetOpen(true)}
            >
              {tabItems.find((it) => it.value === tab)?.label}
              <ChevronDown size={12} className="ml-1" />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          {tab === 'submission' && <SubmissionWorkbench embedded />}
          {tab === 'write' && <WritingList />}
          {tab === 'slides' && <SlidesView />}
          {tab === 'library' && <LibraryView />}
        </div>
      </div>

      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={t('writing.viewSwitch', '切换视图')}>
        <div className="space-y-1">
          {tabItems.map((it) => (
            <button
              key={it.value}
              onClick={() => { setSheetOpen(false); switchTab(it.value); }}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-[15px] transition-colors',
                it.value === tab ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-surface',
              )}
            >
              {it.icon}
              <span className="flex-1">{it.label}</span>
              {it.value === tab && <CheckSquare size={15} className="text-accent" />}
            </button>
          ))}
        </div>
      </BottomSheet>
    </AppShell>
  );
}

function WritingList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // #382: the paper's target journal (from the submission draft) — visible
  // in the Write tab so the workflow feels connected.
  const [targetJournal, setTargetJournal] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templates, setTemplates] = useState<Array<{ id: string; journal_name: string }>>([]);
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const loadDocs = () => {
    setLoading(true);
    setError(null);
    api.listDocs()
      .then((r) => setDocs(r.docs))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadDocs();
    // #382: 联动状态 — submission draft (target journal/template) + template names.
    api.listSubmissionDrafts().then((r) => {
      const d = r.drafts[0];
      if (d) {
        setTargetJournal(d.target_journal || '');
        setTemplateName(d.template_id || '');
      }
    }).catch(() => {});
    api.listFormatTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
    api.listStudies().then((r) => setStudies(r)).catch(() => {});
  }, []);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  // #995: 批量删除 — 多选模式(checkbox)+ 批量操作栏。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const toggleSelect = (docId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId); else next.add(docId);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelected((prev) => (prev.size === docs.length ? new Set() : new Set(docs.map((d) => d.id))));
  };
  const exitSelection = () => setSelected(new Set());

  const handleBatchDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(t('writing.confirmBatchDelete', '确定删除选中的 {{n}} 篇文档？此操作不可撤销。', { n: ids.length }))) return;
    setBatchDeleting(true);
    try {
      const res = await api.batchDeleteDocs(ids);
      setDocs((prev) => prev.filter((d) => !selected.has(d.id)));
      setSelected(new Set());
      if (res.deleted < res.requested) {
        setError(t('writing.batchDeletePartial', '{{n}} 篇已删除，{{m}} 篇未能删除（可能已不存在）', { n: res.deleted, m: res.requested - res.deleted }));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setBatchDeleting(false);
    }
  };
  // #383: 新建论文可选关联研究。
  const [studies, setStudies] = useState<Array<{ study_id: string; display_name: string }>>([]);
  const [selectedStudy, setSelectedStudy] = useState('');

  const handleDelete = async (docId: string) => {
    if (!window.confirm(t('writing.confirmDelete', '确定删除这篇文档？此操作不可撤销。'))) return;
    setDeletingId(docId);
    try {
      await api.deleteDoc(docId);
      setDocs((prev) => prev.filter((d) => d.id !== docId));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const doc = await api.createDoc(newTitle.trim(), selectedStudy || undefined);
      setNewTitle('');
      setShowForm(false);
      setSelectedStudy('');
      setPaperLink({ title: doc.title, abstract: '', docId: doc.id, updatedAt: Date.now() });
      navigate(`/app/writing/${doc.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-text-primary">{t('writing.title', 'Writing Studio')}</h1>
          {targetJournal && (
            <span className="rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-xs text-accent">
              {t('submission.targetJournalShort', '目标期刊')}: {targetJournal}
            </span>
          )}
          {templateName && (
            <span className="rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary">
              {t('submission.templateAppliedShort', '已应用模板')}: {templates.find((t) => t.id === templateName)?.journal_name || templateName}
            </span>
          )}
        </div>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus size={16} className="mr-1" /> {t('writing.newDoc', 'New Document')}
        </Button>
      </header>

        {showForm && (
          <div className="border-b border-border bg-surface-elevated px-6 py-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1">
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder={t('writing.docTitle', 'Document title')}
                  onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') handleCreate(); }}
                />
              </div>
              <select
                value={selectedStudy}
                onChange={(e) => setSelectedStudy(e.target.value)}
                className="h-9 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('writing.studySelect', '关联研究（可选）')}
              >
                <option value="">{t('writing.studySelect', '关联研究（可选）')}</option>
                {studies.map((st) => (
                  <option key={st.study_id} value={st.study_id}>{st.display_name}</option>
                ))}
              </select>
              <Button onClick={handleCreate} disabled={!newTitle.trim() || creating} isLoading={creating}>
                {t('common.create', 'Create')}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-6 pt-4">
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        {selected.size > 0 && (
          /* #995: 批量操作栏 — 选中态常驻顶部,不随滚动消失 */
          <div className="flex items-center justify-between gap-3 border-b border-border bg-accent/5 px-6 py-2.5">
            <div className="flex items-center gap-2 text-sm text-text-primary">
              <CheckSquare size={15} className="text-accent" />
              {t('writing.selectedCount', '已选 {{n}} 篇', { n: selected.size })}
              <button onClick={toggleSelectAll} className="text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
                {selected.size === docs.length ? t('writing.selectAllNone', '取消全选') : t('writing.selectAll', '全选')}
              </button>
              <button onClick={exitSelection} className="rounded p-1 text-text-tertiary hover:text-text-primary" aria-label={t('writing.exitSelection', '退出多选')}>
                <X size={14} />
              </button>
            </div>
            <Button size="sm" variant="ghost" onClick={handleBatchDelete} disabled={batchDeleting} isLoading={batchDeleting} className="text-error">
              <Trash2 size={14} className="mr-1" /> {t('writing.batchDelete', '删除 {{n}} 篇', { n: selected.size })}
            </Button>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-14 w-full rounded-xl" />
              <Skeleton className="h-14 w-full rounded-xl" />
              <Skeleton className="h-14 w-full rounded-xl" />
            </div>
          ) : docs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <FileText size={40} className="mb-3 text-text-tertiary" />
              <p className="text-lg text-text-tertiary">{t('writing.noDocs', 'No documents yet')}</p>
              <p className="text-sm text-text-tertiary">{t('writing.createFirst', 'Create your first document')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {docs.map((d) => (
                <div key={d.id} className={cn('group relative block rounded-xl transition-colors', selected.has(d.id) ? 'bg-accent/5' : 'hover:bg-surface')}>
                {/* #995: 多选 checkbox — 批量删除入口(与单个删除按钮并存) */}
                <label className="absolute left-3 top-1/2 z-10 -translate-y-1/2 cursor-pointer p-1" aria-label={t('writing.selectDoc', '选择文档')}>
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onChange={() => toggleSelect(d.id)}
                    className="h-4 w-4 cursor-pointer accent-accent"
                  />
                </label>
                <Link
                  to={`/app/writing/${d.id}`}
                  onClick={() => setPaperLink({ title: d.title || '', abstract: '', docId: d.id, updatedAt: Date.now() })}
                  className="block"
                >
                  <Card className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      {/* 文档标识图标移左侧 — 与删除按钮分开,不再重叠 */}
                      <FileText size={18} className="ml-7 shrink-0 text-accent/70" />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate font-medium text-text-primary">{d.title || t('writing.untitled', 'Untitled')}</h3>
                        <p className="text-xs text-text-tertiary">
                          {new Date(d.updated_at).toLocaleDateString()}
                          {d.ref_count > 0 ? ` · ${d.ref_count} ${t('writing.refs', 'references')}` : ''}
                        </p>
                      </div>
                    </div>
                  </Card>
                </Link>
                <button
                  onClick={() => handleDelete(d.id)}
                  disabled={deletingId === d.id}
                  title={t('common.delete', '删除')}
                  aria-label={t('common.delete', '删除')}
                  // 右端常显,不再覆盖左侧文档图标;触屏也可达。
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface-elevated hover:text-error disabled:opacity-40"
                >
                  {deletingId === d.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
  );
}


/** #996/#1000: Slides tab（deck 库视图，设计稿口径）— 有 deck 资产的文档
 *  列表，直达编辑器幻灯片视图（?view=deck）；无 deck 时给引导空态。 */
function SlidesView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.listDocs()
      .then((r) => setDocs(r.docs.filter((d) => d.has_deck)))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-3">
        <h2 className="text-sm font-semibold text-text-primary">{t('writing.tabSlides', 'Slides')}</h2>
        <p className="text-xs text-text-tertiary">{t('writing.slidesHint', 'AI 编排过的幻灯片资产（每篇论文一份）。打开后可编辑页标题/要点并导出 PPT。')}</p>
      </div>
      <main className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4">
            <Alert variant="error">{error}</Alert>
          </div>
        )}
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Presentation size={40} className="mb-3 text-text-tertiary" />
            <p className="text-lg text-text-tertiary">{t('writing.slidesEmpty', '还没有幻灯片')}</p>
            <p className="text-sm text-text-tertiary">{t('writing.slidesEmptyHint', '打开一篇论文，切换到「幻灯片」视图让 AI 编排内容')}</p>
            <Button size="sm" className="mt-4" onClick={() => navigate('/app/writing?tab=write')}>
              {t('writing.tabWrite', '写作')}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <Card key={d.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Presentation size={18} className="shrink-0 text-accent/70" />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-medium text-text-primary">{d.title || t('writing.untitled', 'Untitled')}</h3>
                      <p className="text-xs text-text-tertiary">{new Date(d.updated_at).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => navigate(`/app/writing/${d.id}?view=deck`)}
                  >
                    <Presentation size={14} className="mr-1" /> {t('writing.openSlides', '打开幻灯片')}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

/* #481-followup: chart library entry point on the writing workbench.
 * Read-only management here (view/copy/delete) — inserting into a
 * document happens inside a specific document's right panel. */
function LibraryView() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-3">
        <h2 className="text-sm font-semibold text-text-primary">{t('charts.library', '图表图库')}</h2>
        <p className="text-xs text-text-tertiary">{t('charts.libraryHint', 'AI 生成过的全部图表（Reactome 官方通路图 + 自定义示意图 + 统计图）。打开文档后可在右侧面板直接插入。')}</p>
      </div>
      <div className="min-h-0 flex-1">
        <ChartLibrary />
      </div>
    </div>
  );
}
