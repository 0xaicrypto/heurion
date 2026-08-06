import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Brain, BookOpen } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { BrainPage } from '@/routes/brain';
import { KnowledgePage } from '@/routes/knowledge';
import { cn } from '@/lib/utils';

/**
 * #230: 记忆与知识统一入口 — 一个导航项、两个 Tab。
 * 数据同源（Memory Graph 的投影），之前两个导航项让用户困惑。
 * Tab 状态编码在 URL query（?tab=memory|knowledge）以便直达/刷新保持。
 */
type Tab = 'memory' | 'knowledge';

export function MemoryKnowledgePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const tab: Tab = useMemo(() => {
    const p = new URLSearchParams(location.search).get('tab');
    return p === 'knowledge' ? 'knowledge' : 'memory';
  }, [location.search]);

  const switchTab = (next: Tab) => {
    const params = new URLSearchParams();
    if (next !== 'memory') params.set('tab', next);
    navigate({ pathname: '/app/memory', search: params.toString() });
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">{t('nav.memoryKnowledge', '记忆与知识')}</h1>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-elevated p-0.5">
            <button
              onClick={() => switchTab('memory')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors',
                tab === 'memory' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <Brain size={15} />
              {t('nav.brain')}
            </button>
            <button
              onClick={() => switchTab('knowledge')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors',
                tab === 'knowledge' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <BookOpen size={15} />
              {t('nav.knowledge')}
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          {tab === 'memory' ? <BrainPage embedded /> : <KnowledgePage embedded />}
        </div>
      </div>
    </AppShell>
  );
}
