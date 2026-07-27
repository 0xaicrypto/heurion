import { useCallback, useEffect, useState } from 'react';
import { Download, Trash2, Package, Power, PowerOff, RotateCcw, Globe } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Button, Input, Card, Badge, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface Skill {
  name: string; title?: string; description: string; version?: string;
  author?: string; source?: string; enabled?: boolean; installed?: boolean;
  identifier?: string; repo?: string;
}

type Tab = 'builtin' | 'github';

const CATEGORIES: Record<string, { label: string; icon: string }> = {
  clinical:   { label: 'Clinical', icon: '🏥' },
  imaging:    { label: 'Imaging', icon: '🩻' },
  medication: { label: 'Medication', icon: '💊' },
  research:   { label: 'Research', icon: '🔬' },
  writing:    { label: 'Writing', icon: '📝' },
  quality:    { label: 'Quality', icon: '✅' },
  communication: { label: 'Communication', icon: '📨' },
};

export function SkillsPage() {
  const [tab, setTab] = useState<Tab>('builtin');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [ghSkills, setGhSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [ghLoading, setGhLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ghQuery, setGhQuery] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);

  const loadSkills = () => {
    setLoading(true);
    api.listSkills()
      .then(r => setSkills(r.skills))
      .catch(err => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadSkills(); }, []);

  const loadGitHub = useCallback(() => {
    setGhLoading(true);
    api.searchGitHubSkills(ghQuery || undefined)
      .then(r => setGhSkills(r.skills))
      .catch(err => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setGhLoading(false));
  }, [ghQuery]);

  useEffect(() => { if (tab === 'github') loadGitHub(); }, [tab, loadGitHub]);

  const handleInstall = async (identifier: string) => {
    setInstalling(identifier);
    try { await api.installSkill(identifier); loadSkills(); loadGitHub(); }
    catch (err) { setError(err instanceof ApiError ? err.messageText : String(err)); }
    finally { setInstalling(null); }
  };

  const handleToggle = async (name: string, enabled: boolean) => {
    try {
      const r = await api.toggleSkill(name, !enabled);
      setSkills(prev => prev.map(s => s.name === r.name ? { ...s, enabled: r.enabled } : s));
      setGhSkills(prev => prev.map(s => s.name === r.name ? { ...s, installed: true, enabled: r.enabled } : s));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  const handleUninstall = async (name: string) => {
    setUninstalling(name);
    try { await api.uninstallSkill(name); loadSkills(); loadGitHub(); }
    catch (err) { setError(err instanceof ApiError ? err.messageText : String(err)); }
    finally { setUninstalling(null); }
  };

  const installedSet = new Set(skills.filter(s => s.installed).map(s => s.name));

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">Skills Marketplace</h1>
          <Button size="sm" variant="ghost" onClick={loadSkills}><RotateCcw size={14} className="mr-1" /> Refresh</Button>
        </header>

        <nav className="flex border-b border-border bg-surface px-6">
          {([['builtin', 'Built-in', Package], ['github', 'Community', Globe]] as [Tab, string, typeof Package][]).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 -mb-px transition-colors',
                tab === key ? 'border-accent text-accent font-medium' : 'border-transparent text-text-secondary hover:text-text-primary'
              )}
            ><Icon size={14} />{label}</button>
          ))}
        </nav>

        {error && <div className="px-6 pt-4"><Alert variant="error">{error}</Alert></div>}

        {/* Built-in Tab */}
        {tab === 'builtin' && (
          <main className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 9 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
              </div>
            ) : (
              <div className="space-y-8">
                {Object.entries(CATEGORIES).map(([cat, { label, icon }]) => {
                  const catSkills = skills.filter(s => (s as any).identifier?.startsWith?.(`official/${cat}`) || (s as any).identifier?.startsWith?.(`github/${cat}`) || (s as any).identifier?.startsWith?.(`anthropic/${cat}`))
                  if (catSkills.length === 0) return null
                  return (
                    <section key={cat}>
                      <h2 className="mb-3 text-sm font-semibold text-text-secondary flex items-center gap-2">
                        <span>{icon}</span> {label} <Badge variant="default">{catSkills.length}</Badge>
                      </h2>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {catSkills.map(s => (
                          <Card key={s.name} className={cn('p-4 flex flex-col justify-between', s.enabled && 'ring-1 ring-accent/30')}>
                            <div>
                              <div className="flex items-center gap-2 mb-1">
                                <h3 className="font-medium text-sm text-text-primary">{s.name}</h3>
                                {s.enabled && <Badge variant="success" className="text-[10px]">On</Badge>}
                              </div>
                              <p className="text-xs text-text-tertiary line-clamp-2">{s.description}</p>
                              <p className="mt-1 text-[10px] text-text-tertiary">v{s.version} · {s.author}</p>
                            </div>
                            <div className="flex gap-2 mt-3">
                              {!s.installed ? (
                                <Button size="sm" className="w-full" onClick={() => handleInstall((s as any).identifier || s.name)} isLoading={installing === (s as any).identifier}>
                                  <Download size={14} className="mr-1" /> Install
                                </Button>
                              ) : (
                                <>
                                  <Button size="sm" variant={s.enabled ? 'secondary' : 'primary'} className="flex-1" onClick={() => handleToggle(s.name, !!s.enabled)}>
                                    {s.enabled ? <PowerOff size={14} className="mr-1" /> : <Power size={14} className="mr-1" />}
                                    {s.enabled ? 'Disable' : 'Enable'}
                                  </Button>
                                  <Button size="sm" variant="danger" onClick={() => handleUninstall(s.name)} isLoading={uninstalling === s.name}>
                                    <Trash2 size={14} />
                                  </Button>
                                </>
                              )}
                            </div>
                          </Card>
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            )}
          </main>
        )}

        {/* GitHub Tab */}
        {tab === 'github' && (
          <main className="flex-1 overflow-y-auto p-6 flex flex-col">
            <div className="flex gap-2 mb-4">
              <Input
                value={ghQuery}
                onChange={e => setGhQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') loadGitHub(); }}
                placeholder="Search community skills..."
                className="flex-1"
              />
              <Button onClick={loadGitHub} disabled={ghLoading} isLoading={ghLoading}>Search</Button>
            </div>

            {ghLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
              </div>
            ) : ghSkills.length === 0 ? (
              <div className="flex flex-col items-center justify-center flex-1">
                <Globe size={48} className="mb-3 text-text-tertiary" />
                <p className="text-text-tertiary">Loading community skills from GitHub...</p>
                <Button size="sm" variant="ghost" className="mt-3" onClick={loadGitHub}><RotateCcw size={14} className="mr-1" /> Retry</Button>
              </div>
            ) : (
              <div className="space-y-3">
                {ghSkills.map(s => (
                  <Card key={s.identifier || s.name} className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium text-sm text-text-primary">{s.name}</h3>
                          <Badge variant="default" className="text-[10px]">{s.source}</Badge>
                          {installedSet.has(s.name) && <Badge variant="success" className="text-[10px]">Installed</Badge>}
                        </div>
                        <p className="text-xs text-text-secondary mt-1 line-clamp-2">{s.description}</p>
                        <p className="mt-1 text-[10px] text-text-tertiary">
                          {s.version} · {s.author}{s.repo ? ` · ${s.repo}` : ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        className="ml-3 shrink-0"
                        onClick={() => handleInstall(s.identifier!)}
                        disabled={installedSet.has(s.name) || installing === s.identifier}
                        isLoading={installing === s.identifier}
                      >
                        <Download size={14} className="mr-1" />
                        {installedSet.has(s.name) ? 'Installed' : 'Install'}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </main>
        )}
      </div>
    </AppShell>
  );
}
