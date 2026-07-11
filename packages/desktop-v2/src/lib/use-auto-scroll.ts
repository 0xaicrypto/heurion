/**
 * useAutoScroll — keep a chat message list pinned to the bottom while
 * new chunks stream in, but ONLY when the user is already near the
 * bottom. If they've scrolled up to re-read an earlier turn, we leave
 * their scroll position alone.
 *
 * Usage:
 *   const { containerRef, bottomRef, onScroll } =
 *     useAutoScroll([messages.length, messages[messages.length - 1]?.text]);
 *   <div ref={containerRef} onScroll={onScroll} className="overflow-y-auto">
 *     {...messages}
 *     <div ref={bottomRef} />
 *   </div>
 *
 * "Near the bottom" is tracked in a ref (not state) so the onScroll
 * handler never triggers re-renders during high-frequency streaming.
 */
import { useEffect, useRef } from 'react';

const NEAR_BOTTOM_PX = 80;

export function useAutoScroll(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Default true so the very first render (history load) lands at the
  // latest message.
  const autoScrollRef = useRef(true);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = distanceFromBottom < NEAR_BOTTOM_PX;
  };

  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { containerRef, bottomRef, onScroll };
}
