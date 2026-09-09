import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button, Input, Skeleton } from '@/components/ui';
import type { Patient } from '@/lib/types';

export function EnrollDialog({ open, patients, patientsLoading, enrollingHash, onEnroll, onClose }: {
  open: boolean;
  patients: Patient[];
  patientsLoading: boolean;
  enrollingHash: string | null;
  onEnroll: (patientHash: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [enrollQuery, setEnrollQuery] = useState('');
  return (
    // #922: 弹窗外壳收敛到共享 Modal — 原行为保持:无 backdrop 点击关闭、无 Esc 关闭、bg-black/30、max-w-md。
    <Modal
      open={open}
      onClose={onClose}
      backdropClassName="bg-black/30"
      panelClassName="w-full max-w-md rounded-xl border border-border bg-surface-elevated p-6 shadow-lg"
    >
      <h2 className="mb-4 text-lg font-semibold text-text-primary">{t('research.enrollPatient', '入组患者')}</h2>
      {patientsLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : patients.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-text-tertiary">{t('research.noPatientsAvailable', '没有可入组的患者')}</p>
        </div>
      ) : (
        <>
          {/* #719: 患者多时入组弹窗需可搜索。 */}
          <Input
            value={enrollQuery}
            onChange={(e) => setEnrollQuery(e.target.value)}
            placeholder={t('research.searchPatientPlaceholder', '搜索患者（姓名/缩写/ID）…')}
            className="mb-2"
          />
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {patients.filter((p) => {
              const q = enrollQuery.trim().toLowerCase();
              if (!q) return true;
              return (p.name || '').toLowerCase().includes(q)
                || (p.initials || '').toLowerCase().includes(q)
                || p.patient_hash.toLowerCase().includes(q);
            }).map((p) => (
              <div
                key={p.patient_hash}
                className="flex items-center justify-between rounded-lg border border-border p-3"
              >
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {p.name || p.initials || '—'}
                  </p>
                  <p className="text-xs text-text-tertiary">
                    ID: {p.patient_hash.slice(0, 16)}...
                    {p.age_value != null || p.sex ? ' · ' : ''}
                    {p.age_value != null ? `${p.age_value}y` : ''}
                    {p.age_value != null && p.sex ? ' / ' : ''}
                    {p.sex || ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => onEnroll(p.patient_hash)}
                  disabled={enrollingHash === p.patient_hash}
                  isLoading={enrollingHash === p.patient_hash}
                >
                  {t('research.enroll', '入组')}
                </Button>
              </div>
            ))}
          </div>
          {enrollQuery.trim() && patients.filter((p) => {
            const q = enrollQuery.trim().toLowerCase();
            return (p.name || '').toLowerCase().includes(q)
              || (p.initials || '').toLowerCase().includes(q)
              || p.patient_hash.toLowerCase().includes(q);
          }).length === 0 && (
            <p className="py-4 text-center text-xs text-text-tertiary">{t('research.noPatientMatch', '没有匹配的患者')}</p>
          )}
        </>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="ghost" onClick={onClose}>{t('common.cancel', '取消')}</Button>
      </div>
    </Modal>
  );
}
