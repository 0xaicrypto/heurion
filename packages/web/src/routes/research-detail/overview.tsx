import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { Enrollment, StudyDetail, StudyProgress } from './types';

export function OverviewTab({ study, enrollments }: { study: StudyDetail; enrollments: Enrollment[] }) {
  const { t } = useTranslation();
  return (
    <div className="max-w-2xl space-y-4">
      <Card className="p-6 space-y-3">
        <div>
          <div className="text-xs text-text-tertiary">{t('research.studyId', '研究 ID')}</div>
          <div className="font-mono text-sm text-text-secondary">{study.study_id}</div>
        </div>
        {study.short_code && (
          <div>
            <div className="text-xs text-text-tertiary">{t('research.shortCode', '短编号')}</div>
            <div className="text-sm text-text-primary">{study.short_code}</div>
          </div>
        )}
        <div>
          <div className="text-xs text-text-tertiary">{t('research.created', '创建时间')}</div>
          <div className="text-sm text-text-primary">{new Date(study.created_at).toLocaleDateString()}</div>
        </div>
        {study.updated_at && (
          <div>
            <div className="text-xs text-text-tertiary">{t('research.updated', '更新时间')}</div>
            <div className="text-sm text-text-primary">{new Date(study.updated_at).toLocaleDateString()}</div>
          </div>
        )}
        {study.description && (
          <div>
            <div className="text-xs text-text-tertiary">{t('research.description', '描述')}</div>
            <div className="text-sm text-text-primary">{study.description}</div>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h3 className="mb-3 text-sm font-semibold text-text-secondary">{t('research.recentActivity', '近期动态')}</h3>
        {enrollments.length === 0 ? (
          <p className="text-sm text-text-tertiary">{t('research.noEnrollments', '暂无入组记录')}</p>
        ) : (
          <div className="space-y-2">
            {enrollments.slice(0, 10).map((e, i) => (
              <div key={`${e.patient_hash}-${i}`} className="flex items-center justify-between text-sm">
                <span className="text-text-secondary">
                  {e.name || e.initials || e.patient_hash.slice(0, 12)}
                  {e.age_value != null || e.sex ? (
                    <span className="ml-2 text-xs text-text-tertiary">
                      {e.age_value != null ? `${e.age_value}y` : ''}
                      {e.age_value != null && e.sex ? ' / ' : ''}
                      {e.sex || ''}
                    </span>
                  ) : null}
                </span>
                <Badge variant={e.status === 'active' ? 'success' : 'default'}>{e.status}</Badge>
                <span className="text-text-tertiary">{new Date(e.enrolled_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* #12: AI research-progress summary for citations / internal reporting. */
export function StudySummaryCard({ studyId }: { studyId: string }) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<{ facts: string[]; summary: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await api.getStudySummary(studyId));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="max-w-2xl p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-secondary">{t('research.summary', 'AI 研究进展摘要')}</h3>
        <Button size="sm" onClick={generate} isLoading={loading}>
          <Sparkles size={14} className="mr-1" />
          {t('research.generateSummary', '生成摘要')}
        </Button>
      </div>
      {error && <p className="mt-3 text-xs text-error">{error}</p>}
      {summary && (
        <div className="mt-4 space-y-3">
          <p className="rounded-lg border border-border bg-surface-elevated p-3 text-sm leading-relaxed text-text-primary">
            {summary.summary}
          </p>
          <details className="rounded-lg border border-border bg-surface p-3">
            <summary className="cursor-pointer text-xs text-text-tertiary">{t('research.summaryFacts', '依据事实')}</summary>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-text-secondary">
              {summary.facts.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </details>
        </div>
      )}
    </Card>
  );
}

/* #10: structured study-progress overview (enrollment/rules/visits/safety). */
export function StudyProgressCard({ studyId }: { studyId: string }) {
  const { t } = useTranslation();
  // #919: 响应按 StudyProgress 形状收口 — 不再是裸 any。
  const [data, setData] = useState<StudyProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getStudyProgress(studyId)
      .then(setData)
      .catch(err => setError(err instanceof ApiError ? err.messageText : String(err)));
  }, [studyId]);

  if (error) return <Card className="p-6"><p className="text-xs text-error">{error}</p></Card>;
  if (!data) return <Card className="p-6"><Skeleton className="h-24 w-full rounded-lg" /></Card>;

  // #919: 服务端返回部分字段缺失时不崩 — 读取处全部走默认值防护。
  const enrollment = data.enrollment ?? { total: 0, by_arm: {} as Record<string, number> };
  const rules = data.rules ?? { total: 0, confirmed: 0, pending: 0, rejected: 0 };
  const visitsAgg = data.visits ?? { total: 0, completed: 0, by_visit: {} as Record<string, { total: number; completed: number }> };
  const screenings = data.screenings ?? { eligible: 0, ineligible: 0, pending: 0 };
  const safety = data.safety ?? { dlt_count: 0, unconfirmed: 0 };
  // #919: Object.entries 的入参给 ?? {} 兜底。
  const arms = Object.entries(enrollment.by_arm ?? {});
  const visits = Object.entries(visitsAgg.by_visit ?? {});

  return (
    <Card className="p-6">
      <h3 className="mb-3 text-sm font-semibold text-text-secondary">{t('research.progress', '研究进展')}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{enrollment.total ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.enrolled', '入组患者')}</div>
          {arms.length > 0 && (
            <div className="mt-1 space-y-0.5 text-[10px] text-text-tertiary">
              {arms.map(([arm, n]) => <div key={String(arm)}>{String(arm)}: {String(n)}</div>)}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{rules.confirmed ?? 0}/{rules.total ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.rulesConfirmed', '规则已确认')}</div>
          {(rules.pending ?? 0) > 0 && <div className="mt-1 text-[10px] text-warning">{rules.pending} {t('research.pending', '待确认')}</div>}
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{visitsAgg.completed ?? 0}/{visitsAgg.total ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.visits', '随访完成')}</div>
          {visits.length > 0 && (
            <div className="mt-1 space-y-0.5 text-[10px] text-text-tertiary">
              {visits.slice(0, 4).map(([v, s]) => { const st = s as {completed: number; total: number}; return <div key={String(v)}>{String(v)}: {st.completed ?? 0}/{st.total ?? 0}</div>; })}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{screenings.eligible ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.eligible', '符合入组')}</div>
          {(screenings.pending ?? 0) > 0 && <div className="mt-1 text-[10px] text-warning">{screenings.pending} {t('research.pending', '待确认')}</div>}
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{safety.dlt_count ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.dlt', '确认 DLT')}</div>
          {(safety.unconfirmed ?? 0) > 0 && <div className="mt-1 text-[10px] text-warning">{safety.unconfirmed} {t('research.unconfirmed', '未确认')}</div>}
        </div>
      </div>
    </Card>
  );
}
