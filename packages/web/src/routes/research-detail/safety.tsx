import { useTranslation } from 'react-i18next';
import { Check, FlaskConical } from 'lucide-react';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Observation, SafetyStatus } from './types';

const aeGradeColor = (grade?: number) => {
  if (!grade) return 'text-text-secondary';
  return grade >= 3 ? 'text-error' : 'text-warning';
};

export function SafetyTab({ observations, safetyStatus, loading, confirmingObs, confirmingIds, onConfirm, onFormChange }: {
  observations: Observation[];
  safetyStatus: SafetyStatus | null;
  loading: boolean;
  confirmingObs: Record<string, { aeGrade?: number; isDlt?: boolean }>;
  confirmingIds: Set<string>;
  onConfirm: (obsId: string) => void;
  onFormChange: (obsId: string, field: 'aeGrade' | 'isDlt', value: number | boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-w-3xl space-y-4">
      <h2 className="text-sm font-semibold text-text-secondary">{t('research.tabSafety', '安全性')}</h2>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : (
        <>
          {safetyStatus && safetyStatus.triggered_rules.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-medium text-text-primary">{t('research.stopRulesTriggered', '已触发停止规则')}</h3>
              <div className="space-y-2">
                {safetyStatus.triggered_rules.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <Badge variant="error">{r.rule}</Badge>
                    <span className="text-text-secondary">{r.description}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {observations.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-border py-12 text-center">
              <FlaskConical size={36} className="mb-3 text-text-tertiary" />
              <p className="text-text-tertiary">{t('research.noObservations', '暂无安全性记录')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface">
                    <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patient', '患者')}</th>
                    <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patientId', '患者 ID')}</th>
                    <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.basicInfo', '基本信息')}</th>
                    <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.category', '类别')}</th>
                    <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.aeGrade', 'AE 等级')}</th>
                    <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.dltHeader', 'DLT')}</th>
                    <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.date', '日期')}</th>
                    <th className="px-4 py-2 text-left font-medium text-text-secondary"></th>
                  </tr>
                </thead>
                <tbody>
                  {observations.map((o) => (
                    <tr key={o.observation_id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 text-text-primary">{o.name || o.initials || '—'}</td>
                      <td className="px-4 py-2 font-mono text-text-secondary">{o.patient_hash.slice(0, 16)}...</td>
                      <td className="px-4 py-2 text-text-secondary">
                        {o.age_value != null ? `${o.age_value}y` : '—'}
                        {o.age_value != null && o.sex ? ' / ' : ''}
                        {o.sex || ''}
                      </td>
                      <td className="px-4 py-2 text-text-secondary">{o.category}</td>
                      <td className={cn('px-4 py-2 font-medium', aeGradeColor(o.ae_grade))}>
                        {o.confirmed ? (
                          o.ae_grade ?? '—'
                        ) : (
                          <select
                            className="rounded border border-border bg-surface px-2 py-1 text-sm"
                            value={confirmingObs[o.observation_id]?.aeGrade ?? ''}
                            onChange={(e) => onFormChange(o.observation_id, 'aeGrade', e.target.value ? Number(e.target.value) : undefined as unknown as number)}
                          >
                            <option value="">—</option>
                            <option value="1">1</option>
                            <option value="2">2</option>
                            <option value="3">3</option>
                            <option value="4">4</option>
                            <option value="5">5</option>
                          </select>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {o.confirmed ? (
                          o.is_dlt ? <Badge variant="error">DLT</Badge> : '—'
                        ) : (
                          <input
                            type="checkbox"
                            checked={!!confirmingObs[o.observation_id]?.isDlt}
                            onChange={(e) => onFormChange(o.observation_id, 'isDlt', e.target.checked)}
                            className="h-4 w-4"
                          />
                        )}
                      </td>
                      <td className="px-4 py-2 text-text-tertiary">{new Date(o.created_at).toLocaleDateString()}</td>
                      <td className="px-4 py-2">
                        {o.confirmed ? (
                          <span className="inline-flex items-center gap-1 text-success text-xs">
                            <Check size={14} /> {t('research.confirmed', '已确认')}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => onConfirm(o.observation_id)}
                            isLoading={confirmingIds.has(o.observation_id)}
                            disabled={confirmingIds.has(o.observation_id)}
                          >
                            {t('research.confirm', '确认')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
