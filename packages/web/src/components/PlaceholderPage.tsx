import { useTranslation } from 'react-i18next';
import { AppShell } from '@/components/layout/AppShell';
import { Card } from '@/components/ui';

export function PlaceholderPage({ ns, title: _title }: { ns: string; title?: string }) {
  const { t } = useTranslation();
  const title = _title || t(`${ns}.title`, t('nav.' + ns));

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{title}</h1>
        </header>
        <main className="p-6">
          <Card className="p-6">
            <p className="text-sm text-text-secondary">
              {t(`${ns}.comingSoon`, t('common.comingSoon'))}
            </p>
          </Card>
        </main>
      </div>
    </AppShell>
  );
}
