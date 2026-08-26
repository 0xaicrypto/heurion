import { useEffect, useRef, useState } from 'react';

/**
 * #706 — 流式输出期间自动滚到底部，但用户向上滚动阅读历史时暂停。
 *
 * 此前 chat.tsx/patients.tsx 各自用 `bottomRef.current.parentElement`
 * 计算 near-bottom —— 那个元素是消息列表根 div，不是滚动容器，差值恒 0，
 * 导致"暂停自动滚动"完全失效（每次 chunk 更新都被拽回底部）。
 * 正确做法：以真正的滚动容器（`<main class="overflow-y-auto">`）计算。
 *
 * 用法：
 *   const { bottomRef, containerRef, isAtBottom, scrollToBottom } = useAutoScrollOnStream(session?.messages);
 *   <main ref={containerRef} className="overflow-y-auto"> ... <div ref={bottomRef} /> </main>
 *   {!isAtBottom && <button onClick={scrollToBottom}>回到底部</button>}
 */
export function useAutoScrollOnStream(deps: unknown) {
  const containerRef = useRef<HTMLElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      stickRef.current = near;
      setIsAtBottom(near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = bottomRef.current;
    if (!el || !stickRef.current) return;
    el.scrollIntoView({ behavior: 'smooth' });
    setIsAtBottom(true);
  }, [deps]);

  const scrollToBottom = () => {
    stickRef.current = true;
    setIsAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return { containerRef, bottomRef, isAtBottom, scrollToBottom };
}
