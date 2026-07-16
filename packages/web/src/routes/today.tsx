import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertCircle, FilePlus, FileText, UserPlus } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { NewPatientDialog } from '@/components/NewPatientDialog';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/lib/api-client';
import type { AgentState, Patient, TimelineEvent } from '@/lib/types';
import { Alert, Button, Card, Skeleton } from '@/components/ui';

export function TodayPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { displayName } = useAuthStore();
  const [state, setState] = useState<AgentState | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newPatientOpen, setNewPatientOpen] = useState(false);

  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? t('today.morning') : hour < 18 ? t('today.afternoon') : t('today.evening');
  const greeting = t('today.greeting', { time: timeGreeting, name: displayName || '' });

  useEffect(() => {
    Promise.all([
      api.getAgentState().catch(() => null),
      api.getTimeline(10).then((r) => r.items).catch(() => []),
      api.listPatients().catch(() => [] as Patient[]),
    ])
      .then(([s, t, p]) => { setState(s); setTimeline(t); setPatients(p); })
      .catch(() => setError('Failed to load dashboard'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('today.title')}</h1>
        </header>

        <main className="space-y-6 p-6">
          <div>
            <h2 className="text-2xl font-bold text-text-primary">{greeting}</h2>
            <p className="text-text-secondary">{t('today.subtitle')}</p>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Card className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Activity size={20} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-text-primary">{patients.length}</p>
                    <p className="text-sm text-text-secondary">{t('today.activePatients')}</p>
                  </div>
                </div>
              </Card>
              <Card className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10 text-warning">
                    <FileText size={20} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-text-primary">{state?.total_anchor_count ?? 0}</p>
                    <p className="text-sm text-text-secondary">{t('today.pendingReports')}</p>
                  </div>
                </div>
              </Card>
              <Card className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-error/10 text-error">
                    <AlertCircle size={20} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-text-primary">{state?.failed_anchor_count ?? 0}</p>
                    <p className="text-sm text-text-secondary">{t('today.unresolvedConflicts')}</p>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {!loading && patients.length === 0 && (
            <Card className="p-8 text-center">
              <div className="mb-4 flex justify-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10">
                  <UserPlus size={28} className="text-accent" />
                </div>
              </div>
              <h3 className="mb-1 text-lg font-semibold text-text-primary">Create your first patient to get started</h3>
              <p className="mb-4 text-sm text-text-secondary">Register a patient to begin using Nexus features including chat, memory, and research.</p>
              <Button onClick={() => setNewPatientOpen(true)}>
                <UserPlus size={16} className="mr-2" />
                {t('today.newPatient')}
              </Button>
            </Card>
          )}

          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setNewPatientOpen(true)}>
              <UserPlus size={16} className="mr-2" />
              {t('today.newPatient')}
            </Button>
            <Button variant="secondary" onClick={() => navigate('/app/writing')}>
              <FilePlus size={16} className="mr-2" />
              {t('today.newDocument')}
            </Button>
          </div>

          <Card className="p-6">
            <h3 className="mb-4 font-semibold text-text-primary">{t('today.recentActivity')}</h3>
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : timeline.length === 0 ? (
              <p className="text-sm text-text-tertiary">{t('today.empty')}</p>
            ) : (
              <ul className="space-y-3">
                {timeline.slice(0, 15).map((ev, i) => (
                  <li key={ev.sync_id || i} className="flex items-start gap-3 text-sm">
                    <span className="mt-0.5 shrink-0 text-xs text-text-tertiary tabular-nums">
                      {new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="text-text-secondary">{ev.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </main>
      </div>
      <NewPatientDialog
        open={newPatientOpen}
        onClose={() => setNewPatientOpen(false)}
        onCreated={(patientHash) => { setNewPatientOpen(false); navigate(`/app/patients/${patientHash}`); }}
      />
    </AppShell>
  );
}
