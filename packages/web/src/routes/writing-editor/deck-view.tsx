import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { BarChart3, Bold, ChevronDown, ChevronUp, FilePlus, ImagePlus, Italic, Link2, MessageSquare, MessageSquarePlus, Pencil, Presentation, Sparkles, Strikethrough, Underline, X } from 'lucide-react';
import { tableBlockSchema } from '@heurion/contracts';
import { Button } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Slide } from '@/lib/deck';
import type { DeckWire } from '@/lib/types';
import type { DeckAsset, SlideEpochSnapshot } from './deck-asset';
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

/** #1075: 表格块操作按钮 — 与图片/图表块的操作行同款式同位置（对等原则：
 * deck 的编辑能力与正文保持一致）。数据无法解析的坏表格同样给入口
 * （AI 导入/历史遗留可清理/替换，不必整页删除）。 */
function DeckTableActions({ onReplace, onDelete }: { onReplace: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mt-0.5 flex items-center justify-end gap-1">
      <button
        onClick={onReplace}
        aria-label={t('writing.deckReplaceTable', '替换表格')}
        title={t('writing.deckReplaceTable', '替换表格')}
        className="shrink-0 rounded px-1 text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
      >
        {t('writing.deckReplaceTable', '替换表格')}
      </button>
      <button
        onClick={onDelete}
        aria-label={t('writing.deckDeleteTable', '删除表格')}
        title={t('writing.deckDeleteTable', '删除表格')}
        className="shrink-0 rounded px-1 text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-error"
      >
        {t('writing.deckDeleteTable', '删除表格')}
      </button>
    </div>
  );
}

/** #1047: table 块只读渲染 — data 为 JSON 字符串 `{rows: string[][], header?: boolean}`；
 * 解析失败/形状不符降级为占位文本，不崩溃（导入侧已把合并单元格降级为重复文本，
 * 此处无需处理 gridSpan/rowSpan）。
 * #1075: 补替换/删除操作（此前唯一零操作块类型）— 走 deckCtl 既有
 * replaceDeckSlideBlock / deleteDeckSlideBlock（min-1 防线沿用）。 */
function DeckTableBlock({ block, onReplace, onDelete }: {
  block: { data?: string };
  onReplace: () => void;
  onDelete: () => void;
}) {
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
      <div className="min-w-0">
        <p className="rounded border border-dashed border-border px-2 py-1 text-[11px] text-text-tertiary">
          {t('writing.deckTableInvalid', '表格数据无法解析')}
        </p>
        <DeckTableActions onReplace={onReplace} onDelete={onDelete} />
      </div>
    );
  }
  const header = parsed?.header === true;
  return (
    <div className="min-w-0">
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
      <DeckTableActions onReplace={onReplace} onDelete={onDelete} />
    </div>
  );
}

/** #1075: 表格数据表单 — 结构对齐 deck-chart-form（同款 Modal/校验/确认流，
 * 最小可用）：每行一条记录、单元格用 | 分隔，打开时回填原 rows、header
 * 勾选态沿用。确认经 tableBlockSchema 校验（rows 1..200 / ≤30 列 / 单元格
 * ≤2000 字符）后产出 { type:'table', data: JSON 字符串 } 供原位替换。
 * 限制（最小可用取舍）：单元格内不能含 | 或换行（与 | 分隔形态冲突）；
 * 各行允许缺格（contracts 对 ragged 行保持宽松）。 */
function DeckTableFormDialog(input: {
  /** 替换模式：预填原块（rows 回填文本形态，header 回填勾选态）。 */
  initialBlock?: { data?: string };
  onConfirm: (block: { type: 'table'; data: string }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { initialBlock, onConfirm, onClose } = input;
  let parsed: { rows?: unknown; header?: unknown } | null = null;
  if (typeof initialBlock?.data === 'string') {
    try {
      parsed = JSON.parse(initialBlock.data) as { rows?: unknown; header?: unknown };
    } catch {
      parsed = null;
    }
  }
  const rowsRaw = Array.isArray(parsed?.rows) ? (parsed!.rows as unknown[]) : [];
  const initialRows = rowsRaw
    .filter((r): r is unknown[] => Array.isArray(r))
    .map((r) => r.map((c) => String(c ?? '')));
  const [text, setText] = useState(initialRows.map((r) => r.join(' | ')).join('\n'));
  const [header, setHeader] = useState(parsed?.header === true);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    // 空行丢弃；行内单元格按 | 切分并去首尾空白 — 至少 1 行且每行至少
    // 1 个单元格才进 schema 校验（失败给行内提示，不改 content）。
    const rows = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.split('|').map((c) => c.trim()));
    if (rows.length === 0 || rows.some((r) => r.every((c) => c === ''))) {
      setError(t('writing.deckTableFormEmpty', '至少需要一行数据（单元格用 | 分隔）'));
      return;
    }
    const data = JSON.stringify({ rows, ...(header ? { header: true } : {}) });
    const check = tableBlockSchema.safeParse({ type: 'table', data });
    if (!check.success) {
      setError(check.error.issues.map((i) => i.message).join('；').slice(0, 200));
      return;
    }
    onConfirm({ type: 'table', data });
  };

  return (
    <Modal open onClose={onClose} backdropClose escClose backdropClassName="bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface-elevated shadow-xl p-6 m-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{t('writing.deckTableFormTitle', '替换表格')}</h2>
          <button onClick={onClose} aria-label={t('writing.deckChartFormClose', '关闭')} className="text-text-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-text-secondary" htmlFor="deck-table-form-data">
              {t('writing.deckTableFormData', '表格数据（每行一条，单元格用 | 分隔）')}
            </label>
            <textarea
              id="deck-table-form-data"
              aria-label={t('writing.deckTableFormData', '表格数据（每行一条，单元格用 | 分隔）')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder={t('writing.deckTableFormPlaceholder', '指标 | 值\nPFS | 5.2')}
              className="w-full resize-y rounded-lg border border-border bg-surface px-2 py-1.5 text-xs font-mono text-text-primary placeholder:text-text-tertiary outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <label className="flex items-center gap-1.5 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={header}
              onChange={(e) => setHeader(e.target.checked)}
              aria-label={t('writing.deckTableFormHeader', '首行为表头')}
            />
            {t('writing.deckTableFormHeader', '首行为表头')}
          </label>
          {error && (
            <p role="alert" className="rounded border border-error/40 bg-error/10 px-2 py-1 text-xs text-error">
              {t('writing.deckTableFormInvalid', '数据未通过校验')}：{error}
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('writing.deckChartFormCancel', '取消')}
          </Button>
          <Button size="sm" onClick={submit}>
            {t('writing.deckChartFormConfirmReplace', '确认替换')}
          </Button>
        </div>
      </div>
    </Modal>
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
  // #1063: 保留数值符号 — 旧实现 Math.abs 把负值画成正值（临床数据误导）。
  // 有负值时基线上移，正/负极值按比例分摊绘图高度；纯正负同图时折线点/柱体
  // 可落到基线下方。纯正值时几何与旧实现完全一致（基线贴底、向上绘制）。
  const values = data.map((d) => d.value);
  const hasNeg = values.some((v) => v < 0);
  const maxPos = Math.max(...values, 1e-9);
  const maxNegAbs = hasNeg ? Math.abs(Math.min(...values, 0)) : 0;
  const span = plotH - 4;
  const negSpan = hasNeg ? (span * maxNegAbs) / (maxPos + maxNegAbs) : 0;
  const posSpan = span - negSpan;
  const baseline = PAD_TOP + posSpan;
  const isLine = spec.chart_type === 'line' || spec.chart_type === 'dose_curve';
  const px = (i: number) => PAD_X + (data.length === 1 ? (W - PAD_X * 2) / 2 : (i * (W - PAD_X * 2)) / (data.length - 1));
  const py = (v: number) =>
    v >= 0 ? baseline - (v / maxPos) * posSpan : baseline + (v / Math.min(...values, 0)) * negSpan;
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
            // #1063: 负值柱向下 — y 从基线起、向下延伸 h；正值柱维持向上。
            const frac = d.value >= 0 ? d.value / maxPos : d.value / Math.min(...values, 0);
            const h = Math.max(frac * (d.value >= 0 ? posSpan : negSpan), 1);
            return <rect key={i} x={PAD_X + i * bw + bw * 0.15} y={d.value >= 0 ? baseline - h : baseline} width={bw * 0.7} height={h} fill="currentColor" rx="2" />;
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
function DeckSlideCard({ index, slide, deckCtl, total, slideComments, onAddComment, onCommentClick, onNotice }: {
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
  /** #1087: 丢弃/拒绝提示通道（路由 showNotice 横幅）— 非静默原则。 */
  onNotice?: (text: string, ttlMs?: number) => void;
}) {
  const { t } = useTranslation();
  // #1046: 备注折叠态 — 卡片级 UI 状态，默认收起不占视觉。
  const [notesOpen, setNotesOpen] = useState(false);
  // #1044: 图片上传目标（插入 / 原位替换某块）与错误态；图表表单（插入 / 替换某块）。
  // #1087: 插入/替换的竞态判据换结构 epoch 快照 {index, epoch}（上传发起/表单打开
  // 时取，完成/确认时校验）— 文本编辑不动 epoch 不误杀；删页/移页/整 deck 替换失配。
  // #1089-2: 错误态携带失败文件供「重试」走同链路（对齐 DocEditor 错误结构）。
  const [uploadTarget, setUploadTarget] = useState<{ mode: 'insert' } | { mode: 'replace'; blockIndex: number; oldCaption?: string }>({ mode: 'insert' });
  const [uploadError, setUploadError] = useState<{ file: File; message: string; dropped?: boolean } | null>(null);
  // #1089-3: 插入等待期占位（本地 state，成功替换/失败移除，不落 deck 数据）。
  const [uploadPending, setUploadPending] = useState(false);
  const [chartForm, setChartForm] = useState<
    | { mode: 'insert'; expectEpoch: SlideEpochSnapshot | null }
    | { mode: 'replace'; blockIndex: number; expectBlock: DeckWire['slides'][number]['content'][number]; expectEpoch: SlideEpochSnapshot | null }
    | null
  >(null);
  // #1075: 表格数据表单（仅替换 — 表格无「插入」入口，替换对齐图片/图表块）。
  const [tableForm, setTableForm] = useState<{ mode: 'replace'; blockIndex: number; expectBlock: DeckWire['slides'][number]['content'][number]; expectEpoch: SlideEpochSnapshot | null } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // #1063: 要点行容器 — 「+ 要点」追加新行后把焦点补到新行输入框。
  const bodyRef = useRef<HTMLDivElement>(null);
  // #1073-4: 聚焦改显式用户事件信号 — 「+要点」onClick 记录期望的新要点数
  // （当前数+1），effect 消费该信号后立即清除；AI 写回导致的块数变化不置位
  // 信号 → 不再误抢焦点。信号与目标数绑定：过期信号（点击后块数被 AI 改动、
  // 数值对不上）失效不聚焦，也不会滞留到后续 AI 写回时误触发。
  const prevBulletCount = useRef<number | null>(null);
  const focusSignalRef = useRef<number | null>(null);
  const bulletCount = slide.content.filter((b) => typeof b.text === 'string').length;
  useEffect(() => {
    const prev = prevBulletCount.current;
    prevBulletCount.current = bulletCount;
    const target = focusSignalRef.current;
    if (target === null) return;
    focusSignalRef.current = null;
    if (prev !== null && bulletCount === target) {
      const inputs = bodyRef.current?.querySelectorAll<HTMLInputElement>('input:not([type="file"])');
      inputs?.[inputs.length - 1]?.focus();
    }
  }, [bulletCount]);
  // #1051: 本页评论态 — open 评论驱动标题高亮（漂移 = 警示色），激活线程加描边。
  const openSlideComments = slideComments.filter((c) => c.status !== 'resolved');
  const driftedHere = openSlideComments.some((c) => !c.located);
  const activeHere = slideComments.some((c) => c.active);

  /** #1044: 复用 #1038 打通的上传链路（api.uploadFile → getDownloadUrl canonical
   * URL，见 DocEditor.runImageUpload 同构），成功后按目标插入/原位替换 image 块；
   * 失败给行内错误提示（非静默），不产生坏块。
   * #1087: 上传发起时快照目标页结构 epoch，完成时校验 — 不一致（页被删/移/
   * 整 deck 替换）→ 放弃写回 + onNotice 可见提示（非静默）+ 保留重试路径。
   * #1089-3: 插入等待期渲染 pulse 占位块（本地 state），成功替换/失败移除。 */
  const runImageUpload = async (file: File) => {
    const target = uploadTarget;
    // #1087: 入口快照 — 目标页结构 epoch（index+epoch）与目标块引用（#1063）。
    const snap = deckCtl.snapshotSlideEpoch(index);
    const expectBlock = target.mode === 'replace' ? slide.content[target.blockIndex] : undefined;
    const insertMode = target.mode === 'insert';
    setUploadError(null);
    setUploadPending(insertMode);
    try {
      const up = await api.uploadFile(file);
      const { url } = await api.getDownloadUrl(up.file_id);
      // #1087: 完成时校验结构快照 — 失配即放弃（不误插/不误替换），提示非静默，
      // 错误条保留文件供重试（重试时在入口重新快照）。
      if (!snap || !deckCtl.verifySlideEpoch(snap)) {
        setUploadPending(false);
        const msg = insertMode
          ? t('writing.deckInsertDropped', '图片上传完成，但该页已被修改或移除，未能自动插入')
          : t('writing.deckReplaceDropped', '图片上传完成，但原位置已被修改或移除，未能自动替换');
        setUploadError({ file, message: msg, dropped: true });
        onNotice?.(msg, 6000);
        return;
      }
      if (insertMode) deckCtl.insertDeckSlideImage(index, url, file.name, snap);
      else deckCtl.replaceDeckSlideBlock(index, target.blockIndex, deckImageBlock(url, target.oldCaption ?? file.name), expectBlock, snap);
      setUploadPending(false);
    } catch (err) {
      // #1089-2: 上传失败可重试错误态（对齐 DocEditor）— 占位已移除，提示不静默。
      setUploadPending(false);
      setUploadError({ file, message: err instanceof Error ? err.message : String(err) });
    }
  };
  /** #1089-2: 重试 — 走同链路同快照刷新（入口重新快照结构 epoch）。 */
  const retryImageUpload = () => {
    if (!uploadError) return;
    const { file } = uploadError;
    setUploadError(null);
    void runImageUpload(file);
  };
  /** #1089-1: 唯一内容块删除被 min-1 防线拒绝 → 显式提示（非静默），块保留。 */
  const deleteBlockWithGuard = (blockIndex: number) => {
    if (slide.content.length <= 1) {
      onNotice?.(t('writing.deckLastBlock', '每页至少保留一个内容块'));
      return;
    }
    deckCtl.deleteDeckSlideBlock(index, blockIndex);
  };
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/deck-index', String(index)); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        // #1063: 只处理内部卡片排序拖拽 — dataTransfer 含专用 type 才读取。
        // 外部文件/文本拖入时 getData('text/deck-index') 返回空串，
        // 旧实现 Number('') = 0 过了 Number.isInteger 守卫 → 误触发 moveDeckSlide(0, index)。
        if (!e.dataTransfer.types.includes('text/deck-index')) return;
        const raw = e.dataTransfer.getData('text/deck-index');
        const from = Number(raw);
        if (raw !== '' && Number.isInteger(from) && from !== index) deckCtl.moveDeckSlide(from, index);
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
      <div ref={bodyRef} className="flex flex-1 flex-col gap-1 overflow-hidden px-3 py-2 text-xs leading-relaxed text-text-secondary">
        {/* #1047: 按 content 原序交错渲染 — 文本块走要点编辑行，table 块走只读表格；
            #1044: image/chart 块走只读渲染 + 替换/删除操作（原位替换，非追加）。 */}
        {slide.content.map((b, ci) => {
          if (b.type === 'table')
            return (
              <DeckTableBlock
                key={`t-${ci}`}
                block={b}
                /* #1075: 替换/删除入口 — 删除走 deleteBlockWithGuard
                    （min-1 防线 + #1089-1 唯一块拒绝显式提示），
                    替换打开表格数据表单（#1089-4 错误样式对齐图表表单）。 */
                onReplace={() => setTableForm({ mode: 'replace', blockIndex: ci, expectBlock: b, expectEpoch: deckCtl.snapshotSlideEpoch(index) })}
                onDelete={() => deleteBlockWithGuard(ci)}
              />
            );
          if (b.type === 'image')
            return (
              <DeckImageBlock
                key={`img-${ci}`}
                block={b}
                onReplace={() => {
                  setUploadError(null);
                  // #1087: 替换目标在入口快照（块引用 + 页结构 epoch）。
                  setUploadTarget({ mode: 'replace', blockIndex: ci, oldCaption: b.caption });
                  fileInputRef.current?.click();
                }}
                onDelete={() => deleteBlockWithGuard(ci)}
              />
            );
          if (b.type === 'chart')
            return (
              <DeckChartBlock
                key={`chart-${ci}`}
                block={b}
                onReplace={() => setChartForm({ mode: 'replace', blockIndex: ci, expectBlock: b, expectEpoch: deckCtl.snapshotSlideEpoch(index) })}
                onDelete={() => deleteBlockWithGuard(ci)}
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
            onClick={() => {
              // #1073-4: 显式用户事件信号 — 点击置位期望新要点数,effect 消费后聚焦;
              // AI 写回导致的块数变化不经过此处,不触发聚焦。
              focusSignalRef.current = bulletCount + 1;
              deckCtl.updateDeckSlide(index, { bullets: [...deckCtl.slideBullets(slide), ''] });
            }}
            /* #1063: 追加的空块不再被 updateDeckSlide 的 filter 吞掉（旧实现 no-op），
                新行落地后由上方「+要点」显式信号驱动自动聚焦。 */
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
            onClick={() => {
              // #1087: 表单打开时快照目标页结构 epoch（确认时校验，失配提示）。
              setChartForm({ mode: 'insert', expectEpoch: deckCtl.snapshotSlideEpoch(index) });
            }}
            aria-label={t('writing.deckInsertChart', '插入图表')}
            title={t('writing.deckInsertChart', '插入图表')}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
          >
            <BarChart3 size={11} /> {t('writing.deckInsertChart', '图表')}
          </button>
        </div>
        {/* #1089-3: 插入等待期 pulse 占位块（本地 state，成功替换/失败移除，
            不落 deck 数据；对齐 DocEditor 上传占位节点）。 */}
        {uploadPending && (
          <div
            role="status"
            aria-label={t('writing.deckUploadPending', '图片上传中')}
            data-testid={`deck-upload-pending-${index}`}
            className="flex h-14 w-full items-center justify-center rounded border border-dashed border-border bg-surface opacity-70"
          >
            <span className="h-4 w-4 animate-pulse rounded-full bg-border" />
          </div>
        )}
        {/* #1044: 上传失败行内错误（非静默）。#1089-2: 补「重试/忽略」—
            对齐 DocEditor 错误态结构；重试走同链路同快照刷新（#1087）。 */}
        {uploadError && (
          <div role="alert" className="flex flex-wrap items-center gap-1 rounded border border-error/40 bg-error/10 px-1.5 py-0.5 text-[11px] text-error">
            {/* #1087: dropped = 上传成功但结构失配被丢弃 — 不带「上传失败」前缀。 */}
            {!uploadError.dropped && <span className="font-medium">{t('writing.deckImageUploadFail', '图片上传失败')}</span>}
            <span className="min-w-0 flex-1 truncate">
              {uploadError.dropped ? uploadError.message : `${uploadError.file.name}: ${uploadError.message}`}
            </span>
            <button
              onClick={retryImageUpload}
              aria-label={t('writing.imageRetry', '重试')}
              title={t('writing.imageRetry', '重试')}
              className="shrink-0 rounded px-1 py-0.5 text-[11px] text-error transition-colors hover:bg-surface"
            >
              {t('writing.imageRetry', '重试')}
            </button>
            <button
              onClick={() => setUploadError(null)}
              aria-label={t('writing.imageDismiss', '忽略')}
              title={t('writing.imageDismiss', '忽略')}
              className="shrink-0 rounded px-1 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
            >
              {t('writing.imageDismiss', '忽略')}
            </button>
          </div>
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
      {/* #1044: 结构化图表表单 — 插入/替换共用；spec 经 chartBlockSchema 校验后入 content。
          #1087: 打开时快照页结构 epoch（+替换模式的块引用），确认时校验 — 打开到
          确认之间页被删/移/整 deck 替换（如 AI 写回落地）→ 放弃 + onNotice 提示。 */}
      {chartForm && (
        <DeckChartFormDialog
          initialBlock={chartForm.mode === 'replace' ? slide.content[chartForm.blockIndex] : undefined}
          onConfirm={(block: DeckChartFormResult) => {
            if (!chartForm.expectEpoch || !deckCtl.verifySlideEpoch(chartForm.expectEpoch)) {
              // #1087: 打开到确认之间页结构已变（如 AI 写回落地）→ 放弃 + 提示。
              onNotice?.(t('writing.deckFormTargetGone', '该页已被修改或移除，未能完成插入/替换，请重试'), 6000);
              setChartForm(null);
              return;
            }
            // #1087: 插入带入口结构快照 — 确认（同步事件）到写回之间无 await，
            // epoch 校验在 setter 内以最新状态权威兜底。
            if (chartForm.mode === 'insert') deckCtl.insertDeckSlideChart(index, block.spec, block.caption, chartForm.expectEpoch);
            // #1063: 替换同样带块身份快照（表单打开到确认之间块可能被删/移动）。
            else deckCtl.replaceDeckSlideBlock(index, chartForm.blockIndex, block, chartForm.expectBlock, chartForm.expectEpoch);
            setChartForm(null);
          }}
          onClose={() => setChartForm(null)}
        />
      )}
      {/* #1075: 表格数据表单（替换）— 原位替换 table 块，带块身份 + 页结构快照（同上）。 */}
      {tableForm && (
        <DeckTableFormDialog
          initialBlock={slide.content[tableForm.blockIndex]}
          onConfirm={(block: { type: 'table'; data: string }) => {
            if (!tableForm.expectEpoch || !deckCtl.verifySlideEpoch(tableForm.expectEpoch)) {
              onNotice?.(t('writing.deckFormTargetGone', '该页已被修改或移除，未能完成插入/替换，请重试'), 6000);
              setTableForm(null);
              return;
            }
            deckCtl.replaceDeckSlideBlock(index, tableForm.blockIndex, block, tableForm.expectBlock, tableForm.expectEpoch);
            setTableForm(null);
          }}
          onClose={() => setTableForm(null)}
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
  /** #1087: 丢弃/拒绝提示通道（路由 showNotice 横幅）— epoch 失配放弃插入、
   * #1089-1 唯一块拒绝删除等场景明示（非静默）。 */
  onNotice?: (text: string, ttlMs?: number) => void;
}) {
  const { t } = useTranslation();
  const { deckAsset, slides, body, deckCtl, sendChatText, onCardEdit, deckComments, onAddSlideComment, onCommentClick, onNotice } = input;
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
                            /* #1071-4: key 用稳定 id（新建 slide 生成,见 deck-asset
                                newSlideId）— 排序后卡片本地状态（备注展开/上传态）
                                不错挂到别的 slide；无 id 旧数据兜底下标。 */
                            key={slide.id ?? `idx-${i}`}
                            index={i}
                            slide={slide}
                            deckCtl={deckCtl}
                            total={deckAsset.slides.length}
                            slideComments={(deckComments ?? []).filter((c) => c.slideIndex === i + 1)}
                            onAddComment={onAddSlideComment}
                            onCommentClick={onCommentClick}
                            onNotice={onNotice}
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
