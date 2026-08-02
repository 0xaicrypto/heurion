import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(iso: string, locale?: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const isZh = (locale ?? '').toLowerCase().startsWith('zh');
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return isZh ? '刚刚' : 'just now';
  if (minutes < 60) return isZh ? `${minutes}分钟前` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return isZh ? `${hours}小时前` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return isZh ? `${days}天前` : `${days} d ago`;
}

/**
 * Recover block-level markdown structure when pasted/LLM content arrives as
 * one continuous line (line breaks lost on copy). Inserts breaks before
 * block markers: headings, list items, blockquotes and thematic breaks.
 * Fast path: already-multi-line content is left untouched.
 */
function recoverBlockBreaks(text: string): string {
  // Interior newline check: a single trailing newline must not disable recovery.
  if (text.slice(1, -1).includes('\n')) return text;
  // Insert '\n\n' before block markers. Uses capture groups instead of
  // lookbehind for broad browser compatibility.
  const breakBefore = (pre: string, marker: string): string =>
    pre === '' ? marker : `${pre}\n\n${marker}`;
  return text
    // headings: "text## 标题" → "text\n\n## 标题" (only at marker start)
    .replace(/(^|[^\n|#])(#{1,6} )/g, (_m, pre: string, marker: string) => breakBefore(pre, marker))
    // lists / blockquote: "**1. x**- 项" → break before "- 项"
    // (numbered "1. x" is excluded — collides with bold labels and decimals)
    .replace(/(^|[^\n|])((?:- |\* |> ))/g, (_m, pre: string, marker: string) => breakBefore(pre, marker))
    // thematic break: "text---## x" → "text\n\n---"
    .replace(/(^|[^\n|])(---(?![0-9A-Za-z_]))/g, (_m, pre: string, marker: string) => breakBefore(pre, marker));
}

/**
 * Normalize LLM output before markdown rendering. LLMs commonly emit
 * escape sequences as literal text (`\n`), omit blank lines between list
 * items (which CommonMark then collapses into one paragraph), pad output
 * with excess blank lines, or glue blocks onto a single line.
 */
export function normalizeLlmText(input: string): string {
  if (!input) return '';

  let text = input;
  // Literal escape sequences → real characters
  text = text.replace(/\\n/g, '\n');
  text = text.replace(/\\t/g, '\t');
  text = text.replace(/\\"/g, '"');
  text = text.replace(/\\'/g, "'");

  // Recover block markers glued onto a single line (paste / copy artifacts).
  text = recoverBlockBreaks(text);

  // Collapse 3+ consecutive blank lines to 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // Insert a blank line before a list item when the LLM omitted it, so
  // CommonMark recognizes the list. Consecutive list items stay together.
  const isListItem = (line: string) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = out[out.length - 1];
    if (i > 0 && isListItem(line) && prev !== '' && !isListItem(prev)) {
      out.push('');
    }
    out.push(line);
  }
  text = out.join('\n');

  return text.trim();
}
