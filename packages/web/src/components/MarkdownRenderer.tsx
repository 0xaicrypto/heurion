import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
  className?: string;
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
        'prose-pre:bg-surface prose-pre:rounded-lg prose-pre:p-3 prose-pre:text-sm',
        'prose-ol:text-text-secondary prose-ul:text-text-secondary prose-li:my-1',
        'prose-blockquote:border-l-4 prose-blockquote:border-accent prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-text-secondary',
        'prose-table:border-collapse prose-table:w-full prose-table:text-sm',
        'prose-th:border prose-th:border-border prose-th:bg-surface-elevated prose-th:p-2 prose-th:text-left prose-th:text-text-primary prose-th:font-medium',
        'prose-td:border prose-td:border-border prose-td:p-2 prose-td:text-text-secondary',
        'prose-hr:border-border',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm as any]}
        components={{
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

            return (
              <pre className="my-2 overflow-x-auto rounded-lg bg-surface p-3 text-sm">
                {lang && <div className="mb-1 text-xs text-text-tertiary">{lang}</div>}
                <code className="whitespace-pre-wrap font-mono text-text-primary" {...props}>
                  {text}
                </code>
              </pre>
            );
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
