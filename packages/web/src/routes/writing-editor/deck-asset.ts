import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeckWire } from '@/lib/types';

/** DeckWire slide content 块（contracts 内联形状）的本地别名。 */
type DeckSlideBlock = DeckWire['slides'][number]['content'][number];

export interface DeckAsset {
  deckAsset: DeckWire | null;
  setDeckAsset: React.Dispatch<React.SetStateAction<DeckWire | null>>;
  lastSavedDeck: React.MutableRefObject<string>;
  appliedDocDeck: React.MutableRefObject<string>;
  deckJson: string;
  updateDeckSlide: (index: number, next: { title?: string; bullets?: string[] }) => void;
  /** #1046: 备注编辑（DeckWire.slides[].notes）— 空串归一为 undefined 保持 wire 干净。 */
  updateDeckSlideNotes: (index: number, notes: string) => void;
  deleteDeckSlide: (index: number) => void;
  addDeckSlide: () => void;
  slideBullets: (slide: DeckWire['slides'][number]) => string[];
  /** #959 排版编辑（contracts deck v2）：拖拽排序 / 布局母版 / 主题。 */
  moveDeckSlide: (from: number, to: number) => void;
  setDeckSlideLayout: (index: number, layout: string | undefined) => void;
  setDeckTheme: (theme: string | undefined) => void;
  /** #1044: 手动插入图片块（与 AI 图片 bullet 同字段形状，见 deckImageBlock）。 */
  insertDeckSlideImage: (index: number, url: string, caption?: string) => void;
  /** #1044: 手动插入结构化图表块 — spec 须先经 chartBlockSchema 校验（表单内完成）。 */
  insertDeckSlideChart: (index: number, spec: unknown, caption?: string) => void;
  /** #1044: 块原位替换（换图 URL / 换图数据），非追加。 */
  replaceDeckSlideBlock: (slideIndex: number, blockIndex: number, next: DeckSlideBlock) => void;
  /** #1044: 删除块（content 契约下限 1 块，最后一块不删）。 */
  deleteDeckSlideBlock: (slideIndex: number, blockIndex: number) => void;
}

/** #1044: image 块形状单点 — url（web 渲染用 canonical 下载 URL，#1038 链路）+
 * caption；ref 存同一 URL：导出边界 imageBlockSchema 必填 ref（contracts index.ts:27），
 * 非 asset:// 引用原样透传（#900 校验只约束 asset:// 名字），保证人工插入的
 * image 块与 AI 插入的一样能过 presentationContentSchema 校验进入渲染管道。 */
export function deckImageBlock(url: string, caption?: string): DeckSlideBlock {
  return { type: 'image', ref: url, url, ...(caption ? { caption } : {}) };
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
  // #1047: bullets 编辑改为按序替换文本块、非文本块（table/image 等）原位保留 —
  // 旧实现整表重建 content 会把导入的表格块抹掉。
  const updateDeckSlide = (index: number, next: { title?: string; bullets?: string[] }) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      const slides = prev.slides.map((s, i) => {
        if (i !== index) return s;
        const title = next.title !== undefined ? next.title : s.title;
        if (next.bullets === undefined) return { ...s, title };
        let bi = 0;
        const content = [
          ...s.content
            .map((c) => {
              if (typeof c.text !== 'string') return c; // 非文本块原位保留
              const t = next.bullets![bi++];
              return t !== undefined ? { ...c, text: t } : null; // 文本块按序替换
            })
            .filter((c): c is DeckSlideBlock => c !== null),
          // 新增要点（超出原文本块数量）追加为 bullet 段。
          ...next.bullets.slice(bi).map((b) => ({ type: 'paragraph', text: b, style: 'bullet' })),
        ].filter((c) => (typeof c.text === 'string' ? c.text.trim().length > 0 : true));
        return { ...s, title, content };
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
  // ── #1046 备注编辑（导入显示 / 手动补录，导出经 worker addNotes 写回）──
  const updateDeckSlideNotes = (index: number, notes: string) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      return { ...prev, slides: prev.slides.map((s, i) => (i === index ? { ...s, notes: notes.trim() || undefined } : s)) };
    });
  };
  const setDeckTheme = (theme: string | undefined) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      return { ...prev, theme };
    });
  };

  // ── #1044 块级操作：手动插入图片/结构化图表、原位替换、删除 ──
  const insertDeckSlideBlock = (index: number, block: DeckSlideBlock) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      return { ...prev, slides: prev.slides.map((s, i) => (i === index ? { ...s, content: [...s.content, block] } : s)) };
    });
  };
  const insertDeckSlideImage = (index: number, url: string, caption?: string) => {
    insertDeckSlideBlock(index, deckImageBlock(url, caption));
  };
  const insertDeckSlideChart = (index: number, spec: unknown, caption?: string) => {
    insertDeckSlideBlock(index, { type: 'chart', spec, ...(caption ? { caption } : {}) });
  };
  const replaceDeckSlideBlock = (slideIndex: number, blockIndex: number, next: DeckSlideBlock) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        slides: prev.slides.map((s, i) =>
          i === slideIndex ? { ...s, content: s.content.map((c, ci) => (ci === blockIndex ? next : c)) } : s,
        ),
      };
    });
  };
  // content 契约下限 1 块（presentationContentSchema content min 1）— 最后一块不删。
  const deleteDeckSlideBlock = (slideIndex: number, blockIndex: number) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        slides: prev.slides.map((s, i) =>
          i === slideIndex && s.content.length > 1 ? { ...s, content: s.content.filter((_, ci) => ci !== blockIndex) } : s,
        ),
      };
    });
  };

  return { deckAsset, setDeckAsset, lastSavedDeck, appliedDocDeck, deckJson, updateDeckSlide, updateDeckSlideNotes, deleteDeckSlide, addDeckSlide, slideBullets, moveDeckSlide, setDeckSlideLayout, setDeckTheme, insertDeckSlideImage, insertDeckSlideChart, replaceDeckSlideBlock, deleteDeckSlideBlock };
}
