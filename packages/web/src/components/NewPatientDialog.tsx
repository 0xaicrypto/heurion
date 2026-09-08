import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button, Input, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';

interface NewPatientDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (patientHash: string) => void;
}

export function NewPatientDialog({ open, onClose, onCreated }: NewPatientDialogProps) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [initials, setInitials] = useState('');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('');
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // #715: 校验带明确解释 — 姓名/缩写二选一,年龄 0-120。
    if (!name.trim() && !initials.trim()) {
      setError('姓名与缩写至少填一项');
      return;
    }
    if (age && (parseInt(age, 10) < 0 || parseInt(age, 10) > 120 || !/^\d+$/.test(age.trim()))) {
      setError('年龄须为 0–120 之间的整数');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.registerPatient({
        name: name.trim() || undefined,
        initials: initials.trim() || undefined,
        age: age ? parseInt(age, 10) : undefined,
        sex: sex || undefined,
        chief_complaint: chiefComplaint.trim() || undefined,
      });
      onClose();
      setName('');
      setInitials('');
      setAge('');
      setSex('');
      setChiefComplaint('');
      if (onCreated) {
        onCreated(result.patient_hash);
      } else {
        navigate(`/app/patients/${result.patient_hash}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : 'Failed to create patient');
    } finally {
      setLoading(false);
    }
  };

  return (
    // #922: 弹窗外壳收敛到共享 Modal(backdrop 点击关闭 — 原行为保持,无 Esc)。
    <Modal
      open={open}
      onClose={onClose}
      backdropClose
      backdropClassName="bg-black/40"
      panelClassName="w-full max-w-md rounded-xl border border-border bg-surface-elevated p-6 shadow-xl"
    >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">New Patient</h2>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-error/10 px-4 py-2 text-sm text-error">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Full Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. John Doe"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Initials</label>
            <Input
              value={initials}
              onChange={(e) => setInitials(e.target.value)}
              placeholder="e.g. JD"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Age</label>
              <Input
                type="number"
                value={age}
                onChange={(e) => setAge(e.target.value)}
                placeholder="Age"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Sex</label>
              <select
                value={sex}
                onChange={(e) => setSex(e.target.value)}
                className="flex h-10 w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">—</option>
                <option value="M">M</option>
                <option value="F">F</option>
                <option value="O">O</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Chief Complaint</label>
            <Textarea
              value={chiefComplaint}
              onChange={(e) => setChiefComplaint(e.target.value)}
              placeholder="Describe the chief complaint..."
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={(!name.trim() && !initials.trim()) || loading} isLoading={loading}>
              Create Patient
            </Button>
          </div>
        </form>
    </Modal>
  );
}
