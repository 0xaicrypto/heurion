/**
 * #1142 — deck 并发冲突决策条（保留我的 / 载入最新 / 另存快照）。
 * 文案不得暗示已自动合并/已基于最新版本继续保存 — 覆盖是用户的显式选择。
 */
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import type { DeckConflictSnapshot } from './deck-conflict';

export function DeckConflictBanner({ conflict, onKeepMine, onLoadLatest, onSnapshot }: {
  conflict: DeckConflictSnapshot | null;
  onKeepMine: () => void;
  onLoadLatest: () => void;
  onSnapshot: () => void;
}) {
  const { t } = useTranslation();
  if (!conflict) return null;
  return (
    <div
      data-testid="deck-conflict-banner"
      role="alert"
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[12px] text-text-primary"
    >
      <span>
        {t('writing.deckConflictBanner', 'deck 已被其他窗口/AI 修改 — 你的编辑尚未丢失；服务端新版本已存为快照，请选择处理方式')}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" data-testid="deck-conflict-keep-mine" onClick={onKeepMine}>
          {t('writing.deckConflictKeepMine', '保留我的（覆盖）')}
        </Button>
        <Button size="sm" variant="secondary" data-testid="deck-conflict-load-latest" onClick={onLoadLatest}>
          {t('writing.deckConflictLoadLatest', '载入最新')}
        </Button>
        <Button size="sm" variant="ghost" data-testid="deck-conflict-snapshot" onClick={onSnapshot}>
          {t('writing.deckConflictSnapshot', '另存快照')}
        </Button>
      </div>
    </div>
  );
}
