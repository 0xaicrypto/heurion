import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Check, X, Zap, Key, Server, RefreshCw, Activity, BarChart3, Mail, ScrollText, ShieldCheck, Plus, FileText } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { api, ApiError } from '@/lib/api';
import { EmailBindCard } from '@/components/EmailBindCard';
import { AuditSection } from '@/routes/audit';
import { LogsSection } from '@/routes/logs';
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

type Tab = 'profile' | 'llm' | 'embedding' | 'observability' | 'audit' | 'logs' | 'integrations' | 'credits';

const TAB_ALIASES: Record<string, Tab> = { audit: 'audit', logs: 'logs' };

export function SettingsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab');
  const [tab, setTab] = useState<Tab>(TAB_ALIASES[urlTab || ''] || 'llm');

  const selectTab = (next: Tab) => {
    setTab(next);
    setSearchParams(next === 'llm' ? {} : { tab: next }, { replace: true });
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('settings.title')}</h1>
        </header>
        <div className="flex flex-col lg:flex-row">
          <nav className="border-b border-border bg-surface px-3 py-2 lg:w-48 lg:border-b-0 lg:border-r lg:py-4">
            {/* #354: grouped nav — 账号安全 / 模型配置 / 数据管理 / 可观测性 */}
            <TabGroup label={t('settings.groupAccount', '账号安全')}>
              <TabButton active={tab === 'profile'} onClick={() => selectTab('profile')}>
                {t('settings.profile')}
              </TabButton>
            </TabGroup>
            <TabGroup label={t('settings.groupModels', '模型配置')}>
              <TabButton active={tab === 'llm'} onClick={() => selectTab('llm')}>
                {t('settings.llm')}
              </TabButton>
              <TabButton active={tab === 'embedding'} onClick={() => selectTab('embedding')}>
                {t('settings.embedding')}
              </TabButton>
            </TabGroup>
            <TabGroup label={t('settings.groupData', '数据管理')}>
              <TabButton active={tab === 'audit'} onClick={() => selectTab('audit')}>
                <ShieldCheck size={14} className="mr-1 inline" />
                {t('nav.audit', 'Audit')}
              </TabButton>
              <TabButton active={tab === 'logs'} onClick={() => selectTab('logs')}>
                <ScrollText size={14} className="mr-1 inline" />
                {t('nav.logs', 'Logs')}
              </TabButton>
            </TabGroup>
            <TabGroup label={t('settings.groupOps', '可观测性')}>
              <TabButton active={tab === 'observability'} onClick={() => selectTab('observability')}>
                {t('settings.observability')}
              </TabButton>
            </TabGroup>
            <TabGroup label={t('settings.groupIntegrations', '集成')}>
              <TabButton active={tab === 'integrations'} onClick={() => selectTab('integrations')}>
                {t('settings.mcp', 'MCP 连接器')}
              </TabButton>
            </TabGroup>
            <TabGroup label={t('settings.groupAbout', '关于')}>
              <TabButton active={tab === 'credits'} onClick={() => selectTab('credits')}>
                <FileText size={14} className="mr-1 inline" />
                {t('settings.credits', '开源致谢')}
              </TabButton>
            </TabGroup>
          </nav>
          <main className="flex-1 p-4 sm:p-6">
            {tab === 'profile' && <ProfileSection />}
            {tab === 'llm' && <LlmSection />}
            {tab === 'embedding' && <EmbeddingSection />}
            {tab === 'observability' && <ObservabilitySection />}
            {tab === 'audit' && <AuditSection />}
            {tab === 'logs' && <LogsSection />}
            {tab === 'integrations' && <McpSection />}
            {tab === 'credits' && <CreditsSection />}
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
    <li className="shrink-0">
      <button
        onClick={onClick}
        className={cn(
          'w-full rounded-lg px-3 py-1.5 text-left text-sm font-medium transition-colors',
          active ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary',
        )}
      >
        {children}
      </button>
    </li>
  );
}

/** #354: a labeled group of tabs — hidden group label on mobile, shown on lg. */
function TabGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <li className="px-3 pb-0.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary max-lg:hidden">
        {label}
      </li>
      {children}
    </>
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
        {profile.email && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary">
            <Mail size={12} />
            {profile.email}
            {profile.email_verified ? (
              <span className="text-success">{t('auth.verified', '已验证')}</span>
            ) : null}
          </div>
        )}
      </Card>
      )}

      {/* #285: persistent email binding entry */}
      <Card className={cn('space-y-2 p-4', !profile?.email && 'border-accent/40 bg-accent/5')}>
        <label className="flex items-center gap-1.5 text-sm font-medium text-text-secondary">
          {t('auth.emailBinding', '绑定邮箱')}
          {!profile?.email && <Badge variant="warning">{t('auth.unbound', '未绑定')}</Badge>}
        </label>
        <p className="text-xs text-text-tertiary">{t('auth.emailBindingHint', '绑定后可凭邮箱登录与找回密码（手机为可选字段）')}</p>
        {profile?.email ? (
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm">
            <Mail size={14} className="shrink-0 text-text-tertiary" />
            <span className="min-w-0 flex-1 truncate text-text-primary">{profile.email}</span>
            <span className="flex items-center gap-1 text-xs text-success">
              <Check size={12} />
              {t('auth.verified', '已验证')}
            </span>
          </div>
        ) : (
          <EmailBindCard compact onBound={() => api.getUserProfile().then(setProfile).catch(() => {})} />
        )}
      </Card>

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
          <ImageGenConfig />
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
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
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
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
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


/* ────────────────────────── MCP Integrations (#417) ────────────────────────── */
interface McpServerRow {
  id: string; name: string; url: string; capabilities: string[];
  enabled: boolean; has_token: boolean; created_at: string;
}

function McpSection() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [caps, setCaps] = useState<string[]>(['read']);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; tools: Array<{ name: string; description?: string; is_write?: boolean }> } | null>(null);

  const load = () => {
    setLoading(true);
    api.listMcpServers().then((r) => setServers(r.servers)).catch((err) => setError(err instanceof ApiError ? err.messageText : String(err))).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!name.trim() || !url.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.addMcpServer({ name: name.trim(), url: url.trim(), capabilities: caps, token: token || undefined });
      setName(''); setUrl(''); setToken(''); setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    try { await api.deleteMcpServer(id); load(); } catch (err) { setError(err instanceof ApiError ? err.messageText : String(err)); }
  };

  const test = async (id: string) => {
    setError(null);
    try {
      const res = await api.testMcpServer(id);
      setTestResult({ id, ok: res.ok, tools: res.tools || [] });
    } catch (err) {
      setTestResult({ id, ok: false, tools: [] });
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">{t('settings.mcpHint', '配置外部系统（EHR/影像/检验）的 MCP 连接。只读工具立即执行；写工具需管理员审批。')}</p>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus size={14} className="mr-1" /> {t('settings.addServer', '添加服务器')}
        </Button>
      </div>
      {error && <Alert variant="error">{error}</Alert>}

      {showForm && (
        <Card className="space-y-3 p-4">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.serverName', '名称（如 EHR）')} aria-label="name" />
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://ehr.example.com/mcp" aria-label="url" />
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('settings.serverToken', 'Bearer token（可选）')} aria-label="token" />
          <div className="flex gap-1.5">
            {['read', 'write'].map((c) => (
              <button
                key={c}
                onClick={() => setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))}
                className={cn('rounded-full border px-3 py-1 text-xs', caps.includes(c) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary')}
              >
                {c === 'read' ? '只读' : '写'}
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>{t('common.cancel', '取消')}</Button>
            <Button size="sm" onClick={add} isLoading={saving} disabled={!name.trim() || !url.trim()}>{t('common.save', '保存')}</Button>
          </div>
        </Card>
      )}

      {loading ? <Skeleton className="h-16 w-full rounded-xl" /> : servers.length === 0 ? (
        <Card className="p-8 text-center text-sm text-text-tertiary">{t('settings.noServers', '尚未配置 MCP 服务器')}</Card>
      ) : (
        <div className="space-y-2">
          {servers.map((srv) => (
            <Card key={srv.id} className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium text-text-primary">{srv.name}</span>
                  <span className="ml-2 text-xs text-text-tertiary">{srv.url}</span>
                  <div className="mt-1 flex gap-1.5">
                    {srv.capabilities.map((c) => <Badge key={c} variant={c === 'write' ? 'warning' : 'default'}>{c === 'write' ? '写' : '只读'}</Badge>)}
                    {srv.has_token && <Badge>token ✓</Badge>}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => test(srv.id)}>{t('settings.testServer', '测试')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(srv.id)}>{t('common.delete', '删除')}</Button>
                </div>
              </div>
              {testResult?.id === srv.id && (
                <div className="mt-3 rounded-lg border border-border bg-surface p-3">
                  <p className="text-xs font-medium text-text-secondary">{testResult.ok ? '✓ 连接成功' : '✗ 连接失败'}</p>
                  {testResult.tools.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-text-tertiary">
                      {testResult.tools.map((tool) => (
                        <li key={tool.name}>- {tool.name}{tool.is_write ? ' [写]' : ''}{tool.description ? `: ${tool.description.slice(0, 60)}` : ''}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}


/* ────────────────────────── Image generation config (#419) ────────────────────────── */
function ImageGenConfig() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<{ base_url: string; model: string; has_key: boolean } | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getImageSettings().then((r) => {
      setCfg(r);
      setBaseUrl(r.base_url);
      setModel(r.model);
    }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      await api.updateImageSettings({ base_url: baseUrl.trim() || undefined, model: model.trim() || undefined, api_key: apiKey.trim() || undefined });
      setApiKey('');
      setMsg(t('settings.saved', '已保存'));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally { setSaving(false); }
  };

  return (
    <Card className="mt-4 space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">{t('settings.imageGen', '图像生成')}</span>
        {cfg?.has_key && <Badge variant="success">{t('settings.configured', '已配置')}</Badge>}
      </div>
      <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" aria-label="base_url" />
      <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="dall-e-3" aria-label="model" />
      <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t('settings.imgKey', 'API Key（可选，留空不改）')} aria-label="api_key" />
      {error && <Alert variant="error">{error}</Alert>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} isLoading={saving}>
          <Server size={14} className="mr-1.5" /> {t('common.save')}
        </Button>
        {msg && <span className="flex items-center gap-1 text-sm text-success"><Check size={14} /> {msg}</span>}
      </div>
    </Card>
  );
}

/* ────────────────────────── Credits (#470) ────────────────────────── */
function CreditsSection() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card className="p-6">
        <h2 className="text-base font-semibold text-text-primary">{t('settings.credits', '开源致谢')}</h2>
        <p className="mt-2 text-sm text-text-secondary leading-relaxed">
          {t('settings.creditsHint', 'Heurion 内置的科学插图内容来自以下开源项目。CC BY 4.0 要求保留署名。')}
        </p>

        <div className="mt-5 space-y-4">
          <div className="rounded-lg border border-border bg-surface-elevated p-4">
            <h3 className="text-sm font-medium text-text-primary">Reactome Pathway Database</h3>
            <p className="mt-1 text-xs text-text-tertiary leading-relaxed">
              {t('settings.creditsReactome', '信号通路图（render_scene 整图模式），CC BY 4.0。')}
              <a className="text-accent underline hover:opacity-80" href="https://reactome.org/license" target="_blank" rel="noreferrer"> reactome.org/license</a>
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface-elevated p-4">
            <h3 className="text-sm font-medium text-text-primary">NIH BioArt (Wikimedia Commons)</h3>
            <p className="mt-1 text-xs text-text-tertiary leading-relaxed">
              {t('settings.creditsBioArt', 'BioScene 图标目录（T 细胞、巨噬细胞、抗体等），公共领域（美国 NIH 作品）。')}
              <a className="text-accent underline hover:opacity-80" href="https://commons.wikimedia.org/wiki/Category:NIH_BioArt" target="_blank" rel="noreferrer"> commons.wikimedia.org/wiki/Category:NIH_BioArt</a>
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
