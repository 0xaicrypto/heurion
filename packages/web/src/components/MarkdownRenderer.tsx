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

export function MarkdownRenderer({ content, className }: Props) {
  if (!content) return null;

  return (
    <div
      className={cn(
        'prose prose-sm max-w-none break-words',
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
