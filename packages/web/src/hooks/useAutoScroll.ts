import { useEffect, useRef } from 'react';

/**
 * #653 — scroll the chat transcript to the bottom when `deps` change.
 * The identical effect was hand-written in chat.tsx and patients.tsx;
 * attach the returned ref to the transcript's bottom anchor element.
 */
export function useAutoScroll<T extends HTMLElement = HTMLDivElement>(deps: React.DependencyList): React.RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方声明
  }, deps);
  return ref;
}
