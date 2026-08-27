import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * #763 — SpotHint: 一次性、不打断、可跳过的能力引导条。
 * 与 NextBestActions(状态驱动)互补——这个只负责「新能力的首次发现」。
 * 每个能力一个 id;dismiss 永久记住(localStorage)。
 */

interface SpotHintProps {
  /** 能力唯一 key(如 writing-selection-bubble)。 */
  id: string;
  icon?: ReactNode;
  children: ReactNode;
}

const SEEN_KEY = 'nexus.spot-hint.seen';

function hasSeen(id: string): boolean {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[];
    return seen.includes(id);
  } catch {
    return true; // 解析失败按已看过处理,避免重复打扰
  }
}

function markSeen(id: string) {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[];
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen.slice(-30), id]));
  } catch { /* storage unavailable */ }
}

function useSpotHintInternal(id: string): [boolean, () => void] {
  const [visible, setVisible] = useState(() => !hasSeen(id));
  return [visible, () => { markSeen(id); setVisible(false) }];
}

// eslint-disable-next-line react-refresh/only-export-components -- 便捷导出,消费者多
export function useSpotHint(id: string): [boolean, () => void] {
  return useSpotHintInternal(id);
}

export function SpotHint({ id, icon = '✨', children }: SpotHintProps) {
  const [visible, dismiss] = useSpotHintInternal(id);
  if (!visible) return null;
  return (
    <div className="flex items-start justify-between gap-2 rounded-lg border border-accent/25 bg-accent/5 px-3 py-2 text-sm text-text-secondary" role="note">
      <span className="flex items-start gap-2">
        <span aria-hidden className="shrink-0">{icon}</span>
        <span>{children}</span>
      </span>
      <button onClick={dismiss} aria-label="知道了不再显示" className="shrink-0 text-text-tertiary hover:text-text-primary">
        <X size={14} />
      </button>
    </div>
  );
}
