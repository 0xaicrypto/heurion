import { useTranslation } from 'react-i18next';
import type { ChatContextUsage as ContextUsage } from '@/lib/types';

/**
 * U3 — context budget indicator. Shows history-token usage vs the budget so
 * the user can anticipate the next compaction (100% of budget or the
 * turn-window cap). Shared by the global chat and patient chat pages.
 */
export function ContextUsageIndicator({ usage }: { usage?: ContextUsage }) {
  const { t } = useTranslation();
  if (!usage) return null;

  const pct = usage.historyBudget > 0 ? (usage.historyTokens / usage.historyBudget) * 100 : 0;

  return (
    <div
      className="flex items-center gap-1.5 rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary"
      title={t('chat.contextUsageTip', '历史上下文预算：压缩在达到 100% 或 {{turns}} 轮时触发', { turns: usage.historyTurns })}
    >
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface">
        <div
          className={`h-full rounded-full transition-all ${
            pct >= 100 ? 'bg-error' : pct >= 80 ? 'bg-warning' : 'bg-success'
          }`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className={pct >= 100 ? 'text-error' : pct >= 80 ? 'text-warning' : undefined}>
        {Math.round(pct)}%
      </span>
      {/* #721: 百分比含义从 tooltip 提到可见文字 — 用户要知道何时压缩/丢什么。 */}
      <span className="hidden text-text-tertiary sm:inline">
        {t('chat.contextUsageText', '历史上下文（达 100% 自动压缩）')}
      </span>
      {usage.willCompact && (
        <span className="text-error">{t('chat.compactingSoon', '即将压缩')}</span>
      )}
      {usage.omittedTurns > 0 && (
        <span className="text-text-tertiary">{t('chat.omittedTurns', '已省略 {{n}} 轮', { n: usage.omittedTurns })}</span>
      )}
    </div>
  );
}
