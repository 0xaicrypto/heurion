import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface StudyDetail {
  study_id: string;
  title: string;
  status: string;
  protocol_id?: string;
  created_at: string;
  updated_at?: string;
  description?: string;
}

type Tab = 'overview' | 'roster' | 'eligibility' | 'safety';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'roster', label: 'Roster' },
  { key: 'eligibility', label: 'Eligibility' },
  { key: 'safety', label: 'Safety' },
];

export function ResearchDetailPage() {
  const { studyId } = useParams<{ studyId: string }>();
  const navigate = useNavigate();
  const [study, setStudy] = useState<StudyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    if (!studyId) return;
    setLoading(true);
    setError(null);
    api.getStudy(studyId)
      .then(setStudy)
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, [studyId]);

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

  const TabStub = ({ label }: { label: string }) => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <FlaskConical size={36} className="mb-3 text-text-tertiary" />
      <p className="text-text-tertiary">{label} — coming soon</p>
    </div>
  );

  if (loading) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6 gap-3">
            <Skeleton className="h-5 w-5" />
            <Skeleton className="h-5 w-48" />
          </div>
          <div className="p-6 space-y-4">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        </div>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6">
            <Button variant="ghost" size="sm" onClick={() => navigate('/app/research')}>
              <ArrowLeft size={16} className="mr-1" /> Back
            </Button>
          </div>
          <div className="p-6">
            <Alert variant="error">{error}</Alert>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!study) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6">
            <Button variant="ghost" size="sm" onClick={() => navigate('/app/research')}>
              <ArrowLeft size={16} className="mr-1" /> Back
            </Button>
          </div>
          <div className="flex flex-1 items-center justify-center">
            <p className="text-text-tertiary">Study not found</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-surface px-6">
          <Button variant="ghost" size="sm" onClick={() => navigate('/app/research')}>
            <ArrowLeft size={16} />
          </Button>
          <h1 className="font-semibold text-text-primary">{study.title}</h1>
          <Badge variant={statusVariant(study.status)}>{study.status}</Badge>
        </header>

        <nav className="flex gap-1 border-b border-border px-6">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                tab === t.key
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text-primary',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <main className="flex-1 p-6">
          {tab === 'overview' && (
            <div className="max-w-2xl space-y-4">
              <Card className="p-6 space-y-3">
                <div>
                  <div className="text-xs text-text-tertiary">Study ID</div>
                  <div className="font-mono text-sm text-text-secondary">{study.study_id}</div>
                </div>
                {study.protocol_id && (
                  <div>
                    <div className="text-xs text-text-tertiary">Protocol ID</div>
                    <div className="text-sm text-text-primary">{study.protocol_id}</div>
                  </div>
                )}
                <div>
                  <div className="text-xs text-text-tertiary">Created</div>
                  <div className="text-sm text-text-primary">{new Date(study.created_at).toLocaleDateString()}</div>
                </div>
                {study.updated_at && (
                  <div>
                    <div className="text-xs text-text-tertiary">Updated</div>
                    <div className="text-sm text-text-primary">{new Date(study.updated_at).toLocaleDateString()}</div>
                  </div>
                )}
                {study.description && (
                  <div>
                    <div className="text-xs text-text-tertiary">Description</div>
                    <div className="text-sm text-text-primary">{study.description}</div>
                  </div>
                )}
              </Card>
            </div>
          )}
          {tab === 'roster' && <TabStub label="Roster" />}
          {tab === 'eligibility' && <TabStub label="Eligibility" />}
          {tab === 'safety' && <TabStub label="Safety" />}
        </main>
      </div>
    </AppShell>
  );
}
