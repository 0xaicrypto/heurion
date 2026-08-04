import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Check, FileText, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/utils';
import { Alert, Badge, Button, Card, Input, Skeleton } from '@/components/ui';
import type { ApprovalRequest, MedicalRecordEntry, MemoryProposal } from '@/lib/types';

interface PendingIngestionsWidgetProps {
  limit?: number;
  onCountChange?: (count: number) => void;
}

interface PendingRow {
  approval: ApprovalRequest;
  entry: MedicalRecordEntry | null;
  proposal: MemoryProposal | null;
  patientName?: string;
}

const kindVariant: Record<string, 'default' | 'success' | 'warning' | 'error'> = {
  fact: 'success',
  article: 'warning',
  episode_summary: 'default',
  compaction_summary: 'default',
};

export function PendingIngestionsWidget({ limit = 5, onCountChange }: PendingIngestionsWidgetProps) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [operatingId, setOperatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [entriesRes, memoriesRes, patientsRes] = await Promise.all([
        api.listPendingApprovals({ targetType: 'MedicalRecordEntry' }),
        api.listPendingApprovals({ targetType: 'MemoryProposal' }),
        api.listPatients().catch(() => []),
      ]);
      const approvalsRes = { requests: [...entriesRes.requests, ...memoriesRes.requests] };
      const patientNames = new Map(patientsRes.map((p) => [p.patient_hash, p.name]));
      const nextRows: PendingRow[] = approvalsRes.requests.map((approval) => {
        const payload = approval.payload as Record<string, unknown> | null;
        const proposal = payload && typeof payload.kind === 'string' ? (payload as unknown as MemoryProposal) : null;
        const entry = payload && typeof payload.id === 'string' ? (payload as unknown as MedicalRecordEntry) : null;
        const patientHash = proposal?.patientHash ?? entry?.patientHash;
        return {
          approval,
          entry,
          proposal,
          patientName: patientHash ? patientNames.get(patientHash) : undefined,
        };
      });
      setRows(nextRows);
      setTotal(nextRows.length);
      onCountChange?.(nextRows.length);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    load();
  }, [load]);

  const applyResult = useCallback((approvalId: string) => {
    setRows((prev) => prev.filter((r) => r.approval.id !== approvalId));
    setTotal((prev) => {
      const next = Math.max(0, prev - 1);
      onCountChange?.(next);
      return next;
    });
    setRejectingId(null);
    setRejectReason('');
  }, [onCountChange]);

  const handleConfirm = async (approvalId: string) => {
    setOperatingId(approvalId);
    try {
      await api.confirmApproval(approvalId);
      applyResult(approvalId);
    } catch {
      setError(t('today.pendingIngestions.operateFailed'));
    } finally {
      setOperatingId(null);
    }
  };

  const handleReject = async (approvalId: string) => {
    setOperatingId(approvalId);
    try {
      await api.rejectApproval(approvalId, rejectReason.trim());
      applyResult(approvalId);
    } catch {
      setError(t('today.pendingIngestions.operateFailed'));
    } finally {
      setOperatingId(null);
    }
  };

  const visibleRows = useMemo(() => rows.slice(0, limit), [rows, limit]);

  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="mb-4 h-5 w-40" />
        <div className="space-y-3">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h3 className="mb-4 font-semibold text-text-primary">
        {t('today.pendingIngestions.title', { count: total })}
      </h3>

      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      {!error && rows.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('today.pendingIngestions.processed')}</p>
      ) : (
        <ul className="space-y-3">
          {visibleRows.map(({ approval, entry, proposal, patientName }) => {
            const busy = operatingId === approval.id;
            const time = approval.createdAt ? formatRelativeTime(approval.createdAt, i18n.language) : '';
            return (
              <li key={approval.id} className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface p-4">
                <div className="min-w-0 flex-1">
                  {entry ? (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-primary">{patientName || t('today.pendingIngestions.unknownPatient')}</span>
                        <span className="text-xs text-text-tertiary">·</span>
                        <span className="truncate text-sm text-text-secondary">{entry.title || t('today.pendingIngestions.unknownPatient')}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                        {entry.type && <Badge variant="warning">{entry.type}</Badge>}
                        <span>{time}</span>
                        <span>{t('today.pendingIngestions.autoAnalyzed')}</span>
                      </div>
                    </>
                  ) : proposal ? (
                    <>
                      <div className="flex items-center gap-2">
                        <Badge variant={kindVariant[proposal.kind] ?? 'default'}>{proposal.kind}</Badge>
                        <span className="truncate text-sm font-medium text-text-primary">
                          {proposal.patientHash
                            ? (patientName || proposal.patientHash)
                            : t('today.pendingIngestions.globalScope')}
                        </span>
                        {proposal.importance >= 4 && (
                          <Badge variant="error">{t('today.pendingIngestions.highImportance')}</Badge>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{proposal.content}</p>
                      {proposal.conflictsWith && (
                        <p className="mt-1 text-xs text-error">{t('today.pendingIngestions.conflictWarning')}</p>
                      )}
                      <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                        <span>{time}</span>
                        <span>·</span>
                        <span>{t('today.pendingIngestions.autoExtracted')}</span>
                      </div>
                    </>
                  ) : (
                    <span className="text-sm text-text-secondary">{t('today.pendingIngestions.unknownPatient')}</span>
                  )}
                </div>

                <div className="shrink-0">
                  {rejectingId === approval.id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        autoFocus
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleReject(approval.id);
                          if (e.key === 'Escape') setRejectingId(null);
                        }}
                        placeholder={t('today.pendingIngestions.rejectReason')}
                        className="h-8 w-44 text-sm"
                      />
                      <Button size="sm" variant="danger" onClick={() => handleReject(approval.id)} isLoading={busy}>
                        {t('today.pendingIngestions.reject')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setRejectingId(null); setRejectReason(''); }}>
                        {t('today.pendingIngestions.rejectCancel')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => handleConfirm(approval.id)} isLoading={busy}>
                        <Check size={14} className="mr-1" /> {t('today.pendingIngestions.confirm')}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-error hover:bg-error/10" onClick={() => { setRejectReason(''); setRejectingId(approval.id); }}>
                        <X size={14} className="mr-1" /> {t('today.pendingIngestions.reject')}
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {total > limit && (
        <div className="mt-4 border-t border-border pt-3">
          <Link to="/app/brain" className="flex items-center gap-1 text-sm font-medium text-accent hover:underline">
            <FileText size={14} />
            {t('today.pendingIngestions.viewAll', { count: total })}
          </Link>
        </div>
      )}
    </Card>
  );
}
