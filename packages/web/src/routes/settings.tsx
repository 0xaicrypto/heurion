import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Zap, Key, Server, RefreshCw, Activity, BarChart3 } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { api, ApiError } from '@/lib/api-client';
import type { LlmStatus, LlmTestResult, ProviderKind, UserProfile, LlmUpdateInput, QueueMetrics, LlmCostDashboard } from '@/lib/types';
import { useAuthStore } from '@/stores/auth';
import { Button, Input, Card, Badge, Alert, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';

const PROVIDERS: { value: ProviderKind; label: string }[] = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'kimi', label: 'Kimi' },
];

type Tab = 'profile' | 'llm' | 'embedding' | 'observability';

export function SettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('llm');

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('settings.title')}</h1>
        </header>
        <div className="flex">
          <nav className="w-48 border-r border-border bg-surface px-3 py-4">
            <ul className="space-y-1">
              <TabButton active={tab === 'profile'} onClick={() => setTab('profile')}>
                {t('settings.profile')}
              </TabButton>
              <TabButton active={tab === 'llm'} onClick={() => setTab('llm')}>
                {t('settings.llm')}
              </TabButton>
              <TabButton active={tab === 'embedding'} onClick={() => setTab('embedding')}>
                {t('settings.embedding')}
              </TabButton>
              <TabButton active={tab === 'observability'} onClick={() => setTab('observability')}>
                {t('settings.observability')}
              </TabButton>
            </ul>
          </nav>
          <main className="flex-1 p-6">
            {tab === 'profile' && <ProfileSection />}
            {tab === 'llm' && <LlmSection />}
            {tab === 'embedding' && <EmbeddingSection />}
            {tab === 'observability' && <ObservabilitySection />}
          </main>
        </div>
      </div>
    </AppShell>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className={cn(
          'w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
          active ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary',
        )}
      >
        {children}
      </button>
    </li>
  );
}

/* ────────────────────────── Profile Section ────────────────────────── */

function ProfileSection() {
  const { t } = useTranslation();
  const { displayName } = useAuthStore();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const [intendedUse, setIntendedUse] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getUserProfile()
      .then((p) => {
        setProfile(p);
        setName(p.display_name || displayName || '');
        setOrg(p.organization || '');
        setIntendedUse(p.intended_use || '');
      })
      .catch((err) => setError(err instanceof ApiError ? err.messageText : t('settings.profileLoadFailed')))
      .finally(() => setLoading(false));
  }, [displayName, t]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const updated = await api.updateUserProfile({
        display_name: name,
        organization: org,
        intended_use: intendedUse,
      });
      setProfile(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : t('settings.profileSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <ProfileSkeleton />;

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">{t('settings.profile')}</h2>

      {profile && (
        <Card className="p-4">
          <div className="mb-1 text-xs text-text-tertiary">User ID</div>
          <div className="font-mono text-sm text-text-secondary">{profile.user_id}</div>
          {profile.status && (
            <Badge className="mt-2" variant={profile.status === 'active' ? 'success' : 'warning'}>
              {profile.status}
            </Badge>
          )}
          {profile.tier && (
            <Badge className="ml-2">{profile.tier}</Badge>
          )}
        </Card>
      )}

      <Card className="space-y-4 p-4">
        <div>
          <label className="block text-sm font-medium text-text-secondary">{t('settings.displayNameLabel')}</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-secondary">{t('settings.organization')}</label>
          <Input value={org} onChange={(e) => setOrg(e.target.value)} className="mt-1" placeholder={t('common.optional')} />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-secondary">{t('settings.intendedUse')}</label>
          <Input value={intendedUse} onChange={(e) => setIntendedUse(e.target.value)} className="mt-1" placeholder={t('settings.intendedUsePlaceholder')} />
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleSave} isLoading={saving} size="sm">
            {t('common.save')}
          </Button>
          {saved && (
              <span className="flex items-center gap-1 text-sm text-success">
                <Check size={14} /> {t('common.saved')}
              </span>
          )}
          {error && <span className="text-sm text-error">{error}</span>}
        </div>
      </Card>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="max-w-lg space-y-6">
      <div className="h-6 w-24 animate-pulse rounded bg-surface" />
      <div className="space-y-4">
        <div className="h-20 animate-pulse rounded-xl bg-surface" />
        <div className="h-40 animate-pulse rounded-xl bg-surface" />
      </div>
    </div>
  );
}

/* ────────────────────────── LLM Section ────────────────────────── */

function LlmSection() {
  const { t } = useTranslation();
  const { role } = useAuthStore();
  const isAdmin = role === 'admin';
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState<ProviderKind>('deepseek');
  const [keyInput, setKeyInput] = useState('');
  const [savingLlm, setSavingLlm] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const loadStatus = useCallback(() => {
    api
      .getLlmStatus()
      .then((s) => {
        setStatus(s);
        setProvider(s.provider);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.messageText : t('settings.loadFailed')))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const providerKey = (): keyof LlmUpdateInput => {
    const map: Record<string, keyof LlmUpdateInput> = {
      gemini: 'gemini_api_key',
      openai: 'openai_api_key',
      anthropic: 'anthropic_api_key',
      kimi: 'kimi_api_key',
      deepseek: 'deepseek_api_key',
    };
    return map[provider];
  };

  const handleSaveLlm = async () => {
    setSavingLlm(true);
    setSavedMsg(null);
    setError(null);
    try {
      const input: LlmUpdateInput = { provider };
      if (keyInput.trim()) {
        (input as Record<string, string>)[providerKey()] = keyInput.trim();
      }
      const result = await api.updateLlmSettings(input);
      setStatus(result.status);
      setKeyInput('');
      setSavedMsg(t('settings.settingsSaved'));
      setTestResult(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : t('settings.saveFailed'));
    } finally {
      setSavingLlm(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const r = await api.testLlm();
      setTestResult(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : t('settings.testFailed'));
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <LlmSkeleton />;

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">{t('settings.llm')}</h2>

      {error && (
        <Alert variant="error">{error}</Alert>
      )}

      {status && (
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-text-secondary">{t('settings.currentProvider')}</div>
              <div className="font-mono text-text-primary">{status.provider}/{status.model}</div>
            </div>
            {status.activeKeySource && status.activeKeySource !== 'none' ? (
              <div className="flex items-center gap-1 text-sm text-success">
                <Key size={14} /> {status.activeKeySource}
              </div>
            ) : (
              <div className="flex items-center gap-1 text-sm text-warning">
                <X size={14} /> {t('common.noKey')}
              </div>
            )}
          </div>
          {status.activeKeyPreview && (
            <div className="text-xs text-text-tertiary">
              Key: {status.activeKeyPreview} (length: {status.activeKeyLength})
            </div>
          )}
          {status.advisory && (
            <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">{status.advisory}</div>
          )}
        </Card>
      )}

      {isAdmin ? (
        <Card className="space-y-4 p-4">
          <h3 className="font-medium text-text-primary">{t('settings.changeProvider')}</h3>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">{t('settings.provider')}</label>
            <div className="flex flex-wrap gap-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setProvider(p.value)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                    provider === p.value
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-text-secondary hover:border-border-strong',
                  )}
                >
                  {p.label}
                  {status && hasKey(status, p.value) && (
                    <Key size={12} className="ml-1 inline text-success" />
                  )}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              {t('settings.apiKeyLabel')}
            </label>
            <Input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleSaveLlm} isLoading={savingLlm} size="sm">
              <Server size={14} className="mr-1.5" />
              {t('common.save')}
            </Button>
            <Button variant="secondary" onClick={handleTest} isLoading={testing} size="sm">
              <Zap size={14} className="mr-1.5" />
              {t('settings.test')}
            </Button>
            {savedMsg && (
              <span className="flex items-center gap-1 text-sm text-success">
                <Check size={14} /> {savedMsg}
              </span>
            )}
          </div>
          {testResult && (
            <div
              className={cn(
                'rounded-lg px-4 py-3 text-sm',
                testResult.ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error',
              )}
            >
              <div className="font-medium">
                {testResult.ok ? t('common.connectionOk') : t('common.connectionFailed')}
                {testResult.latencyMs ? ` (${testResult.latencyMs}ms)` : ''}
              </div>
              <div className="text-xs opacity-80">
                {testResult.provider}/{testResult.model}
                {testResult.error ? ` — ${testResult.error}` : ''}
                {testResult.diagnosis ? ` [${testResult.diagnosis}]` : ''}
              </div>
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-4">
          <p className="text-sm text-text-tertiary text-center">
            {t('appName')} AI provider is configured by the server administrator.
          </p>
        </Card>
      )}
    </div>
  );
}

/* ────────────────────────── Observability Section ────────────────────────── */

/* ────────────────────────── Embedding Section ────────────────────────── */

function EmbeddingSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ ok: boolean; url: string; model?: string; dimensions?: number | null; device?: string; quantized?: boolean; dtype?: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getEmbeddingStatus()
      .then((s) => { setStatus(s); setError(null); })
      .catch((err) => setError(err instanceof ApiError ? err.messageText : t('settings.embeddingUnreachable')))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Skeleton className="h-40 w-full rounded-xl" />;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">{t('settings.embedding')}</h2>
        <Button size="sm" variant="secondary" onClick={load}>
          <RefreshCw size={14} className="mr-1.5" />
          {t('common.refresh')}
        </Button>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {status && status.ok && (
        <Card className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <Badge variant="success">{t('settings.embeddingOnline', 'Online')}</Badge>
            <span className="text-sm font-medium text-text-primary">{status.model || '—'}</span>
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-lg bg-surface px-3 py-2">
              <span className="text-text-tertiary">{t('settings.embeddingDimensions', 'Dimensions')}: </span>
              <span className="text-text-primary">{status.dimensions ?? '—'}</span>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2">
              <span className="text-text-tertiary">{t('settings.embeddingDevice', 'Device')}: </span>
              <span className="text-text-primary">{status.device || '—'}</span>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2">
              <span className="text-text-tertiary">{t('settings.embeddingQuantized', 'INT8 quantized')}: </span>
              <span className="text-text-primary">{status.quantized ? '✓' : '—'}</span>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2">
              <span className="text-text-tertiary">dtype: </span>
              <span className="text-text-primary">{status.dtype || '—'}</span>
            </div>
          </div>
          <p className="text-xs text-text-tertiary">{status.url}</p>
          <p className="text-xs text-text-secondary">{t('settings.embeddingHint', 'Dimensions appear after the first embed; change model/device in the embedding server env and re-verify dimensions here.')}</p>
        </Card>
      )}
    </div>
  );
}

function ObservabilitySection() {
  const { t } = useTranslation();
  const { role } = useAuthStore();
  const isAdmin = role === 'admin';
  const [llmCost, setLlmCost] = useState<LlmCostDashboard | null>(null);
  const [queue, setQueue] = useState<{ type: string; metrics: QueueMetrics } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cost, q] = await Promise.all([        isAdmin ? api.getAdminLlmCostDashboard() : Promise.resolve(null),
        api.getEvolutionQueueMetrics(),
      ]);
      setLlmCost(cost);
      setQueue(q);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : t('settings.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t, isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <ObservabilitySkeleton />;
  if (error) return <Alert variant="error">{error}</Alert>;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">{t('settings.observability')}</h2>
        <Button size="sm" variant="secondary" onClick={load}>
          <RefreshCw size={14} className="mr-1.5" />
          {t('common.refresh')}
        </Button>
      </div>

      {isAdmin && llmCost && (
        <Card className="space-y-4 p-4">
          <div className="flex items-center gap-2 font-medium text-text-primary">
            <BarChart3 size={18} />
            LLM Cost
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Stat label={t('settings.totalCalls')} value={llmCost.totalCalls} />
            <Stat label={t('settings.totalTokens')} value={llmCost.totalTokens} />
            <Stat label={t('settings.totalCost')} value={`$${llmCost.totalCostUsd.toFixed(4)}`} />
          </div>
          {Object.keys(llmCost.byModel).length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-medium text-text-secondary">{t('settings.byModel')}</h4>
              <div className="space-y-1">
                {Object.entries(llmCost.byModel).map(([model, m]) => (
                  <div key={model} className="flex justify-between border-b border-border pb-1 text-sm text-text-secondary">
                    <span>{model}</span>
                    <span>{m.calls} calls · {m.tokens} tokens · ${m.costUsd.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {queue && (
        <Card className="space-y-4 p-4">
          <div className="flex items-center gap-2 font-medium text-text-primary">
            <Activity size={18} />
            Evolution Queue ({queue.type})
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Stat label={t('settings.waiting')} value={queue.metrics.waiting} />
            <Stat label={t('settings.active')} value={queue.metrics.active} />
            <Stat label={t('settings.failed')} value={queue.metrics.failed} />
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3 text-center">
      <div className="text-2xl font-bold text-accent">{value}</div>
      <div className="mt-1 text-xs text-text-tertiary">{label}</div>
    </div>
  );
}

function ObservabilitySkeleton() {
  return (
    <div className="max-w-3xl space-y-6">
      <div className="h-6 w-32 animate-pulse rounded bg-surface" />
      <div className="h-40 animate-pulse rounded-xl bg-surface" />
      <div className="h-32 animate-pulse rounded-xl bg-surface" />
    </div>
  );
}

function hasKey(status: LlmStatus, provider: ProviderKind): boolean {
  const map: Record<ProviderKind, boolean> = {
    gemini: status.hasGeminiKey,
    openai: status.hasOpenaiKey,
    anthropic: status.hasAnthropicKey,
    kimi: status.hasKimiKey,
    deepseek: status.hasDeepseekKey,
  };
  return map[provider] ?? false;
}

function LlmSkeleton() {
  return (
    <div className="max-w-lg space-y-6">
      <div className="h-6 w-24 animate-pulse rounded bg-surface" />
      <div className="h-24 animate-pulse rounded-xl bg-surface" />
      <div className="h-48 animate-pulse rounded-xl bg-surface" />
    </div>
  );
}
