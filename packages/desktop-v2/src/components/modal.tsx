/**
 * Modal — the ONE dialog shell (UI_UX_REVIEW_2026-07 §5).
 *
 * Wraps @radix-ui/react-dialog (already a dependency — layout.tsx's
 * DeletePatientDialog uses it directly) so every modal gets, for free:
 *   - focus trap + focus restore on close
 *   - Esc to close
 *   - overlay click to close (Radix default)
 *   - aria-labelledby wiring via Dialog.Title
 *
 * Replaces the four hand-rolled `fixed inset-0` overlays in
 * research-workspace.tsx (DeleteStudyDialog / RecordObservationDialog /
 * NewStudyDialog / InviteModal), which had no focus management and
 * inconsistent Esc behaviour.
 *
 * `tone` picks the palette: 'rw' (research workspace, always dark)
 * or 'base' (themed surfaces). Layout is identical.
 */
import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../lib/util';

const TONE = {
  base: {
    panel: 'rounded-lg border border-border-strong bg-surface shadow-2xl',
    title: 'text-base font-semibold text-text-primary',
  },
  rw: {
    panel: 'rw-root rounded-lg border border-rw-border bg-rw-surface shadow-2xl font-rw-display',
    title: 'text-base font-semibold text-rw-t1',
  },
} as const;

export function Modal({
  open,
  onClose,
  title,
  headerExtra,
  tone = 'rw',
  width = 440,
  padded = true,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Optional slot to the right of the title (e.g. a mode toggle). */
  headerExtra?: ReactNode;
  tone?: 'base' | 'rw';
  /** Panel width in px (max-width is clamped to the viewport). */
  width?: number;
  /** Set false when the body manages its own padding / scroll areas. */
  padded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const c = TONE[tone];
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          onClick={(e) => e.stopPropagation()}
          style={{ width }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-w-[92vw] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[88vh] flex-col overflow-hidden focus:outline-none',
            c.panel,
            className,
          )}
        >
          <header
            className={cn(
              'flex shrink-0 items-center justify-between gap-3',
              padded ? 'px-5 pt-4 pb-1' : 'border-b px-5 pt-4 pb-3',
              !padded && (tone === 'rw' ? 'border-rw-border-soft' : 'border-border'),
            )}
          >
            <Dialog.Title asChild>
              <h2 className={c.title}>{title}</h2>
            </Dialog.Title>
            {headerExtra}
          </header>
          <div
            className={cn(
              'min-h-0 flex-1',
              padded ? 'overflow-y-auto px-5 pb-5 pt-2' : 'flex flex-col overflow-hidden',
            )}
          >
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
