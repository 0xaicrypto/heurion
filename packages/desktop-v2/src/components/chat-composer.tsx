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
 * F-skills — Kimi-style "/" skills menu. When the surface passes
 * `onSkillsChange`, typing '/' as the FIRST character of an empty
 * composer (or clicking the ⚡ button next to the attach button)
 * opens a popover listing the enabled skills from the zustand cache.
 * Text typed after the '/' filters the list; ↑/↓ move the cursor,
 * Enter selects, Esc closes. Selecting a skill adds a removable chip
 * above the input and clears the '/' text; the surface receives the
 * chosen skill names via `onSkillsChange` and forwards them on its
 * next sendChat call. The final menu row opens the skills manager.
 *
 * Draft persistence stays with the caller (store drafts/setDraft) —
 * this component is controlled (`value` / `onChange`).
 */
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { Paperclip, SendHorizontal, Settings2, X, Zap } from 'lucide-react';
import { useAppState } from '../store';
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
    menu:    'rounded-lg border border-border-strong bg-surface shadow-xl',
    menuRow: 'text-text-primary',
    menuRowActive: 'bg-accent-subtle',
    menuDesc:'text-text-tertiary',
    menuEmpty:'text-text-tertiary',
    menuDivider: 'border-border',
    chip:    'border-accent/40 bg-accent-subtle text-accent',
  },
  rw: {
    frame:   'rounded-lg border border-rw-border bg-rw-surface px-3 py-2 ' +
             'focus-within:border-rw-accent-bd',
    textarea:'bg-transparent text-sm text-rw-t1 placeholder:text-rw-t4',
    attach:  'text-rw-t3 hover:text-rw-accent',
    send:    'bg-rw-accent text-[#06252c] hover:bg-rw-accent-2',
    menu:    'rounded-lg border border-rw-border bg-rw-surface shadow-xl',
    menuRow: 'text-rw-t1',
    menuRowActive: 'bg-rw-accent-bg',
    menuDesc:'text-rw-t4',
    menuEmpty:'text-rw-t4',
    menuDivider: 'border-rw-border-soft',
    chip:    'border-rw-accent-bd bg-rw-accent-bg text-rw-accent',
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
  selectedSkills,
  onSkillsChange,
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
  /** F-skills — the skill names to apply on the NEXT send. Rendered
   *  as removable chips above the input. Controlled by the surface
   *  (which forwards them into its sendChat call). */
  selectedSkills?: string[];
  /** F-skills — enables the "/" menu + ⚡ button. Fired when the medic
   *  picks or removes a skill. */
  onSkillsChange?: (names: string[]) => void;
}) {
  const t = useT();
  const c = TONE[tone];
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // ── F-skills — "/" menu state ────────────────────────────────────
  const skillsEnabled = !!onSkillsChange;
  const skills            = useAppState((s) => s.skills);
  const skillsLoaded      = useAppState((s) => s.skillsLoaded);
  const refreshSkills     = useAppState((s) => s.refreshSkills);
  const openSkillsManager = useAppState((s) => s.openSkillsManager);
  const [menuOpen, setMenuOpen]   = useState(false);
  const [menuCursor, setMenuCursor] = useState(0);
  // Slash-opened menus close when the '/' prefix is deleted;
  // button-opened menus only close on Esc / select / click-outside.
  const [openedByButton, setOpenedByButton] = useState(false);

  const picked = selectedSkills ?? [];

  // Filter-as-you-type: everything after the leading '/'.
  const filter = menuOpen && value.startsWith('/')
    ? value.slice(1).trim().toLowerCase()
    : '';

  const menuSkills = useMemo(() => {
    const usable = skills.filter((s) => s.enabled && s.invocable);
    if (!filter) return usable;
    return usable.filter((s) =>
      (s.name + ' ' + s.description).toLowerCase().includes(filter),
    );
  }, [skills, filter]);

  // Rows = the filtered skills + the trailing "manage…" row.
  const menuRowCount = menuSkills.length + 1;

  // Lazy hydrate: the post-login fetch normally fills the cache, but
  // if the menu opens first (or the fetch failed) retry here.
  useEffect(() => {
    if (menuOpen && !skillsLoaded) void refreshSkills();
  }, [menuOpen, skillsLoaded, refreshSkills]);

  // Click-outside closes the menu (Radix isn't used here — the menu
  // must live in the composer's layout flow so it anchors correctly
  // in all four surfaces).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
    setOpenedByButton(false);
  }

  function pickSkill(name: string) {
    if (!onSkillsChange) return;
    if (!picked.includes(name)) onSkillsChange([...picked, name]);
    // Selecting swallows the '/'-filter text.
    if (value.startsWith('/')) onChange('');
    closeMenu();
    taRef.current?.focus();
  }

  function removeSkill(name: string) {
    onSkillsChange?.(picked.filter((n) => n !== name));
  }

  function runMenuRow(index: number) {
    if (index < menuSkills.length) {
      pickSkill(menuSkills[index].name);
    } else {
      // Final row — 管理技能与插件…
      if (value.startsWith('/')) onChange('');
      closeMenu();
      openSkillsManager();
    }
  }

  function handleChange(text: string) {
    if (skillsEnabled) {
      if (!menuOpen && value === '' && text === '/') {
        // '/' typed as the first char of an empty composer.
        setMenuOpen(true);
        setOpenedByButton(false);
        setMenuCursor(0);
      } else if (menuOpen && !openedByButton && !text.startsWith('/')) {
        // '/' prefix deleted → dismiss the slash-opened menu.
        setMenuOpen(false);
      } else if (menuOpen) {
        // Filter changed — snap the cursor back to the top match.
        setMenuCursor(0);
      }
    }
    onChange(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuCursor((i) => Math.min(i + 1, menuRowCount - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuCursor((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runMenuRow(Math.min(menuCursor, menuRowCount - 1));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

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
      ref={rootRef}
      onDrop={onDrop}
      onDragOver={onDrop ? (e) => e.preventDefault() : undefined}
    >
      {above}
      {/* F-skills — chips for the skills applied to the next turn. */}
      {skillsEnabled && picked.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {picked.map((name) => (
            <span
              key={name}
              className={cn(
                'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-caption',
                c.chip,
              )}
            >
              <Zap size={11} aria-hidden="true" />
              {name}
              <button
                type="button"
                onClick={() => removeSkill(name)}
                aria-label={t('skills.chip.remove', { name })}
                className="ml-0.5 opacity-70 hover:opacity-100"
              >
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <InlineChatError error={error} tone={tone} onDismiss={onDismissError} />
      <div className="relative">
        {/* F-skills — the "/" popover. Anchored above the input frame. */}
        {skillsEnabled && menuOpen && (
          <div
            role="listbox"
            aria-label={t('skills.menu.heading')}
            className={cn(
              'absolute bottom-full left-0 z-30 mb-2 w-full max-w-sm',
              'overflow-hidden py-1',
              c.menu,
            )}
          >
            <div className={cn('px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wider', c.menuDesc)}>
              {t('skills.menu.heading')}
            </div>
            <div className="max-h-56 overflow-y-auto">
              {menuSkills.length === 0 && (
                <div className={cn('px-3 py-3 text-caption', c.menuEmpty)}>
                  {!skillsLoaded
                    ? t('skills.menu.loading')
                    : skills.some((s) => s.enabled && s.invocable)
                    ? t('skills.menu.empty')
                    : t('skills.menu.none')}
                </div>
              )}
              {menuSkills.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  role="option"
                  aria-selected={i === menuCursor}
                  onMouseEnter={() => setMenuCursor(i)}
                  // mousedown (not click) so the textarea keeps focus.
                  onMouseDown={(e) => { e.preventDefault(); runMenuRow(i); }}
                  className={cn(
                    'flex w-full items-baseline gap-2 px-3 py-1.5 text-left',
                    c.menuRow,
                    i === menuCursor && c.menuRowActive,
                  )}
                >
                  <span className="shrink-0 text-caption font-medium">/{s.name}</span>
                  <span className={cn('min-w-0 flex-1 truncate text-caption', c.menuDesc)}>
                    {s.description}
                  </span>
                </button>
              ))}
            </div>
            <div className={cn('mt-1 border-t pt-1', c.menuDivider)}>
              <button
                type="button"
                role="option"
                aria-selected={menuCursor === menuSkills.length}
                onMouseEnter={() => setMenuCursor(menuSkills.length)}
                onMouseDown={(e) => { e.preventDefault(); runMenuRow(menuSkills.length); }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption',
                  c.menuRow,
                  menuCursor === menuSkills.length && c.menuRowActive,
                )}
              >
                <Settings2 size={13} aria-hidden="true" />
                {t('skills.menu.manage')}
              </button>
            </div>
          </div>
        )}
        <div className={cn('flex items-end gap-2', c.frame)}>
          {skillsEnabled && (
            <button
              type="button"
              title={t('skills.composer.buttonTitle')}
              aria-label={t('skills.composer.buttonTitle')}
              onClick={() => {
                if (menuOpen) {
                  closeMenu();
                } else {
                  setMenuOpen(true);
                  setOpenedByButton(true);
                  setMenuCursor(0);
                  taRef.current?.focus();
                }
              }}
              className={cn('self-end pb-0.5 leading-none', c.attach)}
            >
              <Zap size={16} aria-hidden="true" />
            </button>
          )}
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
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
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
    </div>
  );
}
