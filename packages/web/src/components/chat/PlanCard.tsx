import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle, XCircle, MinusCircle, ListChecks } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskPlan, TaskPlanStepStatus } from '@heurion/contracts';

/**
 * #976 — 任务清单进度卡片（agent todo-list 用户面）。
 * 数据源：session.lastPlan（SSE plan_updated 实时更新）。
 * 用户据此分辨「真完成」与「声称完成」：写回步骤由系统自动勾选（source:
 * system），模型无法手动声明写回步骤完成（闸门 3）。
 */
const STATUS_ICON: Record<TaskPlanStepStatus, React.ReactNode> = {
  done: <CheckCircle2 size={14} className="shrink-0 text-success" />,
  pending: <Circle size={14} className="shrink-0 text-text-tertiary" />,
  failed: <XCircle size={14} className="shrink-0 text-error" />,
  skipped: <MinusCircle size={14} className="shrink-0 text-text-tertiary" />,
};

export function PlanCard({ plan, compact }: { plan: TaskPlan; compact?: boolean }) {
  void compact;
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const total = plan.steps.length;
  const backlog = plan.steps.filter((s) => s.status === 'pending' || s.status === 'failed').length;
  const failedCount = plan.steps.filter((s) => s.status === 'failed').length;

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-accent/30 bg-accent/5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-text-primary transition-colors hover:bg-surface"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ListChecks size={14} className="shrink-0 text-accent" />
          <span className="truncate">{plan.title}</span>
          <span className="shrink-0 text-text-secondary">
            {done}/{total}
          </span>
          {failedCount > 0 && (
            <span className="shrink-0 text-error">· {t('chat.planFailedCount', '{{n}} 步失败', { n: failedCount })}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-accent/20 px-3 py-2 text-xs text-text-secondary">
          <ul className="space-y-1">
            {plan.steps.map((s) => (
              <li key={s.index} className={cn('flex items-start gap-1.5', s.status === 'skipped' && 'opacity-50', s.status === 'done' && 'opacity-75')}>
                <span className="mt-[2px]">{STATUS_ICON[s.status]}</span>
                <span className={cn('min-w-0', s.status === 'done' && 'line-through decoration-text-tertiary')}>
                  {s.index}. {s.title}
                  {s.status === 'failed' && (
                    <span className="text-error"> — {t('chat.planStepFailed', '失败')}{s.failure_note ? `：${s.failure_note}` : ''}{(s.retry_count || 0) > 0 && s.status === 'failed' ? `（${t('chat.planRetryCount', '已重试 {{n}} 次', { n: s.retry_count })}）` : ''}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {plan.status === 'active' && backlog > 0 && (
            <div className="mt-1.5 rounded bg-surface px-2 py-1 text-[11px] text-text-secondary">
              {t('chat.planContinueHint', '回复「继续」让 AI 从未完成步骤接着执行')}
            </div>
          )}
          {plan.status === 'completed' && (
            <div className="mt-1.5 rounded bg-surface px-2 py-1 text-[11px] text-accent">
              {t('chat.planCompleted', '任务清单已全部完成')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
