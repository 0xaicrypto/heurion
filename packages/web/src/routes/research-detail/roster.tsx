import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FlaskConical, Plus, X } from 'lucide-react';
import { Badge, Button, Skeleton } from '@/components/ui';
import type { RosterEntry } from './types';

export function RosterTab({ roster, loading, unenrollingHash, onUnenroll, onOpenEnroll }: {
  roster: RosterEntry[];
  loading: boolean;
  unenrollingHash: string | null;
  onUnenroll: (patientHash: string) => void;
  onOpenEnroll: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-secondary">{t('research.tabRoster', '入组名单')}</h2>
        <Button size="sm" onClick={onOpenEnroll}>
          <Plus size={14} className="mr-1" /> {t('research.enrollPatient', '入组患者')}
        </Button>
      </div>
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : roster.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border py-12 text-center">
          <FlaskConical size={36} className="mb-3 text-text-tertiary" />
          <p className="text-text-tertiary">{t('research.noPatientsEnrolled', '暂无入组患者')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patient', '患者')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patientId', '患者 ID')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.basicInfo', '基本信息')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.status', '状态')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.arm', '分组')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.enrolledAt', '入组时间')}</th>
                <th className="px-4 py-2 text-left font-medium text-text-secondary"></th>
              </tr>
            </thead>
            <tbody>
              {roster.map((r) => (
                // #724: 行点击跳回患者详情(科研↔患者双向桥)。
                <tr
                  key={r.patient_hash}
                  onClick={() => navigate(`/app/patients/${r.patient_hash}`)}
                  className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-surface-elevated"
                >
                  <td className="px-4 py-2 text-text-primary">
                    <span className="underline decoration-dotted underline-offset-2">{r.name || r.initials || '—'}</span>
                  </td>
                  <td className="px-4 py-2 font-mono text-text-secondary">
                    {r.patient_hash.slice(0, 16)}...
                  </td>
                  <td className="px-4 py-2 text-text-secondary">
                    {r.age_value != null ? `${r.age_value}y` : '—'}
                    {r.age_value != null && r.sex ? ' / ' : ''}
                    {r.sex || ''}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={r.status === 'active' ? 'success' : 'default'}>{r.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-text-secondary">{r.arm || '—'}</td>
                  <td className="px-4 py-2 text-text-tertiary">{new Date(r.enrolled_at).toLocaleDateString()}</td>
                  <td className="px-4 py-2">
                    <button
                      className="rounded p-1 text-text-tertiary hover:bg-error/10 hover:text-error transition-colors"
                      onClick={(e) => { e.stopPropagation(); onUnenroll(r.patient_hash); }}
                      disabled={unenrollingHash === r.patient_hash}
                      title={t('research.unenrollTitle', '移出研究')}
                    >
                      <X size={14} />
                    </button>
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
