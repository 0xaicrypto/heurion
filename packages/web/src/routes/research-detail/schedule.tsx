import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { Badge, Button, Skeleton } from '@/components/ui';
import type { Assessment } from './types';

export function ScheduleTab({ assessments, loading, completingIds, onComplete }: {
  assessments: Assessment[];
  loading: boolean;
  completingIds: Set<string>;
  onComplete: (visitId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-w-3xl space-y-4">
      <h2 className="text-sm font-semibold text-text-secondary">{t('research.scheduledAssessments', '随访评估')}</h2>
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : assessments.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border py-12 text-center">
          <CalendarDays size={36} className="mb-3 text-text-tertiary" />
          <p className="text-text-tertiary">{t('research.noScheduledAssessments', '暂无随访计划')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.date', '日期')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patient', '患者')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patientId', '患者 ID')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.basicInfo', '基本信息')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.status', '状态')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary"></th>
              </tr>
            </thead>
            <tbody>
              {assessments.map((a) => (
                <tr key={a.visit_id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 text-text-primary">{new Date(a.scheduled_at).toLocaleString()}</td>
                  <td className="px-4 py-2 text-text-primary">{a.name || a.initials || '—'}</td>
                  <td className="px-4 py-2 font-mono text-text-secondary">{a.patient_hash.slice(0, 16)}...</td>
                  <td className="px-4 py-2 text-text-secondary">
                    {a.age_value != null ? `${a.age_value}y` : '—'}
                    {a.age_value != null && a.sex ? ' / ' : ''}
                    {a.sex || ''}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={a.status === 'completed' ? 'success' : a.status === 'pending' ? 'warning' : 'default'}>
                      {a.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2">
                    {a.recent_entries && a.recent_entries.length > 0 ? (
                      <details className="max-w-[260px]">
                        <summary className="cursor-pointer text-xs text-accent">{t('research.visitEntries', '检查数据')} ({a.recent_entries.length})</summary>
                        <ul className="mt-1 space-y-1">
                          {a.recent_entries.map((e, i) => (
                            <li key={i} className="text-[11px] text-text-secondary">
                              <span className="rounded border border-border px-1 text-[9px] text-text-tertiary">{e.type}</span>{' '}
                              <span className="font-medium">{e.title}</span>
                              <span className="text-text-tertiary"> · {e.date ? new Date(e.date).toLocaleDateString() : ''}</span>
                              <div className="line-clamp-2 text-text-tertiary">{e.content}</div>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <span className="text-xs text-text-tertiary">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {a.status !== 'completed' && (
                      <Button
                        size="sm"
                        onClick={() => onComplete(a.visit_id)}
                        isLoading={completingIds.has(a.visit_id)}
                        disabled={completingIds.has(a.visit_id)}
                      >
                        {t('research.complete', '完成')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
