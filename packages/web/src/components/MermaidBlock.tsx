import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from './MarkdownRenderer';

/**
 * #822 — mermaid 客户端渲染(聊天/写作 markdown 预览)。bundle 按需
 * 动态 import(2.5MB 不进主包);securityLevel=strict + 禁 htmlLabels,
 * 与 worker 渲染壳同安全约束。渲染失败回退代码块展示。
 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          theme: 'default',
        });
        const { svg: out } = await mermaid.render(idRef.current, code);
        if (!cancelled) setSvg(out);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (failed) return <CodeBlock lang="mermaid" text={code} />;
  if (!svg) {
    return (
      <div className="my-2 flex h-32 items-center justify-center rounded-lg border border-border bg-surface text-xs text-text-tertiary">
        正在渲染 mermaid 图…
      </div>
    );
  }
  return (
    <div
      className="my-2 overflow-x-auto rounded-lg border border-border bg-white p-3"
      // mermaid 输出为受控 SVG(securityLevel=strict);注入为一次性 innerHTML。
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
