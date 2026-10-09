/**
 * DOM and HTML security helpers for the web platform.
 */

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes unsafe HTML characters, including single and double quotes,
 * preventing cross-site scripting (XSS) in HTML bodies and attribute values.
 */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>'"]/g, c => ESC_MAP[c] || c)
}
