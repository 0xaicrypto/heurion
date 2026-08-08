import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, FileText, Send } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SubmissionWorkbench } from '@/routes/submission';
import { Alert, Button, Input, Card, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

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

  const tab: Tab = useMemo(() => {
    const p = new URLSearchParams(location.search).get('tab');
    return p === 'submission' ? 'submission' : 'write';
  }, [location.search]);

  const switchTab = (next: Tab) => {
    const params = new URLSearchParams();
    if (next !== 'write') params.set('tab', next);
    navigate({ pathname: '/app/writing', search: params.toString() });
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('writing.title', '论文工作台')}</h1>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-elevated p-0.5">
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
  }, []);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const doc = await api.createDoc(newTitle.trim());
      setNewTitle('');
      setShowForm(false);
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
        <h1 className="font-semibold text-text-primary">{t('writing.title', 'Writing Studio')}</h1>
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
                <Link
                  key={d.id}
                  to={`/app/writing/${d.id}`}
                  className="block rounded-xl transition-colors hover:bg-surface"
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
              ))}
            </div>
          )}
        </main>
      </div>
  );
}
