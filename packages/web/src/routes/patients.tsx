import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { Plus, Search, User } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Button, Input, Card, Badge, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api-client';
import type { Patient } from '@/lib/types';

function PatientList({
  patients,
  selectedHash,
}: {
  patients: Patient[];
  selectedHash?: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const filtered = patients.filter((p) => (p.initials || p.patient_hash).toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="flex h-full w-64 flex-col border-r border-border bg-surface">
      <div className="flex h-14 items-center justify-between border-b border-border px-3">
        <h2 className="font-semibold text-text-primary">{t('nav.patients')}</h2>
        <Button size="sm" variant="ghost">
          <Plus size={16} />
        </Button>
      </div>
      <div className="p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-text-tertiary" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.search')}
            className="pl-9"
          />
        </div>
      </div>
      <ul className="flex-1 overflow-y-auto px-3">
        {filtered.map((p) => (
          <li key={p.patient_hash}>
            <NavLink
              to={`/app/patients/${p.patient_hash}`}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors',
                selectedHash === p.patient_hash
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary',
              )}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-elevated">
                <User size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.initials || p.patient_hash.slice(0, 8)}</p>
                <p className="text-xs text-text-tertiary">
                  {p.age_value != null ? t('common.yearsOld', { age: p.age_value }) : null}
                  {p.age_value != null && p.sex ? ' / ' : ''}
                  {p.sex || ''}
                </p>
              </div>
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PatientTabs({ hash }: { hash?: string }) {
  const { t } = useTranslation();
  const tabs = [
    { to: `/app/patients/${hash}`, label: t('patient.summary'), disabled: false },
    { to: `/app/patients/${hash}/chat`, label: t('patient.chat'), disabled: false },
    { to: '#', label: t('patient.imaging'), disabled: true },
    { to: '#', label: t('patient.labs'), disabled: true },
    { to: '#', label: t('patient.memory'), disabled: true },
    { to: '#', label: t('patient.report'), disabled: true },
  ];

  return (
    <nav className="flex gap-1 border-b border-border px-6">
      {tabs.map((tab) => (
        <NavLink
          key={tab.label}
          to={tab.to}
          aria-disabled={tab.disabled}
          end={tab.to === `/app/patients/${hash}`}
          className={({ isActive }) =>
            cn(
              'border-b-2 px-3 py-3 text-sm font-medium transition-colors',
              isActive
                ? 'border-accent text-accent'
                : tab.disabled
                  ? 'border-transparent text-text-tertiary cursor-default'
                  : 'border-transparent text-text-secondary hover:text-text-primary',
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function PatientsLayout() {
  const { hash } = useParams<{ hash?: string }>();
  const { t } = useTranslation();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listPatients()
      .then(setPatients)
      .catch((err) => setError(err instanceof ApiError ? err.messageText : t('patient.loadPatientsError')))
      .finally(() => setLoading(false));
  }, [t]);

  return (
    <AppShell>
      <div className="flex h-full">
        {loading ? (
          <div className="flex h-full w-64 flex-col border-r border-border bg-surface p-3 gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <PatientList patients={patients} selectedHash={hash} />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {error && (
            <div className="p-3">
              <Alert variant="error">{error}</Alert>
            </div>
          )}
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}

export function PatientSummaryPage() {
  const { t } = useTranslation();
  const { hash } = useParams<{ hash?: string }>();

  if (!hash) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-surface-elevated">
          <User size={28} className="text-text-tertiary" />
        </div>
        <h2 className="text-lg font-semibold text-text-primary">{t('patient.noPatientSelected')}</h2>
        <p className="text-text-secondary">{t('patient.selectPatient')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-text-primary">{hash}</h1>
          <Badge>
            {t('common.yearsOld', { age: '?' })} / {'?'}
          </Badge>
        </div>
        <Button size="sm">{t('patient.chat')}</Button>
      </div>
      <PatientTabs hash={hash} />
      <main className="space-y-6 p-6">
        <Card className="p-6">
          <h3 className="mb-2 font-semibold text-text-primary">{t('patient.clinicalSummary')}</h3>
          <p className="text-sm text-text-secondary">{t('patient.noStructuredSummary')}</p>
        </Card>
        <Card className="p-6">
          <h3 className="mb-2 font-semibold text-text-primary">{t('patient.recentActivity')}</h3>
          <p className="text-sm text-text-secondary">
            {t('patient.lastVisit')}: {t('patient.unavailable')}
          </p>
        </Card>
      </main>
    </div>
  );
}

export function PatientChatPage() {
  const { t } = useTranslation();
  const { hash } = useParams<{ hash: string }>();

  return (
    <div className="flex h-full flex-col">
      <PatientTabs hash={hash} />
      <div className="flex flex-1 items-center justify-center text-text-tertiary">
        <p>{t('patient.chat')} — {hash}</p>
      </div>
    </div>
  );
}
