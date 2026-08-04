import { useTranslation } from 'react-i18next';

export interface ContextUsage {
  historyTokens: number;
  historyBudget: number;
  historyTurns: number;
  omittedTurns: number;
  willCompact: boolean;
}

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
      {usage.willCompact && (
        <span className="text-error">{t('chat.compactingSoon', '即将压缩')}</span>
      )}
    </div>
  );
}
