import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Plus, FlaskConical } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Button, Input, Card, Badge, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface Study {
  study_id: string;
  display_name: string;
  status: string;
  short_code?: string;
  created_at: string;
}

export function ResearchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
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
    if (!newName.trim() || !newCode.trim()) return;
    setCreating(true);
    try {
      await api.createStudy({ display_name: newName.trim(), short_code: newCode.trim() });
      setNewName('');
      setNewCode('');
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
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('research.title', 'Research')}</h1>
          <Button size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus size={16} className="mr-1.5" />
            New Study
          </Button>
        </header>
        <main className="space-y-4 p-6">
          {error && <Alert variant="error">{error}</Alert>}

          {showForm && (
            <Card className="space-y-4 p-4">
              <h3 className="font-medium text-text-primary">Create Study</h3>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-medium text-text-secondary">Name *</label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Study display name"
                  />
                </div>
                <div className="w-32">
                  <label className="mb-1 block text-xs font-medium text-text-secondary">Code *</label>
                  <Input
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value)}
                    placeholder="e.g. CARD"
                  />
                </div>
                <div className="flex items-end">
                  <Button onClick={handleCreate} isLoading={creating} disabled={!newName.trim() || !newCode.trim()} size="sm">
                    Create
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          ) : studies.length === 0 && !error ? (
            <Card className="p-8 text-center">
              <FlaskConical size={32} className="mx-auto mb-3 text-text-tertiary" />
              <p className="text-text-secondary">No studies yet. Click "New Study" to create one.</p>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {studies.map((study) => (
                <Card
                  key={study.study_id}
                  className={cn('cursor-pointer p-4 transition-colors hover:border-accent/40')}
                >
                  <div className="flex items-start justify-between" onClick={() => navigate(`/app/research/${study.study_id}`)}>
                    <div className="min-w-0 flex-1 cursor-pointer" onClick={() => navigate(`/app/research/${study.study_id}`)}>
                      <h3 className="truncate font-medium text-text-primary">{study.display_name}</h3>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                        <span className="font-mono">{study.study_id}</span>
                        {study.short_code && <span>· {study.short_code}</span>}
                      </div>
                    </div>
                    <Badge variant={statusVariant(study.status)}>{study.status}</Badge>
                  </div>
                  <p className="mt-2 text-xs text-text-tertiary">
                    Created {new Date(study.created_at).toLocaleDateString()}
                  </p>
                </Card>
              ))}
            </div>
          )}
        </main>
      </div>
    </AppShell>
  );
}
