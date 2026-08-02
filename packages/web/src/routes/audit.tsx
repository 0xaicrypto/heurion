import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Badge, Card, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/utils';
import type { AuditLogEntry } from '@/lib/types';

const KNOWN_ACTIONS = ['approval.confirmed', 'approval.rejected'];

export function AuditPage() {
  const { t, i18n } = useTranslation();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetType, setTargetType] = useState<string>('all');
  const [action, setAction] = useState<string>('all');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.listAuditLogs({
      targetType: targetType === 'all' ? undefined : targetType,
    })
      .then((res) => setLogs(res.logs))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, [targetType]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = action === 'all' ? logs : logs.filter((l) => l.action === action);

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-6">
          <ScrollText size={18} className="text-text-tertiary" />
          <h1 className="font-semibold text-text-primary">{t('audit.title', 'Audit Log')}</h1>
        </header>

        <main className="space-y-4 p-6">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              className="h-8 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('audit.filterType', 'Filter by target type')}
            >
              <option value="all">{t('audit.allTypes', 'All target types')}</option>
              <option value="MedicalRecordEntry">MedicalRecordEntry</option>
              <option value="Skill">Skill</option>
              <option value="Fact">Fact</option>
              <option value="ResearchRule">ResearchRule</option>
            </select>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="h-8 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('audit.filterAction', 'Filter by action')}
            >
              <option value="all">{t('audit.allActions', 'All actions')}</option>
              {KNOWN_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <span className="text-xs text-text-tertiary">{filtered.length} {t('audit.records', 'records')}</span>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
            </div>
          ) : filtered.length === 0 ? (
            <Card className="p-12 text-center">
              <ScrollText size={36} className="mx-auto mb-3 text-text-tertiary" />
              <p className="text-sm font-medium text-text-primary">{t('audit.empty', 'No audit records found')}</p>
            </Card>
          ) : (
            <div className="space-y-2" data-testid="audit-list">
              {filtered.map((log) => (
                <Card key={log.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={log.action === 'approval.confirmed' ? 'success' : 'error'}>{log.action}</Badge>
                    <Badge variant="default">{log.targetType}</Badge>
                    <span className="text-xs text-text-tertiary">{log.targetId}</span>
                    <span className="ml-auto text-xs text-text-tertiary">
                      {formatRelativeTime(log.createdAt, i18n.language)}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                    <div className="rounded-lg bg-surface p-2">
                      <span className="font-medium text-text-tertiary">{t('audit.actor', 'Actor')}: </span>
                      <span className="text-text-primary">{log.actor}</span>
                    </div>
                    {log.reason && (
                      <div className="rounded-lg bg-surface p-2">
                        <span className="font-medium text-text-tertiary">{t('audit.reason', 'Reason')}: </span>
                        <span className="text-text-primary">{log.reason}</span>
                      </div>
                    )}
                  </div>
                  {(log.before || log.after) && (
                    <details className="mt-2 text-xs text-text-tertiary">
                      <summary className="cursor-pointer">{t('audit.diff', 'Before / after')}</summary>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-3 text-text-secondary">
                        {JSON.stringify({ before: log.before, after: log.after }, null, 2)}
                      </pre>
                    </details>
                  )}
                </Card>
              ))}
            </div>
          )}
        </main>
      </div>
    </AppShell>
  );
}
