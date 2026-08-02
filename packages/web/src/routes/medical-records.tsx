import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { Check, FileText, History, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Alert, Badge, Button, Card, Input, Skeleton, Textarea } from '@/components/ui';
import { PatientTabs } from '@/routes/patients';
import { api, ApiError } from '@/lib/api-client';
import type { MedicalRecordEntry, MedicalRecordEntryType } from '@/lib/types';
import { cn } from '@/lib/utils';

const ENTRY_TYPES: Array<{ value: MedicalRecordEntryType; label: string }> = [
  { value: 'lab', label: 'Lab' },
  { value: 'imaging', label: 'Imaging' },
  { value: 'pathology', label: 'Pathology' },
  { value: 'ecg', label: 'ECG' },
  { value: 'note', label: 'Note' },
  { value: 'diagnosis', label: 'Diagnosis' },
  { value: 'medication', label: 'Medication' },
  { value: 'procedure', label: 'Procedure' },
  { value: 'vaccination', label: 'Vaccination' },
  { value: 'allergy', label: 'Allergy' },
];

const ABNORMAL_PATTERN = /(偏高|偏低|异常|abnormal|elevated|high|low|positive|negative)/i;

function highlightAbnormal(text: string): React.ReactNode {
  const parts = text.split(ABNORMAL_PATTERN);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-error/15 px-0.5 text-error">{part}</mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

interface EntryForm {
  type: MedicalRecordEntryType;
  title: string;
  content: string;
  date: string;
}

const emptyForm: EntryForm = { type: 'note', title: '', content: '', date: new Date().toISOString().slice(0, 10) };

export function MedicalRecordsPage() {
  const { t } = useTranslation();
  const { hash } = useParams<{ hash: string }>();
  const [entries, setEntries] = useState<MedicalRecordEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | MedicalRecordEntry['status']>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | MedicalRecordEntryType>('all');
  const [editing, setEditing] = useState<MedicalRecordEntry | 'new' | null>(null);
  const [form, setForm] = useState<EntryForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!hash) return;
    setLoading(true);
    setError(null);
    api.listMedicalRecordEntries(hash)
      .then((res) => setEntries(res.records))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, [hash]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () => entries.filter((e) =>
      (statusFilter === 'all' || e.status === statusFilter) &&
      (typeFilter === 'all' || e.type === typeFilter),
    ),
    [entries, statusFilter, typeFilter],
  );

  const openCreate = () => {
    setForm({ ...emptyForm });
    setEditing('new');
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const openEdit = (entry: MedicalRecordEntry) => {
    setForm({
      type: entry.type,
      title: entry.title,
      content: entry.content,
      date: (entry.date || '').slice(0, 10),
    });
    setEditing(entry);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleSave = async () => {
    if (!hash || !form.title.trim() || !form.content.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const date = form.date ? new Date(form.date).toISOString() : new Date().toISOString();
      if (editing === 'new') {
        await api.createMedicalRecordEntry(hash, {
          type: form.type,
          title: form.title.trim(),
          content: form.content.trim(),
          date,
          status: 'confirmed',
          createdBy: 'user',
        });
      } else if (editing) {
        await api.updateMedicalRecordEntry(hash, editing.id, {
          type: form.type,
          title: form.title.trim(),
          content: form.content.trim(),
          date,
        });
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (entry: MedicalRecordEntry) => {
    if (!hash || !confirm(t('medicalRecords.confirmDelete', 'Delete this entry?'))) return;
    setError(null);
    try {
      await api.deleteMedicalRecordEntry(hash, entry.id);
      if (editing === entry) setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  const statusVariant = (s: MedicalRecordEntry['status']): 'default' | 'success' | 'warning' | 'error' =>
    s === 'confirmed' ? 'success' : s === 'pending_review' ? 'warning' : 'error';

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
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="h-8 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('medicalRecords.filterStatus', 'Filter by status')}
          >
            <option value="all">{t('medicalRecords.allStatus', 'All statuses')}</option>
            <option value="pending_review">pending_review</option>
            <option value="confirmed">confirmed</option>
            <option value="rejected">rejected</option>
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className="h-8 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('medicalRecords.filterType', 'Filter by type')}
          >
            <option value="all">{t('medicalRecords.allTypes', 'All types')}</option>
            {ENTRY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} className="mr-1" /> {t('medicalRecords.newEntry', 'New Entry')}
          </Button>
        </div>
      </header>
      <PatientTabs hash={hash} active="records" />

      <main className="flex-1 overflow-y-auto p-6">
        {error && <Alert variant="error" className="mb-4">{error}</Alert>}

        {editing && (
          <div ref={formRef} className="mb-6 rounded-xl border border-border bg-surface-elevated p-4">
            <h3 className="mb-3 font-medium text-text-primary">
              {editing === 'new' ? t('medicalRecords.newEntry', 'New Entry') : t('medicalRecords.editEntry', 'Edit Entry')}
            </h3>
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="entry-type" className="mb-1 block text-xs font-medium text-text-secondary">{t('medicalRecords.type', 'Type')}</label>
                  <select
                    id="entry-type"
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value as MedicalRecordEntryType })}
                    className="flex h-10 w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {ENTRY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="entry-title" className="mb-1 block text-xs font-medium text-text-secondary">{t('medicalRecords.fieldTitle', 'Title')}</label>
                  <Input
                    id="entry-title"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder={t('medicalRecords.titlePlaceholder', 'e.g. CBC')}
                  />
                </div>
                <div className="sm:col-span-3">
                  <label htmlFor="entry-date" className="mb-1 block text-xs font-medium text-text-secondary">{t('medicalRecords.date', 'Date')}</label>
                  <Input id="entry-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-48" />
                </div>
                <div className="sm:col-span-3">
                  <label htmlFor="entry-content" className="mb-1 block text-xs font-medium text-text-secondary">{t('medicalRecords.content', 'Content')}</label>
                  <Textarea
                    id="entry-content"
                    value={form.content}
                    onChange={(e) => setForm({ ...form, content: e.target.value })}
                    rows={4}
                    className="resize-y"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  <X size={14} className="mr-1" /> {t('common.cancel', 'Cancel')}
                </Button>
                <Button size="sm" onClick={handleSave} isLoading={saving} disabled={!form.title.trim() || !form.content.trim()}>
                  <Check size={14} className="mr-1" /> {t('common.save', 'Save')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : filtered.length === 0 ? (
          <Card className="p-12 text-center">
            <FileText size={36} className="mx-auto mb-3 text-text-tertiary" />
            <p className="text-sm font-medium text-text-primary">{t('medicalRecords.noEntries', 'No medical record entries yet')}</p>
            <p className="mt-1 text-xs text-text-tertiary">
              {t('medicalRecords.noEntriesHint', 'Lab results, imaging analyses and AI drafts appear here as a timeline')}
            </p>
          </Card>
        ) : (
          <div className="space-y-3" data-testid="entries-timeline">
            {filtered.map((entry) => {
              const isExpanded = expandedId === entry.id || editing === entry;
              return (
                <Card key={entry.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="default">{entry.type}</Badge>
                        <span className="truncate text-sm font-medium text-text-primary">{entry.title}</span>
                        <Badge variant={statusVariant(entry.status)}>{entry.status}</Badge>
                        {entry.createdBy === 'system' && (
                          <Badge variant="warning">{t('medicalRecords.aiDraft', 'AI')}</Badge>
                        )}
                        {entry.version > 1 && (
                          <Badge variant="default">
                            <History size={10} className="mr-1" /> v{entry.version}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-tertiary">
                        <span>{entry.date ? new Date(entry.date).toLocaleDateString() : ''}</span>
                        {entry.sourceFileId && <span>file: {entry.sourceFileId.split('_').slice(1).join('_') || entry.sourceFileId}</span>}
                        {entry.sourceStudyId && <span>study: {entry.sourceStudyId}</span>}
                        {entry.confirmedBy && <span>{t('medicalRecords.confirmedBy', 'Confirmed by')}: {entry.confirmedBy}</span>}
                        {entry.rejectedReason && <span className="text-error">{t('medicalRecords.rejectedReason', 'Reason')}: {entry.rejectedReason}</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => setExpandedId(isExpanded && editing !== entry ? null : entry.id)}
                        className="rounded p-1.5 text-text-secondary hover:bg-surface"
                        title={t('medicalRecords.viewContent', 'View content')}
                      >
                        <FileText size={15} />
                      </button>
                      <button
                        onClick={() => openEdit(entry)}
                        className="rounded p-1.5 text-text-secondary hover:bg-surface"
                        title={t('common.edit', 'Edit')}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => handleDelete(entry)}
                        className="rounded p-1.5 text-text-tertiary hover:bg-error/10 hover:text-error"
                        title={t('common.delete', 'Delete')}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>

                  {(isExpanded || entry.aiSummary) && (
                    <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
                      {entry.aiSummary && (
                        <p className="text-xs text-text-secondary">
                          <span className="font-medium text-text-tertiary">AI: </span>
                          {highlightAbnormal(entry.aiSummary)}
                        </p>
                      )}
                      <p className={cn('whitespace-pre-wrap text-text-primary', !isExpanded && 'line-clamp-3')}>
                        {highlightAbnormal(entry.content)}
                      </p>
                      {entry.extractedText && isExpanded && (
                        <details className="text-xs text-text-tertiary">
                          <summary className="cursor-pointer">{t('medicalRecords.rawText', 'Raw extracted text')}</summary>
                          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-3">{entry.extractedText}</pre>
                        </details>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
