import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Brain, ClipboardCopy, Clock, Pill } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';

interface MemoryNode {
  node_id: number;
  node_type: string;
  content: unknown;
  weight?: number;
  encounter_id?: string;
  updated_at?: number;
}

interface TimelineEntry {
  event_id: number;
  event_type: string;
  content: string;
  timestamp: number;
}

function formatContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    const o = c as Record<string, string>;
    return o.label || o.canonical_en || JSON.stringify(c);
  }
  return String(c);
}

function nodeTypeColors(nodeType: string): string {
  const t = nodeType.toLowerCase();
  if (t.includes('finding') || t.includes('diagnosis')) return 'warning';
  if (t.includes('medication') || t.includes('drug')) return 'success';
  if (t.includes('procedure')) return 'info';
  return 'default';
}

function badgeColors(variant: string): { bg: string; text: string } {
  switch (variant) {
    case 'warning': return { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400' };
    case 'success': return { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' };
    case 'info': return { bg: 'bg-sky-100 dark:bg-sky-900/30', text: 'text-sky-700 dark:text-sky-400' };
    default: return { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-700 dark:text-gray-400' };
  }
}

export function MemoryGraphPage() {
  const { hash } = useParams<{ hash: string }>();
  const [findings, setFindings] = useState<MemoryNode[]>([]);
  const [medications, setMedications] = useState<MemoryNode[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(true);
  const [findingsError, setFindingsError] = useState<string | null>(null);
  const [medicationsLoading, setMedicationsLoading] = useState(true);
  const [medicationsError, setMedicationsError] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  const loadData = useCallback(() => {
    if (!hash) return;
    setFindingsLoading(true);
    setFindingsError(null);
    api.getFindings(hash)
      .then(setFindings)
      .catch((err) => setFindingsError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setFindingsLoading(false));

    setMedicationsLoading(true);
    setMedicationsError(null);
    api.getMedications(hash)
      .then(setMedications)
      .catch((err) => setMedicationsError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setMedicationsLoading(false));

    setTimelineLoading(true);
    setTimelineError(null);
    api.getMemoryTimeline(hash)
      .then(setTimeline)
      .catch((err) => setTimelineError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setTimelineLoading(false));
  }, [hash]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCite = (nodeId: number) => {
    navigator.clipboard.writeText(String(nodeId)).catch(() => {});
  };

  if (!hash) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        <p>No patient selected</p>
      </div>
    );
  }

  const hasError = findingsError && medicationsError && timelineError;
  if (hasError) {
    return (
      <div className="flex h-full flex-col gap-3 p-6">
        {findingsError && <Alert variant="error">Findings: {findingsError}</Alert>}
        {medicationsError && <Alert variant="error">Medications: {medicationsError}</Alert>}
        {timelineError && <Alert variant="error">Timeline: {timelineError}</Alert>}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <section className="mb-8">
        <div className="mb-3 flex items-center gap-2">
          <Brain size={20} className="text-accent" />
          <h2 className="text-lg font-semibold text-text-primary">Findings</h2>
          {!findingsLoading && <Badge variant="default">{findings.length}</Badge>}
        </div>
        {findingsError && <Alert variant="error" className="mb-3">{findingsError}</Alert>}
        {findingsLoading ? (
          <Card className="p-8"><Skeleton className="h-24 w-full rounded-xl" /></Card>
        ) : findings.length === 0 ? (
          <Card className="flex flex-col items-center justify-center p-8 text-center">
            <p className="text-sm text-text-secondary">No findings recorded</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {findings.map((f) => {
              const colors = badgeColors(nodeTypeColors(f.node_type));
              return (
                <Card key={f.node_id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-text-primary">{formatContent(f.content)}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                        <span className={colors.bg + ' ' + colors.text + ' rounded px-1.5 py-0.5 font-medium'}>
                          {f.node_type}
                        </span>
                        <span>{String(f.node_id).slice(0, 8)}</span>
                        {f.weight != null && <span>Weight: {f.weight.toFixed(2)}</span>}
                        {f.updated_at && <span>{new Date(f.updated_at).toLocaleDateString()}</span>}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => handleCite(f.node_id)}>
                      <ClipboardCopy size={14} className="mr-1" /> Cite
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center gap-2">
          <Pill size={20} className="text-success" />
          <h2 className="text-lg font-semibold text-text-primary">Medications</h2>
          {!medicationsLoading && <Badge variant="default">{medications.length}</Badge>}
        </div>
        {medicationsError && <Alert variant="error" className="mb-3">{medicationsError}</Alert>}
        {medicationsLoading ? (
          <Card className="p-8"><Skeleton className="h-24 w-full rounded-xl" /></Card>
        ) : medications.length === 0 ? (
          <Card className="flex flex-col items-center justify-center p-8 text-center">
            <p className="text-sm text-text-secondary">No medications recorded</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {medications.map((m) => {
              const colors = badgeColors(nodeTypeColors(m.node_type));
              return (
                <Card key={m.node_id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-text-primary">{formatContent(m.content)}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                        <span className={colors.bg + ' ' + colors.text + ' rounded px-1.5 py-0.5 font-medium'}>
                          {m.node_type}
                        </span>
                        <span>{String(m.node_id).slice(0, 8)}</span>
                        {m.weight != null && <span>Weight: {m.weight.toFixed(2)}</span>}
                        {m.updated_at && <span>{new Date(m.updated_at).toLocaleDateString()}</span>}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => handleCite(m.node_id)}>
                      <ClipboardCopy size={14} className="mr-1" /> Cite
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Clock size={20} className="text-text-secondary" />
          <h2 className="text-lg font-semibold text-text-primary">Timeline</h2>
          {!timelineLoading && <Badge variant="default">{timeline.length}</Badge>}
        </div>
        {timelineError && <Alert variant="error" className="mb-3">{timelineError}</Alert>}
        {timelineLoading ? (
          <Card className="p-8"><Skeleton className="h-20 w-full rounded-xl" /></Card>
        ) : timeline.length === 0 ? (
          <Card className="flex flex-col items-center justify-center p-8 text-center">
            <p className="text-sm text-text-secondary">No timeline events</p>
          </Card>
        ) : (
          <div className="space-y-1">
            {timeline
              .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
              .map((ev) => (
                <div key={ev.event_id} className="flex gap-4 rounded-lg border border-border bg-surface-elevated p-3 text-sm">
                  <span className="shrink-0 text-xs text-text-tertiary w-20">
                    {new Date(ev.timestamp).toLocaleDateString()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1">
                      <Badge variant="default">{ev.event_type}</Badge>
                    </div>
                    <p className="text-text-secondary">{ev.content}</p>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}
