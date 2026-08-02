import { useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * Streaming path: renders the partial text cheaply (no markdown re-parse per
 * chunk) and switches to the full LlmContent rendering once streaming ends.
 * A rAF throttle coalesces chunk updates within the same frame.
 *
 * U1 — block-projection alternative: full parse happens exactly once, at the
 * end; during streaming the text is lightly formatted (bold/inline-code).
 */
export function StreamingLlmContent({ content, isStreaming, className }: { content: string; isStreaming?: boolean; className?: string }) {
  const [display, setDisplay] = useState(content);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      setDisplay(content);
      return;
    }
    // Throttle: coalesce chunk updates to once per animation frame.
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setDisplay(content);
    });
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [content, isStreaming]);

  if (!isStreaming) {
    return <LlmContent content={content} className={className} />;
  }

  // Lightweight partial rendering: no per-chunk markdown re-parse.
  const text = normalizeLlmText(display || '');
  if (!text) return <span className="animate-pulse text-text-tertiary">●</span>;

  // Light inline formatting only (bold + inline code) for the streaming phase.
  const boldParts = text.split(/\*\*([^*]+)\*\*/g);
  const html = boldParts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-semibold text-text-primary">{part}</strong> : <span key={i}>{part}</span>,
  );

  return (
    <div className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary', className)}>
      {html}
    </div>
  );
}
