import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, Archive, CheckCircle2, Database } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Card, Skeleton } from '@/components/ui';

interface HealthResponse {
  generated_at: string;
  acceptance: {
    approved: number;
    rejected: number;
    rate: number | null;
    by_category: Array<{ category: string; accepted: number; rejected: number; rate: number }>;
  };
  contradictions_7d: number;
  stale: { pending_over_7d: number; high_importance_pinned: number; archived: number };
  scale: { facts: number; articles: number; open_gaps: number; pending: number; episodes: number };
}

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string | number; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-success' : tone === 'warn' ? 'text-warning' : tone === 'bad' ? 'text-error' : 'text-text-primary';
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-xs text-text-tertiary">{icon}{label}</div>
      <div className={`mt-1 text-xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

export function MemoryHealthPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getMemoryHealth());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="mb-4 h-5 w-32" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
        </div>
      </Card>
    );
  }
  if (!data) return null;

  const rate = data.acceptance.rate;
  const rateTone = rate === null ? undefined : rate < 0.5 ? 'bad' : rate < 0.75 ? 'warn' : 'good';

  return (
    <Card className="p-6">
      <h3 className="mb-4 flex items-center gap-2 font-semibold text-text-primary">
        <Activity size={16} className="text-text-tertiary" />
        {t('brain.healthTitle', '记忆健康')}
      </h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={<CheckCircle2 size={14} />}
          label={t('brain.healthAcceptance', '接受率')}
          value={rate === null ? '—' : `${Math.round(rate * 100)}% (${data.acceptance.approved}/${data.acceptance.approved + data.acceptance.rejected})`}
          tone={rateTone}
        />
        <StatCard
          icon={<AlertTriangle size={14} />}
          label={t('brain.healthContradictions', '7天矛盾标记')}
          value={data.contradictions_7d}
          tone={data.contradictions_7d > 0 ? 'warn' : 'good'}
        />
        <StatCard
          icon={<Archive size={14} />}
          label={t('brain.healthStale', '超期 pending')}
          value={`${data.stale.pending_over_7d}${data.stale.high_importance_pinned ? `（${data.stale.high_importance_pinned} 置顶）` : ''}`}
          tone={data.stale.pending_over_7d > 0 ? 'warn' : 'good'}
        />
        <StatCard
          icon={<Database size={14} />}
          label={t('brain.healthScale', '记忆规模')}
          value={`${data.scale.facts} facts · ${data.scale.articles} articles`}
        />
      </div>
      {data.acceptance.by_category.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 text-xs font-medium text-text-tertiary">{t('brain.healthByCategory', '按类别接受率')}</h4>
          <div className="flex flex-wrap gap-2">
            {data.acceptance.by_category.map((c) => (
              <span
                key={c.category}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                  c.rate < 0.3 ? 'border-error/30 bg-error/5 text-error' : c.rate > 0.9 ? 'border-success/30 bg-success/5 text-success' : 'border-border text-text-secondary'
                }`}
              >
                {c.category} {Math.round(c.rate * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
