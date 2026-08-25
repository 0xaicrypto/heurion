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
/**
 * #661 — block projection during streaming (opencode markdown-stream
 * pattern): split the partial text at block boundaries (blank lines, with
 * code fences respected). Blocks that have CLOSED are frozen — rendered once
 * through MarkdownRenderer and cached, never reparsed. Only the trailing
 * incomplete block renders live (light formatting).
 */
const CLOSED_BLOCK_CACHE = new Map<string, React.ReactNode>();

function splitBlocks(text: string): { blocks: string[]; liveTail: string } {
  const blocks: string[] = [];
  let current = '';
  let inFence = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) inFence = !inFence;
    current += (current ? '\n' : '') + line;
    // A block closes at a blank line — unless we're inside a code fence.
    if (!inFence && line.trim() === '') {
      blocks.push(current);
      current = '';
    }
  }
  return { blocks, liveTail: current };
}

function BlockRenderer({ block, className }: { block: string; className?: string }) {
  const cached = CLOSED_BLOCK_CACHE.get(block);
  if (cached) return <>{cached}</>;
  const node = (
    <div className={className}>
      <MarkdownRenderer content={block} />
    </div>
  );
  // Cache per exact block content — completed blocks never reparse.
  if (CLOSED_BLOCK_CACHE.size > 200) CLOSED_BLOCK_CACHE.clear();
  CLOSED_BLOCK_CACHE.set(block, node);
  return node;
}

/** Streaming partial text — inline formatting only (bold + inline code). */
function LiveTail({ text }: { text: string }) {
  const boldParts = text.split(/\*\*([^*]+)\*\*/g);
  return (
    <>
      {boldParts.map((part, i) =>
        i % 2 === 1 ? <strong key={i} className="font-semibold text-text-primary">{part}</strong> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

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
  if (!text) {
    // #fix: 流式等待期(LLM 首 token 前可能 10-30s)必须醒目 — 此前只有
    // 一个 14px 的 ●,用户以为没有响应。
    return (
      <span className="flex items-center gap-2 py-1 text-xs text-text-secondary">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </span>
        <span className="animate-pulse">正在分析…</span>
      </span>
    );
  }

  // #661: closed blocks render once (cached), only the tail is live.
  const { blocks, liveTail } = splitBlocks(text);

  return (
    <div className={cn('break-words text-sm leading-relaxed text-text-secondary', className)}>
      {blocks.map((block, i) => (
        <BlockRenderer key={i} block={block} className={i === 0 ? '' : 'mt-2'} />
      ))}
      {liveTail && (
        <div className="whitespace-pre-wrap">
          <LiveTail text={liveTail} />
        </div>
      )}
    </div>
  );
}
