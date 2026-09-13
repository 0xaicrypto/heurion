import { cn } from '@/lib/utils';

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

/** #996/#1000: 胶囊分段控件 — 三处手写实现(writing 工作台 tab / 编辑器
 *  文档|幻灯片 mini-tab / ChatPanel Chat|Charts)的共享收敛。语义
 *  role=tablist,激活态 = accent(延续现有品牌)。 */
export function SegmentedControl<T extends string>({
  items, value, onChange, ariaLabel, size = 'sm', className,
}: {
  items: Array<SegmentedItem<T>>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-elevated p-0.5', className)}
    >
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            'flex items-center gap-1.5 rounded-md transition-colors',
            size === 'xs' ? 'px-2 py-1 text-xs' : 'px-2.5 py-1 text-[13px]',
            value === it.value
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface hover:text-text-primary',
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}
