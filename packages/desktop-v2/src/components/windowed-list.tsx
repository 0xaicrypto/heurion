/**
 * Windowing helpers (UI_UX_REVIEW_2026-07 §6).
 *
 * react-window could not be added (the pnpm store on this machine is
 * bound to a different location, and reinstalling node_modules from a
 * sandbox is riskier than the win), so long lists use the sanctioned
 * fallback: render a bounded slice + a button to reveal the rest.
 *
 *   - useTailWindow: chat histories — keep the LAST n items mounted
 *     (newest at the bottom), "load earlier" reveals older turns.
 *     Variable-height chat rows make this strictly safer than a
 *     fixed-row virtualizer anyway.
 *   - useHeadWindow: top-down lists (patient sidebar, roster table) —
 *     keep the FIRST n items, "show more" extends the window.
 *
 * Both are O(visible) in DOM nodes, which is the property that
 * matters: a 2 000-message session or 5 000-patient roster no longer
 * mounts thousands of rows.
 */
import { useEffect, useState } from 'react';

export function useTailWindow<T>(items: T[], initial = 60, step = 100) {
  const [count, setCount] = useState(initial);
  const hiddenCount = Math.max(0, items.length - count);
  const visible = hiddenCount > 0 ? items.slice(hiddenCount) : items;
  return {
    visible,
    hiddenCount,
    /** Index of visible[0] inside the full array — callers that key
     *  handlers off the original index must add this offset. */
    offset: hiddenCount,
    showEarlier: () => setCount((c) => c + step),
  };
}

export function useHeadWindow<T>(items: T[], initial = 40, step = 200) {
  const [count, setCount] = useState(initial);
  // Reset the window when the underlying collection identity shrinks
  // dramatically (e.g. switching studies) so a previously expanded
  // window doesn't leak into the next dataset.
  useEffect(() => {
    if (items.length <= initial) setCount(initial);
  }, [items.length, initial]);
  const hiddenCount = Math.max(0, items.length - count);
  const visible = hiddenCount > 0 ? items.slice(0, count) : items;
  return {
    visible,
    hiddenCount,
    showMore: () => setCount((c) => c + step),
  };
}
