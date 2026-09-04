import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router-dom';
import { Brain, Check, ChevronDown, ExternalLink, FileText, Inbox, MessageSquare, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
// #653: 待审批行投影/加载与 today widget 收敛到共享 lib。
import { fetchIngestionRows, kindVariant, type IngestionRow as InboxRow } from '@/lib/ingestion-rows';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { RejectReasonDialog } from './RejectReasonDialog';
import type { MedicalRecordEntry, MemoryProposal } from '@/lib/types';

interface IngestionInboxProps {
  onChanged?: () => void;
}

/** file-pipeline 的 fact 提案 sourceRange 形如 `file:<fileId>#<window>`;压缩/会话提取形如 `session:<sessionId>`(#836-followup)。 */
const FILE_SOURCE_PREFIX = 'file:'
const SESSION_SOURCE_PREFIX = 'session:'

/** KB 重命名(facts→article→summary)后的本地化徽章文案 — 徽章不再裸显英文 kind。 */
const KIND_LABEL_KEYS: Record<string, string> = {
  fact: 'brain.kindFact',
  summary: 'brain.kindSummary',
  article: 'brain.kindSummary',
  episode_summary: 'brain.kindEpisode',
  compaction_summary: 'brain.kindCompaction',
}

interface FactFileGroup {
  key: string
  label: string
  icon: 'file' | 'session'
  rows: InboxRow[]
}

/**
 * #836-followup:提案 reason 是服务端内部机器串(英文),直接展示给用户
 * 很突兀。已知模式映射为本地化文案;未识别的原样保留(如"聊天/手动导入：…"
 * 本就是中文)。
 */
function localizeReason(reason: string, t: TFunction): string {
  const jit = reason.match(/^JIT read-time synthesis/)
  if (jit) return t('brain.reasonJit', '读时综合：临时产物，审核通过后沉淀为知识')
  const synth = reason.match(/^AI synthesis from (\d+) confirmed fact/)
  if (synth) return t('brain.reasonSynthesized', '基于 {{n}} 条已确认事实合成', { n: synth[1] })
  const comp = reason.match(/^Compaction extraction \((.+?), source: (.+?)\)$/)
  if (comp) {
    const roleMap: Record<string, string> = { doctor: '医生', patient: '患者', research: '研究', user: '用户' }
    return t('brain.reasonCompaction', '会话压缩提取（{{cat}}，来源：{{role}}）', {
      cat: comp[1],
      role: roleMap[comp[2]] || comp[2],
    })
  }
  const file = reason.match(/^extracted from file (.+)$/)
  if (file) return t('brain.reasonFromFile', '从文档《{{name}}》提取', { name: file[1] })
  return reason
}

/**
 * 按来源聚合 fact 提案 — 一个文档(或一次会话)一张审批卡,一键全收/全拒,
 * 展开可逐条复核。非文件/会话来源的提案/病历条目原样进 rest。
 * 文件名取自提案 reason(pipeline 固定写 "extracted from file <name>"),
 * 会话名取自服务端 enrichment 的 sourceSession;解析失败回退裸 ID。
 */
function partitionFactGroups(rows: InboxRow[]): { groups: FactFileGroup[]; rest: InboxRow[] } {
  const groups = new Map<string, FactFileGroup>()
  const rest: InboxRow[] = []
  for (const r of rows) {
    const sr = r.proposal?.sourceRange
    if (r.proposal?.kind !== 'fact' || !sr) {
      rest.push(r)
      continue
    }
    let key: string | null = null
    let label: string | null = null
    let icon: 'file' | 'session' = 'file'
    if (sr.startsWith(FILE_SOURCE_PREFIX)) {
      key = sr.split('#')[0]
      const m = r.proposal.reason?.match(/^extracted from file (.+)$/)
      label = m?.[1] || key.slice(FILE_SOURCE_PREFIX.length)
      icon = 'file'
    } else if (sr.startsWith(SESSION_SOURCE_PREFIX)) {
      // #836-followup: session:<id>#<quote> — 引号证据在 '#' 后,分组与回退
      // 标签只取 id 部分,否则每个事实各成一组。
      key = sr.split('#')[0]
      label = r.proposal.sourceSession || `会话 ${key.slice(SESSION_SOURCE_PREFIX.length).slice(-8)}`
      icon = 'session'
    }
    if (!key || !label) {
      rest.push(r)
      continue
    }
    const existing = groups.get(key)
    if (existing) {
      existing.rows.push(r)
    } else {
      groups.set(key, { key, label, icon, rows: [r] })
    }
  }
  return { groups: Array.from(groups.values()), rest }
}

/**
 * 提案溯源(#836-followup)— 服务端把 relatedFacts/sourceRange 解析为来源
 * 文档、会话与依据事实;此处展示 chips + 可展开的逐条依据(默认收起)。
 */
function SummaryProvenance({ proposal }: { proposal: MemoryProposal }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const docs = proposal.sourceDocuments ?? [];
  const sessions = proposal.sourceSessions ?? [];
  const facts = proposal.sourceFacts ?? [];
  if (docs.length === 0 && sessions.length === 0 && facts.length === 0) return null;
  return (
    <div className="mt-2">
      {(docs.length > 0 || sessions.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {docs.map((d) => (
            <span
              key={d}
              title={d}
              className="inline-flex max-w-[260px] items-center gap-1 rounded border border-border bg-surface-elevated px-1.5 py-0.5 text-[11px] text-text-secondary"
            >
              <FileText size={10} className="shrink-0 text-text-tertiary" />
              <span className="truncate">{d}</span>
            </span>
          ))}
          {sessions.map((s) => (
            <span
              key={s}
              title={s}
              className="inline-flex max-w-[260px] items-center gap-1 rounded border border-border bg-surface-elevated px-1.5 py-0.5 text-[11px] text-text-secondary"
            >
              <MessageSquare size={10} className="shrink-0 text-text-tertiary" />
              <span className="truncate">{s}</span>
            </span>
          ))}
        </div>
      )}
      {facts.length > 0 && (
        <>
          {docs.length === 0 && sessions.length === 0 && (
            <p className="mt-1 text-[11px] text-text-tertiary">
              {t('brain.legacyFactsNoOrigin', '以上为历史事实，当时未记录来源')}
            </p>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1.5 text-[11px] font-medium text-accent hover:underline"
          >
            {open ? t('brain.hideSources', '收起依据') : t('brain.viewSources', '查看依据')} ({facts.length})
          </button>
          {open && (
            <ul className="mt-1.5 space-y-1.5 rounded-lg border border-border bg-surface-elevated p-2">
              {facts.map((f) => (
                <li key={f.stableId} className="text-[11px] leading-relaxed text-text-secondary">
                  <span className="mr-1.5 font-mono text-[10px] text-text-tertiary">{f.stableId}</span>
                  {f.content}
                  {f.sourceDocument && <span className="ml-1.5 text-text-tertiary">— {f.sourceDocument}</span>}
                  {f.sourceSession && <span className="ml-1.5 text-text-tertiary">— {f.sourceSession}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function IngestionInbox({ onChanged }: IngestionInboxProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const kindLabel = useCallback(
    (kind: string) => {
      const key = KIND_LABEL_KEYS[kind];
      return key ? t(key, kind) : kind;
    },
    [t],
  );
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [targetFilter, setTargetFilter] = useState<'all' | 'entry' | 'memory'>('all');
  const [operating, setOperating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectIds, setRejectIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await fetchIngestionRows();
      setRows(rows);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filteredRows = useMemo(
    () => rows.filter((r) => {
      if (targetFilter === 'entry' && !r.entry) return false;
      if (targetFilter === 'memory' && !r.proposal) return false;
      if (typeFilter === 'all') return true;
      return r.entry?.type === typeFilter || r.proposal?.kind === typeFilter;
    }),
    [rows, typeFilter, targetFilter],
  );

  const typeOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.entry?.type || r.proposal?.kind).filter((x): x is MedicalRecordEntry['type'] | MemoryProposal['kind'] => Boolean(x)))),
    [rows],
  );

  // E: group pending by scope — patient groups + a global group.
  const groupedRows = useMemo(() => {
    const groups: Array<{ key: string; label: string; rows: typeof filteredRows }> = [];
    const byPatient = new Map<string, typeof filteredRows>();
    for (const r of filteredRows) {
      const hash = r.proposal?.patientHash ?? r.entry?.patientHash;
      if (!hash) {
        const g = groups.find((x) => x.key === '__global__');
        if (g) g.rows.push(r); else groups.push({ key: '__global__', label: t('brain.globalScope', '全局'), rows: [r] });
        continue;
      }
      if (!byPatient.has(hash)) byPatient.set(hash, []);
      byPatient.get(hash)!.push(r);
    }
    for (const [hash, rows] of byPatient) {
      const name = rows[0]?.patientName || hash;
      groups.push({ key: hash, label: name, rows });
    }
    return groups;
  }, [filteredRows, t]);

  const allVisibleSelected = filteredRows.length > 0 && filteredRows.every((r) => selected.has(r.approval.id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const r of filteredRows) next.delete(r.approval.id);
      } else {
        for (const r of filteredRows) next.add(r.approval.id);
      }
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const removeRows = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    setRows((prev) => prev.filter((r) => !gone.has(r.approval.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    onChanged?.();
  }, [onChanged]);

  // 批量操作改为有界并发逐条推进 — 每完成一条即更新进度并移除该行,
  // 失败条目留存原地,结束后汇总报错(此前 Promise.all 全量并发、
  // 全部完成才移除,批量时 UI 无任何反馈)。
  const runBatch = useCallback(async (ids: string[], op: (id: string) => Promise<unknown>) => {
    setOperating(true);
    setError(null);
    setProgress({ done: 0, total: ids.length });
    const succeeded: string[] = [];
    const failed: string[] = [];
    let cursor = 0;
    const CONCURRENCY = 4;
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          await op(id);
          succeeded.push(id);
        } catch {
          failed.push(id);
        }
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));
    if (succeeded.length > 0) removeRows(succeeded);
    if (failed.length > 0) {
      setError(`${t('brain.batchPartialFailed', '部分条目处理失败')} (${failed.length}/${ids.length})`);
    }
    setProgress(null);
    setOperating(false);
  }, [removeRows, t]);

  const confirmIds = useCallback(
    (ids: string[]) => runBatch(ids, (id) => api.confirmApproval(id)),
    [runBatch],
  );

  const handleReject = useCallback((ids: string[], reason: string) => {
    setRejectOpen(false);
    return runBatch(ids, (id) => api.rejectApproval(id, reason));
  }, [runBatch]);

  const renderRow = (row: InboxRow) => {
    const { approval, entry, proposal, patientName } = row;
    const patientLabel = patientName || t('brain.unknownPatient');
    if (proposal) {
      return (
        <li key={approval.id} className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <input
                type="checkbox"
                checked={selected.has(approval.id)}
                onChange={() => toggleSelect(approval.id)}
                className="mt-1 h-4 w-4 shrink-0 accent-accent"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Brain size={14} className="shrink-0 text-text-tertiary" />
                  <Badge variant={kindVariant[proposal.kind] ?? 'default'}>{kindLabel(proposal.kind)}</Badge>
                  {proposal.patientHash && <span className="truncate text-sm font-medium text-text-primary">{patientLabel}</span>}
                  <Badge variant="default">{proposal.confidence}</Badge>
                  <span className="text-xs text-text-tertiary">★ {proposal.importance}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{proposal.content}</p>
                {proposal.conflictsWith && (
                  <p className="mt-1 text-xs text-error">{t('brain.conflictWarning')}</p>
                )}
                {proposal.reason && (
                  <p className="mt-0.5 text-[11px] text-text-tertiary">
                    {localizeReason(proposal.reason, t)}
                  </p>
                )}
                {proposal.kind === 'summary' && (
                  <SummaryProvenance proposal={proposal} />
                )}
                {/* #845: skill 提案的剧本卡 diff 预览 — 激活后医生会看到什么 + 证据展示 */}
                {(() => {
                  const skillCard = (approval.payload as Record<string, any> | null)?.skillCard as
                    | { title: string; description: string; steps: string[]; followRate: string; evidence?: { observationCount?: number; correctionRate?: number; trajectoryCount?: number; sessionIds?: string[] } }
                    | undefined;
                  if (!skillCard) return null;
                  return (
                    <div data-testid="skill-card-preview" className="mt-2 rounded-lg border border-border bg-surface-2 p-3 text-xs">
                      <p className="font-medium text-text-primary">🧩 {skillCard.title}</p>
                      {skillCard.description && <p className="mt-0.5 text-text-secondary">{skillCard.description}</p>}
                      {skillCard.steps?.length > 0 && (
                        <ol className="mt-1 list-decimal pl-4 text-text-secondary">
                          {skillCard.steps.map((s, i) => <li key={i}>{s}</li>)}
                        </ol>
                      )}
                      <p className="mt-1 text-text-tertiary">
                        证据:{skillCard.evidence?.observationCount ?? 0} 次观察 ·
                        修正率 {Math.round((skillCard.evidence?.correctionRate ?? 0) * 100)}% ·
                        {skillCard.evidence?.trajectoryCount ?? 0} 条轨迹 · 遵循率 {skillCard.followRate}
                      </p>
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={() => confirmIds([approval.id])} disabled={operating}>
                <Check size={14} className="mr-1" /> {t('brain.confirm')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-error hover:bg-error/10"
                onClick={() => { setRejectIds([approval.id]); setRejectOpen(true); }}
                disabled={operating}
              >
                <X size={14} className="mr-1" /> {t('brain.reject')}
              </Button>
            </div>
          </div>
        </li>
      );
    }
    return (
      <li key={approval.id} className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <input
              type="checkbox"
              checked={selected.has(approval.id)}
              onChange={() => toggleSelect(approval.id)}
              className="mt-1 h-4 w-4 shrink-0 accent-accent"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-text-primary">{patientLabel}</span>
                <span className="text-xs text-text-tertiary">—</span>
                <span className="truncate text-sm text-text-secondary">{entry?.title || t('brain.unknownPatient')}</span>
                <Badge variant="warning">{entry?.status ?? 'pending_review'}</Badge>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                {entry?.type && <Badge variant="default">{entry.type}</Badge>}
                <span>{entry?.date ? new Date(entry.date).toLocaleDateString() : ''}</span>
                <span>{t('brain.autoAnalyzed')}</span>
              </div>
              {entry?.content && (
                <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{entry.content}</p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={() => confirmIds([approval.id])} disabled={operating} isLoading={operating && selected.has(approval.id)}>
              <Check size={14} className="mr-1" /> {t('brain.confirm')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-error hover:bg-error/10"
              onClick={() => { setRejectIds([approval.id]); setRejectOpen(true); }}
              disabled={operating}
            >
              <X size={14} className="mr-1" /> {t('brain.reject')}
            </Button>
            {entry?.patientHash && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => navigate(`/app/patients/${entry.patientHash}/records`)}
              >
                <ExternalLink size={14} className="mr-1" /> {t('brain.view')}
              </Button>
            )}
          </div>
        </div>
      </li>
    );
  };

  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="mb-4 h-5 w-40" />
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-text-primary">{t('brain.inboxTitle')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={targetFilter}
            onChange={(e) => setTargetFilter(e.target.value as typeof targetFilter)}
            className="h-8 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('brain.targetFilter', 'Filter by target')}
          >
            <option value="all">{t('brain.allTargets', 'All targets')}</option>
            <option value="entry">MedicalRecordEntry</option>
            <option value="memory">MemoryProposal</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              disabled={filteredRows.length === 0}
              className="h-4 w-4 accent-accent"
            />
            {t('brain.selectAll')}
          </label>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-8 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('brain.typeFilter')}
          >
            <option value="all">{t('brain.allTypes')}</option>
            {typeOptions.map((type) => (
              <option key={type} value={type}>{KIND_LABEL_KEYS[type] ? t(KIND_LABEL_KEYS[type], type) : type}</option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={() => confirmIds(Array.from(selected))}
            disabled={selected.size === 0 || operating}
            isLoading={operating}
          >
            <Check size={14} className="mr-1" /> {t('brain.batchConfirm')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => { setRejectIds(Array.from(selected)); setRejectOpen(true); }}
            disabled={selected.size === 0 || operating}
          >
            <X size={14} className="mr-1" /> {t('brain.batchReject')}
          </Button>
        </div>
      </div>

      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      {progress && (
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-text-tertiary">
            <span>{t('brain.batchProgressing', '正在处理审批')} {progress.done}/{progress.total}</span>
            <span>{Math.round((progress.done / Math.max(1, progress.total)) * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
            <div
              className="h-full rounded-full bg-accent transition-all duration-200"
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <Inbox size={36} className="mb-3 text-text-tertiary" />
          <p className="text-sm font-medium text-text-primary">{t('brain.emptyTitle')}</p>
          <p className="text-xs text-text-secondary">{t('brain.emptySubtitle')}</p>
          <p className="mt-1 text-xs text-text-tertiary">{t('brain.emptyHint')}</p>
        </div>
      ) : filteredRows.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-tertiary">{t('brain.noEntries')}</p>
      ) : (
        <div className="space-y-5">
          {groupedRows.map((group) => {
            const { groups: factGroups, rest } = partitionFactGroups(group.rows);
            return (
              <div key={group.key}>
                <div className="mb-2 flex items-center gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{group.label}</h4>
                  <span className="text-xs text-text-tertiary">({group.rows.length})</span>
                </div>
                <ul className="space-y-3">
                  {factGroups.map((g) => {
                    const gIds = g.rows.map((r) => r.approval.id);
                    const isOpen = expandedGroups.has(g.key);
                    return (
                      <li key={g.key} className="rounded-xl border border-border bg-surface">
                        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            onClick={() => toggleGroup(g.key)}
                            aria-expanded={isOpen}
                          >
                            <span className="shrink-0 text-text-tertiary">
                              {g.icon === 'session' ? <MessageSquare size={14} /> : <FileText size={14} />}
                            </span>
                            <span className="truncate text-sm font-medium text-text-primary">{g.label}</span>
                            <Badge variant="default">
                              {g.icon === 'session'
                                ? `${t('brain.sessionGroupFacts', '会话提取的记忆')} · ${g.rows.length}`
                                : `${t('brain.docGroupFacts', '文档提取的记忆')} · ${g.rows.length}`}
                            </Badge>
                            <ChevronDown size={14} className={`shrink-0 text-text-tertiary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                          </button>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button size="sm" onClick={() => confirmIds(gIds)} disabled={operating}>
                              <Check size={14} className="mr-1" /> {t('brain.groupConfirmAll', '全部接受')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-error hover:bg-error/10"
                              onClick={() => { setRejectIds(gIds); setRejectOpen(true); }}
                              disabled={operating}
                            >
                              <X size={14} className="mr-1" /> {t('brain.groupRejectAll', '全部拒绝')}
                            </Button>
                          </div>
                        </div>
                        {isOpen && (
                          <ul className="space-y-3 border-t border-border p-4">
                            {g.rows.map(renderRow)}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                  {rest.map(renderRow)}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <RejectReasonDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        loading={operating}
        onConfirm={(reason) => handleReject(rejectIds.length ? rejectIds : [], reason)}
      />
    </Card>
  );
}
