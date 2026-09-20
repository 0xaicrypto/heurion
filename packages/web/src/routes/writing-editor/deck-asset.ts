import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeckWire } from '@/lib/types';

/** DeckWire slide content 块（contracts 内联形状）的本地别名。 */
type DeckSlideBlock = DeckWire['slides'][number]['content'][number];

/** #1087: slide 结构 epoch 快照 — 上传/表单发起时取（snapshotSlideEpoch），
 * 完成/确认时校验（verifySlideEpoch / insert·replace 的 expect 参数）。 */
export interface SlideEpochSnapshot {
  index: number;
  epoch: number;
}

/** #1087: hook 内部状态 — deck 与其结构 epoch 并行数组原子更新（单 state 对象，
 * 避免双 setState 失步）。epochs 不落 wire（deckJson 只序列化 deck）。 */
interface DeckWithEpochs {
  deck: DeckWire | null;
  /** 结构 epoch，按 slide 下标平行：文本/备注/布局/块级编辑不动；删页 splice、
   * 移页 tandem 重排、增页追加新值、整 deck 替换全量重置（新页签发新值）。 */
  epochs: number[];
}

export interface DeckAsset {
  deckAsset: DeckWire | null;
  setDeckAsset: React.Dispatch<React.SetStateAction<DeckWire | null>>;
  lastSavedDeck: React.MutableRefObject<string>;
  appliedDocDeck: React.MutableRefObject<string>;
  deckJson: string;
  /** #1087: 读取当前目标页的结构 epoch 快照（页不存在/越界 → null）。 */
  snapshotSlideEpoch: (index: number) => SlideEpochSnapshot | null;
  /** #1087: 校验快照与当前结构一致（页未删/未移/未被整 deck 替换）。 */
  verifySlideEpoch: (snap: SlideEpochSnapshot) => boolean;
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
   * #1087: expect（上传发起时的结构快照）提供时校验目标页 epoch — 页被删/移/
   * 整 deck 替换则放弃插入（不误插别的页）；同页文本编辑不动 epoch，照常落块。 */
  insertDeckSlideImage: (index: number, url: string, caption?: string, expect?: SlideEpochSnapshot) => void;
  /** #1044: 手动插入结构化图表块 — spec 须先经 chartBlockSchema 校验（表单内完成）。
   * #1087: expect 同上（表单打开时快照，确认时校验）。 */
  insertDeckSlideChart: (index: number, spec: unknown, caption?: string, expect?: SlideEpochSnapshot) => void;
  /**
   * #1044: 块原位替换（换图 URL / 换图数据），非追加。
   * #1063: expectBlock（入口快照的目标块引用）提供时校验块身份，异步竞态下
   * 目标块已被删/移动则放弃替换，不误写其他块。
   * #1087: expectEpoch（slide 结构快照）叠加校验 — 页被删/移/整 deck 替换则放弃。
   */
  replaceDeckSlideBlock: (slideIndex: number, blockIndex: number, next: DeckSlideBlock, expectBlock?: DeckSlideBlock, expectEpoch?: SlideEpochSnapshot) => void;
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
 * #1087 — deck 与结构 epoch（slideEpochs）并入同一 state 原子更新：
 * 判据从「slide 对象引用/稳定 id」（#1071-3）换成「快照 {index, epoch} 与当前
 * epoch 一致」— 无 id slide 的同页文本编辑（对象必然重建）不再误判丢上传；
 * 真危险变更（删页/移页/整 deck 替换）才失配。epoch 为进程内数据，不落 wire。
 */
export function useDeckAsset(): DeckAsset {
  const { t } = useTranslation();
  const [deckState, setDeckState] = useState<DeckWithEpochs>({ deck: null, epochs: [] });
  const nextEpochRef = useRef(1);
  const deckAsset = deckState.deck;
  const lastSavedDeck = useRef<string>('');
  const appliedDocDeck = useRef<string>('');
  const deckJson = useMemo(() => (deckAsset ? JSON.stringify(deckAsset) : ''), [deckAsset]);

  // #1087: 最新结构态镜像（渲染期同步,幂等）— 上传 await 落地后闭包里的
  // deckAsset 已过期,快照/校验经此读当前值;写回决策仍以 insert/replace 的
  // 函数式更新内的权威校验兜底（双保险）。
  const deckStateRef = useRef(deckState);
  deckStateRef.current = deckState;

  /** #1087: 上传/表单发起时读取目标页结构快照。 */
  const snapshotSlideEpoch = useCallback((index: number): SlideEpochSnapshot | null => {
    const { deck, epochs: eps } = deckStateRef.current;
    if (!deck || index < 0 || index >= deck.slides.length || index >= eps.length) return null;
    return { index, epoch: eps[index] };
  }, []);
  /** #1087: 校验快照 — 页仍在原位且 epoch 未变（文本编辑不变 epoch）。 */
  const verifySlideEpoch = useCallback((snap: SlideEpochSnapshot): boolean => {
    const { deck, epochs: eps } = deckStateRef.current;
    return !!deck && snap.index < deck.slides.length && snap.index < eps.length && eps[snap.index] === snap.epoch;
  }, []);

  /** #1087: 整 deck 替换的 setter — 兼容直值与函数式两种入参（与
   * React.Dispatch<SetStateAction<DeckWire|null>> 同签名,外部调用方
   * writing-editor/deck-conflict/doc-chat 均传直值）。deck 引用变化 →
   * 全体 epoch 重置签发新值（AI 写回/导入/冲突采用/撤销），在途上传快照
   * 全部失配 → 调用方提示而非静默丢弃；同引用（无变更）不重置。 */
  const setDeckAsset = useCallback((next: DeckWire | null | ((prev: DeckWire | null) => DeckWire | null)) => {
    setDeckState((prev) => {
      const deck = typeof next === 'function' ? next(prev.deck) : next;
      if (deck === prev.deck) return prev;
      return { deck, epochs: deck ? deck.slides.map(() => nextEpochRef.current++) : [] };
    });
  }, []);

  // ── #773: deck 资产卡片编辑（写 Doc.deck，独立于 body）──────────
  // #1047: bullets 编辑改为按序替换文本块、非文本块（table/image 等）原位保留 —
  // 旧实现整表重建 content 会把导入的表格块抹掉。
  // #1063: 空文本块不再被 filter 吞掉（作为编辑占位保留）— 旧实现「清空一行 →
  // 该行立即从 DOM 消失（丢焦点/丢行）」「+ 要点追加的空块立即被滤掉（按钮 no-op）」，
  // 单页清空全部要点时更是产出 content: []，违反导出契约 content.min(1)，
  // 导出时 validateRenderContent 整体失败 → 静默落回 body 重编排。
  // 现约定：空文本块是编辑中态，行始终存在；仅兜底保证 content 永不为空数组。
  const updateDeckSlide = (index: number, next: { title?: string; bullets?: string[] }) => {
    setDeckState((prev) => {
      if (!prev.deck) return prev;
      const slides = prev.deck.slides.map((s, i) => {
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
      // #1087: 标题/要点为文本编辑，不动结构 epoch（在途上传照常落本页）。
      return { deck: { ...prev.deck, slides }, epochs: prev.epochs };
    });
  };
  const deleteDeckSlide = (index: number) => {
    setDeckState((prev) => {
      if (!prev.deck || prev.deck.slides.length <= 1) return prev;
      // #1087: 删页 = 结构变更 — epoch 同步 splice（被删页及其后移位页上的
      // 在途快照全部失配；被删页之前的页 epoch 不变，插入不受牵连）。
      return {
        deck: { ...prev.deck, slides: prev.deck.slides.filter((_, i) => i !== index) },
        epochs: prev.epochs.filter((_, i) => i !== index),
      };
    });
  };
  const addDeckSlide = () => {
    setDeckState((prev) => {
      if (!prev.deck) return prev;
      // #1087: 追加新页签发新 epoch（既有下标不变，在途快照不受影响）。
      return {
        deck: {
          ...prev.deck,
          // #1071-4: 新建 slide 携带稳定 id（key 不随数组下标漂移）。
          slides: [...prev.deck.slides, { id: newSlideId(), title: t('writing.deckNewSlide', '新页'), content: [{ type: 'paragraph', text: t('writing.deckNewBullet', '要点'), style: 'bullet' }] }],
        },
        epochs: [...prev.epochs, nextEpochRef.current++],
      };
    });
  };
  const slideBullets = (slide: DeckWire['slides'][number]): string[] =>
    slide.content.filter((c) => typeof c.text === 'string').map((c) => c.text as string);

  // ── #959 排版编辑（contracts deck v2）──────────────────────────
  const moveDeckSlide = (from: number, to: number) => {
    setDeckState((prev) => {
      if (!prev.deck || from === to || from < 0 || to < 0 || from >= prev.deck.slides.length || to >= prev.deck.slides.length) return prev;
      // #1087: 移页 = 结构变更 — epoch 与 slides 同步 tandem 重排：
      // 移位区间内的页下标指向已换页 → 在途快照失配（提示后放弃）；
      // 区间外（含目标页未被波及时）epoch 不变，插入不受牵连。
      const slides = [...prev.deck.slides];
      const epochs = [...prev.epochs];
      const [moved] = slides.splice(from, 1);
      const [movedEpoch] = epochs.splice(from, 1);
      slides.splice(to, 0, moved);
      epochs.splice(to, 0, movedEpoch);
      return { deck: { ...prev.deck, slides }, epochs };
    });
  };
  const setDeckSlideLayout = (index: number, layout: string | undefined) => {
    setDeckState((prev) => {
      if (!prev.deck) return prev;
      // #1087: 布局是页内属性，页身份/位置不变 — 不动 epoch。
      return { deck: { ...prev.deck, slides: prev.deck.slides.map((s, i) => (i === index ? { ...s, layout } : s)) }, epochs: prev.epochs };
    });
  };
  // ── #1046 备注编辑（导入显示 / 手动补录，导出经 worker addNotes 写回）──
  const updateDeckSlideNotes = (index: number, notes: string) => {
    setDeckState((prev) => {
      if (!prev.deck) return prev;
      // #1087: 备注为文本编辑 — 不动 epoch。
      return { deck: { ...prev.deck, slides: prev.deck.slides.map((s, i) => (i === index ? { ...s, notes: notes.trim() || undefined } : s)) }, epochs: prev.epochs };
    });
  };
  const setDeckTheme = (theme: string | undefined) => {
    setDeckState((prev) => {
      if (!prev.deck) return prev;
      return { deck: { ...prev.deck, theme }, epochs: prev.epochs };
    });
  };

  // ── #1044 块级操作：手动插入图片/结构化图表、原位替换、删除 ──
  /**
   * #1087: 插入路径结构校验 — expect 为入口（上传发起 / 表单打开）时的目标页
   * 结构快照 {index, epoch}。回写时目标页 epoch 与快照不一致（页被删/移位/
   * 整 deck 替换）→ 放弃插入（no-op 优于插错页），放弃与否经 onNotice 由
   * 调用方明示（非静默）。同页标题/要点文本编辑不动 epoch → 照常落块
   * （修复 #1071-3 引用判据对无 id slide 的误杀）。
   */
  const insertDeckSlideBlock = (index: number, block: DeckSlideBlock, expect?: SlideEpochSnapshot) => {
    setDeckState((prev) => {
      if (!prev.deck) return prev;
      if (expect && prev.epochs[index] !== expect.epoch) return prev;
      return { deck: { ...prev.deck, slides: prev.deck.slides.map((s, i) => (i === index ? { ...s, content: [...s.content, block] } : s)) }, epochs: prev.epochs };
    });
  };
  const insertDeckSlideImage = (index: number, url: string, caption?: string, expect?: SlideEpochSnapshot) => {
    insertDeckSlideBlock(index, deckImageBlock(url, caption), expect);
  };
  const insertDeckSlideChart = (index: number, spec: unknown, caption?: string, expect?: SlideEpochSnapshot) => {
    insertDeckSlideBlock(index, { type: 'chart', spec, ...(caption ? { caption } : {}) }, expect);
  };
  /**
   * #1044: 块原位替换（换图 URL / 换图数据），非追加。
   * #1063: expectBlock 提供时校验「目标索引处仍是同一块」（引用相等 — 状态更新
   * 对未改动块保持引用）后才替换。异步上传场景：入口快照目标块，await 两次网络
   * 往返期间删块/移动/并发编辑会让索引指向别的块甚至越界 — 旧实现按索引盲写，
   * 静默 no-op 或替换错图；现在身份不符则放弃替换（no-op 优于写错块）。
   * #1087: expectEpoch（slide 结构快照）叠加校验 — 页被删/移/整 deck 替换则放弃。
   */
  const replaceDeckSlideBlock = (slideIndex: number, blockIndex: number, next: DeckSlideBlock, expectBlock?: DeckSlideBlock, expectEpoch?: SlideEpochSnapshot) => {
    setDeckState((prev) => {
      if (!prev.deck) return prev;
      // #1087: slide 层结构校验 — 页被删/移/整 deck 替换 → 放弃。
      if (expectEpoch && prev.epochs[slideIndex] !== expectEpoch.epoch) return prev;
      return {
        deck: {
          ...prev.deck,
          slides: prev.deck.slides.map((s, i) => {
            if (i !== slideIndex) return s;
            // #1063: 块身份校验 — 目标索引处块引用与快照不符（被删/移动/整表替换）→ 放弃。
            if (expectBlock !== undefined && s.content[blockIndex] !== expectBlock) return s;
            return { ...s, content: s.content.map((c, ci) => (ci === blockIndex ? next : c)) };
          }),
        },
        // #1087: 块级编辑不动页结构 epoch（页身份/位置未变）。
        epochs: prev.epochs,
      };
    });
  };
  // content 契约下限 1 块（presentationContentSchema content min 1）— 最后一块不删。
  const deleteDeckSlideBlock = (slideIndex: number, blockIndex: number) => {
    setDeckState((prev) => {
      if (!prev.deck) return prev;
      return {
        deck: {
          ...prev.deck,
          slides: prev.deck.slides.map((s, i) =>
            i === slideIndex && s.content.length > 1 ? { ...s, content: s.content.filter((_, ci) => ci !== blockIndex) } : s,
          ),
        },
        // #1087: 块级编辑不动页结构 epoch；唯一块拒绝（min-1）提示在调用方补齐。
        epochs: prev.epochs,
      };
    });
  };

  return { deckAsset, setDeckAsset, lastSavedDeck, appliedDocDeck, deckJson, snapshotSlideEpoch, verifySlideEpoch, updateDeckSlide, updateDeckSlideNotes, deleteDeckSlide, addDeckSlide, slideBullets, moveDeckSlide, setDeckSlideLayout, setDeckTheme, insertDeckSlideImage, insertDeckSlideChart, replaceDeckSlideBlock, deleteDeckSlideBlock };
}
