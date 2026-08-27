import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, X, FileText, GitGraph, BookOpen } from 'lucide-react';
import { Card, Button } from '@/components/ui';
import { dismissNba, useNextBestActionSignals } from '@/lib/nba';

/**
 * #761 — NextBestActions: 基于账号状态的「建议下一步」行动卡。
 * 信号计算在 lib/nba.ts(三页复用);本组件只负责渲染与跳转。
 * today 页顶部 + knowledge 页顶部接入;每卡可 dismiss(30 天内不再推)。
 */
export function NextBestActions() {
  const navigate = useNavigate();
  const signals = useNextBestActionSignals();
  const [, force] = useState(0);
  if (signals.length === 0) return null;

  return (
    <Card className="border-dashed border-accent/40 p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary">
        <Sparkles size={14} className="text-accent" />
        建议下一步
      </h3>
      <div className="space-y-1.5">
        {signals.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-text-secondary">
              {a.tone === 'warning'
                ? <GitGraph size={14} className="shrink-0 text-warning" />
                : a.id.startsWith('nba-file')
                  ? <FileText size={14} className="shrink-0 text-accent" />
                  : <BookOpen size={14} className="shrink-0 text-accent" />}
              <span className="truncate">{a.text}</span>
            </span>
            <button
              onClick={() => { dismissNba(a.id); force((n) => n + 1); }}
              aria-label="dismiss"
              className="text-text-tertiary hover:text-text-primary"
            >
              <X size={13} />
            </button>
            <Button size="sm" variant="secondary" onClick={() => { dismissNba(a.id); navigate(a.targetPath); }}>
              {a.actionLabel}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
