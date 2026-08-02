import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Brain, Check, ExternalLink, Inbox, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { RejectReasonDialog } from './RejectReasonDialog';
import type { ApprovalRequest, MedicalRecordEntry, MemoryProposal } from '@/lib/types';

interface InboxRow {
  approval: ApprovalRequest;
  entry: MedicalRecordEntry | null;
  proposal: MemoryProposal | null;
  patientName?: string;
}

interface IngestionInboxProps {
  onChanged?: () => void;
}

const kindVariant: Record<string, 'default' | 'success' | 'warning' | 'error'> = {
  fact: 'success',
  article: 'warning',
  episode_summary: 'default',
  compaction_summary: 'default',
};

export function IngestionInbox({ onChanged }: IngestionInboxProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [targetFilter, setTargetFilter] = useState<'all' | 'entry' | 'memory'>('all');
  const [operating, setOperating] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectIds, setRejectIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [entriesRes, memoriesRes, patientsRes] = await Promise.all([
        api.listPendingApprovals({ targetType: 'MedicalRecordEntry' }),
        api.listPendingApprovals({ targetType: 'MemoryProposal' }),
        api.listPatients().catch(() => []),
      ]);
      const patientNames = new Map(patientsRes.map((p) => [p.patient_hash, p.name]));
      const entryRows: InboxRow[] = entriesRes.requests.map((approval) => {
        const payload = approval.payload as Record<string, unknown> | null;
        const entry = payload && typeof payload.id === 'string' ? (payload as unknown as MedicalRecordEntry) : null;
        return {
          approval,
          entry,
          proposal: null,
          patientName: entry?.patientHash ? patientNames.get(entry.patientHash) : undefined,
        };
      });
      const proposalRows: InboxRow[] = memoriesRes.requests.map((approval) => {
        const payload = approval.payload as Record<string, unknown> | null;
        const proposal = payload && typeof payload.kind === 'string' ? (payload as unknown as MemoryProposal) : null;
        return {
          approval,
          entry: null,
          proposal,
          patientName: proposal?.patientHash ? patientNames.get(proposal.patientHash) : undefined,
        };
      });
      setRows([...entryRows, ...proposalRows]);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filteredRows = useMemo(
    () => rows.filter((r) => {
      if (targetFilter === 'entry' && !r.entry) return false;
      if (targetFilter === 'memory' && !r.proposal) return false;
      if (typeFilter === 'all') return true;
      return r.entry?.type === typeFilter || r.proposal?.kind === typeFilter;
    }),
    [rows, typeFilter, targetFilter],
  );

  const typeOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.entry?.type || r.proposal?.kind).filter((x): x is MedicalRecordEntry['type'] | MemoryProposal['kind'] => Boolean(x)))),
    [rows],
  );

  const allVisibleSelected = filteredRows.length > 0 && filteredRows.every((r) => selected.has(r.approval.id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const r of filteredRows) next.delete(r.approval.id);
      } else {
        for (const r of filteredRows) next.add(r.approval.id);
      }
      return next;
    });
  };

  const removeRows = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    setRows((prev) => prev.filter((r) => !gone.has(r.approval.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    onChanged?.();
  }, [onChanged]);

  const confirmIds = async (ids: string[]) => {
    setOperating(true);
    setError(null);
    try {
      await Promise.all(ids.map((id) => api.confirmApproval(id)));
      removeRows(ids);
    } catch {
      setError(t('brain.operateFailed'));
    } finally {
      setOperating(false);
    }
  };

  const handleReject = async (ids: string[], reason: string) => {
    setOperating(true);
    setError(null);
    setRejectOpen(false);
    try {
      await Promise.all(ids.map((id) => api.rejectApproval(id, reason)));
      removeRows(ids);
    } catch {
      setError(t('brain.operateFailed'));
    } finally {
      setOperating(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="mb-4 h-5 w-40" />
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-text-primary">{t('brain.inboxTitle')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={targetFilter}
            onChange={(e) => setTargetFilter(e.target.value as typeof targetFilter)}
            className="h-8 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('brain.targetFilter', 'Filter by target')}
          >
            <option value="all">{t('brain.allTargets', 'All targets')}</option>
            <option value="entry">MedicalRecordEntry</option>
            <option value="memory">MemoryProposal</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              disabled={filteredRows.length === 0}
              className="h-4 w-4 accent-accent"
            />
            {t('brain.selectAll')}
          </label>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-8 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('brain.typeFilter')}
          >
            <option value="all">{t('brain.allTypes')}</option>
            {typeOptions.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={() => confirmIds(Array.from(selected))}
            disabled={selected.size === 0 || operating}
            isLoading={operating}
          >
            <Check size={14} className="mr-1" /> {t('brain.batchConfirm')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => { setRejectIds(Array.from(selected)); setRejectOpen(true); }}
            disabled={selected.size === 0 || operating}
          >
            <X size={14} className="mr-1" /> {t('brain.batchReject')}
          </Button>
        </div>
      </div>

      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <Inbox size={36} className="mb-3 text-text-tertiary" />
          <p className="text-sm font-medium text-text-primary">{t('brain.emptyTitle')}</p>
          <p className="text-xs text-text-secondary">{t('brain.emptySubtitle')}</p>
          <p className="mt-1 text-xs text-text-tertiary">{t('brain.emptyHint')}</p>
        </div>
      ) : filteredRows.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-tertiary">{t('brain.noEntries')}</p>
      ) : (
        <ul className="space-y-3">
          {filteredRows.map(({ approval, entry, proposal, patientName }) => {
            const patientLabel = patientName || t('brain.unknownPatient');
            if (proposal) {
              return (
                <li key={approval.id} className="rounded-xl border border-border bg-surface p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected.has(approval.id)}
                        onChange={() => toggleSelect(approval.id)}
                        className="mt-1 h-4 w-4 shrink-0 accent-accent"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Brain size={14} className="shrink-0 text-text-tertiary" />
                          <Badge variant={kindVariant[proposal.kind] ?? 'default'}>{proposal.kind}</Badge>
                          {proposal.patientHash && <span className="truncate text-sm font-medium text-text-primary">{patientLabel}</span>}
                          <Badge variant="default">{proposal.confidence}</Badge>
                          <span className="text-xs text-text-tertiary">★ {proposal.importance}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{proposal.content}</p>
                        {proposal.reason && (
                          <p className="mt-0.5 text-[11px] text-text-tertiary">{proposal.reason}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button size="sm" onClick={() => confirmIds([approval.id])} disabled={operating}>
                        <Check size={14} className="mr-1" /> {t('brain.confirm')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-error hover:bg-error/10"
                        onClick={() => { setRejectIds([approval.id]); setRejectOpen(true); }}
                        disabled={operating}
                      >
                        <X size={14} className="mr-1" /> {t('brain.reject')}
                      </Button>
                    </div>
                  </div>
                </li>
              );
            }
            return (
              <li key={approval.id} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selected.has(approval.id)}
                      onChange={() => toggleSelect(approval.id)}
                      className="mt-1 h-4 w-4 shrink-0 accent-accent"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-primary">{patientLabel}</span>
                        <span className="text-xs text-text-tertiary">—</span>
                        <span className="truncate text-sm text-text-secondary">{entry?.title || t('brain.unknownPatient')}</span>
                        <Badge variant="warning">{entry?.status ?? 'pending_review'}</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                        {entry?.type && <Badge variant="default">{entry.type}</Badge>}
                        <span>{entry?.date ? new Date(entry.date).toLocaleDateString() : ''}</span>
                        <span>{t('brain.autoAnalyzed')}</span>
                      </div>
                      {entry?.content && (
                        <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{entry.content}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" onClick={() => confirmIds([approval.id])} disabled={operating} isLoading={operating && selected.has(approval.id)}>
                      <Check size={14} className="mr-1" /> {t('brain.confirm')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-error hover:bg-error/10"
                      onClick={() => { setRejectIds([approval.id]); setRejectOpen(true); }}
                      disabled={operating}
                    >
                      <X size={14} className="mr-1" /> {t('brain.reject')}
                    </Button>
                    {entry?.patientHash && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => navigate(`/app/patients/${entry.patientHash}/records`)}
                      >
                        <ExternalLink size={14} className="mr-1" /> {t('brain.view')}
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <RejectReasonDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        loading={operating}
        onConfirm={(reason) => handleReject(rejectIds.length ? rejectIds : [], reason)}
      />
    </Card>
  );
}
