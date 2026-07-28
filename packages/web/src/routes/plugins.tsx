import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Globe, Package, Puzzle, Search, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, Input, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';

const SOURCES = [
  { key: 'official', label: 'Official', icon: <Globe size={14} />, desc: 'Heurion official plugins' },
  { key: 'all', label: 'All Sources', icon: <Package size={14} />, desc: 'Combined catalog search' },
];

interface CatalogPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  author: { name: string };
  tags: string[];
  runtime: string;
  installed: boolean;
}

interface InstalledPlugin {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  config: Record<string, unknown>;
}

export function PluginsPage() {
  const [tab, setTab] = useState<'installed' | 'market'>('market');
  const [source, setSource] = useState('official');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogPlugin[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);

  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [installedLoading, setInstalledLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const loadInstalled = useCallback(async () => {
    setInstalledLoading(true);
    try {
      const r = await api.listInstalledPlugins();
      setInstalled(r.plugins);
    } catch { /* ignore */ }
    finally { setInstalledLoading(false); }
  }, []);

  useEffect(() => { loadInstalled(); }, [loadInstalled]);

  const doSearch = useCallback(async (q: string, src: string) => {
    setMarketLoading(true);
    setMarketError(null);
    try {
      const r = await api.listPluginCatalog(q, src === 'all' ? undefined : src);
      setResults(r.plugins);
    } catch (err) {
      setMarketError(err instanceof ApiError ? err.messageText : 'Search failed');
      setResults([]);
    } finally {
      setMarketLoading(false);
    }
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query, source), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, source, doSearch]);

  const toggle = async (pluginId: string, enabled: boolean) => {
    try {
      if (enabled) await api.disablePlugin(pluginId);
      else await api.enablePlugin(pluginId);
      loadInstalled();
      doSearch(query, source);
    } catch { /* ignore */ }
  };

  const handleInstall = async (pluginId: string) => {
    setInstalling(pluginId);
    try {
      await api.installPlugin(pluginId);
      loadInstalled();
      doSearch(query, source);
    } catch (err) {
      setMarketError(err instanceof ApiError ? err.messageText : 'Install failed');
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async (pluginId: string) => {
    try {
      await api.uninstallPlugin(pluginId);
      loadInstalled();
      doSearch(query, source);
    } catch (err) {
      setMarketError(err instanceof ApiError ? err.messageText : 'Uninstall failed');
    }
  };

  const installedSet = new Set(installed.map((s) => s.pluginId));

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">Plugin Marketplace</h1>
          <div className="ml-6 flex gap-1">
            <button onClick={() => setTab('market')} className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', tab === 'market' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary')}>
              Marketplace
            </button>
            <button onClick={() => setTab('installed')} className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', tab === 'installed' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary')}>
              Installed ({installed.length})
            </button>
          </div>
        </header>

        <main className="p-6">
          {marketError && <Alert variant="error" className="mb-4">{marketError}</Alert>}

          {tab === 'market' && (
            <div>
              {/* Source tabs */}
              <div className="mb-4 flex gap-2">
                {SOURCES.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setSource(s.key)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                      source === s.key
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-text-secondary hover:border-border-strong',
                    )}
                    title={s.desc}
                  >
                    {s.icon}
                    {s.label}
                  </button>
                ))}
              </div>

              {/* Search bar */}
              <div className="relative mb-4 max-w-md">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-text-tertiary" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={query ? `Searching "${query}"…` : 'Search available plugins…'}
                  className="pl-10"
                />
              </div>

              {/* Results */}
              {marketLoading ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Skeleton className="h-36 rounded-xl" /><Skeleton className="h-36 rounded-xl" /><Skeleton className="h-36 rounded-xl" />
                </div>
              ) : results.length === 0 ? (
                <Card className="p-8 text-center">
                  <Puzzle size={32} className="mx-auto mb-3 text-text-tertiary" />
                  <p className="text-text-secondary">{query ? 'No matching plugins found' : `${SOURCES.find((s) => s.key === source)?.label || 'This'} catalog has no plugins available`}</p>
                </Card>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {results.map((plugin) => {
                    const isInstalled = installedSet.has(plugin.id);
                    return (
                      <Card key={plugin.id} className="flex flex-col p-4">
                        <div className="flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-medium text-text-primary truncate">{plugin.name}</h3>
                            <Badge variant="default" className="shrink-0 text-xs">
                              {plugin.category}
                            </Badge>
                          </div>
                          <p className="mt-2 text-xs text-text-tertiary line-clamp-3">{plugin.description || 'No description'}</p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {plugin.tags.map((tag) => (
                              <span key={tag} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-tertiary">{tag}</span>
                            ))}
                          </div>
                          <p className="mt-2 text-xs text-text-tertiary/60">v{plugin.version} · {plugin.author.name} · {plugin.runtime}</p>
                        </div>
                        <Button
                          size="sm"
                          className="mt-3 w-full"
                          variant={isInstalled ? 'secondary' : 'primary'}
                          onClick={() => handleInstall(plugin.id)}
                          isLoading={installing === plugin.id}
                        >
                          {isInstalled ? 'Installed ✓' : <><Download size={14} className="mr-1.5" /> Install</>}
                        </Button>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'installed' && (
            <div>
              {installedLoading ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Skeleton className="h-32 rounded-xl" /><Skeleton className="h-32 rounded-xl" />
                </div>
              ) : installed.length === 0 ? (
                <Card className="p-8 text-center">
                  <Package size={32} className="mx-auto mb-3 text-text-tertiary" />
                  <p className="text-text-secondary">No plugins installed yet. Browse the Marketplace.</p>
                  <Button size="sm" className="mt-4" onClick={() => setTab('market')}>Browse Marketplace</Button>
                </Card>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {installed.map((plugin) => (
                    <Card key={plugin.pluginId} className="flex flex-col p-4">
                      <div className="flex-1">
                        <div className="flex items-start justify-between">
                          <h3 className="font-medium text-text-primary truncate">{plugin.name}</h3>
                          <Badge variant={plugin.enabled ? 'success' : 'default'} className="shrink-0">
                            {plugin.enabled ? 'Active' : 'Disabled'}
                          </Badge>
                        </div>
                        <p className="mt-2 text-xs text-text-tertiary line-clamp-2">{plugin.description || 'No description'}</p>
                        <p className="mt-1 text-xs text-text-tertiary/60">v{plugin.version} · {plugin.author}</p>
                      </div>
                      <div className="mt-3 flex gap-2">
                        <Button size="sm" variant="secondary" className="flex-1" onClick={() => toggle(plugin.pluginId, plugin.enabled)}>
                          {plugin.enabled ? <><ToggleRight size={14} className="mr-1" /> Disable</> : <><ToggleLeft size={14} className="mr-1" /> Enable</>}
                        </Button>
                        <Button size="sm" variant="ghost" className="shrink-0 text-error" onClick={() => handleUninstall(plugin.pluginId)}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </AppShell>
  );
}
