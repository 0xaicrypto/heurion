/**
 * CopyButton — shared per-message / per-code-block copy affordance for
 * every chat surface (Today CrossPatientChat, Encounter, Research Chat,
 * Cross-Research) plus ChatMarkdown code blocks.
 *
 * Design contract:
 *   - The PARENT decides visibility (usually the
 *     `opacity-0 group-hover:opacity-100 focus-visible:opacity-100
 *     transition-opacity` reveal pattern) via `className`; this
 *     component only owns the per-tone button visuals.
 *   - `tone="base"` for light/dark themed surfaces (Encounter, Today);
 *     `tone="rw"` for the always-dark Research Workspace palette.
 *   - Clipboard: navigator.clipboard first; Tauri webview clipboard
 *     permissions vary across platforms, so we fall back to the
 *     hidden-textarea + document.execCommand('copy') trick.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

const TONE_CLASSES: Record<'base' | 'rw', string> = {
  base: 'text-text-tertiary hover:text-text-primary hover:bg-surface-elevated',
  rw:   'text-rw-t3 hover:text-rw-t1 hover:bg-rw-surface-2',
};

export function CopyButton({
  text,
  tone = 'base',
  className,
}: {
  text: string;
  tone?: 'base' | 'rw';
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Clear the pending "revert to Copy icon" timer on unmount so we
  // never setState on an unmounted component.
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const handleCopy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Tauri webview / older engines: clipboard API may be blocked.
      // Fall back to the legacy hidden-textarea trick.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (!ok) return;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const label = copied ? '已复制' : '复制';
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center
                  rounded transition-colors
                  ${copied ? 'text-confirmed' : TONE_CLASSES[tone]}
                  ${className ?? ''}`}
    >
      {copied
        ? <Check size={14} aria-hidden="true" />
        : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}
