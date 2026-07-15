import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { Plus, Search, User } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Input, Card, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';

interface Patient {
  hash: string;
  name: string;
  age?: number;
  gender?: string;
  lastVisit?: string;
}

const demoPatients: Patient[] = [
  { hash: 'p1', name: '张三', age: 58, gender: '男', lastVisit: '2026-07-10' },
  { hash: 'p2', name: '李四', age: 42, gender: '女', lastVisit: '2026-07-08' },
];

function PatientList({
  patients,
  selectedHash,
}: {
  patients: Patient[];
  selectedHash?: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const filtered = patients.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

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
          <li key={p.hash}>
            <NavLink
              to={`/app/patients/${p.hash}`}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors',
                selectedHash === p.hash
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary',
              )}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-elevated">
                <User size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="text-xs text-text-tertiary">
                  {p.age}岁 · {p.gender}
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
    { to: `/app/patients/${hash}`, label: t('patient.summary') },
    { to: `/app/patients/${hash}/chat`, label: t('patient.chat') },
    { to: '#', label: t('patient.imaging') },
    { to: '#', label: t('patient.labs') },
    { to: '#', label: t('patient.memory') },
    { to: '#', label: t('patient.report') },
  ];

  return (
    <nav className="flex gap-1 border-b border-border px-6">
      {tabs.map((tab) => (
        <NavLink
          key={tab.label}
          to={tab.to}
          end={tab.to === `/app/patients/${hash}`}
          className={({ isActive }) =>
            cn(
              'border-b-2 px-3 py-3 text-sm font-medium transition-colors',
              isActive
                ? 'border-accent text-accent'
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

  return (
    <AppShell>
      <div className="flex h-full">
        <PatientList patients={demoPatients} selectedHash={hash} />
        <div className="flex min-w-0 flex-1 flex-col">
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

  const patient = demoPatients.find((p) => p.hash === hash);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-text-primary">{patient?.name || hash}</h1>
          <Badge>{patient?.age}岁 · {patient?.gender}</Badge>
        </div>
        <Button size="sm">{t('patient.chat')}</Button>
      </div>
      <PatientTabs hash={hash} />
      <main className="space-y-6 p-6">
        <Card className="p-6">
          <h3 className="mb-2 font-semibold text-text-primary">临床摘要</h3>
          <p className="text-sm text-text-secondary">暂无结构化摘要。开始问诊以提取信息。</p>
        </Card>
        <Card className="p-6">
          <h3 className="mb-2 font-semibold text-text-primary">最近活动</h3>
          <p className="text-sm text-text-secondary">上次访问：{patient?.lastVisit || '—'}</p>
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
