import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BubbleMenu as TiptapBubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/react';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui';

/**
 * #792 — Selection Bubble 抽取:气泡工具条 + 全程内联运行态卡片此前
 * (~130 行) 内联在 DocEditor,连带 6 个 bubble 回调 props 与 ref 存值 +
 * force setState 的输入 hack。抽出后:
 *   - 自定义指令输入改为受控 useState(input 态每次 run 以 startedAt
 *     remount,不需要 ref 强刷);
 *   - DocEditor props 14 → 10(onBubbleAction + bubble 单对象);
 *   - 气泡文案走 i18n(此前 14 条硬编码)。
 */

export interface BubbleRunState {
  action: string;
  status: 'input' | 'running' | 'done' | 'error';
  /** 正文流(应用时替换选区的内容)。 */
  stream: string;
  /** 模型思维链(折叠展示,部分模型不返回)。 */
  reasoning: string;
  error: string | null;
  startedAt: number;
}

export interface SelectionBubbleProps {
  editor: Editor;
  /** 审阅模式 live 判定(父组件持 reviewKeyRef,闭包取实时值)。 */
  isReviewing: () => boolean;
  /** #752-ux: 气泡内联运行态 — 整个润色过程(思考/流式/错误)在气泡里。 */
  run: BubbleRunState | null;
  /** 动作按钮分发(polish|rewrite|academic|summarize|自定义 preset id)。 */
  onAction: (action: string, sel: { text: string; from: number; to: number }) => void;
  /** input 态:用户提交自定义指令 → 开始运行。 */
  onStart: (instruction: string) => void;
  /** 应用 AI 结果到选区(使用运行开始时记录的 from/to)。 */
  onApply: () => void;
  /** 运行中=取消(abort);完成态=丢弃结果。 */
  onDiscard: () => void;
  /** 出错后原地重试同一动作。 */
  onRetry: () => void;
}

const ACTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['polish', '✨', 'bubblePolish'],
  ['rewrite', '📝', 'bubbleRewrite'],
  ['academic', '🔬', 'bubbleAcademic'],
  ['summarize', '📄', 'bubbleSummarize'],
];

export function SelectionBubble({ editor, isReviewing, run, onAction, onStart, onApply, onDiscard, onRetry }: SelectionBubbleProps) {
  const { t } = useTranslation();
  const [instruction, setInstruction] = useState('');
  /** pointerdown/click 双通道去重:同一次按下只分发一次。 */
  const busyRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** #752-ux: 最新运行态 — shouldShow 闭包经 updateOptions 每轮刷新可读。 */
  const runRef = useRef(run);
  runRef.current = run;

  const fireAction = (id: string) => {
    if (busyRef.current === id) return;
    const sel = editor.state.selection;
    const text = editor.state.doc.textBetween(sel.from, sel.to, '\n').trim();
    busyRef.current = id;
    setBusy(id);
    try {
      onAction(id, { text, from: sel.from, to: sel.to });
    } finally {
      // 菜单即将随选区消费而隐藏;下一轮选中重置 busy。
      window.setTimeout(() => { busyRef.current = null; setBusy(null); }, 300);
    }
  };

  return (
    <TiptapBubbleMenu
      editor={editor}
      updateDelay={150}
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ state, from, to }: { state: { doc: { textBetween: (f: number, t: number, s: string) => string } }; from: number; to: number }) => {
        if (isReviewing()) return false;
        // #752-ux: 运行/完成卡片不被选区塌陷或点击空白打断
        if (runRef.current && runRef.current.status !== 'error') return true;
        if (runRef.current?.status === 'error') return true;
        const selText = state.doc.textBetween(from, to, '\n').trim();
        return selText.length > 10;
      }}
    >
      {run ? (
        /* #752-ux: 全过程内联气泡 — 思考过程(折叠)/流式正文/结果操作,
            不再弹出顶部面板。Apply 用运行开始时的 from/to。 */
        <div className="w-[min(420px,88vw)] rounded-lg border border-border bg-surface-elevated p-2.5 shadow-lg">
        {run.status === 'input' ? (
          /* #752-ux: ✨润色 = 气泡内自定义指令输入,支持任意 prompt。
              key=startedAt — 每次 run 进入 input 态重置输入框。 */
          <div>
            <textarea
              key={run.startedAt}
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={t('writing.bubblePlaceholder', '告诉 AI 怎么改(可留空直接润色),如:压缩到 200 字 / 强调安全性信号 / 改写成投稿信语气')}
              rows={3}
              className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onStart(instruction.trim());
                }
              }}
            />
            <div className="mt-1.5 flex items-center justify-between">
              <span className="text-[10px] text-text-tertiary">{t('writing.bubbleKeyHint', '⌘/Ctrl + Enter 开始')}</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); onDiscard(); }}>{t('writing.bubbleCancel', '取消')}</Button>
                <Button size="sm" onClick={(e) => { e.preventDefault(); onStart(instruction.trim()); }}>{t('writing.bubbleStart', '开始')}</Button>
              </div>
            </div>
          </div>
        ) : (
          <>
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-text-tertiary">
            <span className="flex items-center gap-1">
              {run.status === 'running'
                ? <><Loader2 size={11} className="animate-spin" /> {t('writing.bubbleRunning', 'AI 生成中…')}</>
                : run.status === 'error'
                  ? <span className="text-error">✗ {t('writing.bubbleFailed', '出错了')}</span>
                  : <><Check size={11} className="text-success" /> {t('writing.bubbleDone', '已完成 {{n}} 字', { n: run.stream.length })}</>}
            </span>
            <span className="tabular-nums">{Math.round((Date.now() - run.startedAt) / 100) / 10}s</span>
          </div>
          {run.reasoning && (
            <details className="mb-1.5 rounded-md bg-surface px-2 py-1">
              <summary className="cursor-pointer select-none text-[11px] text-text-tertiary">{t('writing.bubbleReasoning', '💭 思考过程')}</summary>
              <div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-text-secondary">{run.reasoning}</div>
            </details>
          )}
          {run.error ? (
            /* #752-qa C4: 截断等错误时保留已生成的部分内容 — 用户可
                手动复制,不再整体丢弃 */
            <div>
              <div className="rounded-md border border-error/40 bg-error/5 px-2 py-1.5 text-[11px] text-error" role="alert">{run.error}</div>
              {run.stream.trim() && (
                <div className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface px-2 py-1.5 text-[12px] leading-relaxed text-text-secondary">
                  {run.stream}
                  <div className="mt-1 text-[10px] text-text-tertiary">{t('writing.bubblePartialHint', '↑ 已生成的部分内容,可手动复制')}</div>
                </div>
              )}
            </div>
          ) : (
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface px-2 py-1.5 text-[12px] leading-relaxed text-text-primary">
              {run.stream || '…'}
            </div>
          )}
          <div className="mt-2 flex items-center justify-end gap-1">
            {run.status === 'running' && (
              /* #752-ux-cancel: 运行中可随时取消 — abort 断流,静默收起 */
              <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); onDiscard(); }}>
                <X size={12} className="mr-1" /> {t('writing.bubbleCancel', '取消')}
              </Button>
            )}
            {run.status === 'error' && (
              <Button size="sm" variant="secondary" onClick={(e) => { e.preventDefault(); onRetry(); }}>{t('writing.bubbleRetry', '重试')}</Button>
            )}
            {run.status === 'done' && (
              <>
                <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); onDiscard(); }}>{t('writing.bubbleDiscard', '丢弃')}</Button>
                <Button size="sm" onClick={(e) => { e.preventDefault(); onApply(); }}>
                  <Check size={12} className="mr-1" /> {t('writing.bubbleReplace', '替换选中')}
                </Button>
              </>
            )}
          </div>
          </>
          )}
        </div>
      ) : (
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-elevated px-1 py-0.5 shadow-lg">
        {ACTIONS.map(([id, icon, labelKey]) => (
          <button
            key={id}
            // #752-feedback: pointerdown 主通道 — 在任何 focus/可见性
            // 逻辑之前触发;click 兜底并按 action 去重防止双发。
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              fireAction(id);
            }}
            onClick={(e) => e.stopPropagation()}
            disabled={busy === id}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-60"
            title={t(`writing.${labelKey}`)}
          >
            <span aria-hidden>{busy === id ? '⏳' : icon}</span>{t(`writing.${labelKey}`)}
          </button>
        ))}
      </div>
      )}
    </TiptapBubbleMenu>
  );
}
