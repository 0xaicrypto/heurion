import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MessageSquare, Activity, BookOpen, Brain, ArrowRight, Layers, Clock, Zap, Gauge } from 'lucide-react';
import { Card, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { MarketingShell } from '@/components/marketing/MarketingShell';

interface MemoryStats {
  facts: number;
  episodes: number;
  knowledge: number;
  events: number;
}

interface ScopeCoverageView {
  scope: string;
  patientHash?: string;
  confirmedFacts: number;
  coveredFacts: number;
  ratio: number;
  uncoveredSample: string[];
}

interface CoverageView {
  global: ScopeCoverageView;
  patients: ScopeCoverageView[];
  hintThreshold: number;
}

function countField(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number') return value;
  return 0;
}

export function MemoryPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [coverage, setCoverage] = useState<CoverageView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.hasToken()) return;
    setLoading(true);
    Promise.all([
      api.exportMemory(),
      api.getKnowledgeCoverage().catch(() => null),
    ])
      .then(([rawStats, cov]) => {
        const data = rawStats as typeof rawStats & { event_log_count?: number };
        setStats({
          facts: countField(data.facts),
          episodes: countField(data.episodes),
          knowledge: countField(data.knowledge),
          events: countField(data.event_log_count),
        });
        if (cov) setCoverage(cov);
      })
      .catch((err) => setError(err.messageText || String(err)))
      .finally(() => setLoading(false));
  }, []);

  const T = {
    title: t('memory.title', '四层记忆 + 一次投影'),
    subtitle: t('memory.subtitle', 'Heurion 不会把整段聊天历史塞进模型。它把原始输入提炼成越来越抽象的记忆层，每次对话前只投影最相关的片段。'),

    layersTitle: t('memory.layersTitle', '记忆的四层抽象'),
    layers: [
      {
        icon: <MessageSquare size={24} />,
        title: t('memory.layerRaw', '原始输入'),
        desc: t('memory.layerRawDesc', '用户消息、上传文件、助手回复、确认动作，全部追加到不可变事件日志。'),
      },
      {
        icon: <Activity size={24} />,
        title: 'Facts',
        desc: t('memory.layerFactsDesc', '每 5 轮对话自动提取一次，带 category、importance、sourceType 与 patientHash。'),
      },
      {
        icon: <BookOpen size={24} />,
        title: 'Knowledge',
        desc: t('memory.layerKnowledgeDesc', '当 ≥3 条相关 Facts 累积后，自动合成为可读的知识总结并版本化。'),
      },
      {
        icon: <Brain size={24} />,
        title: 'Persona',
        desc: t('memory.layerPersonaDesc', '每次聊天前根据全部 Facts 与 Knowledge 动态生成系统人设。'),
      },
    ],

    projectionTitle: t('memory.projectionTitle', '六层记忆投影优先级'),
    projectionItems: [
      t('memory.projectionItem1', 'Persona：你是谁、关心什么、偏好何种表达方式'),
      t('memory.projectionItem2', '当前患者上下文（最高优先级，永不遗忘）'),
      t('memory.projectionItem3', '最近 3 轮完整对话（不压缩，保留细节）'),
      t('memory.projectionItem4', '近期会话 Episodes 摘要（压缩远期历史）'),
      t('memory.projectionItem5', '加权 Facts / Knowledge：attention = 重要性 × e^(-0.3×天数)'),
      t('memory.projectionItem6', 'Skills：被验证过并可复用的策略与工具'),
    ],

    decayTitle: t('memory.decayTitle', '时间衰减让记忆有重点'),
    decayBody: t('memory.decayBody', '一条 importance=5 的事实，7 天后注意力衰减到约 12%；importance=1 的事实几乎不再进入上下文。老知识不会消失，只是让位给更新、更相关的内容。'),

    ctaTitle: t('memory.ctaTitle', '查看记忆图谱'),
    ctaBody: t('memory.ctaBody', '在应用内打开 Memory Graph，直观浏览患者、事实与知识点之间的关联。'),
  };

  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 to-transparent" />
        <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:py-28">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Brain size={24} />
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">{T.title}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-text-secondary">{T.subtitle}</p>
        </div>
      </section>

      {api.hasToken() && (
        <section className="border-b border-border bg-surface">
          <div className="mx-auto max-w-7xl px-4 py-10">
            <h2 className="mb-6 text-center text-sm font-medium uppercase tracking-wider text-text-tertiary">
              {t('memory.statsTitle', '您的记忆统计')}
            </h2>
            {loading && (
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-20 w-full" />
                ))}
              </div>
            )}
            {error && (
              <p className="text-center text-sm text-error">{error}</p>
            )}
            {stats && !loading && (
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                <StatCard value={stats.facts} label="Facts" />
                <StatCard value={stats.episodes} label="Episodes" />
                <StatCard value={stats.knowledge} label="Summaries" />
                <StatCard value={stats.events} label={t('memory.statEvents', '事件')} />
              </div>
            )}
            {/* #816: facts→summary 覆盖率 — 记忆沉淀健康度 */}
            {coverage && !loading && (
              <div className="mx-auto mt-8 max-w-3xl">
                <CoveragePanel coverage={coverage} />
              </div>
            )}
          </div>
        </section>
      )}

      <section className="mx-auto max-w-7xl px-4 py-24">
        <h2 className="mb-10 text-center text-2xl font-bold text-text-primary">{T.layersTitle}</h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {T.layers.map((l, idx) => (
            <Card key={idx} className="p-6 text-center transition-all hover:border-accent/30">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">{l.icon}</div>
              <h3 className="font-semibold text-text-primary">{l.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{l.desc}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="grid items-start gap-12 lg:grid-cols-2">
            <div>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Layers size={24} />
              </div>
              <h2 className="text-2xl font-bold text-text-primary">{T.projectionTitle}</h2>
              <p className="mt-4 text-text-secondary">{t('memory.projectionIntro', '投影不是简单拼接，而是按优先级与注意力权重把不同记忆层组合成系统 Prompt。')}</p>
            </div>
            <div className="space-y-4">
              {T.projectionItems.map((item, idx) => (
                <div key={idx} className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">{idx + 1}</div>
                  <p className="text-text-secondary">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <Card className="p-8">
            <div className="flex items-center gap-3 text-accent">
              <Clock size={20} />
              <span className="font-bold">attention = importance × e^(-0.3 × days)</span>
            </div>
            <div className="mt-6 space-y-3">
              {[
                { label: t('memory.decayRow5', 'importance=5，7 天后'), v: '~12%' },
                { label: t('memory.decayRow3', 'importance=3，7 天后'), v: '~3%' },
                { label: t('memory.decayRow1', 'importance=1，7 天后'), v: '~0.7%' },
              ].map((row, idx) => (
                <div key={idx} className="flex items-center justify-between border-b border-border pb-3 last:border-0 last:pb-0">
                  <span className="text-text-secondary">{row.label}</span>
                  <span className="font-mono text-text-primary">{row.v}</span>
                </div>
              ))}
            </div>
          </Card>
          <div>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Zap size={24} />
            </div>
            <h2 className="text-2xl font-bold text-text-primary">{T.decayTitle}</h2>
            <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.decayBody}</p>
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-16 text-center">
          <h2 className="text-2xl font-bold text-text-primary">{T.ctaTitle}</h2>
          <p className="mx-auto mt-3 max-w-xl text-text-secondary">{T.ctaBody}</p>
          <div className="mt-6">
            <Link to="/app/today" className="inline-flex items-center font-medium text-accent hover:underline">
              {t('memory.ctaOpenApp', '进入应用')}
              <ArrowRight size={16} className="ml-1" />
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-4 text-center">
      <p className="text-3xl font-bold text-accent">{value}</p>
      <p className="mt-1 text-sm text-text-tertiary">{label}</p>
    </div>
  );
}

/** #816: 覆盖率面板 — ratio 条 + 低覆盖提示(沉淀/手动合成)。 */
function CoveragePanel({ coverage }: { coverage: CoverageView }) {
  const { t } = useTranslation();
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  const rows = [coverage.global, ...coverage.patients].filter((r) => r.confirmedFacts > 0);
  if (rows.length === 0) return null;
  return (
    <Card className="p-6 text-left">
      <div className="mb-4 flex items-center gap-2 text-accent">
        <Gauge size={18} />
        <span className="font-semibold">{t('memory.coverageTitle', '知识覆盖率（facts → summary）')}</span>
      </div>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={`${r.scope}-${r.patientHash || 'global'}`}>
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">
                {r.scope === 'global' ? t('memory.coverageGlobal', '全局知识库') : `${t('memory.coveragePatient', '患者')} ${r.patientHash?.slice(0, 12)}`}
              </span>
              <span className="font-mono text-text-primary">
                {r.coveredFacts}/{r.confirmedFacts} · {pct(r.ratio)}
              </span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-border">
              <div
                className={`h-full rounded-full ${r.ratio < coverage.hintThreshold ? 'bg-error' : 'bg-accent'}`}
                style={{ width: pct(r.ratio) }}
              />
            </div>
            {r.ratio < coverage.hintThreshold && (
              <p className="mt-1 text-xs text-text-tertiary">
                {t('memory.coverageLow', '覆盖率偏低 — 可在对话中说"总结知识库"或对相关事实手动合成总结（如：{{sample}}）', { sample: r.uncoveredSample[0]?.slice(0, 40) || '…' })}
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
