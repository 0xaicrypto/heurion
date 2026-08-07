import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

interface AuditLog {
  id: string;
  pluginId: string;
  toolName: string;
  jobId: string;
  status: string;
  durationMs: number;
  inputSummary?: string;
  errorMessage?: string;
  createdAt: string;
}

interface JobStatus {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown';
  created_at: number;
  result?: Record<string, unknown>;
  error?: string;
}

const statusOptions = ['', 'pending', 'running', 'completed', 'failed', 'unknown'];

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusVariant(status: string): 'default' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'running':
      return 'warning';
    default:
      return 'default';
  }
}

/** #341: section body — reused by SettingsPage's logs tab. */
export function LogsSection() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<Array<{ pluginId: string; name: string }>>([]);

  const [pluginId, setPluginId] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);

  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobStatus | null>(null);
  const [jobLoading, setJobLoading] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .listInstalledPlugins()
      .then((res) => setPlugins(res.plugins))
      .catch(() => setPlugins([]));
  }, []);

  const loadLogs = () => {
    setLoading(true);
    setError(null);
    api
      .getPluginAuditLogs({
        pluginId: pluginId || undefined,
        status: status || undefined,
        limit,
        offset,
      })
      .then((res) => {
        setLogs(res.logs);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.messageText : 'Failed to load logs'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, status, limit, offset]);

  const handleJobClick = async (log: AuditLog) => {
    setJobLoading(true);
    setJobError(null);
    setSelectedJob(null);
    setSelectedLog(log);
    try {
      const job = await api.getExecutionJobStatus(log.jobId);
      setSelectedJob(job);
    } catch (err) {
      setJobError(err instanceof ApiError ? err.messageText : 'Failed to load job status');
    } finally {
      setJobLoading(false);
    }
  };

  const selectClass =
    'h-10 rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <main className="space-y-4 p-6">
          {error && <Alert>{error}</Alert>}

          <Card className="p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-text-secondary">Plugin</label>
                <select
                  value={pluginId}
                  onChange={(e) => { setPluginId(e.target.value); setOffset(0); }}
                  className={selectClass}
                >
                  <option value="">All plugins</option>
                  {plugins.map((p) => (
                    <option key={p.pluginId} value={p.pluginId}>
                      {p.name} ({p.pluginId})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-text-secondary">Status</label>
                <select
                  value={status}
                  onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
                  className={selectClass}
                >
                  {statusOptions.map((s) => (
                    <option key={s} value={s}>
                      {s || 'All statuses'}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-text-secondary">Limit</label>
                <select
                  value={limit}
                  onChange={(e) => { setLimit(parseInt(e.target.value, 10)); setOffset(0); }}
                  className={selectClass}
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            {loading && logs.length === 0 ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : logs.length === 0 ? (
              <div className="p-6 text-sm text-text-secondary">No plugin execution logs yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface text-text-secondary">
                    <tr>
                      <th className="px-4 py-3 font-medium">Time</th>
                      <th className="px-4 py-3 font-medium">Plugin</th>
                      <th className="px-4 py-3 font-medium">Tool</th>
                      <th className="px-4 py-3 font-medium">Job ID</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Duration</th>
                      <th className="px-4 py-3 font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {logs.map((log) => (
                      <tr key={log.id} className="hover:bg-surface/50">
                        <td className="px-4 py-3 whitespace-nowrap text-text-secondary">{formatDate(log.createdAt)}</td>
                        <td className="px-4 py-3 text-text-primary">{log.pluginId}</td>
                        <td className="px-4 py-3 text-text-primary">{log.toolName}</td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => handleJobClick(log)}
                            className="font-mono text-xs text-accent hover:underline"
                          >
                            {log.jobId}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={statusVariant(log.status)}>{log.status}</Badge>
                        </td>
                        <td className="px-4 py-3 text-text-secondary">{log.durationMs}ms</td>
                        <td className="px-4 py-3 max-w-xs truncate text-error" title={log.errorMessage || ''}>
                          {log.errorMessage || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {total > limit && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <span className="text-xs text-text-secondary">
                  {offset + 1}-{Math.min(offset + limit, total)} of {total}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setOffset((o) => Math.max(0, o - limit))}
                    disabled={offset === 0}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setOffset((o) => o + limit)}
                    disabled={offset + limit >= total}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {jobError && <Alert>{jobError}</Alert>}
          {jobLoading && (
            <Card className="p-4 space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full" />
            </Card>
          )}
          {selectedLog && (
            <Card className="p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text-primary">Job {selectedLog.jobId}</span>
                <Badge variant={statusVariant(selectedLog.status)}>{selectedLog.status}</Badge>
                <span className="text-xs text-text-secondary">{selectedLog.durationMs}ms</span>
              </div>
              <div className="text-xs text-text-secondary">
                {formatDate(selectedLog.createdAt)} · {selectedLog.pluginId} · {selectedLog.toolName}
              </div>

              {selectedLog.errorMessage && (
                <div className="rounded-lg bg-error/10 p-3 text-sm text-error">
                  <span className="font-medium">Audit error:</span>
                  <p className="mt-1 whitespace-pre-wrap">{selectedLog.errorMessage}</p>
                </div>
              )}

              {selectedJob?.error && (
                <div className="rounded-lg bg-error/10 p-3 text-sm text-error">
                  <span className="font-medium">Worker error:</span>
                  <p className="mt-1 whitespace-pre-wrap">{selectedJob.error}</p>
                </div>
              )}

              {selectedJob?.result && (
                <>
                  <div className="text-xs font-medium text-text-secondary">Result</div>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-surface p-3 text-xs text-text-primary">
                    {JSON.stringify(selectedJob.result, null, 2)}
                  </pre>
                </>
              )}

              {selectedLog.inputSummary && (
                <>
                  <div className="text-xs font-medium text-text-secondary">Input summary</div>
                  <pre className="max-h-48 overflow-auto rounded-lg bg-surface p-3 text-xs text-text-primary">
                    {selectedLog.inputSummary}
                  </pre>
                </>
              )}

              {!selectedJob?.error && !selectedJob?.result && !selectedLog.errorMessage && !selectedLog.inputSummary && (
                <p className="text-sm text-text-secondary">No detailed information returned for this job.</p>
              )}
            </Card>
          )}
    </main>
  );
}

/** Standalone page — kept for the legacy /app/logs route (redirects to settings tab). */
export function LogsPage() {
  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">Execution Logs</h1>
        </header>
        <LogsSection />
      </div>
    </AppShell>
  );
}
