import { useEffect, useState } from 'react';
import { Download, Package, Play, Puzzle } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';

interface Workflow {
  workflow_id: string;
  name: string;
  description?: string;
  created_at: string;
  archived?: boolean;
}

interface Pack {
  pack_id: string;
  name: string;
  description: string;
  workflow_count: number;
}

interface WorkflowRun {
  run_id: string;
  workflow_id: string;
  status: string;
  started_at: string;
  completed_at?: string;
}

export function PluginsPage() {
  const [tab, setTab] = useState<'installed' | 'marketplace' | 'runs'>('installed');

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">Plugins</h1>
          <div className="ml-6 flex gap-1">
            {(['installed', 'marketplace', 'runs'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  tab === t ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary',
                )}
              >
                {t === 'installed' ? 'Installed' : t === 'marketplace' ? 'Marketplace' : 'Runs'}
              </button>
            ))}
          </div>
        </header>

        <main className="p-6">
          {tab === 'installed' && <InstalledWorkflows />}
          {tab === 'marketplace' && <MarketplacePacks />}
          {tab === 'runs' && <RunHistory />}
        </main>
      </div>
    </AppShell>
  );
}

function InstalledWorkflows() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listWorkflows()
      .then((r) => setWorkflows(r.workflows))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SkeletonGrid />;
  if (error) return <Alert variant="error">{error}</Alert>;
  if (workflows.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Puzzle size={32} className="mx-auto mb-3 text-text-tertiary" />
        <p className="text-text-secondary">No plugins installed yet. Check the Marketplace tab.</p>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {workflows.map((w) => (
        <Card key={w.workflow_id} className="p-4">
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <h3 className="font-medium text-text-primary truncate">{w.name}</h3>
              <p className="mt-1 text-xs text-text-tertiary">{w.description || 'No description'}</p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="font-mono text-xs text-text-tertiary">{w.workflow_id}</span>
            {w.archived ? <Badge variant="warning">archived</Badge> : <Badge variant="success">active</Badge>}
          </div>
        </Card>
      ))}
    </div>
  );
}

function MarketplacePacks() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.listWorkflowPacks()
      .then((r) => setPacks(r.packs))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const install = async (packId: string) => {
    setInstalling(packId);
    try {
      await api.installWorkflowPack(packId);
      setInstalled(packId);
      setTimeout(() => setInstalled(null), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : 'Install failed');
    } finally {
      setInstalling(null);
    }
  };

  if (loading) return <SkeletonGrid />;
  if (error) return <Alert variant="error">{error}</Alert>;
  if (packs.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Package size={32} className="mx-auto mb-3 text-text-tertiary" />
        <p className="text-text-secondary">No packs available.</p>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {packs.map((pack) => (
        <Card key={pack.pack_id} className="flex flex-col p-4">
          <div className="flex-1">
            <h3 className="font-medium text-text-primary">{pack.name}</h3>
            <p className="mt-1 text-xs text-text-tertiary line-clamp-3">{pack.description}</p>
            <div className="mt-2">
              <Badge>{pack.workflow_count} workflow{pack.workflow_count !== 1 ? 's' : ''}</Badge>
            </div>
          </div>
          <Button
            size="sm"
            className="mt-3 w-full"
            onClick={() => install(pack.pack_id)}
            isLoading={installing === pack.pack_id}
            variant={installed === pack.pack_id ? 'secondary' : 'primary'}
          >
            {installed === pack.pack_id ? (
              'Installed ✓'
            ) : (
              <>
                <Download size={14} className="mr-1.5" />
                Install
              </>
            )}
          </Button>
        </Card>
      ))}
    </div>
  );
}

function RunHistory() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.getWorkflowRuns()
      .then((r) => setRuns(r.runs))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const statusVariant = (s: string): 'default' | 'success' | 'warning' | 'error' => {
    switch (s) {
      case 'completed': return 'success';
      case 'running': return 'warning';
      case 'failed': return 'error';
      default: return 'default';
    }
  };

  if (loading) return <SkeletonGrid />;
  if (error) return <Alert variant="error">{error}</Alert>;
  if (runs.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Play size={32} className="mx-auto mb-3 text-text-tertiary" />
        <p className="text-text-secondary">No runs yet.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {runs.map((r) => (
        <Card key={r.run_id} className="flex items-center justify-between p-4">
          <div>
            <p className="font-medium text-sm text-text-primary">{r.workflow_id}</p>
            <p className="text-xs text-text-tertiary">
              {new Date(r.started_at).toLocaleString()}
              {r.completed_at && ` → ${new Date(r.completed_at).toLocaleTimeString()}`}
            </p>
          </div>
          <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
        </Card>
      ))}
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}
