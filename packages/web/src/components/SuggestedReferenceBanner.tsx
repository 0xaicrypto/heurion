import { useTranslation } from 'react-i18next';
import { Lightbulb, X } from 'lucide-react';
import { Button } from '@/components/ui';
import type { SessionSuggestion } from '@/routes/writing-editor/suggestions';

/** #1012: 建议态引用横幅 — 不打断操作；虚线边框与正式引用（实线）明确区分；
 *  建议永远不会自动变成正式引用（设计原则 4 红线）。 */
export function SuggestedReferenceBanner(input: {
  suggestions: SessionSuggestion[];
  resolving: string | null;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { suggestions, resolving, onAccept, onDismiss } = input;
  if (suggestions.length === 0) return null;

  return (
    <div className="space-y-1.5" data-testid="suggested-reference-banner">
      <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
        <Lightbulb size={12} className="text-accent" />
        {t('chat.suggestionBannerTitle', '可能用得上（建议，尚未引用）')}
      </div>
      {suggestions.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-2 rounded-lg border border-dashed border-accent/50 bg-accent/5 px-3 py-2"
        >
          <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[10px] text-accent">
            {t('chat.suggestionBadge', '建议')}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-text-primary">{s.reference.label || s.reference.snapshot.slice(0, 40)}</p>
            <p className="truncate text-[10px] text-text-tertiary">{s.reason}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={resolving !== null}
            isLoading={resolving === s.id}
            onClick={() => onAccept(s.id)}
          >
            {t('chat.suggestionUse', '引用')}
          </Button>
          <button
            onClick={() => onDismiss(s.id)}
            disabled={resolving !== null}
            className="shrink-0 rounded p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
            aria-label={t('chat.suggestionIgnore', '忽略')}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
