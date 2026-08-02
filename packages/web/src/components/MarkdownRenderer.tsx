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

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

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
        <code className="whitespace-pre-wrap font-mono text-text-primary">{text}</code>
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
        'prose-headings:text-text-primary prose-headings:font-semibold',
        'prose-p:text-text-secondary prose-p:leading-relaxed',
        'prose-a:text-accent hover:prose-a:underline',
        'prose-strong:text-text-primary prose-strong:font-semibold',
        'prose-code:text-text-primary prose-code:bg-surface prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-sm prose-code:font-mono',
        'prose-pre:bg-transparent prose-pre:p-0 prose-pre:rounded-none',
        'prose-ol:text-text-secondary prose-ul:text-text-secondary prose-li:my-1',
        'prose-blockquote:border-l-4 prose-blockquote:border-accent prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-text-secondary',
        'prose-table:border-collapse prose-table:w-full prose-table:text-sm prose-table:block prose-table:overflow-x-auto',
        'prose-th:border prose-th:border-border prose-th:bg-surface-elevated prose-th:p-2 prose-th:text-left prose-th:text-text-primary prose-th:font-medium',
        'prose-td:border prose-td:border-border prose-td:p-2 prose-td:text-text-secondary',
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
                <code className="rounded bg-surface px-1 py-0.5 text-sm font-mono text-text-primary" {...props}>
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
