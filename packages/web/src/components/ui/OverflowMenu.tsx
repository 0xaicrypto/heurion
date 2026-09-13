import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface OverflowMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** 场景条件隐藏(如 studyId 缺失时的 Methods/Results)。 */
  hidden?: boolean;
  /** 断点隐藏(如窄屏才显示的 viewMode 切换)。 */
  className?: string;
  danger?: boolean;
  title?: string;
}

/** #996/#1000: 「···」更多菜单 — 次要操作统一收口(设计稿桌面下拉/移动
 *  弹层双形态，此处统一为右对齐浮层，移动端同样可用)。外点/Esc 关闭。 */
export function OverflowMenu({
  items, ariaLabel, align = 'right', variant = 'ghost', className,
}: {
  items: OverflowMenuItem[];
  ariaLabel?: string;
  align?: 'left' | 'right';
  /** 触发器按钮样式。 */
  variant?: 'ghost' | 'secondary';
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visible = items.filter((i) => !i.hidden);
  if (visible.length === 0) return null;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-label={ariaLabel ?? t('common.more', '更多操作')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-8 items-center justify-center rounded-lg transition-colors',
          variant === 'secondary'
            ? 'w-9 border border-border bg-surface-elevated text-text-secondary hover:bg-surface'
            : 'w-8 px-2 text-text-secondary hover:bg-surface hover:text-text-primary',
        )}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute top-full z-40 mt-1 w-52 rounded-xl border border-border bg-surface-elevated p-1 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {visible.map((item, i) => (
            <button
              key={`${item.label}-${i}`}
              type="button"
              disabled={item.disabled}
              title={item.title}
              onClick={() => { setOpen(false); item.onClick(); }}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors disabled:opacity-40',
                item.danger ? 'text-error hover:bg-error/10' : 'text-text-primary hover:bg-surface',
                item.className,
              )}
            >
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
