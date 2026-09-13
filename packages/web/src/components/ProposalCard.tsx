import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { diffLines } from 'diff';
import {
  Sparkles, History, FileText, BarChart3, RotateCcw,
  Check, X, ChevronLeft, ChevronRight, Eye,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

/** #996/#998: 统一变更提议组件 — 设计稿四种触发场景共用同一张卡片,
 *  只差表头(图标+颜色+文案)与主操作;新增写入场景只需注册一个表头。 */
export type ProposalSource = 'ai_edit' | 'conflict' | 'methods' | 'results' | 'restore';

export interface ProposalReviewState {
  stats: { pending: number; accepted: number; rejected: number };
  changeNav: { idx: number; total: number };
  selectedChange: { id: string; text: string } | null;
  onJumpTo: (idx: number) => void;
  onResolveOne: (changeId: string, accept: boolean) => void;
  onResolveAll: (accept: boolean) => void;
  onFinish: (cancelled: boolean) => void;
}

/** 冲突双栏(#996/#997):yours = 本地待保存,saved = 服务端已保存版(409 payload)。 */
export interface ProposalConflictState {
  yours: string;
  saved: string;
  onKeepMine: () => void;
  onUseSaved: () => void;
}

type LucideIcon = typeof Sparkles;

const SOURCE_META: Record<ProposalSource, { icon: LucideIcon; chipClass: string; titleKey: string }> = {
  ai_edit: { icon: Sparkles, chipClass: 'bg-author-ai', titleKey: 'writing.proposal.aiEditTitle' },
  conflict: { icon: History, chipClass: 'bg-source-conflict', titleKey: 'writing.proposal.conflictTitle' },
  methods: { icon: FileText, chipClass: 'bg-accent', titleKey: 'writing.proposal.methodsTitle' },
  results: { icon: BarChart3, chipClass: 'bg-verify-verified', titleKey: 'writing.proposal.resultsTitle' },
  restore: { icon: RotateCcw, chipClass: 'bg-author-human', titleKey: 'writing.restoreReviewTitle' },
};

/** 冲突卡「View full diff」— 行级 unified diff(与前端 track-changes 同色语义)。 */
const MAX_DIFF_LINES = 80;
function LineDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffLines(before, after), [before, after]);
  const rows: Array<{ type: 'add' | 'del' | 'same'; text: string }> = [];
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, '').split('\n');
    for (const line of lines) {
      rows.push({ type: p.added ? 'add' : p.removed ? 'del' : 'same', text: line });
    }
  }
  const shown = rows.slice(0, MAX_DIFF_LINES);
  return (
    <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-surface font-mono text-[11px] leading-5">
      {shown.map((row, i) => (
        <div
          key={i}
          className={cn(
            'px-2 whitespace-pre-wrap break-all',
            row.type === 'add' && 'bg-[rgba(34,197,94,0.16)] text-[rgba(21,128,61,0.95)]',
            row.type === 'del' && 'bg-[rgba(239,68,68,0.14)] text-[rgba(185,28,28,0.9)] line-through decoration-[rgba(220,38,38,0.6)]',
            row.type === 'same' && 'text-text-tertiary',
          )}
        >
          <span className="mr-1 select-none opacity-60">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}</span>
          {row.text}
        </div>
      ))}
      {rows.length > shown.length && (
        <div className="border-t border-border px-2 py-1 text-text-tertiary">
          +{rows.length - shown.length} …
        </div>
      )}
    </div>
  );
}

export function ProposalCard({
  source,
  subject,
  titleOverride,
  note,
  queuedRounds,
  review,
  conflict,
  sticky,
}: {
  source: ProposalSource;
  subject?: string;
  titleOverride?: string;
  note?: string;
  queuedRounds?: number;
  review?: ProposalReviewState;
  conflict?: ProposalConflictState;
  sticky?: boolean;
}) {
  const { t } = useTranslation();
  const [showDiff, setShowDiff] = useState(false);
  const meta = SOURCE_META[source];
  const Icon = meta.icon;
  const title = titleOverride ?? t(meta.titleKey);
  const conflictMode = source === 'conflict' && conflict;

  return (
    <div
      className={cn(
        'border-b border-border bg-surface-elevated shadow-sm',
        sticky && 'sticky top-0 z-10',
      )}
      data-proposal-source={source}
    >
      {/* 表头:来源图标芯片 + 文案 + 副标题 */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white', meta.chipClass)}>
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-text-primary">{title}</p>
          {(subject || note) && (
            <p className="truncate text-[11px] text-text-tertiary">
              {subject}
              {subject && note ? ' · ' : ''}
              {note}
            </p>
          )}
        </div>
        {conflictMode && (
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? t('writing.proposal.hideFullDiff', '收起 diff') : t('writing.proposal.viewFullDiff', '查看完整 diff')}
          </Button>
        )}
      </div>

      {/* 冲突双栏:Yours / AI's (saved) — #997 409 payload 数据源 */}
      {conflictMode && (
        <div className="grid grid-cols-1 gap-2 px-3 pb-1.5 sm:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="border-b border-border bg-surface px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
              {t('writing.proposal.yours')}
            </div>
            <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all px-2 py-1.5 text-[11px] text-text-secondary">
              {conflict.yours || <span className="italic text-text-tertiary">—</span>}
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="border-b border-border bg-surface px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
              {t('writing.proposal.saved')}
            </div>
            <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all px-2 py-1.5 text-[11px] text-text-secondary">
              {conflict.saved || <span className="italic text-text-tertiary">—</span>}
            </div>
          </div>
          {showDiff && (
            <div className="sm:col-span-2">
              <LineDiff before={conflict.yours} after={conflict.saved} />
            </div>
          )}
        </div>
      )}

      {/* 审阅模式:统计 + 逐条导航 + 选中处接受/拒绝(能力与旧横幅一致) */}
      {review && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-1.5 text-[11px] text-text-tertiary">
          <span className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5">
            <Eye size={12} />
            {t('writing.proposal.pendingStats', '{{n}} pending · accepted {{a}} · rejected {{r}}', {
              n: review.stats.pending, a: review.stats.accepted, r: review.stats.rejected,
            })}
            <span className="ml-1 flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-[rgba(34,197,94,0.55)]" />
              <span className="inline-block h-2 w-2 rounded-sm bg-[rgba(239,68,68,0.5)]" />
            </span>
          </span>
          {typeof queuedRounds === 'number' && queuedRounds > 0 && (
            <span className="rounded bg-surface px-1.5 py-0.5">
              {t('writing.proposal.queuedRounds', '{{n}} more queued', { n: queuedRounds })}
            </span>
          )}
          {review.selectedChange && (
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">「{review.selectedChange.text}」</span>
              <Button size="sm" variant="ghost" onClick={() => review.onResolveOne(review.selectedChange!.id, true)} title={t('writing.proposal.accept', 'Accept')}>
                <Check size={12} className="text-verify-verified" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => review.onResolveOne(review.selectedChange!.id, false)} title={t('writing.proposal.reject', 'Reject')}>
                <X size={12} className="text-error" />
              </Button>
            </span>
          )}
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={review.changeNav.total === 0 || review.changeNav.idx <= 0} onClick={() => review.onJumpTo(review.changeNav.idx - 1)} title={t('writing.proposal.prevChange', 'Previous change')}>
              <ChevronLeft size={13} />
            </Button>
            <span className="tabular-nums">
              {review.changeNav.total > 0
                ? `${review.changeNav.idx + 1}/${review.changeNav.total}`
                : t('writing.proposal.noChanges', 'No changes')}
            </span>
            <Button size="sm" variant="ghost" disabled={review.changeNav.total === 0 || review.changeNav.idx >= review.changeNav.total - 1} onClick={() => review.onJumpTo(review.changeNav.idx + 1)} title={t('writing.proposal.nextChange', 'Next change')}>
              <ChevronRight size={13} />
            </Button>
          </span>
        </div>
      )}

      {/* 主操作行:来源 → diff → 二选一(设计稿对照表) */}
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        {conflictMode ? (
          <>
            <Button size="sm" variant="secondary" onClick={conflict.onKeepMine}>
              {t('writing.conflictKeepMine', '保留我的版本')}
            </Button>
            <Button size="sm" onClick={conflict.onUseSaved}>
              {t('writing.proposal.useAisVersion', "Use AI's version")}
            </Button>
          </>
        ) : review ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => review.onFinish(true)}>
              {source === 'methods' ? t('writing.proposal.discardDraft', 'Discard draft') : t('writing.proposal.discard', 'Discard')}
            </Button>
            <span className="flex items-center gap-1">
              <Button size="sm" variant="secondary" disabled={review.stats.pending === 0} onClick={() => review.onResolveAll(false)}>
                {t('writing.proposal.rejectAll', 'Reject all')}
              </Button>
              <Button size="sm" disabled={review.stats.pending === 0} onClick={() => review.onResolveAll(true)}>
                {source === 'results' || source === 'methods'
                  ? t('writing.proposal.insertIntoDoc', 'Insert into document')
                  : t('writing.proposal.keepAisEdit', "Keep AI's edit")}
              </Button>
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
