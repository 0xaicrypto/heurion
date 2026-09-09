import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, FileText, Mail, BookOpen, Copy, Check, Download } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { downloadBlob } from '@/lib/download';
import { Alert, Button, Card, Input, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { JournalRecordDto, RecommendJournalsResult, TieredRecommendationDto, PrecheckResult, FormatTemplate, SubmissionDraft } from '@/lib/types';
import { getPaperLink, setPaperLink } from '@/lib/paper-link';

type Tab = 'journals' | 'cover' | 'template' | 'check';

/** #362: embedded workbench (no AppShell) — used by the Writing & Submission tab. */
export function SubmissionWorkbench({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('journals');

  const [title, setTitle] = useState('');
  const [abstract, setAbstract] = useState('');
  const [keywords, setKeywords] = useState('');
  const [authors, setAuthors] = useState('');
  const [draft, setDraft] = useState<SubmissionDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  // #920: autosave 失败此前静默吞掉，用户以为已保存 — 走可见错误横幅。
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(async (patch: Partial<SubmissionDraft>) => {
    if (!title.trim()) return;
    try {
      // #902: 载荷带上当前关联文档 — 服务端按 docId 隔离草稿（#726），
      // 缺 doc_id 会错误命中「该状态最新一条」的旧草稿。
      const res = await api.saveSubmissionDraft({
        doc_id: getPaperLink()?.docId,
        article_title: title,
        abstract,
        keywords,
        authors: authors.split(',').map((a) => a.trim()).filter(Boolean),
        cover_letter: patch.cover_letter ?? undefined,
        target_journal: patch.target_journal ?? undefined,
        template_id: patch.template_id ?? undefined,
      });
      setDraft(res.draft);
      setSavedFlash(true);
      setSaveError(null);
      // #382: the submission inputs ARE the paper — keep the cross-tab link fresh.
      setPaperLink({ title: title.trim(), abstract: abstract || '', docId: getPaperLink()?.docId, updatedAt: Date.now() });
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      // #920: autosave is best-effort,但失败必须可见（内容仍留在本地输入框）。
      setSaveError(err instanceof ApiError ? err.messageText : t('submission.autosaveFailed', '自动保存失败，内容仍在本页，请重试'));
    }
  }, [title, abstract, keywords, authors, t]);

  // Restore the latest draft on mount (refresh never loses work).
  useEffect(() => {
    api.listSubmissionDrafts()
      .then((res) => {
        const latest = res.drafts[0];
        if (latest) {
          setTitle(latest.article_title || '');
          setAbstract(latest.abstract || '');
          setKeywords(latest.keywords || '');
          setAuthors((latest.authors || []).join(', '));
          setDraft(latest);
        }
        // #382: 选题带入 — the paper selected in the Write tab feeds the
        // submission inputs when the draft has no title yet (fresh link).
        const link = getPaperLink();
        if ((!latest || !latest.article_title) && link) {
          setTitle(link.title);
          setAbstract(link.abstract);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Debounced autosave when the article info changes.
  useEffect(() => {
    if (!loaded || !title.trim()) return;
    const timer = setTimeout(() => persist({}), 800);
    return () => clearTimeout(timer);
  }, [title, abstract, keywords, authors, loaded, persist]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {!embedded && (
        <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-6">
          <Send size={18} className="text-text-tertiary" />
          <h1 className="font-semibold text-text-primary">{t('submission.title', '投稿工作台')}</h1>
          {savedFlash && <span className="ml-auto text-xs text-success">✓ {t('submission.saved', '已自动保存')}</span>}
        </header>
      )}
      {/* #920: autosave 失败横幅（成功保存后自动清除）。 */}
      {saveError && (
        <div className="mx-6 mt-3">
          <Alert variant="error">{saveError}</Alert>
        </div>
      )}
      <div className="flex flex-col gap-4 p-6 lg:flex-row">
          {/* ① 论文信息面板 */}
          <Card className="h-fit w-full shrink-0 space-y-3 p-4 lg:w-80">
            <div className="flex items-center gap-1.5 text-sm font-medium text-text-secondary">
              <FileText size={14} />
              {t('submission.paperInfo', '论文信息')}
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary">{t('submission.titleLabel', '标题')}</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" aria-label={t('submission.titleLabel', '标题')} />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary">{t('submission.abstractLabel', '摘要')}</label>
              <textarea
                value={abstract}
                onChange={(e) => setAbstract(e.target.value)}
                aria-label={t('submission.abstractLabel', '摘要')}
                rows={6}
                className="mt-1 w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary">{t('submission.keywordsLabel', '关键词')}</label>
              <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} className="mt-1" placeholder="egfr, nsclc, immunotherapy" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary">{t('submission.authorsLabel', '作者（逗号分隔）')}</label>
              <Input value={authors} onChange={(e) => setAuthors(e.target.value)} className="mt-1" />
            </div>
            <p className="text-xs text-text-tertiary">{t('submission.autosaveHint', '修改自动保存，刷新不丢失')}</p>
          </Card>

          {/* ② 投稿助手 */}
          <div className="min-w-0 flex-1">
            <nav className="mb-3 flex flex-wrap gap-1">
              <TabBtn active={tab === 'journals'} onClick={() => setTab('journals')} icon={<BookOpen size={14} />} label={t('submission.journalsTab', '选刊推荐')} />
              <TabBtn active={tab === 'cover'} onClick={() => setTab('cover')} icon={<Mail size={14} />} label={t('submission.coverTab', 'Cover letter')} />
              <TabBtn active={tab === 'template'} onClick={() => setTab('template')} icon={<FileText size={14} />} label={t('submission.templateTab', '格式模板')} />
              <TabBtn active={tab === 'check'} onClick={() => setTab('check')} icon={<Check size={14} />} label={t('submission.checkTab', '投稿前检查')} />
            </nav>

            {tab === 'journals' && <JournalsTab title={title} abstract={abstract} language={undefined} onPick={(j) => persist({ target_journal: j.zh_name || j.name })} />}
            {tab === 'cover' && <CoverTab title={title} abstract={abstract} authors={authors} draft={draft} onSaved={(cl) => persist({ cover_letter: cl })} />}
            {tab === 'template' && <TemplateTab title={title} abstract={abstract} authors={authors} onSaved={(tid) => persist({ template_id: tid })} />}
            {tab === 'check' && <CheckTab draft={draft} />}
          </div>
        </div>
      </div>
  );
}


function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/* ══════════════ Tab 1: 选刊推荐(#848 三档梯度)══════════════ */

const ARTICLE_TYPE_OPTIONS = [
  { value: '', label: '自动/不限' },
  { value: 'rct', label: 'RCT' },
  { value: 'cohort', label: '队列研究' },
  { value: 'real_world', label: '真实世界/回顾性' },
  { value: 'case_report', label: '病例报告' },
  { value: 'review', label: '综述' },
  { value: 'meta', label: 'Meta 分析' },
];
const PRIORITY_OPTIONS = [
  { value: 'impact', label: '冲影响力' },
  { value: 'speed', label: '求速度' },
  { value: 'acceptance', label: '保接受' },
] as const;
const TIER_META: Record<'reach' | 'match' | 'safety', { label: string; hint: string; accent: string }> = {
  reach: { label: '冲刺', hint: '影响力高于当前匹配带,接受率低 — 值得一试', accent: 'border-l-rose-400' },
  match: { label: '匹配', hint: 'Scope 与研究类型最贴合的现实档', accent: 'border-l-emerald-400' },
  safety: { label: '保底', hint: '接受率/速度优先的稳妥选择', accent: 'border-l-sky-400' },
};
const DIM_LABELS: Record<string, string> = {
  scope: 'Scope 匹配',
  articleType: '研究类型适配',
  impact: '影响力',
  speed: '速度',
  acceptance: '接受率',
  cost: '费用',
};

function Monogram({ logo, large = false }: { logo: { monogram: string; color: string }; large?: boolean }) {
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-lg font-bold text-white', large ? 'h-10 w-10 text-base' : 'h-8 w-8 text-sm')}
      style={{ backgroundColor: logo.color }}
      aria-hidden
    >
      {logo.monogram}
    </span>
  );
}

function MetricBadge({ children }: { children: React.ReactNode }) {
  return <BadgePill>{children}</BadgePill>;
}

function JournalCard({ rec, picked, onPick }: { rec: TieredRecommendationDto; picked: boolean; onPick: (j: JournalRecordDto) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const j = rec.journal;
  const ifMetric = j.metrics.impact_factor;
  return (
    <Card className={cn('border-l-4 p-4', TIER_META[rec.tier].accent)}>
      <div className="flex items-start gap-3">
        <Monogram logo={j.logo} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-text-primary">{j.zh_name || j.name}</span>
            {j.zh_name && j.name !== j.zh_name && <span className="text-xs text-text-tertiary">{j.name}</span>}
            <span className="ml-auto text-sm font-medium text-text-secondary">{t('submission.matchScore', '匹配分')} {rec.total_score}</span>
          </div>
          {j.description && <p className="mt-0.5 text-xs text-text-tertiary">{j.description}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ifMetric && (
              <MetricBadge>
                IF {ifMetric.value}
                <span className="ml-1 text-[10px] text-text-tertiary">({t('submission.asOf', '截至')} {ifMetric.asOf})</span>
              </MetricBadge>
            )}
            {j.metrics.cas_zone && <MetricBadge>{j.metrics.cas_zone.value}</MetricBadge>}
            {j.metrics.acceptance_rate && <MetricBadge>{t('submission.acceptRate', '接受率')} ~{j.metrics.acceptance_rate.value}%</MetricBadge>}
            {j.metrics.review_weeks_median && <MetricBadge>{t('submission.reviewWeeks', '一审')} ~{j.metrics.review_weeks_median.value}{t('submission.weeks', '周')}</MetricBadge>}
            {j.metrics.apc && (
              <MetricBadge>
                APC ≈ {j.metrics.apc.currency === 'USD' ? '$' : `${j.metrics.apc.currency} `}{j.metrics.apc.value.toLocaleString('en-US')}
              </MetricBadge>
            )}
            {j.metrics.open_alex && <MetricBadge>h-index {j.metrics.open_alex.hIndex}</MetricBadge>}
            {j.freshness.stale && <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning">{t('submission.staleData', '数据较旧')}</span>}
          </div>
          {rec.breakdown.length > 0 && (
            <button type="button" onClick={() => setOpen(!open)} className="mt-2 text-xs font-medium text-accent hover:underline">
              {open ? t('submission.whyCollapse', '收起理由') : t('submission.whyExpand', '为什么推荐 / 为什么不是顶刊')}
            </button>
          )}
          {open && (
            <ul className="mt-2 space-y-1 rounded-lg border border-border bg-surface-elevated p-2.5">
              {rec.breakdown.map((b) => (
                <li key={b.dimension} className="flex items-start gap-2 text-xs">
                  <span className="w-20 shrink-0 font-medium text-text-secondary">{DIM_LABELS[b.dimension] ?? b.dimension}</span>
                  <span className="w-8 shrink-0 tabular-nums text-text-tertiary">{b.score}</span>
                  <span className="text-text-secondary">{b.evidence}</span>
                </li>
              ))}
              {/* 方案1: 同类文章证据(OpenAlex 全文检索,该刊近两年) */}
              {(j.similar_works?.length ?? 0) > 0 && (
                <li className="flex items-start gap-2 border-t border-border pt-1.5 text-xs">
                  <span className="w-20 shrink-0 font-medium text-text-secondary">{t('submission.similarWorks', '同类文章')}</span>
                  <span className="text-text-secondary">
                    {t('submission.similarWorksHint', '该刊近两年发表过相近工作：')}
                    <ul className="mt-0.5 space-y-0.5">
                      {j.similar_works!.slice(0, 2).map((w) => (
                        <li key={w.doi ?? w.title} className="truncate text-text-tertiary">
                          {w.doi
                            ? <a href={`https://doi.org/${w.doi}`} target="_blank" rel="noreferrer" className="hover:underline">{w.title}</a>
                            : w.title}
                          {w.year ? ` (${w.year})` : ''}
                        </li>
                      ))}
                    </ul>
                    <span className="text-[10px] text-text-tertiary">OpenAlex</span>
                  </span>
                </li>
              )}
            </ul>
          )}
          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={() => onPick(j)}>
              {picked ? <><Check size={13} className="mr-1" />{t('submission.selected', '已选用')}</> : t('submission.useTemplate', '使用该刊')}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function JournalsTab({ title, abstract, language, onPick }: { title: string; abstract: string; language: 'en' | 'zh' | undefined; onPick: (j: JournalRecordDto) => void }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<RecommendJournalsResult | null>(null);
  const [priority, setPriority] = useState<'impact' | 'speed' | 'acceptance'>('impact');
  const [articleType, setArticleType] = useState('');
  const [selfPayOa, setSelfPayOa] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);

  const recommend = async () => {
    if (!title.trim()) {
      setError(t('submission.needTitle', '请先填写论文标题'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.recommendJournals({
        title,
        abstract: abstract || undefined,
        article_type: articleType || undefined,
        priority,
        self_pay_oa: selfPayOa,
        language,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  };

  const pick = (j: JournalRecordDto) => {
    setPickedId(j.id);
    onPick(j);
  };

  const tierCount = result ? result.tiers.reach.length + result.tiers.match.length + result.tiers.safety.length : 0;

  return (
    <div className="space-y-3">
      {/* 画像控制(D3:priority 权重预设) */}
      <Card className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">{t('submission.priorityLabel', '档位偏好')}</span>
          <div className="flex gap-1">
            {PRIORITY_OPTIONS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPriority(p.value)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  priority === p.value ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={selfPayOa} onChange={(e) => setSelfPayOa(e.target.checked)} className="accent-[var(--accent)]" />
            {t('submission.selfPayOa', '接受自费 OA(APC)')}
          </label>
        </div>
        <select
          value={articleType}
          onChange={(e) => setArticleType(e.target.value)}
          aria-label={t('submission.articleTypeLabel', '研究类型')}
          className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {ARTICLE_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={recommend} isLoading={loading}>{t('submission.recommend', '推荐期刊')}</Button>
          {tierCount > 0 && (
            <span className="text-xs text-text-tertiary">
              {t('submission.tierSummary', '冲 {{reach}} / 稳 {{match}} / 保 {{safety}}', { reach: result!.tiers.reach.length, match: result!.tiers.match.length, safety: result!.tiers.safety.length })}
            </span>
          )}
        </div>
      </Card>

      {error && <Alert variant="error">{error}</Alert>}

      {/* 红线区(D5:预警期刊灰显,任何档位不得推荐) */}
      {result && result.redline.length > 0 && (
        <Card className="border-warning/40 bg-warning/5 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-warning">
            ⚠ {t('submission.redlineTitle', '红线预警(中科院预警名单{{asOf}})— 不推荐投稿', { asOf: result.warning_list_asof ? ` ${result.warning_list_asof}` : '' })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {result.redline.map((j) => (
              <span key={j.id} className="rounded-lg border border-warning/30 bg-surface px-2 py-1 text-xs text-text-tertiary line-through decoration-warning/60">
                {j.zh_name || j.name}
                <span className="ml-1 no-underline">— {j.warnings[0]?.note}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : !result ? (
        <Card className="p-8 text-center text-sm text-text-tertiary">
          {t('submission.journalsHint', '填写标题/摘要后点击「推荐期刊」，获取冲/稳/保三档梯度推荐')}
        </Card>
      ) : tierCount === 0 ? (
        <Card className="p-8 text-center text-sm text-text-tertiary">
          {t('submission.noMatch', '未找到有命中证据的期刊，可尝试补充摘要关键词')}
        </Card>
      ) : (
        (['reach', 'match', 'safety'] as const).map((tier) => {
          const recs = result.tiers[tier];
          if (recs.length === 0) return null;
          return (
            <section key={tier} className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                {TIER_META[tier].label}
                <span className="text-xs font-normal text-text-tertiary">{TIER_META[tier].hint}</span>
              </h3>
              {recs.map((rec) => (
                <JournalCard key={rec.journal.id} rec={rec} picked={pickedId === rec.journal.id} onPick={pick} />
              ))}
            </section>
          );
        })
      )}
    </div>
  );
}

function BadgePill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary">{children}</span>;
}

/* ══════════════ Tab 2: Cover letter ══════════════ */
function CoverTab({ title, abstract, authors, draft, onSaved }: { title: string; abstract: string; authors: string; draft: SubmissionDraft | null; onSaved: (cl: string) => void }) {
  const { t } = useTranslation();
  const [journal, setJournal] = useState(draft?.target_journal || '');
  const [text, setText] = useState(draft?.cover_letter || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (draft?.target_journal && !journal) setJournal(draft.target_journal);
    if (draft?.cover_letter && !text) setText(draft.cover_letter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const generate = async () => {
    if (!title.trim()) {
      setError(t('submission.needTitle', '请先填写论文标题'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.generateCoverLetter({
        title,
        abstract,
        authors: authors.split(',').map((a) => a.trim()).filter(Boolean),
        journal_name: journal || undefined,
      });
      setText(res.cover_letter);
      onSaved(res.cover_letter);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  };

  const downloadCoverLetter = () => {
    if (!text) return;
    // #653: 下载触发收敛 lib/download.downloadBlob。
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, `cover-letter-${(title || 'paper').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40)}.md`);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={journal}
          onChange={(e) => setJournal(e.target.value)}
          placeholder={t('submission.targetJournal', '目标期刊（可选）')}
          className="max-w-xs"
        />
        <Button size="sm" onClick={generate} isLoading={loading}>
          {t('submission.generateCover', '生成 Cover letter')}
        </Button>
        {text && (
          <>
            <Button size="sm" variant="ghost" onClick={copy}>
              {copied ? <Check size={13} className="mr-1" /> : <Copy size={13} className="mr-1" />}
              {copied ? t('common.copied', '已复制') : t('common.copy', '复制')}
            </Button>
            <Button size="sm" variant="ghost" onClick={downloadCoverLetter}>
              <Download size={13} className="mr-1" /> {t('submission.downloadCover', '下载 Markdown')}
            </Button>
          </>
        )}
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      {text ? (
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); onSaved(e.target.value); }}
          rows={18}
          className="w-full rounded-lg border border-border bg-surface-elevated p-3 font-mono text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <Card className="p-8 text-center text-sm text-text-tertiary">
          {t('submission.coverHint', 'AI 生成投稿信草稿（含研究亮点/原创声明），可自由编辑')}
        </Card>
      )}
    </div>
  );
}

/* ══════════════ Tab 3: 格式模板 ══════════════ */
function TemplateTab({ title, abstract, authors, onSaved }: { title: string; abstract: string; authors: string; onSaved: (tid: string) => void }) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<FormatTemplate[]>([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    api.listFormatTemplates()
      .then((res) => setTemplates(res.templates))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const prefill = async (template: FormatTemplate) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.prefillTemplate({
        template_id: template.id,
        title,
        abstract,
        authors: authors.split(',').map((a) => a.trim()).filter(Boolean),
      });
      setContent(res.content);
      onSaved(template.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  };

  // #382 联动点 3: 模板应用到写作 — create a Doc with the template skeleton.
  const applyToWriting = async (template: FormatTemplate) => {
    if (!title.trim()) {
      setError(t('submission.needTitle', '请先填写论文标题'));
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const prefilled = content || (await api.prefillTemplate({
        template_id: template.id, title, abstract,
        authors: authors.split(',').map((a) => a.trim()).filter(Boolean),
      })).content;
      const doc = await api.createDoc(`${title}（${template.journal_name} 模板）`);
      await api.updateDoc(doc.id, { title: doc.title, body: prefilled });
      setAppliedTemplateId(template.id);
      setPaperLink({ title: title.trim(), abstract: abstract || '', docId: doc.id, updatedAt: Date.now() });
      onSaved(template.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && <Alert variant="error">{error}</Alert>}
      {loading && !templates.length ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {templates.map((tmpl) => (
            <Card key={tmpl.id} className="p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary">{tmpl.journal_name}</span>
                <BadgePill>{tmpl.word_limit}</BadgePill>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-text-tertiary">{tmpl.reference_style}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => prefill(tmpl)}>
                  {t('submission.prefill', '预填充')}
                </Button>
                <Button size="sm" onClick={() => applyToWriting(tmpl)} isLoading={applying}>
                  {t('submission.applyToWriting', '应用到写作')}
                </Button>
              </div>
              {appliedTemplateId === tmpl.id && (
                <p className="mt-2 text-xs text-success">
                  ✓ {t('submission.appliedHint', '已创建文档，去「写作」Tab 继续填充')}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
      {content && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={16}
          className="w-full rounded-lg border border-border bg-surface-elevated p-3 font-mono text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
    </div>
  );
}

/* ══════════════ #851: 期刊要求对照检查 ══════════════ */
function JournalPrecheckCard({ draft }: { draft: SubmissionDraft | null }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(draft?.target_journal || '');
  const [candidates, setCandidates] = useState<JournalRecordDto[]>([]);
  const [journalId, setJournalId] = useState<string | null>(null);
  const [result, setResult] = useState<PrecheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #920: 检索此前无 loading/防重 — 连点会并发请求并互相覆盖结果。
  const [searching, setSearching] = useState(false);

  const search = async () => {
    if (!query.trim() || searching) return;
    setSearching(true);
    setError(null);
    try {
      const res = await api.searchJournals(query.trim());
      setCandidates(res.journals.slice(0, 6));
      if (res.journals.length === 0) setError(t('submission.journalNotFound', '未找到期刊，可尝试英文名检索'));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setSearching(false);
    }
  };

  const runPrecheck = async (id: string) => {
    setJournalId(id);
    setLoading(true);
    setError(null);
    try {
      const res = await api.precheck({
        journal_id: id,
        doc_id: getPaperLink()?.docId,
        text: draft?.abstract || undefined,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">{t('submission.journalPrecheck', '投稿前检查（对照期刊 Guide for Authors）')}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setJournalId(null); setResult(null); }}
          placeholder={t('submission.journalSearchPlaceholder', '输入期刊名检索，如 Lancet Oncology')}
          className="max-w-xs"
          onKeyDown={(e) => { if (e.key === 'Enter' && !searching) void search(); }}
        />
        <Button size="sm" variant="ghost" onClick={search} isLoading={searching} disabled={!query.trim() || searching}>{t('submission.journalSearch', '检索')}</Button>
      </div>
      {candidates.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {candidates.map((j) => (
            <button
              key={j.id}
              type="button"
              onClick={() => void runPrecheck(j.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors',
                journalId === j.id ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary',
              )}
            >
              <Monogram logo={j.logo} />
              {j.zh_name || j.name}
            </button>
          ))}
        </div>
      )}
      {loading && <Skeleton className="mt-3 h-16 w-full rounded-lg" />}
      {error && <Alert variant="error">{error}</Alert>}
      {result && (
        <div className="mt-3 space-y-2">
          {!result.ok && (
            <Alert variant="warning">
              {result.reason}
              {result.manual_url && (
                <> <a href={result.manual_url} target="_blank" rel="noreferrer" className="font-medium underline">{t('submission.openGuide', '打开官方要求')}</a></>
              )}
            </Alert>
          )}
          <ul className="space-y-1.5">
            {result.items.map((item) => (
              <li key={item.id} className="flex items-start gap-2 text-sm">
                {item.ok === true ? (
                  <Check size={14} className="mt-0.5 shrink-0 text-success" />
                ) : item.ok === false ? (
                  <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-error text-[10px] text-error">✕</span>
                ) : (
                  <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-warning text-[10px] text-warning">?</span>
                )}
                <span className={cn(item.ok === false ? 'text-text-primary' : 'text-text-secondary')}>
                  {item.label}
                  {item.detail && <span className="ml-1 text-xs text-text-tertiary">{item.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-tertiary">
            {t('submission.precheckLegend', '✓ 自动通过 · ✕ 需修改 · ? 人工核对')}
          </p>
        </div>
      )}
    </Card>
  );
}

/* ══════════════ Tab 4: 投稿前检查 + 状态追踪 ══════════════ */
// #718: 状态标签走 t() — 语言切换后跟随。
function statusLabel(v: string, t: (k: string, def: string) => string): string {
  switch (v) {
    case 'draft': return t('submission.statusDraft', '拟投');
    case 'ready': return t('submission.statusReady', '已就绪');
    case 'submitted': return t('submission.statusSubmitted', '已投');
    case 'revision': return t('submission.statusRevision', '返修');
    case 'published': return t('submission.statusPublished', '发表');
    default: return v;
  }
}
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'draft', label: 'draft' },
  { value: 'ready', label: 'ready' },
  { value: 'submitted', label: 'submitted' },
  { value: 'revision', label: 'revision' },
  { value: 'published', label: 'published' },
];

function CheckTab({ draft }: { draft: SubmissionDraft | null }) {
  const { t } = useTranslation();
  const [checks, setChecks] = useState<Array<{ id: string; label: string; ok: boolean }>>([]);
  const [passed, setPassed] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(draft?.status || 'draft');
  const [statusSaving, setStatusSaving] = useState(false);
  // #920: 状态更新失败此前静默 ignore — 用户以为状态已切换。
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    api.getSubmissionChecklist()
      .then((r) => { setChecks(r.checks); setPassed(r.passed); setTotal(r.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [draft?.updated_at]);

  const updateStatus = async (next: string) => {
    setStatusSaving(true);
    try {
      const res = await api.updateSubmissionStatus(next as SubmissionDraft['status']);
      setStatus(res.draft.status);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof ApiError ? err.messageText : t('submission.statusUpdateFailed', '状态更新失败，请重试'));
    } finally {
      setStatusSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* #851: 期刊要求对照检查 */}
      <JournalPrecheckCard draft={draft} />

      {/* 状态追踪 */}
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-text-secondary">{t('submission.statusTitle', '投稿状态')}</span>
          {statusSaving && <span className="text-xs text-text-tertiary">…</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateStatus(opt.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                status === opt.value
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary',
              )}
            >
              {statusLabel(opt.value, t)}
            </button>
          ))}
        </div>
        {/* #920: 状态更新失败可见。 */}
        {statusError && (
          <div className="mt-2">
            <Alert variant="error">{statusError}</Alert>
          </div>
        )}
      </Card>

      {/* 检查清单 */}
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-text-secondary">{t('submission.checklistTitle', '投稿前检查')}</span>
          <span className={cn('text-xs font-medium', passed === total && total > 0 ? 'text-success' : 'text-warning')}>
            {passed}/{total} {t('submission.checksDone', '项通过')}
          </span>
        </div>
        {loading ? (
          <Skeleton className="h-20 w-full rounded-xl" />
        ) : (
          <ul className="space-y-1.5">
            {checks.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                {c.ok ? (
                  <Check size={14} className="shrink-0 text-success" />
                ) : (
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-warning text-[10px] text-warning">!</span>
                )}
                <span className={c.ok ? 'text-text-primary' : 'text-text-secondary'}>{c.label}</span>
              </li>
            ))}
          </ul>
        )}
        {!loading && passed === total && total > 0 && (
          <p className="mt-3 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">
            ✓ {t('submission.readyHint', '检查全部通过，可以投稿了')}
          </p>
        )}
      </Card>
    </div>
  );
}
