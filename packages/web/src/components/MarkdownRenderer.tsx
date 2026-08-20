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

/** #598: 表格语法容错 — 模型常输出非标准表格(表头缺前导 |、
 *  分隔行写成 |--、---| 等),GFM 严格解析失败会退回 raw text。
 *  仅在"表格上下文"(相邻行含 |)内修复;纯 ---(hr)不受影响。
 */
function fixTableSyntax(md: string): string {
  const lines = md.split('\n')
  const isSeparator = (l: string) => /^\s*\|?[\-:]+\|?[\-: |]*$/.test(l) && l.includes('-')
  const isHr = (l: string) => /^\s*-{3,}\s*$/.test(l)
  // 标准分隔行: | --- | --- |(每列 :?-+:?)→ 保留原样,避免列数被改写。
  const isStandardSep = (l: string) => /^\s*\|(\s*:?-+:?\s*\|){2,}\s*$/.test(l)
  const colCount = (l: string) => Math.max(0, (l.match(/\|/g) || []).length - 1)

  return lines.map((line, i) => {
    const next = i + 1 < lines.length ? lines[i + 1] : ''
    const prev = i > 0 ? lines[i - 1] : ''

    // 1) 表头行缺前导 | 且下一行是分隔行 → 补前导 |
    if (line.includes('|') && !line.trim().startsWith('|') && isSeparator(next) && !isHr(next)) {
      return '| ' + line.trim()
    }
    // 2) 非标准分隔行(非 hr,处于表格上下文)→ 规范为 | --- | ... |
    //    标准分隔行原样保留(列数与表头一致,避免被改写破坏表格)。
    if (isSeparator(line) && !isHr(line) && !isStandardSep(line) && (prev.includes('|') || next.includes('|'))) {
      const n = Math.max(1, colCount(prev.includes('|') ? prev : next))
      return `| ${Array(n).fill('---').join(' | ')} |`
    }
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
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const lang = match ? match[1] : '';
            const text = String(children).replace(/\n$/, '');

            if (inline) {
              return (
                <code className="rounded bg-surface px-1 py-0.5 text-[13px] font-mono text-text-primary" {...props}>
                  {children}
                </code>
              );
            }

            // #598: 模型常把单个标点/短符号用 ``` 围栏包裹(如 `..`、`.`),
            // 若围栏无语言标注且内容极短(≤4 字符、无换行),按普通文本
            // 渲染而非代码块,避免"明明不是代码却显示成 code"。
            if (!lang && text.trim().length <= 4 && !text.includes('\n')) {
              return <span className="text-text-primary">{children}</span>;
            }

            return <CodeBlock lang={lang} text={text} />;
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
