import { useTranslation } from 'react-i18next';
import { AppShell } from '@/components/layout/AppShell';
import { Card } from '@/components/ui';

export function SettingsPage() {
  const { t } = useTranslation();

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('settings.title')}</h1>
        </header>
        <main className="space-y-6 p-6">
          <Card className="p-6">
            <h3 className="mb-2 font-semibold text-text-primary">{t('settings.profile')}</h3>
            <p className="text-sm text-text-secondary">个人资料设置即将推出。</p>
          </Card>
          <Card className="p-6">
            <h3 className="mb-2 font-semibold text-text-primary">{t('settings.llm')}</h3>
            <p className="text-sm text-text-secondary">模型配置设置即将推出。</p>
          </Card>
          <Card className="p-6">
            <h3 className="mb-2 font-semibold text-text-primary">{t('settings.data')}</h3>
            <p className="text-sm text-text-secondary">数据导出和归档设置即将推出。</p>
          </Card>
        </main>
      </div>
    </AppShell>
  );
}
