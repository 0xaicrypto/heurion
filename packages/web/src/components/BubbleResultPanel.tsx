import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui';

/**
 * #778 — 润色气泡结果面板。
 *
 * 两个升级（用户反馈：此前只能整体接受/丢弃）：
 * 1. **结果可直接编辑** — done 态从只读 div 改为 textarea，预填 AI 结果，
 *    用户改完再「替换选中」，落文档的是用户手上的最终版
 * 2. **多轮继续修改** — 输入新要求 + 用户改过的当前版本一起发回 polish
 *    管线（selection=当前版本, instruction=新要求，服务端零改动），
 *    循环往复直到「替换选中」
 *
 * draft 状态面板内自持：每次新 run 完成（startedAt 变化）自动重置为最新流；
 * 多轮之间用户手改的内容经 onRefine(currentText) 带入下一轮。
 */
export interface BubbleRunLike {
  status: 'input' | 'running' | 'done' | 'error';
  /** 正文流（应用时替换选区的内容）。 */
  stream: string;
  /** 模型思维链（折叠展示，部分模型不返回）。 */
  reasoning: string;
  error: string | null;
  startedAt: number;
  /** #778: 多轮轮次（≥2 显示「第 N 轮」）。 */
  round?: number;
}

export interface BubbleResultPanelProps {
  run: BubbleRunLike;
  /** 应用 AI 结果到选区（finalText=用户编辑后的最终版）。 */
  onApply: (finalText: string) => void;
  /** running=取消断流；done=丢弃结果。 */
  onDiscard: () => void;
  /** 出错后原地重试同一动作。 */
  onRetry: () => void;
  /** #778: 多轮 — instruction=新要求，currentText=用户可能已修改的当前版本。 */
  onRefine: (instruction: string, currentText: string) => void;
}

export function BubbleResultPanel({ run, onApply, onDiscard, onRetry, onRefine }: BubbleResultPanelProps) {
  const { t } = useTranslation();
  /** 用户编辑中的结果（done 时从 stream 初始化，可自由修改）。 */
  const [draft, setDraft] = useState('');
  /** 继续修改的指令输入。 */
  const [refineText, setRefineText] = useState('');
  /** 已初始化 draft 的 run 标记（多轮时新 done 自动重置）。 */
  const draftInitRef = useRef(0);

  useEffect(() => {
    if (run.status === 'done' && draftInitRef.current !== run.startedAt) {
      draftInitRef.current = run.startedAt;
      setDraft(run.stream);
      setRefineText('');
    }
  }, [run.status, run.startedAt, run.stream]);

  const draftLen = draft.length || run.stream.length;
  const submitRefine = () => {
    const instruction = refineText.trim();
    if (!instruction) return;
    onRefine(instruction, draft || run.stream);
    setRefineText('');
  };

  return (
    <>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-text-tertiary">
        <span className="flex items-center gap-1">
          {run.status === 'running'
            ? <><Loader2 size={11} className="animate-spin" /> {t('writing.bubbleRunning', 'AI 生成中…')}</>
            : run.status === 'error'
              ? <span className="text-error">✗ {t('writing.bubbleFailed', '出错了')}</span>
              : <><Check size={11} className="text-success" /> {t('writing.bubbleDone', '已完成 {{n}} 字', { n: draftLen })}{run.round && run.round > 1 ? ` · ${t('writing.bubbleRound', '第 {{n}} 轮', { n: run.round })}` : ''}</>}
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
        /* #752-qa C4: 截断等错误时保留已生成的部分内容 — 用户可手动复制 */
        <div>
          <div className="rounded-md border border-error/40 bg-error/5 px-2 py-1.5 text-[11px] text-error" role="alert">{run.error}</div>
          {run.stream.trim() && (
            <div className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface px-2 py-1.5 text-[12px] leading-relaxed text-text-secondary">
              {run.stream}
              <div className="mt-1 text-[10px] text-text-tertiary">{t('writing.bubblePartialHint', '↑ 已生成的部分内容,可手动复制')}</div>
            </div>
          )}
        </div>
      ) : run.status === 'done' ? (
        /* #778: 结果可直接编辑 — 替换选中的是用户手上的最终版 */
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          className="block w-full max-h-40 min-h-[64px] overflow-y-auto resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] leading-relaxed text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface px-2 py-1.5 text-[12px] leading-relaxed text-text-primary">
          {run.stream || '…'}
        </div>
      )}
      {run.status === 'done' && (
        /* #778: 多轮继续修改 — 新要求 + 当前版本发回 polish 管线 */
        <div className="mt-1.5 flex items-end gap-1">
          <textarea
            value={refineText}
            onChange={(e) => setRefineText(e.target.value)}
            rows={1}
            placeholder={t('writing.bubbleRefinePlaceholder', '继续修改：告诉 AI 还要怎么改（基于当前版本）')}
            className="min-h-[28px] flex-1 resize-none rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitRefine();
              }
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!refineText.trim()}
            onClick={(e: ReactMouseEvent<HTMLButtonElement>) => { e.preventDefault(); submitRefine(); }}
          >
            {t('writing.bubbleContinue', '继续')}
          </Button>
        </div>
      )}
      <div className="mt-2 flex items-center justify-end gap-1">
        {run.status === 'running' && (
          /* #752-ux-cancel: 运行中可随时取消 — abort 断流，静默收起 */
          <Button size="sm" variant="ghost" onClick={(e: ReactMouseEvent<HTMLButtonElement>) => { e.preventDefault(); onDiscard(); }}>
            <X size={12} className="mr-1" /> {t('writing.bubbleCancel', '取消')}
          </Button>
        )}
        {run.status === 'error' && (
          <Button size="sm" variant="secondary" onClick={(e: ReactMouseEvent<HTMLButtonElement>) => { e.preventDefault(); onRetry(); }}>{t('writing.bubbleRetry', '重试')}</Button>
        )}
        {run.status === 'done' && (
          <>
            <Button size="sm" variant="ghost" onClick={(e: ReactMouseEvent<HTMLButtonElement>) => { e.preventDefault(); onDiscard(); }}>{t('writing.bubbleDiscard', '丢弃')}</Button>
            <Button
              size="sm"
              disabled={!draft.trim()}
              onClick={(e: ReactMouseEvent<HTMLButtonElement>) => { e.preventDefault(); onApply(draft || run.stream); }}
            >
              <Check size={12} className="mr-1" /> {t('writing.bubbleReplace', '替换选中')}
            </Button>
          </>
        )}
      </div>
    </>
  );
}
