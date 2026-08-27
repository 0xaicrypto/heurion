// #761: NBA dismissal store — split from NextBestActions.tsx so the component
// file stays component-only (react-refresh/only-export-components).

export interface StoredAction {
  id: string;
  at: number;
}

const DISMISS_KEY = 'nexus.nba.dismissed';

export function loadDismissed(): StoredAction[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]') as StoredAction[];
  } catch {
    return [];
  }
}

export function dismissNba(id: string) {
  const dismissed = loadDismissed().filter((d) => d.id !== id).slice(-20);
  localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed, { id, at: Date.now() }]));
}

/** dismiss 后 30 天内同 id 不再出现;之后状态仍相关可重新亮起。 */
export function isDismissedRecently(id: string): boolean {
  const found = loadDismissed().find((d) => d.id === id);
  return !!found && Date.now() - found.at < 30 * 86400_000;
}

// ── signal → action mapping (needs router + api) ──
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface NbaAction {
  id: string;
  icon?: unknown;
  text: string;
  actionLabel: string;
  targetPath: string;
}

/**
 * #761: 只读现有数据计算下一步建议(FilePipelineJob/gaps/stale articles)。
 * 组件层负责把 targetPath 渲染为跳转按钮与图标。
 */
export function useNextBestActionSignals(): Array<{ id: string; text: string; actionLabel: string; targetPath: string; tone: 'accent' | 'warning' }> {
  const [actions, setActions] = useState<Array<{ id: string; text: string; actionLabel: string; targetPath: string; tone: 'accent' | 'warning' }>>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const signals = await Promise.allSettled([
        api.listFiles(10).then((r) => r.files.slice(0, 3)),
        api.getKnowledgeGaps({ status: 'open', pageSize: 5 }).then((r) => r.gaps),
        api.getKnowledgeArticles().then((r) => r.articles.filter((a) => a.status === 'stale')),
      ]);
      const found: Array<{ id: string; text: string; actionLabel: string; targetPath: string; tone: 'accent' | 'warning' }> = [];

      const files = signals[0].status === 'fulfilled' ? signals[0].value : [];
      if (files.length > 0) {
        found.push({
          id: `nba-file-${files[0].file_id}`,
          text: files.length === 1
            ? `《${files[0].name}》已入库,要不要问问它的核心结论?`
            : `${files.length} 个新文件已入库,试试用它们提问`,
          actionLabel: '去问问',
          targetPath: '/app/chat',
          tone: 'accent',
        });
      }

      const gaps = signals[1].status === 'fulfilled' ? signals[1].value : [];
      if (gaps.length > 0) {
        found.push({
          id: 'nba-gaps-open',
          text: gaps.length === 1 ? 'AI 发现了 1 个知识缺口' : `AI 发现了 ${gaps.length} 个知识缺口`,
          actionLabel: '处理',
          targetPath: '/app/knowledge?view=gaps',
          tone: 'accent',
        });
      }

      const stale = signals[2].status === 'fulfilled' ? signals[2].value : [];
      if (stale.length >= 2) {
        found.push({
          id: 'nba-articles-stale',
          text: `${stale.length} 篇文章因新事实过期`,
          actionLabel: '查看',
          targetPath: '/app/knowledge?view=articles',
          tone: 'warning',
        });
      }

      setActions(alive
        ? found.filter((a) => !isDismissedRecently(a.id)).slice(0, 3)
        : []);
    })();
    return () => { alive = false; };
  }, []);

  return actions;
}
