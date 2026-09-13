import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { api, ApiError } from '@/lib/api';
import { Alert, Skeleton } from '@/components/ui';

type Overview = Awaited<ReturnType<typeof api.getMemoryMetricsOverview>>;
type Suggestions = Awaited<ReturnType<typeof api.getMemorySuggestionMetrics>>;
type Gaps = Awaited<ReturnType<typeof api.getMemoryGapMetrics>>;
type References = Awaited<ReturnType<typeof api.getMemoryReferenceMetrics>>;

function pct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function MetricCard(input: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-xs text-text-tertiary">{input.label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{input.value}</p>
      {input.hint && <p className="mt-1 text-[11px] text-text-tertiary">{input.hint}</p>}
    </div>
  );
}

/** #1030: 记忆使用观察指标（admin-only）— MemoryUsageBus + eventLog 聚合。 */
export function AdminMetricsPage() {
  const [days, setDays] = useState(14);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [gaps, setGaps] = useState<Gaps | null>(null);
  const [references, setReferences] = useState<References | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.getMemoryMetricsOverview(days),
      api.getMemorySuggestionMetrics(days),
      api.getMemoryGapMetrics(days),
      api.getMemoryReferenceMetrics(days, 20),
    ]).then(([o, s, g, r]) => {
      if (cancelled) return;
      setOverview(o);
      setSuggestions(s);
      setGaps(g);
      setReferences(r);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof ApiError ? err.messageText : 'Failed to load memory metrics');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [days]);

  // 按天合计（跨 action）用于迷你趋势条。
  const dailyTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of overview?.daily ?? []) map.set(d.date, (map.get(d.date) ?? 0) + d.count);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [overview]);
  const dailyMax = useMemo(() => Math.max(1, ...dailyTotals.map(([, n]) => n)), [dailyTotals]);

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">Admin — Memory Metrics</h1>
          <div className="flex gap-1">
            {[14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`rounded-lg border px-3 py-1 text-xs transition-colors ${days === d ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary'}`}
              >
                {d}d
              </button>
            ))}
          </div>
        </header>
        <main className="space-y-6 p-6">
          {error && <Alert variant="error">{error}</Alert>}

          {loading ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
              </div>
              <Skeleton className="h-48 rounded-xl" />
              <Skeleton className="h-48 rounded-xl" />
            </div>
          ) : (
            <>
              <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <MetricCard label="Bus events" value={String(overview?.totals.events ?? 0)} hint={`${overview?.totals.users ?? 0} users · ${overview?.totals.sessions ?? 0} sessions`} />
                <MetricCard
                  label="Suggestion accept rate"
                  value={pct(suggestions?.acceptRate ?? null)}
                  hint={`suggested ${suggestions?.suggested ?? 0} · accepted ${suggestions?.accepted ?? 0} · dismissed ${suggestions?.dismissed ?? 0}`}
                />
                <MetricCard
                  label="Gap answer rate"
                  value={pct(gaps?.answerRate ?? null)}
                  hint={`detected ${gaps?.detected ?? 0} · answered ${gaps?.answered ?? 0} · ${gaps?.usersWithGaps ?? 0} users`}
                />
                <MetricCard
                  label="Top reference uses"
                  value={String(references?.items[0]?.uses ?? 0)}
                  hint={references?.items[0] ? `${references.items[0].kind} · ${references.items[0].label}` : 'no reference usage yet'}
                />
              </section>

              <section className="rounded-xl border border-border bg-surface p-4">
                <h2 className="mb-3 text-sm font-medium text-text-secondary">Daily events (all actions)</h2>
                {dailyTotals.length === 0 ? (
                  <p className="py-6 text-center text-xs text-text-tertiary">No data in this window</p>
                ) : (
                  <div className="flex h-24 items-end gap-1">
                    {dailyTotals.map(([date, count]) => (
                      <div key={date} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${date}: ${count}`}>
                        <div className="w-full rounded-t bg-accent/60" style={{ height: `${Math.max(2, Math.round((count / dailyMax) * 80))}px` }} />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-border bg-surface p-4">
                <h2 className="mb-3 text-sm font-medium text-text-secondary">Action × unit type</h2>
                {(!overview || overview.byActionUnitType.length === 0) ? (
                  <p className="py-6 text-center text-xs text-text-tertiary">No bus events in this window</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-text-secondary">
                          <th className="px-3 py-2 font-medium">Action</th>
                          <th className="px-3 py-2 font-medium">Unit type</th>
                          <th className="px-3 py-2 text-right font-medium">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.byActionUnitType.map((r) => (
                          <tr key={`${r.action}:${r.unitType}`} className="border-b border-border/50">
                            <td className="px-3 py-2 text-text-primary">{r.action}</td>
                            <td className="px-3 py-2 text-text-secondary">{r.unitType}</td>
                            <td className="px-3 py-2 text-right text-text-primary">{r.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-border bg-surface p-4">
                <h2 className="mb-3 text-sm font-medium text-text-secondary">Top reused references</h2>
                {(!references || references.items.length === 0) ? (
                  <p className="py-6 text-center text-xs text-text-tertiary">No reference usage in this window</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-text-secondary">
                          <th className="px-3 py-2 font-medium">Label</th>
                          <th className="px-3 py-2 font-medium">Kind</th>
                          <th className="px-3 py-2 text-right font-medium">Uses</th>
                          <th className="px-3 py-2 text-right font-medium">Sessions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {references.items.map((r) => (
                          <tr key={r.referenceId} className="border-b border-border/50">
                            <td className="max-w-[320px] truncate px-3 py-2 text-text-primary" title={r.label}>{r.label}</td>
                            <td className="px-3 py-2 text-text-secondary">{r.kind}</td>
                            <td className="px-3 py-2 text-right text-text-primary">{r.uses}</td>
                            <td className="px-3 py-2 text-right text-text-secondary">{r.sessions}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </AppShell>
  );
}
