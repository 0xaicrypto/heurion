import { useTranslation } from 'react-i18next';
import { Activity, FileText, AlertCircle, UserPlus, FilePlus } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { useAuthStore } from '@/stores/auth';
import { Button, Card } from '@/components/ui';

export function TodayPage() {
  const { t } = useTranslation();
  const { displayName } = useAuthStore();

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('today.title')}</h1>
        </header>

        <main className="space-y-6 p-6">
          <div>
            <h2 className="text-2xl font-bold text-text-primary">
              {t('today.greeting', { name: displayName || t('common.login') })}
            </h2>
            <p className="text-text-secondary">{t('chat.contextHint')}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <Activity size={20} />
                </div>
                <div>
                  <p className="text-2xl font-bold text-text-primary">0</p>
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
                  <p className="text-2xl font-bold text-text-primary">0</p>
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
                  <p className="text-2xl font-bold text-text-primary">0</p>
                  <p className="text-sm text-text-secondary">{t('today.unresolvedConflicts')}</p>
                </div>
              </div>
            </Card>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button>
              <UserPlus size={16} className="mr-2" />
              {t('today.newPatient')}
            </Button>
            <Button variant="secondary">
              <FilePlus size={16} className="mr-2" />
              {t('today.newDocument')}
            </Button>
          </div>

          <Card className="p-6">
            <h3 className="mb-4 font-semibold text-text-primary">{t('today.recentActivity')}</h3>
            <p className="text-sm text-text-tertiary">{t('today.empty')}</p>
          </Card>
        </main>
      </div>
    </AppShell>
  );
}
