import { useCallback, useMemo, useRef, useState } from 'react';
import type { DeckWire } from '@/lib/types';

/**
 * #696/#773 — Doc.deck 资产状态从 writing-editor 路由下沉。
 *
 * #1112/#review-11: 卡片流退役后本 hook 收敛为纯投影/基线持有 —
 * deckAsset 是服务端投影缓存（编辑真相源 = pptx 工件字节，画布负责），
 * lastSavedDeck 跟踪服务端已保存版本（dirty 判定 / citation 基线），
 * appliedDocDeck 跟踪 AI 写回已应用版本（doc_updated.deck 幂等）。
 * 卡片编辑方法（updateDeckSlide/insertDeckSlideChart/撤销栈/epoch…）
 * 随卡片流一并移除，不再保留死代码。
 */
export interface DeckAsset {
  deckAsset: DeckWire | null;
  setDeckAsset: (deck: DeckWire | null) => void;
  lastSavedDeck: React.MutableRefObject<string>;
  appliedDocDeck: React.MutableRefObject<string>;
  deckJson: string;
}

export function useDeckAsset(): DeckAsset {
  const [deckAsset, setDeckAssetState] = useState<DeckWire | null>(null);
  const lastSavedDeck = useRef<string>('');
  const appliedDocDeck = useRef<string>('');
  const deckJson = useMemo(() => (deckAsset ? JSON.stringify(deckAsset) : ''), [deckAsset]);
  // 调用方全部传直值（装载/AI 写回/citation 回灌）；不再支持函数式入参。
  const setDeckAsset = useCallback((deck: DeckWire | null) => setDeckAssetState(deck), []);
  return { deckAsset, setDeckAsset, lastSavedDeck, appliedDocDeck, deckJson };
}
