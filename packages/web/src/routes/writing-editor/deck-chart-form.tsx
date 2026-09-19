import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { chartBlockSchema, type ChartBlock } from '@heurion/contracts';
import { Button } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';

/**
 * #1044: deck 图表结构化表单 — 选图表类型 + 填数据行，产出经 chartBlockSchema
 * 校验的 spec（与 AI edit_deck insert_chart 走同一契约形状，edit-deck-tool.ts）。
 * 临床安全约束（#176/#960）：图表只能是结构化数据驱动的确定性渲染，
 * 绝不引入生成式图片 — 人工路径不绕开这条设计。校验失败 → 表单内错误提示，
 * 不回调 onConfirm、不入 content。
 */
export interface DeckChartFormResult {
  type: 'chart';
  spec: ChartBlock['spec'];
  caption?: string;
}

const CHART_TYPES: Array<ChartBlock['spec']['chart_type']> = ['line', 'bar', 'dose_curve'];

export function DeckChartFormDialog(input: {
  /** 替换模式：预填原块（spec 字段回填，caption 回填）。 */
  initialBlock?: { spec?: unknown; caption?: string };
  onConfirm: (block: DeckChartFormResult) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { initialBlock, onConfirm, onClose } = input;
  const initSpec = (typeof initialBlock?.spec === 'object' && initialBlock?.spec !== null ? initialBlock.spec : {}) as {
    chart_type?: unknown;
    data?: unknown;
    title?: unknown;
  };
  const initRows = Array.isArray(initSpec.data)
    ? (initSpec.data as Array<{ label?: unknown; value?: unknown }>)
        .slice(0, 200)
        .map((d) => ({ label: typeof d?.label === 'string' ? d.label : '', value: typeof d?.value === 'number' ? String(d.value) : '' }))
    : [];
  const isReplace = initialBlock !== undefined;
  const [chartType, setChartType] = useState<string>(
    CHART_TYPES.includes(initSpec.chart_type as ChartBlock['spec']['chart_type']) ? (initSpec.chart_type as string) : 'bar',
  );
  const [rows, setRows] = useState<Array<{ label: string; value: string }>>(
    initRows.length > 0 ? initRows : [{ label: '', value: '' }, { label: '', value: '' }],
  );
  const [title, setTitle] = useState(typeof initSpec.title === 'string' ? initSpec.title : '');
  const [caption, setCaption] = useState(typeof initialBlock?.caption === 'string' ? initialBlock.caption : '');
  const [error, setError] = useState<string | null>(null);

  const updateRow = (i: number, next: Partial<{ label: string; value: string }>) =>
    setRows((prev) => prev.map((r, ri) => (ri === i ? { ...r, ...next } : r)));

  const submit = () => {
    // 全空行丢弃；填了 label/value 之一的行参与校验 — value 空/非数字时
    // 交给 chartBlockSchema 报错（表单内提示，不入 content）。
    // #1063: Number() 可产出 ±Infinity（'Infinity'/'-Infinity'/'1e999' 溢出等），
    // 而 zod z.number 只拒 NaN 不拒 Infinity，Infinity 会产出非法 SVG 坐标 —
    // 非有限数归一为 NaN 走既有 zod 失败路径（表单内报错，不入 content）。
    const data = rows
      .filter((r) => r.label.trim() !== '' || r.value.trim() !== '')
      .map((r) => {
        const n = r.value.trim() === '' ? NaN : Number(r.value);
        return { label: r.label.trim().slice(0, 200), value: Number.isFinite(n) ? n : NaN };
      });
    const spec = { chart_type: chartType, data, ...(title.trim() ? { title: title.trim().slice(0, 500) } : {}) };
    const check = chartBlockSchema.safeParse({ type: 'chart', spec });
    if (!check.success) {
      setError(check.error.issues.map((i) => i.message).join('；').slice(0, 200));
      return;
    }
    onConfirm({ type: 'chart', spec: check.data.spec, ...(caption.trim() ? { caption: caption.trim().slice(0, 500) } : {}) });
  };

  return (
    <Modal open onClose={onClose} backdropClose escClose backdropClassName="bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface-elevated shadow-xl p-6 m-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">
            {isReplace ? t('writing.deckChartFormReplaceTitle', '替换图表') : t('writing.deckChartFormTitle', '插入图表')}
          </h2>
          <button onClick={onClose} aria-label={t('writing.deckChartFormClose', '关闭')} className="text-text-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-text-secondary">{t('writing.deckChartFormType', '图表类型')}</label>
            <select
              value={chartType}
              onChange={(e) => setChartType(e.target.value)}
              aria-label={t('writing.deckChartFormType', '图表类型')}
              className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {CHART_TYPES.map((ct) => (
                <option key={ct} value={ct}>
                  {ct === 'line' ? t('writing.deckChartTypeLine', '折线图') : ct === 'bar' ? t('writing.deckChartTypeBar', '柱状图') : t('writing.deckChartTypeDoseCurve', '剂量曲线')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-text-secondary">{t('writing.deckChartFormData', '数据（标签 + 数值）')}</label>
            <div className="space-y-1.5">
              {rows.map((row, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    value={row.label}
                    onChange={(e) => updateRow(i, { label: e.target.value })}
                    aria-label={`${t('writing.deckChartFormDataLabel', '数据标签')} ${i + 1}`}
                    placeholder={t('writing.deckChartFormDataLabel', '数据标签')}
                    className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <input
                    value={row.value}
                    onChange={(e) => updateRow(i, { value: e.target.value })}
                    aria-label={`${t('writing.deckChartFormDataValue', '数据值')} ${i + 1}`}
                    placeholder={t('writing.deckChartFormDataValue', '数值')}
                    inputMode="decimal"
                    className="w-24 shrink-0 rounded border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, { label: '', value: '' }])}
              className="mt-1.5 rounded px-1.5 py-0.5 text-xs text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
            >
              + {t('writing.deckChartFormAddRow', '添加一行')}
            </button>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-text-secondary">{t('writing.deckChartFormTitleField', '图表标题（可选）')}</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label={t('writing.deckChartFormTitleField', '图表标题（可选）')}
              className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text-primary outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-text-secondary">{t('writing.deckChartFormCaption', '图注（可选）')}</label>
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              aria-label={t('writing.deckChartFormCaption', '图注（可选）')}
              className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text-primary outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          {/* #1044: 校验失败提示（chartBlockSchema.safeParse 不通过）— 表单内展示，不入 content。 */}
          {error && (
            <p role="alert" className="rounded border border-error/40 bg-error/10 px-2 py-1 text-xs text-error">
              {t('writing.deckChartFormInvalid', '数据未通过校验')}：{error}
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('writing.deckChartFormCancel', '取消')}
          </Button>
          <Button size="sm" onClick={submit}>
            {isReplace ? t('writing.deckChartFormConfirmReplace', '确认替换') : t('writing.deckChartFormConfirm', '确认插入')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
