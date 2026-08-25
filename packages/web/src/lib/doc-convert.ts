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

// ── 数学公式($...$ / $$...$$ ↔ TipTap Mathematics 节点) ──
// #fix: 学术论文渲染 — 服务端公式 OCR 产出 $$...$$ LaTeX,加载时转为
// Mathematics 节点(KaTeX 渲染成数学符号),保存时还原为 markdown。

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 把 markdown 中的 $...$ / $$...$$ 预处理为 Mathematics 节点 HTML。 */
function mathToHtml(md: string): string {
  if (!md || !md.includes('$')) return md;
  let out = md;
  // 保护转义 \$ (字面美元符)。
  out = out.replace(/\\\$/g, '\u0000');
  // 块公式 $$...$$(跨行,非贪婪)。节点内带 LaTeX 文本子内容 —
  // turndown 会把空 div 判定为 blank 而跳过规则,必须有内容才能回写。
  out = out.replace(/\$\$([\s\S]*?)\$\$/g, (_m, latex: string) => {
    const tex = latex.trim();
    const safe = escapeHtmlAttr(tex);
    return `\n\n<div data-type="block-math" data-latex="${safe}">${safe}</div>\n\n`;
  });
  // 行内公式 $...$ — 首尾非 $ 非空白,内部无空格(避免误吞含空格文本)。
  out = out.replace(/(^|[^$\w])\$([^$\s]+)\$(?![$\w])/g, (_m, pre: string, latex: string) => {
    const safe = escapeHtmlAttr(latex);
    return `${pre}<span data-type="inline-math" data-latex="${safe}">${safe}</span>`;
  });
  // 恢复转义美元符。
  return out.replace(/\u0000/g, '$');
}

/** 数学节点 → markdown(保存回写)。 */
turndown.addRule('blockMath', {
  filter: (node: HTMLElement) => node.getAttribute?.('data-type') === 'block-math',
  replacement: (_content: string, node: Node) => {
    const latex = (node as HTMLElement).getAttribute('data-latex') || '';
    return `\n\n$$${latex}$$\n\n`;
  },
});
turndown.addRule('inlineMath', {
  filter: (node: HTMLElement) => node.getAttribute?.('data-type') === 'inline-math',
  replacement: (_content: string, node: Node) => {
    const latex = (node as HTMLElement).getAttribute('data-latex') || '';
    return `$${latex}$`;
  },
});

export function markdownToHtml(md: string): string {
  if (!md) return '';
  const html = marked.parse(mathToHtml(md), { async: false }) as string;
  return html;
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown.turndown(html);
}
