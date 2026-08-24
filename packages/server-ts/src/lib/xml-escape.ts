/** XML/HTML escape — was duplicated (with different coverage) in the two
 *  chart renderers (#690). Full entity set: & < > ". */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
