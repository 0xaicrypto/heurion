import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';

interface RejectReasonDialogProps {
  open: boolean;
  title?: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  loading?: boolean;
}

export function RejectReasonDialog({ open, title, onConfirm, onClose, loading }: RejectReasonDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');

  if (!open) return null;

  const handleConfirm = () => {
    // Reason is optional — rejecting without a note is allowed.
    onConfirm(reason.trim());
    setReason('');
  };

  return (
    // #922: 弹窗外壳收敛到共享 Modal(backdrop 点击关闭 — 原行为保持;
    // Esc 仍只挂 Input onKeyDown,不升级为全局)。
    <Modal
      open={open}
      onClose={onClose}
      backdropClose
      backdropClassName="bg-black/40"
      panelClassName="w-full max-w-md rounded-xl border border-border bg-surface-elevated p-6 shadow-xl"
    >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{title || t('brain.rejectTitle')}</h2>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface"
            aria-label={t('brain.rejectCancel')}
          >
            <X size={18} />
          </button>
        </div>

        <Input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConfirm();
            if (e.key === 'Escape') onClose();
          }}
          placeholder={t('brain.rejectReason')}
        />

        <div className="mt-5 flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('brain.rejectCancel')}
          </Button>
          <Button variant="danger" onClick={handleConfirm} isLoading={loading}>
            {t('brain.reject')}
          </Button>
        </div>
    </Modal>
  );
}
