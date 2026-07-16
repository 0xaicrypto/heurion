import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Plus, FlaskConical } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Button, Input, Card, Badge, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

interface Study {
  study_id: string;
  title: string;
  status: string;
  protocol_id?: string;
  created_at: string;
}

export function ResearchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newProtocol, setNewProtocol] = useState('');
  const [creating, setCreating] = useState(false);

  const loadStudies = () => {
    setLoading(true);
    setError(null);
    api.listStudies()
      .then(setStudies)
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadStudies();
  }, []);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      await api.createStudy({ title: newTitle.trim(), protocol_id: newProtocol.trim() || undefined });
      setNewTitle('');
      setNewProtocol('');
      setShowForm(false);
      loadStudies();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setCreating(false);
    }
  };

  const statusVariant = (s: string): 'default' | 'success' | 'warning' | 'error' => {
    switch (s.toLowerCase()) {
      case 'completed': return 'success';
      case 'in_progress':
      case 'running': return 'warning';
      case 'failed':
      case 'error': return 'error';
      default: return 'default';
    }
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('research.title', 'Research')}</h1>
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            <Plus size={16} className="mr-1" /> {t('research.newStudy', 'New Study')}
          </Button>
        </header>

        {showForm && (
          <div className="border-b border-border bg-surface-elevated px-6 py-4">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder={t('research.studyTitle', 'Study title')}
                />
              </div>
              <div className="w-48">
                <Input
                  value={newProtocol}
                  onChange={(e) => setNewProtocol(e.target.value)}
                  placeholder={t('research.protocolId', 'Protocol ID (optional)')}
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
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
            </div>
          ) : studies.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <FlaskConical size={40} className="mb-3 text-text-tertiary" />
              <p className="text-lg text-text-tertiary">{t('research.noStudies', 'No studies yet')}</p>
              <p className="text-sm text-text-tertiary">{t('research.createFirst', 'Create your first research study')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {studies.map((s) => (
                <div
                  key={s.study_id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/app/research/${s.study_id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') navigate(`/app/research/${s.study_id}`); }}
                >
                  <Card className="p-4 transition-colors hover:bg-surface">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-text-primary">{s.title}</h3>
                        <p className="text-xs text-text-tertiary">
                          {s.protocol_id ? `Protocol: ${s.protocol_id} · ` : ''}
                          {new Date(s.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                    </div>
                  </Card>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </AppShell>
  );
}
