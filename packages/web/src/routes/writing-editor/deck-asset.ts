import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeckWire } from '@/lib/types';

export interface DeckAsset {
  deckAsset: DeckWire | null;
  setDeckAsset: React.Dispatch<React.SetStateAction<DeckWire | null>>;
  lastSavedDeck: React.MutableRefObject<string>;
  appliedDocDeck: React.MutableRefObject<string>;
  deckJson: string;
  updateDeckSlide: (index: number, next: { title?: string; bullets?: string[] }) => void;
  deleteDeckSlide: (index: number) => void;
  addDeckSlide: () => void;
  slideBullets: (slide: DeckWire['slides'][number]) => string[];
  /** #959 排版编辑（contracts deck v2）：拖拽排序 / 布局母版 / 主题。 */
  moveDeckSlide: (from: number, to: number) => void;
  setDeckSlideLayout: (index: number, layout: string | undefined) => void;
  setDeckTheme: (theme: string | undefined) => void;
}

/**
 * #696/#773 — Doc.deck 资产状态,从 writing-editor 路由下沉:
 * lastSavedDeck 跟踪服务端已保存版本（dirty 判定），
 * appliedDocDeck 跟踪 AI 写回已应用版本（doc_updated.deck 幂等）。
 */
export function useDeckAsset(): DeckAsset {
  const { t } = useTranslation();
  const [deckAsset, setDeckAsset] = useState<DeckWire | null>(null);
  const lastSavedDeck = useRef<string>('');
  const appliedDocDeck = useRef<string>('');
  const deckJson = useMemo(() => (deckAsset ? JSON.stringify(deckAsset) : ''), [deckAsset]);

  // ── #773: deck 资产卡片编辑（写 Doc.deck，独立于 body）──────────
  const updateDeckSlide = (index: number, next: { title?: string; bullets?: string[] }) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      const slides = prev.slides.map((s, i) => {
        if (i !== index) return s;
        const content = next.bullets !== undefined
          ? next.bullets.map((b) => ({ type: 'paragraph', text: b, style: 'bullet' })).filter((b) => b.text.trim())
          : s.content;
        return { ...s, title: next.title !== undefined ? next.title : s.title, content };
      });
      return { ...prev, slides };
    });
  };
  const deleteDeckSlide = (index: number) => {
    setDeckAsset((prev) => {
      if (!prev || prev.slides.length <= 1) return prev;
      return { ...prev, slides: prev.slides.filter((_, i) => i !== index) };
    });
  };
  const addDeckSlide = () => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        slides: [...prev.slides, { title: t('writing.deckNewSlide', '新页'), content: [{ type: 'paragraph', text: t('writing.deckNewBullet', '要点'), style: 'bullet' }] }],
      };
    });
  };
  const slideBullets = (slide: DeckWire['slides'][number]): string[] =>
    slide.content.filter((c) => typeof c.text === 'string').map((c) => c.text as string);

  // ── #959 排版编辑（contracts deck v2）──────────────────────────
  const moveDeckSlide = (from: number, to: number) => {
    setDeckAsset((prev) => {
      if (!prev || from === to || from < 0 || to < 0 || from >= prev.slides.length || to >= prev.slides.length) return prev;
      const slides = [...prev.slides];
      const [moved] = slides.splice(from, 1);
      slides.splice(to, 0, moved);
      return { ...prev, slides };
    });
  };
  const setDeckSlideLayout = (index: number, layout: string | undefined) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      return { ...prev, slides: prev.slides.map((s, i) => (i === index ? { ...s, layout } : s)) };
    });
  };
  const setDeckTheme = (theme: string | undefined) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      return { ...prev, theme };
    });
  };

  return { deckAsset, setDeckAsset, lastSavedDeck, appliedDocDeck, deckJson, updateDeckSlide, deleteDeckSlide, addDeckSlide, slideBullets, moveDeckSlide, setDeckSlideLayout, setDeckTheme };
}
