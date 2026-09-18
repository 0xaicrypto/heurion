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
  // 保护转义 \$ (字面美元符) — 文本占位符避免控制字符。
  out = out.replace(/\\\$/g, '@@LITERAL_DOLLAR@@');
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
  return out.replace(/@@LITERAL_DOLLAR@@/g, '$');
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

// ── 手动格式化扩展的 round-trip(#1037) ──
// 编辑器补齐 Strike/Link/TaskList 等手动格式化入口后,保存链路必须保值:
// turndown 内置规则不含删除线与任务列表,不补会静默丢 mark。

// #1037: GFM 任务列表 — TipTap TaskItem(li[data-type=taskItem]) → `- [x] `/`- [ ] `。
turndown.addRule('taskItem', {
  filter: (node: HTMLElement) => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
  replacement: (content: string, node: Node) => {
    const checked = (node as HTMLElement).getAttribute('data-checked') === 'true';
    return `- [${checked ? 'x' : ' '}] ${content.trim().replace(/\n+/g, '\n')}\n`;
  },
});

// #1037: 删除线(s/del) → GFM ~~波浪线~~(marked/TipTap Strike 产出这两个标签)。
turndown.addRule('strikethrough', {
  filter: ['s', 'del'],
  replacement: (content: string) => `~~${content}~~`,
});

// #1054: Underline 全链路 — markdown(CommonMark/GFM)没有下划线行内语法,
// 采用 <u> HTML 直通存储(GitHub 同款方案)。turndown 默认规则会剥掉未识别
// 的 <u> 标签(保存即丢 mark),补保留规则;replacement 重写标签,属性天然不回存。
turndown.addRule('underline', {
  filter: 'u',
  replacement: (content: string) => `<u>${content}</u>`,
});

// #1054: <u> 白名单 sanitize(最小引入 — 此前正文链路无 sanitize 机制,
// block-math/taskList 等既有 HTML 透传不受影响)。<u> 只允许纯文本内容:
// 属性与嵌套标签一律剥离;script/style 连内容整体移除,不产生注入面。
// 白名单之外的其他标签不做处理(保持既有透传行为,注入面不因本特性扩大)。
function sanitizeUnderlineHtml(html: string): string {
  return html
    .replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, (_m: string, inner: string) => {
      const text = inner
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]*>/g, '');
      return `<u>${text}</u>`;
    })
    // 未闭合/残缺的 <u …> 开标签统一重写为无属性 <u>。
    .replace(/<u\b[^>]*>/gi, '<u>');
}

/**
 * #1037: marked 产出的 GFM 任务列表(li + input[type=checkbox])不是
 * TipTap TaskList/TaskItem 的解析形态,原样喂给编辑器会丢勾选态 —
 * 这里把 checkbox 项升级为 ul[data-type=taskList]/li[data-type=taskItem]。
 */
function taskListToTiptap(html: string): string {
  const out = html
    .replace(/<li><input checked="" disabled="" type="checkbox">\s*/g, '<li data-type="taskItem" data-checked="true">')
    .replace(/<li><input disabled="" type="checkbox">\s*/g, '<li data-type="taskItem" data-checked="false">');
  // 直接包含任务项的 <ul> 升级为 taskList 容器(嵌套任务列表同样命中)。
  return out.replace(/<ul>(\s*<li data-type="taskItem")/g, '<ul data-type="taskList">$1');
}

export function markdownToHtml(md: string): string {
  if (!md) return '';
  const html = marked.parse(mathToHtml(md), { async: false }) as string;
  // #1054: <u> 直通放行前过白名单 sanitize(属性/嵌套标签剥离)。
  return taskListToTiptap(sanitizeUnderlineHtml(html));
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown.turndown(html);
}
