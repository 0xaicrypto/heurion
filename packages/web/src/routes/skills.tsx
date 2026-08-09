import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Trash2, Package, Power, PowerOff, RotateCcw, Globe, Sparkles, Check } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Button, Input, Card, Badge, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Skill {
  name: string; title?: string; description: string; version?: string;
  author?: string; source?: string; enabled?: boolean; installed?: boolean;
  identifier?: string; repo?: string;
}

type Tab = 'builtin' | 'github' | 'captured';

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
    api.searchSkills(ghQuery || '', 'github')
      .then(r => setGhSkills(r.results.map(s => ({ ...s, installed: !!s.installed }))))
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

  const installedSet = new Set(skills.map(s => s.name));

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">Skills Marketplace</h1>
          <Button size="sm" variant="ghost" onClick={loadSkills}><RotateCcw size={14} className="mr-1" /> Refresh</Button>
        </header>

        <nav className="flex border-b border-border bg-surface px-6">
          {([['builtin', 'Built-in', Package], ['github', 'Community', Globe], ['captured', 'Captured / Experience', Download]] as [Tab, string, typeof Package][]).map(([key, label, Icon]) => (
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

        {/* #15: Captured skills + experience-synthesis candidates, pending review */}
        {tab === 'captured' && <CapturedSkillsTab />}
      </div>
    </AppShell>
  );
}

interface CapturedRow {
  id: string; name: string; description: string; steps: string[];
  prompt: string; status: string; source_session?: string; created_at: string;
}

function CapturedSkillsTab() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CapturedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthResult, setSynthResult] = useState<Array<{name: string; description: string; source_count: number}> | null>(null);

  const load = () => {
    setLoading(true);
    api.listCapturedSkills()
      .then(r => setRows(r.skills as unknown as CapturedRow[]))
      .catch(err => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleConfirm = async (id: string) => {
    setConfirming(id);
    try {
      await api.confirmCapturedSkill(id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setConfirming(null);
    }
  };

  const handleSynthesize = async () => {
    setSynthesizing(true);
    setSynthResult(null);
    try {
      const r = await api.synthesizeExperience();
      setSynthResult(r.candidates);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setSynthesizing(false);
    }
  };

  const pending = rows.filter(r => r.status !== 'confirmed');

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('skills.capturedTitle', '待审技能与经验')}</h2>
            <p className="text-sm text-text-tertiary">{t('skills.capturedHint', '聊天捕获的流程草稿 + 从多条已确认事实自动合成的经验候选，确认后成为可复用技能。')}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={handleSynthesize} isLoading={synthesizing}>
            <Sparkles size={14} className="mr-1" />
            {t('skills.synthesize', '整理经验')}
          </Button>
        </div>

        {synthResult && synthResult.length > 0 && (
          <Alert variant="success">
            {t('skills.synthesized', '已合成候选')}: {synthResult.map(c => c.name).join('、')}
          </Alert>
        )}

        {error && <Alert variant="error">{error}</Alert>}

        {loading ? (
          <div className="space-y-3"><Skeleton className="h-20 w-full rounded-xl" /><Skeleton className="h-20 w-full rounded-xl" /></div>
        ) : pending.length === 0 ? (
          <Card className="p-8 text-center text-text-tertiary">
            <Download size={28} className="mx-auto mb-3" />
            <p className="text-sm">{t('skills.noCaptured', '暂无待审技能。聊天中识别到可复用流程时会自动捕获，或点击「整理经验」从已确认事实合成。')}</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {pending.map((row) => {
              const isSynth = row.source_session?.includes('experience-synthesis');
              return (
                <Card key={row.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-text-primary">{row.name}</h3>
                        <Badge variant={isSynth ? 'warning' : 'default'} className="shrink-0 text-[10px]">
                          {isSynth ? t('skills.badgeSynth', '经验合成') : t('skills.badgeCaptured', '对话捕获')}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-text-tertiary">{row.description}</p>
                      {row.steps.length > 0 && (
                        <ol className="mt-2 list-inside list-decimal space-y-0.5 text-xs text-text-secondary">
                          {row.steps.slice(0, 6).map((s, i) => <li key={i}>{s}</li>)}
                        </ol>
                      )}
                    </div>
                    <Button size="sm" onClick={() => handleConfirm(row.id)} isLoading={confirming === row.id} className="shrink-0">
                      <Check size={14} className="mr-1" />
                      {t('common.confirm', '确认')}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
