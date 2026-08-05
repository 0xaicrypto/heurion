import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { BrainStatsCards } from '@/components/brain/BrainStatsCards';
import { MemoryHealthPanel } from '@/components/brain/MemoryHealthPanel';
import { IngestionInbox } from '@/components/brain/IngestionInbox';
import { RecentActivityFeed } from '@/components/brain/RecentActivityFeed';
import { api } from '@/lib/api-client';
import type { BrainStats } from '@/lib/types';

export function BrainPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<BrainStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      setStats(await api.getBrainStats());
    } catch {
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleChanged = () => {
    loadStats();
    setActivityRefreshKey((k) => k + 1);
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-6">
          <Brain size={18} className="text-text-tertiary" />
          <h1 className="font-semibold text-text-primary">{t('brain.title')}</h1>
        </header>

        <main className="space-y-6 p-6">
          <BrainStatsCards stats={stats} loading={statsLoading} />
          <MemoryHealthPanel />
          <IngestionInbox onChanged={handleChanged} />
          <RecentActivityFeed refreshKey={activityRefreshKey} />
        </main>
      </div>
    </AppShell>
  );
}
