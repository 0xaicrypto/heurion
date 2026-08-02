import { useTranslation } from 'react-i18next';
import { CheckCircle2, ClipboardList, Hourglass } from 'lucide-react';
import { Card, Skeleton } from '@/components/ui';
import type { BrainStats } from '@/lib/types';

interface BrainStatsCardsProps {
  stats: BrainStats | null;
  loading: boolean;
}

export function BrainStatsCards({ stats, loading }: BrainStatsCardsProps) {
  const { t } = useTranslation();

  if (loading || !stats) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
    );
  }

  const cards = [
    { label: t('brain.statsPending'), value: stats.pending, icon: <Hourglass size={20} />, tone: 'bg-warning/10 text-warning' },
    { label: t('brain.statsConfirmedToday'), value: stats.confirmedToday, icon: <CheckCircle2 size={20} />, tone: 'bg-success/10 text-success' },
    { label: t('brain.statsTotalEntries'), value: stats.totalEntries, icon: <ClipboardList size={20} />, tone: 'bg-accent/10 text-accent' },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {cards.map((c) => (
        <Card key={c.label} className="p-4">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${c.tone}`}>{c.icon}</div>
            <div>
              <p className="text-2xl font-bold text-text-primary">{c.value}</p>
              <p className="text-sm text-text-secondary">{c.label}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
