import { marked } from 'marked';
import TurndownService from 'turndown';

/**
 * Doc conversion layer — the document body stays markdown (LLM-friendly),
 * while the editor works on HTML (TipTap/ProseMirror).
 *
 *   loading / LLM output : markdown → HTML  (marked)
 *   saving               : HTML → markdown (turndown)
 */

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});

// turndown has no built-in table support — render <table> as a GFM table.
function tableToMarkdown(table: HTMLElement): string {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll('th,td')) {
      cells.push(cell.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
  return [line(rows[0]), sep, ...rows.slice(1).map(line)].join('\n');
}

turndown.addRule('table', {
  filter: 'table',
  replacement: (_content: string, node: Node) => {
    const md = tableToMarkdown(node as HTMLElement);
    return md ? `\n\n${md}\n\n` : '';
  },
});

export function markdownToHtml(md: string): string {
  if (!md) return '';
  const html = marked.parse(md, { async: false }) as string;
  return html;
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown.turndown(html);
}
