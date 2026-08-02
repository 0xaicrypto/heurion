import { useMemo } from 'react';
import { cn, normalizeLlmText } from '@/lib/utils';
import { MarkdownRenderer, CodeBlock } from './MarkdownRenderer';

/**
 * Renders LLM response content with automatic format detection:
 * - a single ```markdown/``` fence → rendered as markdown
 * - a single ```json fence or a pure JSON body → pretty-printed JSON block
 * - anything else → markdown (tables, lists, code blocks, …)
 */
export function LlmContent({ content, className }: { content: string; className?: string }) {
  const text = useMemo(() => normalizeLlmText(content || ''), [content]);

  const detected = useMemo(() => {
    if (!text) return { kind: 'empty' as const };

    // Pure JSON body (no fences): starts with {/[ and parses.
    const trimmed = text.trim();
    const looksLikeJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (looksLikeJson) {
      try {
        JSON.parse(trimmed);
        return { kind: 'json' as const, value: trimmed };
      } catch { /* fall through */ }
    }

    // Single fenced block wrapping the whole reply
    const fence = /^```(\w*)\s*\n([\s\S]*?)\n```$/.exec(trimmed);
    if (fence) {
      const lang = fence[1].toLowerCase();
      const inner = fence[2];
      if (lang === 'json') {
        try {
          JSON.parse(inner);
          return { kind: 'json' as const, value: inner };
        } catch { /* not valid json — fall through to markdown */ }
      }
      if (lang === 'markdown' || lang === 'md' || lang === '') {
        return { kind: 'markdown' as const, value: inner };
      }
      // Single fenced code (python, sql, …) stays a code block.
      return { kind: 'markdown' as const, value: text };
    }

    return { kind: 'markdown' as const, value: text };
  }, [text]);

  if (detected.kind === 'empty') return null;

  if (detected.kind === 'json') {
    let pretty = detected.value;
    try {
      pretty = JSON.stringify(JSON.parse(detected.value), null, 2);
    } catch { /* keep raw */ }
    return (
      <div className={cn('my-1', className)}>
        <CodeBlock lang="json" text={pretty} />
      </div>
    );
  }

  return <MarkdownRenderer content={detected.value} className={className} />;
}
