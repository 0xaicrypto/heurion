/**
 * Component vocabulary — the 8 primitives from
 * docs/design/nexus-ux-redesign.md §7.
 *
 * Kept in one file deliberately; the design says "small set of
 * primitives composes every screen" and that's easier to enforce
 * when they're all visible together.
 */

import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/util';

/* ───────────── Button (3 variants) ───────────── */

type ButtonVariant = 'primary' | 'subtle' | 'ghost';

export function Button({
  variant = 'subtle',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-sm font-medium ' +
    'transition-colors duration-80 ease-out-soft focus-visible:focus-ring ' +
    'disabled:opacity-50 disabled:pointer-events-none';
  const variants: Record<ButtonVariant, string> = {
    primary:
      'bg-accent text-white hover:bg-accent-hover active:bg-accent-press ' +
      'px-6 py-[13px] text-[15px]',
    subtle:
      'bg-transparent border border-border text-text-primary ' +
      'hover:bg-accent-subtle hover:border-border-strong ' +
      'px-[18px] py-[10px] text-[14px]',
    ghost:
      'bg-transparent text-text-secondary hover:text-text-primary ' +
      'hover:bg-accent-subtle px-[14px] py-[9px] text-[14px]',
  };
  return (
    <button className={cn(base, variants[variant], className)} {...rest}>
      {children}
    </button>
  );
}

/* ───────────── Card ───────────── */

export function Card({
  className,
  children,
  onClick,
  selected,
}: {
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
}) {
  const interactive = onClick !== undefined;
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-md border bg-surface p-4',
        interactive && 'cursor-pointer transition-colors duration-80',
        interactive && !selected && 'hover:border-border-strong',
        selected
          ? 'border-accent ring-1 ring-accent ring-inset'
          : 'border-border',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ───────────── Section ───────────── */

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-baseline justify-between border-b border-border pb-2">
        <h2 className="font-display text-section text-text-primary">{title}</h2>
        {action}
      </div>
      <div>{children}</div>
    </section>
  );
}

/* ───────────── Chip (neutral / tinted) ───────────── */

export function Chip({
  children,
  variant = 'neutral',
  mono,
  className,
}: {
  children: ReactNode;
  variant?: 'neutral' | 'tinted' | 'caution' | 'confirmed' | 'retract';
  mono?: boolean;
  className?: string;
}) {
  const variants = {
    neutral: 'border border-border text-text-secondary',
    tinted: 'bg-accent-subtle text-accent border border-transparent',
    caution: 'border border-caution/40 text-caution',
    confirmed: 'border border-confirmed/40 text-confirmed',
    retract: 'border border-retract/40 text-retract',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-2 py-0.5 text-caption',
        mono && 'font-mono',
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ───────────── Input ───────────── */

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-sm border border-border bg-surface px-3 py-2',
        'text-body text-text-primary placeholder:text-text-tertiary',
        'transition-colors duration-80 focus:border-accent focus:outline-none',
        'focus:ring-2 focus:ring-accent/30',
        className,
      )}
      {...rest}
    />
  );
}

/* ───────────── StatusDot ───────────── */

export function StatusDot({
  kind,
  className,
}: {
  kind: 'unread' | 'caution' | 'retract';
  className?: string;
}) {
  const colors = {
    unread: 'bg-accent',
    caution: 'bg-caution',
    retract: 'bg-retract',
  };
  return <span className={cn('inline-block h-2 w-2 rounded-full', colors[kind], className)} />;
}

/* ───────────── EmptyState ───────────── */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <h3 className="font-display text-section text-text-primary">{title}</h3>
      {description && (
        <p className="max-w-md text-body text-text-secondary">{description}</p>
      )}
      {action}
    </div>
  );
}

/* ───────────── CitationChip ───────────── */
/* Inline reference inside agent messages. Click opens context rail.   */

export function CitationChip({
  index,
  source,
  onClick,
}: {
  index: number;
  source: string;
  onClick?: () => void;
}) {
  return (
    <button
      title={source}
      onClick={onClick}
      className={cn(
        'inline-flex h-4 min-w-[16px] items-center justify-center rounded-[4px]',
        'border border-border bg-surface px-1 text-[10px] font-mono',
        'text-text-secondary align-super',
        'hover:border-accent hover:text-accent transition-colors duration-80',
      )}
    >
      {index}
    </button>
  );
}
