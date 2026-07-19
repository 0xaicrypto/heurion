import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { FileText, Plus, Save, Trash2, X } from 'lucide-react';
import { Alert, Button, Card, Input, Skeleton, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { PatientTabs } from '@/routes/patients';

interface MedicalRecord {
  id: string;
  patient_hash: string;
  title: string;
  sections: Record<string, string>;
  created_at: string;
  updated_at: string;
}

const SECTION_KEYS = [
  { key: 'chief_complaint', label: 'Chief Complaint' },
  { key: 'history_of_present_illness', label: 'History of Present Illness' },
  { key: 'past_medical_history', label: 'Past Medical History' },
  { key: 'family_history', label: 'Family History' },
  { key: 'physical_exam', label: 'Physical Exam' },
  { key: 'diagnosis', label: 'Diagnosis' },
  { key: 'treatment_plan', label: 'Treatment Plan' },
  { key: 'progress_notes', label: 'Progress Notes' },
];

export function MedicalRecordsPage() {
  const { t } = useTranslation();
  const { hash } = useParams<{ hash: string }>();
  const [records, setRecords] = useState<MedicalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<{ title: string; sections: Record<string, string> }>({
    title: '',
    sections: {},
  });

  const loadRecords = async () => {
    if (!hash) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.listMedicalRecords(hash);
      setRecords(r.records);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRecords();
  }, [hash]);

  const resetForm = () => {
    setForm({ title: '', sections: {} });
    setSelectedId(null);
    setIsCreating(false);
  };

  const handleCreate = () => {
    setIsCreating(true);
    setSelectedId(null);
    setForm({ title: 'New Medical Record', sections: {} });
  };

  const handleEdit = (record: MedicalRecord) => {
    setSelectedId(record.id);
    setIsCreating(false);
    setForm({ title: record.title, sections: { ...record.sections } });
  };

  const handleSave = async () => {
    if (!hash) return;
    setSaving(true);
    setError(null);
    try {
      if (selectedId) {
        await api.updateMedicalRecord(selectedId, { title: form.title, sections: form.sections });
      } else {
        await api.createMedicalRecord({ patient_hash: hash, title: form.title, sections: form.sections });
      }
      resetForm();
      await loadRecords();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('common.confirmDelete', 'Delete this record?'))) return;
    try {
      await api.deleteMedicalRecord(id);
      if (selectedId === id) resetForm();
      await loadRecords();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  const updateSection = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, sections: { ...prev.sections, [key]: value } }));
  };

  if (!hash) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        <p>{t('patient.noPatientSelected')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
        <div className="flex items-center gap-3">
          <FileText size={18} className="text-text-tertiary" />
          <h1 className="font-semibold text-text-primary">{t('medicalRecords.title', 'Medical Records')}</h1>
        </div>
        <Button size="sm" onClick={handleCreate}>
          <Plus size={14} className="mr-1" /> {t('medicalRecords.newRecord', 'New Record')}
        </Button>
      </header>
      <PatientTabs hash={hash} active="records" />

      <main className="flex flex-1 overflow-hidden">
        <aside className="w-72 overflow-y-auto border-r border-border bg-surface p-4">
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </div>
          ) : records.length === 0 ? (
            <p className="text-sm text-text-tertiary">{t('medicalRecords.noRecords', 'No medical records yet')}</p>
          ) : (
            <div className="space-y-2">
              {records.map((r) => (
                <div key={r.id} onClick={() => handleEdit(r)} className="cursor-pointer">
                  <Card
                    className={`p-3 ${selectedId === r.id || (isCreating && !selectedId) ? '' : 'hover:bg-surface-elevated'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-text-primary">{r.title}</p>
                        <p className="text-xs text-text-tertiary">{new Date(r.updated_at).toLocaleString()}</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(r.id); }}
                        className="shrink-0 rounded p-1 text-text-tertiary hover:text-error hover:bg-error/10"
                        title={t('common.delete', 'Delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </Card>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="flex flex-1 flex-col overflow-y-auto p-6">
          {error && <Alert variant="error" className="mb-4">{error}</Alert>}

          {isCreating || selectedId ? (
            <div className="mx-auto w-full max-w-3xl space-y-4">
              <div className="flex items-center justify-between">
                <Input
                  value={form.title}
                  onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                  placeholder={t('medicalRecords.recordTitle', 'Record title')}
                  className="text-lg font-semibold"
                />
                <div className="ml-3 flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={resetForm}>
                    <X size={14} className="mr-1" /> {t('common.cancel', 'Cancel')}
                  </Button>
                  <Button size="sm" onClick={handleSave} isLoading={saving} disabled={saving || !form.title.trim()}>
                    <Save size={14} className="mr-1" /> {t('common.save', 'Save')}
                  </Button>
                </div>
              </div>

              {SECTION_KEYS.map(({ key, label }) => (
                <div key={key}>
                  <label className="mb-1 block text-sm font-medium text-text-secondary">{label}</label>
                  <Textarea
                    value={form.sections[key] || ''}
                    onChange={(e) => updateSection(key, e.target.value)}
                    placeholder={`Enter ${label.toLowerCase()}...`}
                    rows={3}
                    className="resize-y"
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center text-center text-text-tertiary">
              <FileText size={40} className="mb-3" />
              <p className="text-lg">{t('medicalRecords.selectOrCreate', 'Select a record or create a new one')}</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
