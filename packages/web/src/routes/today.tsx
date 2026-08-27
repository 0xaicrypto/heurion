import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Activity, FilePlus, FileText, GitGraph, Sparkles, UserPlus } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { NewPatientDialog } from '@/components/NewPatientDialog';
import { PendingIngestionsWidget } from '@/components/today/PendingIngestionsWidget';
import { EmailBindBanner } from '@/components/EmailBindCard';
import { NextBestActions } from '@/components/NextBestActions';
import { PluginExtensionPoint } from '@/components/plugins/PluginExtensionPoint';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/lib/api';
import type { AgentState, Patient, TimelineEvent } from '@/lib/types';
import { Alert, Button, Card, Skeleton } from '@/components/ui';

export function TodayPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { displayName } = useAuthStore();
  const [state, setState] = useState<AgentState | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newPatientOpen, setNewPatientOpen] = useState(false);
  const [profile, setProfile] = useState<{ email?: string } | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // #759: 入组建议聚合卡 — 自动筛查命中且未入组(top N)。
  const [researchSuggestions, setResearchSuggestions] = useState<Array<{ studyId: string; patientHash: string; patientInitials: string; verdict: string; reason: string; screenedAt: string }>>([]);

  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? t('today.morning') : hour < 18 ? t('today.afternoon') : t('today.evening');
  const greeting = t('today.greeting', { time: timeGreeting, name: displayName || '' });

  useEffect(() => {
    api.getUserProfile().then(setProfile).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([
      api.getAgentState().catch(() => null),
      api.getActivity(15).then((r) => r.items).catch(() => []),
      api.listPatients().catch(() => [] as Patient[]),
      api.getRecentResearchSuggestions().catch(() => ({ suggestions: [] })),
    ])
      .then(([s, t, p, sg]) => { setState(s); setTimeline(t); setPatients(p); setResearchSuggestions(sg.suggestions || []); })
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
          {/* #761: 基于状态的下一步建议 — 系统主动引导而非信息墙 */}
          <NextBestActions />
          {/* #285: non-blocking email binding prompt for users without email */}
          {!profile?.email && !bannerDismissed && (
            <EmailBindBanner
              onDismiss={() => setBannerDismissed(true)}
              onBound={(email) => setProfile({ email })}
            />
          )}
          <div>
            <h2 className="text-2xl font-bold text-text-primary">{greeting}</h2>
            <p className="text-text-secondary">{t('today.subtitle')}</p>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <PluginExtensionPoint
            point="dashboard_card"
            context={{ userName: displayName }}
            fallback={null}
          />

          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {/* #728: 统计卡可点击 — 数字引导到对应模块。 */}
              <button
                onClick={() => navigate('/app/patients')}
                className="rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-surface-elevated"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Activity size={20} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-text-primary">{patients.length}</p>
                    <p className="text-sm text-text-secondary">{t('today.activePatients')} →</p>
                  </div>
                </div>
              </button>
              <button
                onClick={() => navigate('/app/memory')}
                className="rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-surface-elevated"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10 text-warning">
                    <FileText size={20} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-text-primary">{pendingCount}</p>
                    <p className="text-sm text-text-secondary">{t('today.pendingReports')} →</p>
                  </div>
                </div>
              </button>
              <button
                onClick={() => navigate('/app/skills')}
                className="rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-surface-elevated"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Sparkles size={20} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-text-primary">{state?.skill_count ?? 0}</p>
                    <p className="text-sm text-text-secondary">{t('today.skills')} →</p>
                  </div>
                </div>
              </button>
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
              <p className="mb-4 text-sm text-text-secondary">Register a patient to begin using Heurion features including chat, memory, and research.</p>
              <Button onClick={() => setNewPatientOpen(true)}>
                <UserPlus size={16} className="mr-2" />
                {t('today.newPatient')}
              </Button>
            </Card>
          )}

          <PendingIngestionsWidget onCountChange={setPendingCount} />

          {/* #759: 入组建议 — 自动筛查命中且未入组的患者,主动举牌而非等医生查 */}
          {researchSuggestions.length > 0 && (
            <Card className="border-accent/30 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
                <GitGraph size={14} className="text-accent" />
                {t('today.enrollSuggestions', '入组建议')}
              </h3>
              <ul className="space-y-1.5">
                {researchSuggestions.map((sg) => (
                  <li key={`${sg.studyId}:${sg.patientHash}`}>
                    <button
                      onClick={() => navigate(`/app/patients/${sg.patientHash}`)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg border border-accent/25 bg-accent/5 px-3 py-2 text-left transition-colors hover:border-accent/60"
                    >
                      <span className="truncate text-sm text-text-primary">
                        {t('today.suggestionRow', '{{initials}} 可能符合一项研究', { initials: sg.patientInitials || sg.patientHash.slice(0, 8) })}
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${sg.verdict === 'eligible' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                        {sg.verdict === 'eligible' ? t('research.eligible', '符合') : t('research.pendingReview', '待复核')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setNewPatientOpen(true)}>
              <UserPlus size={16} className="mr-2" />
              {t('today.newPatient')}
            </Button>
            <Button variant="secondary" onClick={() => navigate('/app/writing?tab=write')}>
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
