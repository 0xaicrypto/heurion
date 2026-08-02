import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button, Input } from '@/components/ui';

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

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleConfirm = () => {
    const trimmed = reason.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    setReason('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={handleBackdrop} role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface-elevated p-6 shadow-xl">
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
          <Button variant="danger" onClick={handleConfirm} disabled={!reason.trim()} isLoading={loading}>
            {t('brain.reject')}
          </Button>
        </div>
      </div>
    </div>
  );
}
