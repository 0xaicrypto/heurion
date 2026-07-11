/**
 * MessageRow — the ONE chat-message layout shared by every chat surface
 * (Today CrossPatientChat, Encounter, Research ChatTab, CrossResearchChat).
 *
 * UI_UX_REVIEW_2026-07 §3: before this, the four surfaces used three
 * different paradigms (role-label rows, left/right bubbles, a bare
 * answer card). Now they all render the same header row
 * (role label + optional timestamp + hover CopyButton) above the
 * markdown body; only the COLORS change with `tone` ('base' for the
 * light/dark themed surfaces, 'rw' for the always-dark Research
 * Workspace palette).
 *
 * Visual contract:
 *   - user turns get a subtle tinted bubble; agent turns render plain.
 *   - `headerExtra` slots inline after the timestamp (Encounter's tier
 *     indicator lives there).
 *   - `preContent` renders between the header and the body (Encounter's
 *     ReasoningPane).
 *   - `children` render below the body — citations, web-source cards,
 *     schedule proposals, attachment chips… whatever the surface needs.
 *   - streaming: inline cursor while text is arriving + the shared
 *     StreamingFooter under agent turns.
 */
import type { ReactNode } from 'react';
import { ChatMarkdown, type FileChipRef } from './chat-markdown';
import { CopyButton } from './copy-button';
import { StreamingFooter, StreamingCursor } from './thinking-indicator';
import { useT } from '../lib/i18n';
import { cn } from '../lib/util';

export type ChatTone = 'base' | 'rw';

const TONE = {
  base: {
    role:   'text-caption font-medium text-text-primary',
    ts:     'text-caption text-text-tertiary',
    body:   'text-body leading-relaxed text-text-primary',
    bubble: 'rounded-md border border-border bg-accent-subtle/50 px-3 py-2',
  },
  rw: {
    role:   'text-[12px] font-medium text-rw-t1',
    ts:     'text-[11px] text-rw-t3',
    body:   'text-sm leading-relaxed text-rw-t1',
    bubble: 'rounded-md border border-rw-accent-bd bg-rw-accent-bg px-3 py-2',
  },
} as const;

export function MessageRow({
  role,
  text,
  ts,
  tone = 'base',
  streaming,
  fileMap,
  children,
  copyText,
  headerExtra,
  preContent,
  footerLabel,
}: {
  role: 'user' | 'agent';
  text: string;
  ts?: string;
  tone?: ChatTone;
  streaming?: boolean;
  fileMap?: Record<string, FileChipRef>;
  /** Extras rendered under the body — citations, web cards, proposal
   *  cards, attachment chips. */
  children?: ReactNode;
  /** Raw text for the hover copy button. Defaults to `text`; pass ''
   *  / undefined-able override when copying should be disabled. */
  copyText?: string;
  /** Inline slot after the timestamp (e.g. Encounter tier indicator). */
  headerExtra?: ReactNode;
  /** Slot between header and body (e.g. Encounter ReasoningPane). */
  preContent?: ReactNode;
  /** Custom StreamingFooter label while no text has arrived yet. */
  footerLabel?: string;
}) {
  const t = useT();
  const c = TONE[tone];
  const copy = copyText ?? text;

  return (
    <div className="group relative">
      <div className="mb-1 flex items-baseline gap-2">
        <span className={c.role}>
          {role === 'user' ? t('encounter.label.you') : t('encounter.label.nexus')}
        </span>
        {ts && <span className={c.ts}>{ts}</span>}
        {headerExtra}
        {/* Per-message copy — raw markdown, right end of the header
            row, hover-revealed. Hidden while streaming. */}
        {copy && !streaming && (
          <CopyButton
            text={copy}
            tone={tone}
            className="ml-auto self-center opacity-0 group-hover:opacity-100
                       focus-visible:opacity-100 transition-opacity"
          />
        )}
      </div>
      {preContent}
      <div className={cn(c.body, role === 'user' && c.bubble)}>
        {text && <ChatMarkdown text={text} fileMap={fileMap} />}
        {streaming && text && <StreamingCursor tone={tone} />}
      </div>
      {role === 'agent' && (
        <StreamingFooter
          streaming={streaming}
          hasText={!!(text && text.length > 0)}
          tone={tone}
          label={text ? undefined : footerLabel}
        />
      )}
      {children}
    </div>
  );
}

/**
 * InlineChatError — the ONE error affordance for chat surfaces.
 * Renders as a small alert row directly above the composer instead of
 * the previous three styles (red caption text / "[error: …]" spliced
 * into message text / "(出错：…)" inside a bubble).
 */
export function InlineChatError({
  error,
  tone = 'base',
  onDismiss,
}: {
  error: string | null | undefined;
  tone?: ChatTone;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  const cls = tone === 'rw'
    ? 'border-rw-red bg-rw-red-bg text-rw-red'
    : 'border-retract/40 bg-retract/10 text-retract';
  return (
    <div
      role="alert"
      className={cn(
        'mb-2 flex items-start gap-2 rounded-md border px-3 py-1.5 text-[12px] leading-relaxed',
        cls,
      )}
    >
      <span aria-hidden className="mt-px">⚠</span>
      <span className="min-w-0 flex-1 break-words">{error}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="dismiss"
          className="shrink-0 opacity-60 hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
}
