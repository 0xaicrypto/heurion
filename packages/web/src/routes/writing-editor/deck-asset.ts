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
  /** #1044: 手动插入图片块（与 AI 图片 bullet 同字段形状，见 deckImageBlock）。
   * #1071-3: expectSlide（入口快照的目标 slide）提供时校验 slide 身份，异步竞态
   * 下目标页已被删/移则放弃插入，不误插别的页。 */
  insertDeckSlideImage: (index: number, url: string, caption?: string, expectSlide?: DeckWire['slides'][number]) => void;
  /** #1044: 手动插入结构化图表块 — spec 须先经 chartBlockSchema 校验（表单内完成）。
   * #1071-3: expectSlide 同上（表单打开时快照,确认时校验）。 */
  insertDeckSlideChart: (index: number, spec: unknown, caption?: string, expectSlide?: DeckWire['slides'][number]) => void;
  /**
   * #1044: 块原位替换（换图 URL / 换图数据），非追加。
   * #1063: expectBlock（入口快照的目标块引用）提供时校验块身份，异步竞态下
   * 目标块已被删/移动则放弃替换，不误写其他块。
   */
  replaceDeckSlideBlock: (slideIndex: number, blockIndex: number, next: DeckSlideBlock, expectBlock?: DeckSlideBlock) => void;
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

/** #1071-4: slide 稳定 id 生成（slide_ 前缀 + 随机段，单 deck 30 页内撞码可忽略）。
 * 范围取舍：只为**新建** slide 生成；不对既有无 id slide 整批回填 — 回填会整批
 * 更换卡片 React key（idx-<i> → slide_<id>）触发重挂，卡片本地状态（备注展开/
 * 上传目标）被重置（#1046 备注编辑回归网暴露）；且落盘 payload 形状漂移会扰动
 * 切文档/冲突流程的精确断言。既有 slide 无 id 时 key 兜底 idx-<index>（与旧行为
 * 一致），已有 id 在全部变更操作中原样保留（spread 不动）。服务端 wire/
 * presentationSlideSchema 均已放行可选 id，数据迁移可后续一次性补齐。 */
const newSlideId = (): string => `slide_${Math.random().toString(36).slice(2, 10)}`;

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
  // #1063: 空文本块不再被 filter 吞掉（作为编辑占位保留）— 旧实现「清空一行 →
  // 该行立即从 DOM 消失（丢焦点/丢行）」「+ 要点追加的空块立即被滤掉（按钮 no-op）」，
  // 单页清空全部要点时更是产出 content: []，违反导出契约 content.min(1)，
  // 导出时 validateRenderContent 整体失败 → 静默落回 body 重编排。
  // 现约定：空文本块是编辑中态，行始终存在；仅兜底保证 content 永不为空数组。
  const updateDeckSlide = (index: number, next: { title?: string; bullets?: string[] }) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      const slides = prev.slides.map((s, i) => {
        if (i !== index) return s;
        const title = next.title !== undefined ? next.title : s.title;
        if (next.bullets === undefined) return { ...s, title };
        let bi = 0;
        let content: DeckSlideBlock[] = [
          ...s.content
            .map((c) => {
              if (typeof c.text !== 'string') return c; // 非文本块原位保留
              const t = next.bullets![bi++];
              return t !== undefined ? { ...c, text: t } : null; // 文本块按序替换
            })
            .filter((c): c is DeckSlideBlock => c !== null),
          // 新增要点（超出原文本块数量）追加为 bullet 段（含空串占位，#1063 不再滤掉）。
          ...next.bullets.slice(bi).map((b) => ({ type: 'paragraph', text: b, style: 'bullet' }) as DeckSlideBlock),
        ];
        // #1063 兜底：编辑后一个块都不剩（仅剩非文本块被删光等极端场景）→
        // 保留一个空文本块占位，绝不产出 content: []（导出契约 min(1)）。
        if (content.length === 0) {
          content = [{ type: 'paragraph', text: '', style: 'bullet' }];
        }
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
        // #1071-4: 新建 slide 携带稳定 id（key 不随数组下标漂移）。
        slides: [...prev.slides, { id: newSlideId(), title: t('writing.deckNewSlide', '新页'), content: [{ type: 'paragraph', text: t('writing.deckNewBullet', '要点'), style: 'bullet' }] }],
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
  /**
   * #1071-3: 插入路径身份校验（对齐 #1063 replaceDeckSlideBlock 的 expectBlock
   * 快照纪律）— expectSlide 为入口（上传发起 / 表单打开）时的目标 slide 快照。
   * 回写时目标索引处的 slide 与快照「引用不同且稳定 id 不同」→ slide 已被删/
   * 移/整页替换，放弃插入（no-op 优于插错页）。已回填 id 的 slide 在并发纯文本
   * 编辑下 id 不变（对象重建但身份仍在）→ 仍可落块；无 id 旧数据退化为引用比对
   * （同 #1063 口径）。
   */
  const insertDeckSlideBlock = (index: number, block: DeckSlideBlock, expectSlide?: DeckWire['slides'][number]) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      if (expectSlide !== undefined) {
        const cur = prev.slides[index];
        const sameIdentity = cur === expectSlide || (expectSlide.id !== undefined && cur?.id === expectSlide.id);
        if (!sameIdentity) return prev;
      }
      return { ...prev, slides: prev.slides.map((s, i) => (i === index ? { ...s, content: [...s.content, block] } : s)) };
    });
  };
  const insertDeckSlideImage = (index: number, url: string, caption?: string, expectSlide?: DeckWire['slides'][number]) => {
    insertDeckSlideBlock(index, deckImageBlock(url, caption), expectSlide);
  };
  const insertDeckSlideChart = (index: number, spec: unknown, caption?: string, expectSlide?: DeckWire['slides'][number]) => {
    insertDeckSlideBlock(index, { type: 'chart', spec, ...(caption ? { caption } : {}) }, expectSlide);
  };
  /**
   * #1044: 块原位替换（换图 URL / 换图数据），非追加。
   * #1063: expectBlock 提供时校验「目标索引处仍是同一块」（引用相等 — 状态更新
   * 对未改动块保持引用）后才替换。异步上传场景：入口快照目标块，await 两次网络
   * 往返期间删块/移动/并发编辑会让索引指向别的块甚至越界 — 旧实现按索引盲写，
   * 静默 no-op 或替换错图；现在身份不符则放弃替换（no-op 优于写错块）。
   */
  const replaceDeckSlideBlock = (slideIndex: number, blockIndex: number, next: DeckSlideBlock, expectBlock?: DeckSlideBlock) => {
    setDeckAsset((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        slides: prev.slides.map((s, i) => {
          if (i !== slideIndex) return s;
          // #1063: 块身份校验 — 目标索引处块引用与快照不符（被删/移动/整表替换）→ 放弃。
          if (expectBlock !== undefined && s.content[blockIndex] !== expectBlock) return s;
          return { ...s, content: s.content.map((c, ci) => (ci === blockIndex ? next : c)) };
        }),
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
