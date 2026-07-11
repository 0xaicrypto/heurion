/**
 * ChatComposer — the ONE composer shared by every chat surface
 * (Today CrossPatientChat, Encounter, Research ChatTab,
 * CrossResearchChat).
 *
 * UI_UX_REVIEW_2026-07 §3: before this, each surface hand-rolled its
 * own input (single-line <Input> on Today, fixed 2-row textarea in
 * Encounter, single-line transparent <input> in the two research
 * chats) with three different send buttons. Now:
 *
 *   - multiline auto-growing textarea (1–6 rows)
 *   - Enter = send, Shift+Enter = newline
 *   - optional attachment button (lucide Paperclip) when the surface
 *     passes `onPickFiles`; paste / drop handlers are passed in so
 *     each surface keeps its own upload pipeline
 *   - consistent send button (lucide SendHorizontal + i18n label)
 *   - `tone` switches base vs research-workspace palette; the LAYOUT
 *     is identical in both.
 *
 * Draft persistence stays with the caller (store drafts/setDraft) —
 * this component is controlled (`value` / `onChange`).
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Paperclip, SendHorizontal } from 'lucide-react';
import { useT } from '../lib/i18n';
import { cn } from '../lib/util';
import { InlineChatError, type ChatTone } from './chat-message';

const TONE = {
  base: {
    frame:   'rounded-lg border border-border bg-bg px-3 py-2 ' +
             'focus-within:border-border-strong',
    textarea:'bg-transparent text-body text-text-primary placeholder:text-text-tertiary',
    attach:  'text-text-tertiary hover:text-accent',
    send:    'bg-accent text-white hover:bg-accent-hover active:bg-accent-press',
  },
  rw: {
    frame:   'rounded-lg border border-rw-border bg-rw-surface px-3 py-2 ' +
             'focus-within:border-rw-accent-bd',
    textarea:'bg-transparent text-sm text-rw-t1 placeholder:text-rw-t4',
    attach:  'text-rw-t3 hover:text-rw-accent',
    send:    'bg-rw-accent text-[#06252c] hover:bg-rw-accent-2',
  },
} as const;

// 1–6 rows. Matches the textarea's leading (text-sm/text-body ≈ 20px
// line height) + vertical padding baked into the element itself.
const LINE_PX = 20;
const MAX_ROWS = 6;

export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled,
  sendDisabled,
  tone = 'base',
  placeholder,
  onPaste,
  onDrop,
  onPickFiles,
  error,
  onDismissError,
  above,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  /** Streaming / busy — locks the textarea and shows "…" on the send
   *  button. */
  disabled?: boolean;
  /** Extra send gating (e.g. empty input + no attachments). */
  sendDisabled?: boolean;
  tone?: ChatTone;
  placeholder?: string;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** When provided, renders the Paperclip attach button + hidden
   *  file input; the surface owns the actual upload logic. */
  onPickFiles?: (files: FileList) => void;
  /** Inline alert row above the composer — the single error style
   *  for all chat surfaces. */
  error?: string | null;
  onDismissError?: () => void;
  /** Slot above the input frame (file-library chip strips, pending
   *  attachment chips, focus banners…). */
  above?: ReactNode;
}) {
  const t = useT();
  const c = TONE[tone];
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: reset to a single row, then take scrollHeight clamped
  // to MAX_ROWS. useLayoutEffect avoids a visible 1-frame jump.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = LINE_PX * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDrop ? (e) => e.preventDefault() : undefined}
    >
      {above}
      <InlineChatError error={error} tone={tone} onDismiss={onDismissError} />
      <div className={cn('flex items-end gap-2', c.frame)}>
        {onPickFiles && (
          <label
            className={cn('cursor-pointer self-end pb-0.5 leading-none', c.attach)}
            title={t('chat.attachTitle')}
          >
            <Paperclip size={16} aria-hidden="true" />
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onPickFiles(e.target.files);
                }
                // Reset so picking the same file twice re-fires onChange.
                e.target.value = '';
              }}
            />
          </label>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          onPaste={onPaste}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'flex-1 resize-none outline-none leading-5',
            'disabled:opacity-60',
            c.textarea,
          )}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || sendDisabled}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1',
            'text-xs font-medium transition-colors disabled:opacity-60',
            'disabled:pointer-events-none',
            c.send,
          )}
        >
          {disabled
            ? '…'
            : (
              <>
                <SendHorizontal size={13} aria-hidden="true" />
                {t('chat.send')}
              </>
            )}
        </button>
      </div>
    </div>
  );
}
