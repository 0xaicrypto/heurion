import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { BarChart3, Bold, ChevronDown, ChevronUp, FilePlus, ImagePlus, Italic, Link2, MessageSquare, MessageSquarePlus, Pencil, Presentation, Sparkles, Strikethrough, Underline, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Slide } from '@/lib/deck';
import type { DeckWire } from '@/lib/types';
import type { DeckAsset } from './deck-asset';
import { deckImageBlock } from './deck-asset';
import { DeckChartFormDialog, type DeckChartFormResult } from './deck-chart-form';

/** #688: deck 卡片网格视图 — 从 writing-editor 路由机械拆出；
 * deck 数据与操作状态仍归路由，单卡片操作回调经 props 传入。 */

/** #1051: deck slide 评论（target='deck_slide'）— 卡片高亮/徽标的数据源。
 * deck 不是 TipTap，不做 ProseMirror decoration：在卡片对应文字（标题）上
 * 加高亮样式 + 评论徽标入口，点击与 CommentsPanel 联动。 */
export interface DeckSlideCommentInfo {
  commentId: string;
  /** 1-based 页码（与 API/edit_deck 同口径）。 */
  slideIndex: number;
  anchorText: string;
  status: string;
  /** 服务端锚点诊断（仅 open 评论重算；false = 漂移提示态）。 */
  located: boolean;
  /** 当前激活线程 — 高亮描边（与侧边栏联动）。 */
  active?: boolean;
}

/** #1054: <u> 直通渲染 — rehype-raw 把行内原始 HTML 解析为元素，
 * rehype-sanitize 白名单（GitHub 同款 schema + u）兜底剥离 script/事件属性等，
 * 只为下划线放行 <u>，不放开全量 HTML 直通的注入面。 */
const DECK_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'u'],
};

/** #1050: 行内 markdown 展示（复用正文同款 react-markdown + remark-gfm）—
 * 只涉及行内标记（bold/italic/strike/link）；p 折叠为 fragment，
 * 不给 slide 文字引入块级嵌套。#1054: + <u> 下划线（rehype-raw + sanitize）。 */
function DeckInlineText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm as never]}
      rehypePlugins={[rehypeRaw as never, [rehypeSanitize, DECK_SANITIZE_SCHEMA] as never]}
      components={{
        p: ({ children }: any) => <>{children}</>,
        u: ({ children }: any) => <u className="underline">{children}</u>,
        a: ({ children, href }: any) => (
          <a href={href} target="_blank" rel="noreferrer" className="pointer-events-auto text-accent underline">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** #1050: slide 文本行 — 展示态渲染 markdown 行内标记；聚焦切纯文本 input 编辑 +
 * Bold/Italic/Strike/Link 快捷按钮（对选中文字包裹 markdown 语法，不引入 TipTap）。
 * #1054: 补 U 按钮 — 下划线走 <u> HTML 直通（markdown 无此语法），包裹/取消。 */
function DeckTextLine({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** #1050: 选中文字包裹 markdown 语法；空选区仅在光标处插入标记对。 */
  const wrapSelection = (before: string, after: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const sel = value.slice(start, end);
    onChange(`${value.slice(0, start)}${before}${sel}${after}${value.slice(end)}`);
    // 包裹后恢复选区（rAF 等 React 受控值落地后回填焦点/选区）。
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + before.length, start + before.length + sel.length);
    });
  };

  /** #1054: U 按钮 — 下划线是 HTML 直通（无 markdown 语法），支持包裹/取消：
   * 选中区含完整 <u>…</u> 标签对、或两侧紧邻标签对（选区在标签内）时解包，否则包裹。 */
  const toggleUnderline = () => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const sel = value.slice(start, end);
    // 形态一：选中区自带完整 <u>…</u>（长度须超过空标签对，即至少包住 1 个字符）。
    if (sel.startsWith('<u>') && sel.endsWith('</u>') && sel.length > 7) {
      const inner = sel.slice(3, -4);
      onChange(`${value.slice(0, start)}${inner}${value.slice(end)}`);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(start, start + inner.length);
      });
      return;
    }
    // 形态二：选区两侧紧邻 <u>/</u>（含空选区光标置于标签对内的场景）。
    if (value.slice(start - 3, start) === '<u>' && value.slice(end, end + 4) === '</u>') {
      onChange(`${value.slice(0, start - 3)}${sel}${value.slice(end + 4)}`);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(start - 3, end - 3);
      });
      return;
    }
    wrapSelection('<u>', '</u>');
  };

  const fmtBtn = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="rounded border border-border bg-surface px-1 py-0.5 leading-none text-text-tertiary transition-colors hover:text-accent"
    >
      {icon}
    </button>
  );

  return (
    <div className="min-w-0 flex-1">
      <div className="relative">
        {/* 展示态：覆盖层渲染 markdown；input 隐形垫底（占位 + 点击即编辑）。 */}
        {!focused && (
          <span className="pointer-events-none absolute inset-0 block truncate px-1 py-0.5">
            <DeckInlineText text={value} />
          </span>
        )}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={`w-full rounded bg-transparent px-1 py-0.5 outline-none focus:bg-surface focus:ring-1 focus:ring-ring ${focused ? '' : 'opacity-0'}`}
        />
      </div>
      {focused && (
        <div className="mt-0.5 flex items-center gap-1">
          {fmtBtn(t('writing.deckFmtBold', '粗体'), <Bold size={10} />, () => wrapSelection('**', '**'))}
          {fmtBtn(t('writing.deckFmtItalic', '斜体'), <Italic size={10} />, () => wrapSelection('*', '*'))}
          {fmtBtn(t('writing.deckFmtStrike', '删除线'), <Strikethrough size={10} />, () => wrapSelection('~~', '~~'))}
          {/* #1054: 下划线 — <u> 直通（markdown 无此语法），支持包裹/取消。 */}
          {fmtBtn(t('writing.deckFmtUnderline', '下划线'), <Underline size={10} />, toggleUnderline)}
          {fmtBtn(t('writing.deckFmtLink', '链接'), <Link2 size={10} />, () => wrapSelection('[', '](https://)'))}
        </div>
      )}
    </div>
  );
}

/** #1047: table 块只读渲染 — data 为 JSON 字符串 `{rows: string[][], header?: boolean}`；
 * 解析失败/形状不符降级为占位文本，不崩溃（导入侧已把合并单元格降级为重复文本，
 * 此处无需处理 gridSpan/rowSpan）。 */
function DeckTableBlock({ block }: { block: { data?: string } }) {
  const { t } = useTranslation();
  let parsed: { rows?: unknown; header?: unknown } | null = null;
  if (typeof block.data === 'string') {
    try {
      parsed = JSON.parse(block.data) as { rows?: unknown; header?: unknown };
    } catch {
      parsed = null;
    }
  }
  const rowsRaw = parsed?.rows;
  const rows = Array.isArray(rowsRaw) ? rowsRaw.filter((r): r is unknown[] => Array.isArray(r)) : [];
  if (rows.length === 0) {
    return (
      <p className="rounded border border-dashed border-border px-2 py-1 text-[11px] text-text-tertiary">
        {t('writing.deckTableInvalid', '表格数据无法解析')}
      </p>
    );
  }
  const header = parsed?.header === true;
  return (
    <div className="max-h-[60%] overflow-auto rounded border border-border">
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => {
                const Cell = header && ri === 0 ? 'th' : 'td';
                return (
                  <Cell
                    key={ci}
                    className={`border border-border px-1.5 py-0.5 text-left align-top ${header && ri === 0 ? 'bg-surface-elevated font-medium text-text-primary' : 'text-text-secondary'}`}
                  >
                    {String(cell ?? '')}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** #1044: image 块只读渲染 + 替换/删除操作 — url/caption 字段与正文图片
 * 投影（lib/deck.ts）、AI 图片 bullet 同形状；url 缺失降级占位不崩溃。 */
function DeckImageBlock({ block, onReplace, onDelete }: {
  block: { url?: string; caption?: string };
  onReplace: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  if (!block.url) {
    return (
      <p className="rounded border border-dashed border-border px-2 py-1 text-[11px] text-text-tertiary">
        {t('writing.deckImageInvalid', '图片链接缺失')}
      </p>
    );
  }
  return (
    <figure className="min-w-0">
      <img src={block.url} alt={block.caption || ''} title={block.caption || undefined} className="max-h-28 w-auto max-w-full self-start rounded border border-border object-contain" />
      <figcaption className="mt-0.5 flex items-center gap-1">
        {block.caption && <span className="min-w-0 flex-1 truncate text-[10px] text-text-tertiary">{block.caption}</span>}
        <button
          onClick={onReplace}
          aria-label={t('writing.deckReplaceImage', '替换图片')}
          title={t('writing.deckReplaceImage', '替换图片')}
          className="shrink-0 rounded px-1 text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
        >
          {t('writing.deckReplaceImage', '替换图片')}
        </button>
        <button
          onClick={onDelete}
          aria-label={t('writing.deckDeleteImage', '删除图片')}
          title={t('writing.deckDeleteImage', '删除图片')}
          className="shrink-0 rounded px-1 text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-error"
        >
          {t('writing.deckDeleteImage', '删除图片')}
        </button>
      </figcaption>
    </figure>
  );
}

/** #1044: chart 块只读渲染 — 确定性 SVG（柱/折线/剂量曲线），数据驱动非生成式
 * （#176 临床安全约束，与 AI insert_chart 同 spec 形状；导出侧走同一确定性管道）。
 * spec 缺失/数据畸形降级为占位文本，不崩溃（同 #1047 表格口径）。 */
function DeckChartBlock({ block, onReplace, onDelete }: {
  block: { spec?: unknown; caption?: string };
  onReplace: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const spec = (typeof block.spec === 'object' && block.spec !== null ? block.spec : null) as {
    chart_type?: string;
    data?: unknown;
    title?: string;
  } | null;
  const data = (Array.isArray(spec?.data) ? spec!.data : []).filter(
    (d): d is { label: string; value: number } =>
      typeof (d as { label?: unknown })?.label === 'string' && typeof (d as { value?: unknown })?.value === 'number',
  );
  if (!spec || data.length === 0) {
    return (
      <p className="rounded border border-dashed border-border px-2 py-1 text-[11px] text-text-tertiary">
        {t('writing.deckChartInvalid', '图表数据无法解析')}
      </p>
    );
  }
  // 确定性坐标：viewBox 200×110，等分映射，无任何随机/模型参与。
  const W = 200;
  const H = 110;
  const PAD_X = 28;
  const PAD_TOP = 8;
  const plotH = H - 8 - 18;
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1e-9);
  const baseline = PAD_TOP + plotH;
  const isLine = spec.chart_type === 'line' || spec.chart_type === 'dose_curve';
  const px = (i: number) => PAD_X + (data.length === 1 ? (W - PAD_X * 2) / 2 : (i * (W - PAD_X * 2)) / (data.length - 1));
  const py = (v: number) => baseline - (Math.abs(v) / max) * (plotH - 4);
  return (
    <figure className="min-w-0 rounded border border-border bg-surface p-1.5">
      {spec.title && <figcaption className="mb-0.5 truncate text-[11px] font-medium text-text-primary">{spec.title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title || t('writing.deckChartAriaLabel', '数据图表')} className="w-full text-accent">
        {/* 基线轴 */}
        <line x1={PAD_X} y1={baseline} x2={W - PAD_X} y2={baseline} className="text-border" stroke="currentColor" strokeWidth="1" />
        {isLine ? (
          <>
            <polyline points={data.map((d, i) => `${px(i)},${py(d.value)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />
            {data.map((d, i) => (
              <circle key={i} cx={px(i)} cy={py(d.value)} r="2.5" fill="currentColor" />
            ))}
          </>
        ) : (
          data.map((d, i) => {
            const bw = (W - PAD_X * 2) / data.length;
            const h = Math.max((Math.abs(d.value) / max) * (plotH - 4), 1);
            return <rect key={i} x={PAD_X + i * bw + bw * 0.15} y={baseline - h} width={bw * 0.7} height={h} fill="currentColor" rx="2" />;
          })
        )}
        {data.map((d, i) => (
          <text key={i} x={px(i)} y={H - 6} fontSize="7" textAnchor="middle" className="text-text-tertiary" fill="currentColor">
            {d.label.slice(0, 12)}
          </text>
        ))}
      </svg>
      {(block.caption || data.length > 0) && (
        <figcaption className="mt-0.5 flex items-center gap-1">
          {block.caption && <span className="min-w-0 flex-1 truncate text-[10px] text-text-tertiary">{block.caption}</span>}
          <button
            onClick={onReplace}
            aria-label={t('writing.deckReplaceChart', '替换图表')}
            title={t('writing.deckReplaceChart', '替换图表')}
            className="shrink-0 rounded px-1 text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
          >
            {t('writing.deckReplaceChart', '替换图表')}
          </button>
          <button
            onClick={onDelete}
            aria-label={t('writing.deckDeleteChart', '删除图表')}
            title={t('writing.deckDeleteChart', '删除图表')}
            className="shrink-0 rounded px-1 text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-error"
          >
            {t('writing.deckDeleteChart', '删除图表')}
          </button>
        </figcaption>
      )}
    </figure>
  );
}

/** 单张 deck 卡片（deckAsset 分支）— 提取为组件承载卡片级 UI 状态（如 #1046 备注折叠、#1044 插入/替换目标）。 */
function DeckSlideCard({ index, slide, deckCtl, total, slideComments, onAddComment, onCommentClick }: {
  index: number;
  slide: DeckWire['slides'][number];
  deckCtl: DeckAsset;
  total: number;
  /** #1051: 锚定本页的评论（target='deck_slide', slideIndex=index+1）。 */
  slideComments: DeckSlideCommentInfo[];
  /** #1051: 「添加评论」入口（整页评论 — anchorText 取页标题）。 */
  onAddComment?: (slideIndex0: number, anchorText: string) => void;
  /** #1051: 点击评论标记 → 侧边栏定位/展开线程。 */
  onCommentClick?: (commentId: string) => void;
}) {
  const { t } = useTranslation();
  // #1046: 备注折叠态 — 卡片级 UI 状态，默认收起不占视觉。
  const [notesOpen, setNotesOpen] = useState(false);
  // #1044: 图片上传目标（插入 / 原位替换某块）与错误态；图表表单（插入 / 替换某块）。
  const [uploadTarget, setUploadTarget] = useState<{ mode: 'insert' } | { mode: 'replace'; blockIndex: number; oldCaption?: string }>({ mode: 'insert' });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [chartForm, setChartForm] = useState<{ mode: 'insert' } | { mode: 'replace'; blockIndex: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // #1051: 本页评论态 — open 评论驱动标题高亮（漂移 = 警示色），激活线程加描边。
  const openSlideComments = slideComments.filter((c) => c.status !== 'resolved');
  const driftedHere = openSlideComments.some((c) => !c.located);
  const activeHere = slideComments.some((c) => c.active);

  /** #1044: 复用 #1038 打通的上传链路（api.uploadFile → getDownloadUrl canonical
   * URL，见 DocEditor.runImageUpload 同构），成功后按目标插入/原位替换 image 块；
   * 失败给行内错误提示（非静默），不产生坏块。 */
  const runImageUpload = async (file: File) => {
    const target = uploadTarget;
    try {
      const up = await api.uploadFile(file);
      const { url } = await api.getDownloadUrl(up.file_id);
      setUploadError(null);
      if (target.mode === 'insert') deckCtl.insertDeckSlideImage(index, url, file.name);
      else deckCtl.replaceDeckSlideBlock(index, target.blockIndex, deckImageBlock(url, target.oldCaption ?? file.name));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/deck-index', String(index)); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/deck-index'));
        if (Number.isInteger(from) && from !== index) deckCtl.moveDeckSlide(from, index);
      }}
      title={t('writing.deckDragHint', '拖拽卡片可调整页序')}
      className="flex aspect-video flex-col overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="shrink-0 text-[11px] font-semibold text-text-tertiary">{index + 1}.</span>
        <input
          value={slide.title}
          onChange={(e) => deckCtl.updateDeckSlide(index, { title: e.target.value })}
          /* #1051: 评论锚定本页 → 标题高亮（deck 非 TipTap，用底色而非
             decoration）；漂移页警示色；激活线程加描边。点击 = 联动侧边栏。 */
          onClick={() => {
            const first = openSlideComments[0];
            if (first) onCommentClick?.(first.commentId);
          }}
          data-comment-id={openSlideComments.length > 0 ? openSlideComments[0].commentId : undefined}
          className={cn(
            'min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-xs font-semibold text-text-primary outline-none focus:bg-surface focus:ring-1 focus:ring-ring',
            openSlideComments.length > 0 && (driftedHere ? 'bg-warning/10' : 'bg-accent/10'),
            activeHere && 'ring-1 ring-accent/50',
          )}
        />
        {/* #1051: 评论徽标 — 数量入口，点击展开/定位侧边栏线程。 */}
        {openSlideComments.length > 0 && (
          <button
            type="button"
            data-testid={`deck-slide-comments-${index}`}
            data-comment-id={openSlideComments[0].commentId}
            onClick={() => onCommentClick?.(openSlideComments[0].commentId)}
            title={t('writing.deckSlideComments', '本页有 {{n}} 条评论', { n: openSlideComments.length })}
            className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-accent transition-colors hover:bg-surface"
          >
            <MessageSquare size={11} /> {openSlideComments.length}
          </button>
        )}
        {/* #959: 每页布局母版选择（contracts v2）— 预览/导出同语义。 */}
        <select
          value={slide.layout ?? ''}
          onChange={(e) => deckCtl.setDeckSlideLayout(index, e.target.value || undefined)}
          title={t('writing.deckLayout', '布局母版')}
          className="shrink-0 rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-text-secondary outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">{t('writing.deckLayoutDefault', '默认')}</option>
          <option value="title">{t('writing.deckLayoutTitle', '封面')}</option>
          <option value="section">{t('writing.deckLayoutSection', '章节页')}</option>
          <option value="bullets">{t('writing.deckLayoutBullets', '要点')}</option>
          <option value="bullets+image">{t('writing.deckLayoutBulletsImage', '要点+图')}</option>
          <option value="chart-full">{t('writing.deckLayoutChartFull', '整页图表')}</option>
          <option value="quote">{t('writing.deckLayoutQuote', '引用')}</option>
          <option value="blank">{t('writing.deckLayoutBlank', '空白')}</option>
        </select>
        {/* #1045: 键盘可访问的排序替代方案 — 上移/下移按钮复用
            moveDeckSlide（与拖拽同一状态更新逻辑,不新造排序实现）;
            首尾越界方向禁用（moveDeckSlide 自身也有越界保护）。 */}
        <button
          onClick={() => deckCtl.moveDeckSlide(index, index - 1)}
          disabled={index === 0}
          aria-label={t('writing.deckMoveUp', '上移此页')}
          title={t('writing.deckMoveUp', '上移此页')}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
        >
          <ChevronUp size={12} />
        </button>
        <button
          onClick={() => deckCtl.moveDeckSlide(index, index + 1)}
          disabled={index === total - 1}
          aria-label={t('writing.deckMoveDown', '下移此页')}
          title={t('writing.deckMoveDown', '下移此页')}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
        >
          <ChevronDown size={12} />
        </button>
        <button
          onClick={() => deckCtl.deleteDeckSlide(index)}
          title={t('writing.deckDeleteSlide', '删除此页')}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-error"
        >
          <X size={12} />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-1 overflow-hidden px-3 py-2 text-xs leading-relaxed text-text-secondary">
        {/* #1047: 按 content 原序交错渲染 — 文本块走要点编辑行，table 块走只读表格；
            #1044: image/chart 块走只读渲染 + 替换/删除操作（原位替换，非追加）。 */}
        {slide.content.map((b, ci) => {
          if (b.type === 'table') return <DeckTableBlock key={`t-${ci}`} block={b} />;
          if (b.type === 'image')
            return (
              <DeckImageBlock
                key={`img-${ci}`}
                block={b}
                onReplace={() => {
                  setUploadError(null);
                  setUploadTarget({ mode: 'replace', blockIndex: ci, oldCaption: b.caption });
                  fileInputRef.current?.click();
                }}
                onDelete={() => deckCtl.deleteDeckSlideBlock(index, ci)}
              />
            );
          if (b.type === 'chart')
            return (
              <DeckChartBlock
                key={`chart-${ci}`}
                block={b}
                onReplace={() => setChartForm({ mode: 'replace', blockIndex: ci })}
                onDelete={() => deckCtl.deleteDeckSlideBlock(index, ci)}
              />
            );
          if (typeof b.text !== 'string') return null;
          const j = slide.content.slice(0, ci + 1).filter((x) => typeof x.text === 'string').length - 1;
          return (
            <div key={ci} className="flex min-w-0 items-start gap-1.5">
              <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
              <DeckTextLine
                value={b.text}
                onChange={(v) => {
                  const bullets = deckCtl.slideBullets(slide).map((x, k) => (k === j ? v : x));
                  deckCtl.updateDeckSlide(index, { bullets });
                }}
              />
            </div>
          );
        })}
        {/* #1044: 插入图片（复用 #1038 上传链路）/ 插入图表（结构化表单，非生成式）入口。 */}
        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={() => deckCtl.updateDeckSlide(index, { bullets: [...deckCtl.slideBullets(slide), ''] })}
            className="rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
          >
            + {t('writing.deckAddBullet', '要点')}
          </button>
          {/* #1051: 本页评论入口 — 整页评论，anchorText 取页标题（创建走同一套侧边栏线程）。 */}
          {onAddComment && (
            <button
              data-testid={`deck-comment-entry-${index}`}
              onClick={() => onAddComment(index, slide.title)}
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
            >
              <MessageSquarePlus size={11} /> {t('writing.deckAddComment', '评论')}
            </button>
          )}
          <button
            onClick={() => {
              setUploadError(null);
              setUploadTarget({ mode: 'insert' });
              fileInputRef.current?.click();
            }}
            aria-label={t('writing.deckInsertImage', '插入图片')}
            title={t('writing.deckInsertImage', '插入图片')}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
          >
            <ImagePlus size={11} /> {t('writing.deckInsertImage', '图片')}
          </button>
          <button
            onClick={() => setChartForm({ mode: 'insert' })}
            aria-label={t('writing.deckInsertChart', '插入图表')}
            title={t('writing.deckInsertChart', '插入图表')}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
          >
            <BarChart3 size={11} /> {t('writing.deckInsertChart', '图表')}
          </button>
        </div>
        {/* #1044: 上传失败行内错误（非静默），下次尝试自动清除。 */}
        {uploadError && (
          <p role="alert" className="rounded border border-error/40 bg-error/10 px-1.5 py-0.5 text-[11px] text-error">
            {t('writing.deckImageUploadFail', '图片上传失败')}：{uploadError}
          </p>
        )}
        {/* #1044: 隐藏文件选择 — 插入与替换共用一个 input（uploadTarget 决定落点）。 */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void runImageUpload(f);
          }}
        />
      </div>
      {/* #1046: 备注编辑区 — 可折叠（默认收起不占视觉），绑定 DeckWire.slides[].notes。 */}
      <div className="border-t border-border px-3 py-1">
        <button
          onClick={() => setNotesOpen((o) => !o)}
          aria-expanded={notesOpen}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
        >
          {notesOpen ? <ChevronDown size={11} /> : <ChevronUp size={11} className="rotate-180" />}
          {t('writing.deckNotesToggle', '备注')}
        </button>
        {notesOpen && (
          <textarea
            aria-label={t('writing.deckNotesEditor', '备注内容')}
            value={slide.notes ?? ''}
            onChange={(e) => deckCtl.updateDeckSlideNotes(index, e.target.value)}
            rows={2}
            placeholder={t('writing.deckNotesPlaceholder', '说话人备注（导出 PPT 时写入备注页）')}
            className="mt-1 w-full resize-none rounded border border-border bg-surface p-1.5 text-[11px] leading-relaxed text-text-secondary outline-none focus:ring-1 focus:ring-ring"
          />
        )}
      </div>
      {/* #1044: 结构化图表表单 — 插入/替换共用；spec 经 chartBlockSchema 校验后入 content。 */}
      {chartForm && (
        <DeckChartFormDialog
          initialBlock={chartForm.mode === 'replace' ? slide.content[chartForm.blockIndex] : undefined}
          onConfirm={(block: DeckChartFormResult) => {
            if (chartForm.mode === 'insert') deckCtl.insertDeckSlideChart(index, block.spec, block.caption);
            else deckCtl.replaceDeckSlideBlock(index, chartForm.blockIndex, block);
            setChartForm(null);
          }}
          onClose={() => setChartForm(null)}
        />
      )}
    </div>
  );
}

export function DeckView(input: {
  deckAsset: DeckWire | null;
  slides: Slide[];
  body: string;
  deckCtl: DeckAsset;
  sendChatText: (text: string) => Promise<void>;
  onCardEdit: (slide: Slide) => void;
  /** #1051: deck slide 评论（target='deck_slide'）— 高亮/徽标数据源。 */
  deckComments?: DeckSlideCommentInfo[];
  /** #1051: slide 卡片「添加评论」入口（slideIndex0 0-based, anchorText=页标题）。 */
  onAddSlideComment?: (slideIndex0: number, anchorText: string) => void;
  /** #1051: 评论标记点击 → 侧边栏联动。 */
  onCommentClick?: (commentId: string) => void;
}) {
  const { t } = useTranslation();
  const { deckAsset, slides, body, deckCtl, sendChatText, onCardEdit, deckComments, onAddSlideComment, onCommentClick } = input;
  return (
    <div className="space-y-3">
                    {deckAsset ? (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2">
                        <span className="text-xs text-accent">
                          {t('writing.deckAssetBadge', 'AI 编排 deck 资产 — 卡片内可直接编辑（改标题/调要点/删页），保存不会改动文档正文。')}
                        </span>
                        <div className="flex shrink-0 items-center gap-2">
                          {/* #959: deck 级主题选择（contracts v2）— 预览与导出（worker 母版）同语义。 */}
                          <select
                            value={deckAsset.theme ?? ''}
                            onChange={(e) => deckCtl.setDeckTheme(e.target.value || undefined)}
                            title={t('writing.deckTheme', 'deck 主题（导出 PPT 应用主题母版）')}
                            className="rounded border border-border bg-surface px-1.5 py-1 text-[11px] text-text-secondary outline-none focus:ring-1 focus:ring-ring"
                          >
                            <option value="">{t('writing.deckThemeDefault', '主题：默认')}</option>
                            <option value="clinical">{t('writing.deckThemeClinical', '临床蓝')}</option>
                            <option value="warm-paper">{t('writing.deckThemeWarmPaper', '暖色纸面')}</option>
                          </select>
                          <Button size="sm" variant="secondary" onClick={deckCtl.addDeckSlide}>
                            <FilePlus size={13} className="mr-1" /> {t('writing.deckAddSlide', '添加一页')}
                          </Button>
                        </div>
                      </div>
                    ) : slides.length <= 1 && body.trim() && (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-surface-elevated px-4 py-2.5">
                        <span className="text-xs text-text-secondary">
                          {t('writing.deckSinglePageHint', '文档还没有 ## 分页结构，导出 PPT 只会有一页。可让 AI 按内容语义拆页。')}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void sendChatText(t('writing.aiSplitPrompt', '请把当前稿件按内容语义拆成多页（每页一个 ## 二级标题），为生成 PPT 做准备。'))}
                        >
                          <Sparkles size={13} className="mr-1" /> {t('writing.aiSplitPages', 'AI 帮我拆页')}
                        </Button>
                      </div>
                    )}
                    {deckAsset ? (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        {deckAsset.slides.map((slide, i) => (
                          <DeckSlideCard
                            key={i}
                            index={i}
                            slide={slide}
                            deckCtl={deckCtl}
                            total={deckAsset.slides.length}
                            slideComments={(deckComments ?? []).filter((c) => c.slideIndex === i + 1)}
                            onAddComment={onAddSlideComment}
                            onCommentClick={onCommentClick}
                          />
                        ))}
                      </div>
                    ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      {slides.map((slide, i) => (
                        <div
                          key={i}
                          className="group relative flex aspect-video flex-col overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-sm transition-shadow hover:shadow-md"
                        >
                          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                            <span className="truncate text-xs font-semibold text-text-primary">
                              {i + 1}. {slide.title}
                            </span>
                            <button
                              onClick={() => onCardEdit(slide)}
                              title={t('writing.deckCardEdit', '跳回文档编辑此页')}
                              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-opacity hover:bg-surface hover:text-accent group-hover:opacity-100 md:opacity-0"
                            >
                              <Pencil size={11} /> {t('writing.deckCardEdit', '编辑')}
                            </button>
                          </div>
                          <div className="flex flex-1 flex-col gap-1.5 overflow-hidden px-3 py-2 text-xs leading-relaxed text-text-secondary">
                            {slide.blocks.slice(0, 8).map((b, j) =>
                              b.type === 'image' ? (
                                <img key={j} src={b.url} alt={b.caption || ''} className="max-h-[55%] w-auto self-start rounded border border-border object-contain" />
                              ) : b.type === 'bullet' ? (
                                <div key={j} className="flex min-w-0 items-start gap-1.5">
                                  <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
                                  <span className="line-clamp-2">{b.text}</span>
                                </div>
                              ) : (
                                <p key={j} className="line-clamp-2">{b.text}</p>
                              ),
                            )}
                            {slide.blocks.length > 8 && (
                              <span className="text-[11px] text-text-tertiary">…{t('writing.deckMoreBlocks', '还有 {{n}} 段', { n: slide.blocks.length - 8 })}</span>
                            )}
                          </div>
                        </div>
                      ))}
                      </div>
                    )}
                    {/* #770 设计更新 2：导出交互 = 预填 chat 消息发送，不新建旁路 API。
                        #773: deck 资产存在时导出内容源 = Doc.deck（所见即所导）。 */}
                    <div className="flex justify-end">
                      <Button size="sm" onClick={() => void sendChatText(deckAsset
                        ? t('writing.aiExportDeckPrompt', '请把当前 deck 导出为 PPT（使用现有 deck 内容，不要重新编排）。')
                        : t('writing.aiExportPptPrompt', '请把当前稿件导出为 PPT。'))}>
                        <Presentation size={13} className="mr-1" /> {t('writing.aiExportPpt', 'AI 导出 PPT')}
                      </Button>
                    </div>
    </div>
  );
}
