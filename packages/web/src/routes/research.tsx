import { useTranslation } from 'react-i18next';
import { AppShell } from '@/components/layout/AppShell';
import { Card } from '@/components/ui';

export function ResearchPage() {
  const { t } = useTranslation();

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('nav.research')}</h1>
        </header>
        <main className="p-6">
          <Card className="p-6">
            <p className="text-sm text-text-secondary">研究工作台功能即将推出。</p>
          </Card>
        </main>
      </div>
    </AppShell>
  );
}
