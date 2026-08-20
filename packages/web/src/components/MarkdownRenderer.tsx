import { useState } from 'react';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Check, Copy } from 'lucide-react';

interface Props {
  content: string;
  className?: string;
}

export function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const displayText = lang === 'json'
    ? (() => {
        try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
      })()
    : text;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-text-tertiary">{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-text-tertiary transition-colors hover:bg-surface-elevated hover:text-text-primary"
          aria-label={`Copy ${lang || 'code'}`}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-sm">
        <code className="whitespace-pre-wrap font-mono text-text-primary">{displayText}</code>
      </pre>
    </div>
  );
}

/** #598: 表格语法容错 — 模型常输出非标准表格:
 *  ① 表头缺前导 |(如 'On-Chain Reality| Asset |') ② 表头列数与分隔行
 *  不一致(5 列表头 + 4 列分隔) ③ 分隔行写成 |--、---| 等。
 *  GFM 严格解析失败会退回 raw text。仅修复表格上下文,纯 ---(hr)不受影响。
 */
/**
 * #598: 单行表格展开 — 模型常把整个表格挤成一行
 * (On-Chain Reality| Asset |...| |---|---| | WETH |...|| WMNT |...)。
 * 检测"管道密集 + 分隔段"的行,按表头列数拆分为标准多行表格。
 */
function expandSingleLineTable(line: string): string | null {
  if ((line.match(/\|/g) || []).length < 4) return null
  const sepIdx = line.search(/\|[-:]{1,}\|/)
  if (sepIdx < 0) return null
  const headerRaw = line.slice(0, sepIdx)
  const sepMatch = line.slice(sepIdx).match(/^\|?[-:]{1,}(\|[-:]{1,})+\|?/)
  if (!sepMatch) return null
  const dataRaw = line.slice(sepIdx + sepMatch[0].length)
  if (!dataRaw.includes('|')) return null

  const headerCells = headerRaw.split('|').map((s) => s.trim()).filter((s) => s !== '')
  if (headerCells.length === 0) return null
  const cols = headerCells.length
  const hdr = headerRaw.trim().startsWith('|') ? headerRaw.trim() : `| ${headerRaw.trim()}`
  const sepLine = `| ${Array(cols).fill('---').join(' | ')} |`
  const cells = dataRaw.split('|').map((s) => s.trim()).filter((s) => s !== '')
  const rows: string[] = []
  for (let i = 0; i < cells.length; i += cols) {
    rows.push(`| ${cells.slice(i, i + cols).join(' | ')} |`)
  }
  return [hdr, sepLine, ...rows].join('\n')
}

function fixTableSyntax(md: string): string {
  const lines = md.split('\n')
  // 先尝试展开单行表格(命中则替换该行)。
  const expanded = lines.map((l) => expandSingleLineTable(l) ?? l)

  const isSeparator = (l: string) => /^\s*\|?[-:]+\|?[-: |]*$/.test(l) && l.includes('-')
  const isHr = (l: string) => /^\s*-{3,}\s*$/.test(l)
  const isStandardSep = (l: string) => /^\s*\|(\s*:?-+:?\s*\|){2,}\s*$/.test(l)
  const colCount = (l: string) => Math.max(0, (l.match(/\|/g) || []).length - 1)

  let forceCols: number | null = null
  return expanded.map((line, i) => {
    const next = i + 1 < lines.length ? lines[i + 1] : ''
    const prev = i > 0 ? lines[i - 1] : ''

    // 1) 表头行缺前导 | 且下一行是分隔行 → 补前导 |,并强制分隔行列数
    //    与表头一致(模型可能少写一列分隔)。
    if (line.includes('|') && !line.trim().startsWith('|') && isSeparator(next) && !isHr(next)) {
      const header = '| ' + line.trim()
      forceCols = Math.max(1, colCount(header))
      return header
    }
    // 2) 分隔行(非 hr,处于表格上下文)→ 规范为 | --- | ... |。
    if (isSeparator(line) && !isHr(line) && (forceCols != null || prev.includes('|') || next.includes('|'))) {
      if (forceCols != null) {
        const n = forceCols
        forceCols = null
        return `| ${Array(n).fill('---').join(' | ')} |`
      }
      if (!isStandardSep(line)) {
        const n = Math.max(1, colCount(prev.includes('|') ? prev : next))
        return `| ${Array(n).fill('---').join(' | ')} |`
      }
    }
    forceCols = null
    return line
  }).join('\n')
}

export function MarkdownRenderer({ content, className }: Props) {
  if (!content) return null;
  content = fixTableSyntax(content);

  return (
    <div
      className={cn(
        'prose prose-sm max-w-none break-words',
        // #389: dark mode — prose's default colors (lists, hr, blockquote,
        // leftover elements) are dark; invert them under .dark while the
        // explicit semantic-color overrides below keep their theme values.
        'dark:prose-invert',
        // In-chat typography scale: base 14px body, headings kept close to
        // body size (default prose h1/h2 are far too large for a chat bubble).
        'prose-headings:text-text-primary prose-headings:font-semibold',
        'prose-h1:text-base prose-h2:text-base prose-h3:text-sm prose-h4:text-sm prose-h5:text-sm prose-h6:text-sm',
        'prose-p:text-text-secondary prose-p:leading-relaxed',
        'prose-a:text-accent hover:prose-a:underline',
        'prose-strong:text-text-primary prose-strong:font-semibold',
        'prose-code:text-text-primary prose-code:bg-surface prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[13px] prose-code:font-mono',
        'prose-pre:bg-transparent prose-pre:p-0 prose-pre:rounded-none',
        'prose-ol:text-text-secondary prose-ul:text-text-secondary prose-li:my-1',
        'prose-blockquote:border-l-4 prose-blockquote:border-accent prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-text-secondary',
        'prose-hr:border-border',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm as any, remarkBreaks as any]}
        components={{
          pre({ children }: any) {
            // CodeBlock renders its own container; unwrap the default <pre>.
            return <>{children}</>;
          },
          code({ inline, children, ...props }: any) {
            const text = String(children).replace(/\n$/, '');

            if (inline) {
              return (
                <code className="rounded bg-surface px-1 py-0.5 text-[13px] font-mono text-text-primary" {...props}>
                  {children}
                </code>
              );
            }

            // #598: 围栏代码块不再单独渲染为带框/复制按钮的代码块 —
            // 按普通文本(等宽、保留换行)展示,避免"非代码被 code 化"的
            // 视觉突兀与误判。
            return (
              <pre className="my-1 whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-text-primary">{text}</pre>
            );
          },
          a({ children, href }) {
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-accent underline hover:opacity-80">
                {children}
              </a>
            );
          },
          // Tables: the wrapper scrolls horizontally; the <table> itself must
          // keep `display: table` (a block table breaks row/column layout).
          table({ children }: any) {
            return (
              <div className="my-2 overflow-x-auto">
                <table className="w-full border-collapse text-xs">{children}</table>
              </div>
            );
          },
          th({ children }: any) {
            return (
              <th className="whitespace-nowrap border border-border bg-surface-elevated p-2 text-left font-medium text-text-primary">
                {children}
              </th>
            );
          },
          td({ children }: any) {
            return (
              <td className="border border-border p-2 align-top text-text-secondary">
                {children}
              </td>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
