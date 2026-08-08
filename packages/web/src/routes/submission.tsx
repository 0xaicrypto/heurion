import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, FileText, Mail, BookOpen, Copy, Check, Download } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Card, Input, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { JournalRecommendation, FormatTemplate, SubmissionDraft } from '@/lib/types';
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(async (patch: Partial<SubmissionDraft>) => {
    if (!title.trim()) return;
    try {
      const res = await api.saveSubmissionDraft({
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
      // #382: the submission inputs ARE the paper — keep the cross-tab link fresh.
      setPaperLink({ title: title.trim(), abstract: abstract || '', docId: getPaperLink()?.docId, updatedAt: Date.now() });
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSavedFlash(false), 1500);
    } catch {
      /* autosave is best-effort */
    }
  }, [title, abstract, keywords, authors]);

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

            {tab === 'journals' && <JournalsTab title={title} abstract={abstract} onPick={(j) => persist({ target_journal: j.name })} />}
            {tab === 'cover' && <CoverTab title={title} abstract={abstract} authors={authors} draft={draft} onSaved={(cl) => persist({ cover_letter: cl })} />}
            {tab === 'template' && <TemplateTab title={title} abstract={abstract} authors={authors} onSaved={(tid) => persist({ template_id: tid })} />}
            {tab === 'check' && <CheckTab draft={draft} />}
          </div>
        </div>
      </div>
  );
}

/** Standalone page — legacy /app/submission route. */
export function SubmissionPage() {
  return (
    <AppShell>
      <SubmissionWorkbench />
    </AppShell>
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

/* ══════════════ Tab 1: 选刊推荐 ══════════════ */
function JournalsTab({ title, abstract, onPick }: { title: string; abstract: string; onPick: (j: JournalRecommendation) => void }) {
  const { t } = useTranslation();
  const [journals, setJournals] = useState<JournalRecommendation[]>([]);
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
      const res = await api.recommendJournals({ title, abstract });
      setJournals(res.journals);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={recommend} isLoading={loading}>
          {t('submission.recommend', '推荐期刊')}
        </Button>
        {journals.length > 0 && (
          <span className="text-xs text-text-tertiary">{journals.length} {t('submission.topJournals', '个推荐期刊')}</span>
        )}
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : journals.length === 0 ? (
        <Card className="p-8 text-center text-sm text-text-tertiary">
          {t('submission.journalsHint', '填写标题/摘要后点击「推荐期刊」，获取 Top 5 期刊匹配')}
        </Card>
      ) : (
        journals.map((j) => (
          <Card key={j.id} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-text-primary">{j.name}</span>
              <BadgePill>IF {j.impact_factor}</BadgePill>
              <BadgePill>{t('submission.acceptRate', '接受率')} {j.acceptance_rate}%</BadgePill>
              <BadgePill>{t('submission.reviewWeeks', '审稿')} ~{j.review_weeks}{t('submission.weeks', '周')}</BadgePill>
              <BadgePill>{j.cas_zone}</BadgePill>
              <span className="ml-auto text-sm text-text-secondary">{'★'.repeat(Math.min(5, Math.max(1, Math.round(j.match_score))))}</span>
            </div>
            <p className="mt-2 text-xs text-text-tertiary">{j.reason}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { onPick(j); setPickedId(j.id); }}
              >
                {pickedId === j.id ? <><Check size={13} className="mr-1" />{t('submission.selected', '已选用')}</> : t('submission.useTemplate', '使用该刊')}
              </Button>
            </div>
          </Card>
        ))
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
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cover-letter-${(title || 'paper').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40)}.md`;
    a.click();
    URL.revokeObjectURL(url);
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

/* ══════════════ Tab 4: 投稿前检查 + 状态追踪 ══════════════ */
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'draft', label: '拟投' },
  { value: 'ready', label: '已就绪' },
  { value: 'submitted', label: '已投' },
  { value: 'revision', label: '返修' },
  { value: 'published', label: '发表' },
];

function CheckTab({ draft }: { draft: SubmissionDraft | null }) {
  const { t } = useTranslation();
  const [checks, setChecks] = useState<Array<{ id: string; label: string; ok: boolean }>>([]);
  const [passed, setPassed] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(draft?.status || 'draft');
  const [statusSaving, setStatusSaving] = useState(false);

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
    } catch {
      /* ignore */
    } finally {
      setStatusSaving(false);
    }
  };

  return (
    <div className="space-y-4">
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
              {opt.label}
            </button>
          ))}
        </div>
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
