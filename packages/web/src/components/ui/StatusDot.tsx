import { cn } from '@/lib/utils';

export type StatusTone = 'active' | 'pending' | 'success' | 'error' | 'muted';

const TONE_CLASSES: Record<StatusTone, string> = {
  active: 'bg-accent',
  pending: 'bg-warning',
  success: 'bg-success',
  error: 'bg-error',
  muted: 'bg-clinical-low-conf',
};

/**
 * §11.4 (#221): StatusDot — the logo's "lit dot" as a design-language
 * primitive. At rest it is the brand dot; while `pulse` it breathes
 * (thinking / pending review / in-progress). Used for: streaming
 * indicator, pending memory, current-nav page, task activity.
 */
export function StatusDot({ tone = 'muted', pulse = false, className, title }: {
  tone?: StatusTone;
  pulse?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span
      role="status"
      aria-label={title}
      title={title}
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        TONE_CLASSES[tone],
        pulse && 'animate-pulse',
        className,
      )}
    />
  );
}
