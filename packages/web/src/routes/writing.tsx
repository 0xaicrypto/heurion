import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, FileText, Send, Trash2, Loader2 } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SubmissionWorkbench } from '@/routes/submission';
import { Alert, Button, Input, Card, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { setPaperLink } from '@/lib/paper-link';

interface Doc {
  id: string;
  title: string;
  updated_at: string;
  ref_count: number;
}

type Tab = 'write' | 'submission';

/** #362 合并决策: 论文工作台 — 写作 + 投稿一个入口两个 Tab。 */
export function WritingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  // #382: 投稿在前、默认投稿 — 线性流程从选刊开始；?tab=write 直达写作。
  const tab: Tab = useMemo(() => {
    const p = new URLSearchParams(location.search).get('tab');
    return p === 'write' ? 'write' : 'submission';
  }, [location.search]);

  const switchTab = (next: Tab) => {
    const params = new URLSearchParams();
    if (next !== 'submission') params.set('tab', next);
    navigate({ pathname: '/app/writing', search: params.toString() });
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('writing.title', '论文工作台')}</h1>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-elevated p-0.5">
            <button
              onClick={() => switchTab('submission')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors',
                tab === 'submission' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <Send size={15} />
              {t('submission.title', '投稿')}
            </button>
            <button
              onClick={() => switchTab('write')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors',
                tab === 'write' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <FileText size={15} />
              {t('writing.tabWrite', '写作')}
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          {tab === 'submission' ? <SubmissionWorkbench embedded /> : <WritingList />}
        </div>
      </div>
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
  }, []);

  const [deletingId, setDeletingId] = useState<string | null>(null);

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
      const doc = await api.createDoc(newTitle.trim());
      setNewTitle('');
      setShowForm(false);
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
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder={t('writing.docTitle', 'Document title')}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                />
              </div>
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
                <div key={d.id} className="group relative block rounded-xl transition-colors hover:bg-surface">
                <Link
                  to={`/app/writing/${d.id}`}
                  onClick={() => setPaperLink({ title: d.title || '', abstract: '', docId: d.id, updatedAt: Date.now() })}
                  className="block"
                >
                  <Card className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-text-primary">{d.title || t('writing.untitled', 'Untitled')}</h3>
                        <p className="text-xs text-text-tertiary">
                          {new Date(d.updated_at).toLocaleDateString()}
                          {d.ref_count > 0 ? ` · ${d.ref_count} ${t('writing.refs', 'references')}` : ''}
                        </p>
                      </div>
                      <FileText size={16} className="text-text-tertiary" />
                    </div>
                  </Card>
                </Link>
                <button
                  onClick={() => handleDelete(d.id)}
                  disabled={deletingId === d.id}
                  title={t('common.delete', '删除')}
                  className="absolute right-4 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-text-tertiary opacity-0 transition-opacity hover:bg-surface-elevated hover:text-error focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
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
