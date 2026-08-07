import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import { api } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { Card, Skeleton } from '@/components/ui';
import type { AuditLogEntry } from '@/lib/types';

interface RecentActivityFeedProps {
  refreshKey: number;
}

export function RecentActivityFeed({ refreshKey }: RecentActivityFeedProps) {
  const { t, i18n } = useTranslation();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [patientNames, setPatientNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.listAuditLogs({ targetType: 'MedicalRecordEntry' }),
      api.listPatients().catch(() => [] as never[]),
    ])
      .then(([res, patients]) => {
        if (cancelled) return;
        const names = new Map((patients as Array<{ patient_hash: string; name?: string }>).map((p) => [p.patient_hash, p.name ?? '']));
        setPatientNames(names);
        setLogs(res.logs.slice(0, 20));
      })
      .catch(() => {
        if (!cancelled) setLogs([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const describe = (log: AuditLogEntry) => {
    const title = log.entry?.title;
    if (!title) return null;
    if (log.action === 'approval.confirmed') return t('brain.activityConfirmed', { title });
    if (log.action === 'approval.rejected') return t('brain.activityRejected', { title });
    return null;
  };

  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="mb-4 h-5 w-32" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h3 className="mb-4 flex items-center gap-2 font-semibold text-text-primary">
        <Activity size={16} className="text-text-tertiary" />
        {t('brain.activityTitle')}
      </h3>

      {logs.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('brain.activityEmpty')}</p>
      ) : (
        <ul className="space-y-3">
          {logs.map((log) => {
            const text = describe(log);
            if (!text) return null;
            const patientName = log.entry ? patientNames.get(log.entry.patientHash) : undefined;
            return (
              <li key={log.id} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5 shrink-0 text-xs text-text-tertiary tabular-nums">
                  {formatRelativeTime(log.createdAt, i18n.language)}
                </span>
                <span className="text-text-secondary">
                  {patientName ? `${patientName} · ` : ''}
                  {text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
