import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui';

/**
 * §11.5 (#221) step 5: guided empty states — never a blank panel.
 * Every list/collection page uses this instead of ad-hoc empty text.
 */
export function EmptyState({ title, hint, icon, action }: {
  title?: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-lg bg-accent/10 text-accent">
        {icon ?? <Inbox size={24} />}
      </div>
      <p className="text-sm font-medium text-text-primary">{title ?? t('common.empty', '暂无数据')}</p>
      {hint && <p className="max-w-sm text-xs text-text-tertiary">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * §11.5 (#221) step 5: unified error state — icon + message + retry.
 */
export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-lg bg-error/10 text-error">
        <AlertTriangle size={24} />
      </div>
      <p className="text-sm font-medium text-text-primary">{message ?? t('common.error', '加载失败')}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry} className="mt-2">
          <RefreshCw size={14} className="mr-1.5" />
          {t('common.retry', '重试')}
        </Button>
      )}
    </div>
  );
}
