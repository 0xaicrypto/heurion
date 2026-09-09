import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FlaskConical } from 'lucide-react';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import type { Screening } from './types';

export function EligibilityTab({ eligibility, loading, rescanning, onRescan, onEnroll }: {
  eligibility: {screenings: Screening[]} | null;
  loading: boolean;
  rescanning: boolean;
  onRescan: () => void;
  onEnroll: (patientHash: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-secondary">{t('research.eligibilityScreenings', '资格筛查记录')}</h2>
        <Button size="sm" onClick={onRescan} isLoading={rescanning} disabled={rescanning}>
          {t('research.rescan', '重新筛查')}
        </Button>
      </div>
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : !eligibility || eligibility.screenings.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border py-12 text-center">
          <FlaskConical size={36} className="mb-3 text-text-tertiary" />
          <p className="text-text-tertiary">{t('research.noEligibilityData', '暂无筛查数据')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {eligibility.screenings.map((s, i) => (
            <Card key={`${s.patient_hash}-${i}`} className="p-4">
              <div className="flex items-center justify-between mb-2">
                {/* #724: 点击跳回患者详情。 */}
                <button onClick={() => navigate(`/app/patients/${s.patient_hash}`)} className="text-left">
                  <p className="text-sm font-medium text-text-primary hover:underline">{s.name || s.initials || s.patient_hash.slice(0, 12)}</p>
                  <p className="text-xs text-text-tertiary">
                    ID: {s.patient_hash.slice(0, 16)}...
                    {s.age_value != null || s.sex ? ' · ' : ''}
                    {s.age_value != null ? `${s.age_value}y` : ''}
                    {s.age_value != null && s.sex ? ' / ' : ''}
                    {s.sex || ''}
                  </p>
                </button>
                <div className="flex items-center gap-2">
                  <Badge variant={s.status === 'eligible' ? 'success' : s.status === 'ineligible' ? 'error' : 'default'}>
                    {s.status}
                  </Badge>
                  {/* #719: eligible 患者直达入组(预选),不必回 Roster 滚动找人。 */}
                  {s.status === 'eligible' && (
                    <Button size="sm" variant="secondary" onClick={() => onEnroll(s.patient_hash)}>
                      {t('research.enroll', '入组')}
                    </Button>
                  )}
                </div>
              </div>
              {s.criteria_results && s.criteria_results.length > 0 && (
                <div className="space-y-1 mt-2">
                  {s.criteria_results.map((c, j) => (
                    <div key={j} className="flex items-center gap-2 text-xs">
                      <span className={c.passed ? 'text-success' : 'text-error'}>
                        {c.passed ? '\u2713' : '\u2717'}
                      </span>
                      <span className="text-text-secondary">{c.criterion}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
