import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api-client';
import { Button, Card, Skeleton, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { BookOpen, Brain, Lightbulb, Wrench, AlertTriangle, RotateCcw, Check, Clock } from 'lucide-react';

interface Article {
  id: string; title: string; content: string; sources: string[];
  version: number; status: string; staleBecause?: string[];
  createdAt: number; updatedAt: number;
}
interface Fact {
  id: string; category: string; importance: number; content: string;
  count: number; createdAt: number; updatedAt: number; lastSeenAt: number;
}
interface Gap {
  id: string; query: string; context: string; status: string; detectedAt: number;
}
interface Tool {
  id: string; name: string; description: string; language: string;
  enabled: boolean; createdAt: number;
}

type Tab = 'articles' | 'facts' | 'gaps' | 'tools';

const TABS: { key: Tab; label: string; icon: typeof BookOpen }[] = [
  { key: 'articles', label: 'Articles', icon: BookOpen },
  { key: 'facts', label: 'Facts', icon: Brain },
  { key: 'gaps', label: 'Pending', icon: Clock },
  { key: 'tools', label: 'Tools', icon: Wrench },
];

export function KnowledgePage() {
  const [tab, setTab] = useState<Tab>('articles');
  const [articles, setArticles] = useState<Article[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      api.getKnowledge().then(r => setArticles(r.articles)).catch(() => {}),
      api.getFacts().then(r => setFacts(r.facts)).catch(() => {}),
      api.getKnowledgeGaps().then(r => setGaps(r.gaps)).catch(() => {}),
      api.getKnowledgeTools().then(r => setTools(r.tools)).catch(() => {}),
    ]).finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, []);

  const staleCount = articles.filter(a => a.status === 'stale').length;
  const pendingCount = gaps.filter(g => g.status === 'pending').length;

  const resolveGap = async (gapId: string) => {
    await api.resolveKnowledgeGap(gapId).catch(() => {});
    loadAll();
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <div className="flex items-center gap-3">
            <BookOpen size={20} className="text-accent" />
            <h1 className="font-semibold text-text-primary">Knowledge Base</h1>
            {staleCount > 0 && (
              <Badge variant="warning"><AlertTriangle size={12} className="mr-1" /> {staleCount} stale</Badge>
            )}
            {pendingCount > 0 && (
              <Badge variant="default"><Clock size={12} className="mr-1" /> {pendingCount} pending</Badge>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={loadAll}><RotateCcw size={14} className="mr-1" /> Refresh</Button>
        </header>

        <nav className="flex border-b border-border bg-surface px-6">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 -mb-px transition-colors',
                tab === key
                  ? 'border-accent text-accent font-medium'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>

        <main className="p-6">
          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          ) : (
            <>
              {/* ── Articles ── */}
              {tab === 'articles' && (
                <div className="space-y-4">
                  {articles.length === 0 && (
                    <Card className="p-8 text-center">
                      <BookOpen size={32} className="mx-auto mb-3 text-text-tertiary" />
                      <p className="text-text-secondary">No knowledge articles yet.</p>
                      <p className="mt-1 text-sm text-text-tertiary">Articles are auto-generated when 3+ related facts accumulate.</p>
                    </Card>
                  )}
                  {articles.map(a => (
                    <Card key={a.id} className={cn('p-4', a.status === 'stale' && 'border-warning/50')}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-text-primary truncate">{a.title || 'Untitled'}</h3>
                            <Badge variant="default">v{a.version || 1}</Badge>
                            {a.status === 'stale' && <Badge variant="warning"><AlertTriangle size={10} className="mr-1" /> Stale</Badge>}
                          </div>
                          {a.content && <p className="mt-1 text-xs text-text-tertiary line-clamp-2">{a.content.slice(0, 200)}</p>}
                          <p className="mt-1 text-xs text-text-tertiary">
                            {new Date(a.updatedAt || a.createdAt).toLocaleDateString()}
                            {a.sources?.length > 0 && ` · ${a.sources.length} sources`}
                          </p>
                          {a.status === 'stale' && a.staleBecause && (
                            <p className="mt-1 text-xs text-warning">Dependent facts updated: {a.staleBecause.join(', ')}</p>
                          )}
                        </div>
                        {a.status === 'stale' && (
                          <Button size="sm" variant="secondary" className="ml-3"><RotateCcw size={14} className="mr-1" /> Regenerate</Button>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              {/* ── Facts ── */}
              {tab === 'facts' && (
                <div className="space-y-3">
                  {facts.length === 0 && (
                    <Card className="p-8 text-center">
                      <Brain size={32} className="mx-auto mb-3 text-text-tertiary" />
                      <p className="text-text-secondary">No facts stored yet.</p>
                      <p className="mt-1 text-sm text-text-tertiary">Facts are extracted from conversations and imported data.</p>
                    </Card>
                  )}
                  {facts.map(f => (
                    <Card key={f.id} className="p-4">
                      <div className="flex items-start gap-3">
                        <div className={cn(
                          'mt-0.5 px-1.5 py-0.5 rounded text-xs font-medium shrink-0',
                          f.category === 'fact' ? 'bg-blue-500/10 text-blue-500' :
                          f.category === 'preference' ? 'bg-purple-500/10 text-purple-500' :
                          f.category === 'constraint' ? 'bg-orange-500/10 text-orange-500' :
                          f.category === 'goal' ? 'bg-green-500/10 text-green-500' :
                          'bg-slate-500/10 text-slate-500'
                        )}>{f.category}</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-text-primary">{f.content}</p>
                          <p className="mt-1 text-xs text-text-tertiary">
                            Importance: {f.importance} · Seen {f.count}x · {new Date(f.updatedAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              {/* ── Gaps / Pending ── */}
              {tab === 'gaps' && (
                <div className="space-y-3">
                  {gaps.length === 0 && (
                    <Card className="p-8 text-center">
                      <Lightbulb size={32} className="mx-auto mb-3 text-text-tertiary" />
                      <p className="text-text-secondary">No pending knowledge gaps.</p>
                      <p className="mt-1 text-sm text-text-tertiary">Gaps appear when queries don't match existing knowledge.</p>
                    </Card>
                  )}
                  {gaps.map(g => (
                    <Card key={g.id} className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-sm text-text-primary truncate">{g.query}</h3>
                            <Badge variant={g.status === 'pending' ? 'warning' : 'default'}>{g.status}</Badge>
                          </div>
                          {g.context && <p className="mt-1 text-xs text-text-tertiary line-clamp-2">{g.context}</p>}
                          <p className="mt-1 text-xs text-text-tertiary">{new Date(g.detectedAt).toLocaleDateString()}</p>
                        </div>
                        {g.status === 'pending' && (
                          <Button size="sm" variant="secondary" className="ml-3" onClick={() => resolveGap(g.id)}>
                            <Check size={14} className="mr-1" /> Resolve
                          </Button>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              {/* ── Tools ── */}
              {tab === 'tools' && (
                <div className="space-y-3">
                  {tools.length === 0 && (
                    <Card className="p-8 text-center">
                      <Wrench size={32} className="mx-auto mb-3 text-text-tertiary" />
                      <p className="text-text-secondary">No auto-generated tools yet.</p>
                      <p className="mt-1 text-sm text-text-tertiary">Tools are created automatically from knowledge patterns.</p>
                    </Card>
                  )}
                  {tools.map(t => (
                    <Card key={t.id} className={cn('p-4', !t.enabled && 'opacity-60')}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-sm text-text-primary">{t.name}</h3>
                            <Badge variant="default">{t.language}</Badge>
                            {!t.enabled && <Badge>Disabled</Badge>}
                          </div>
                          {t.description && <p className="mt-1 text-xs text-text-tertiary line-clamp-2">{t.description}</p>}
                          <p className="mt-1 text-xs text-text-tertiary">{new Date(t.createdAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </AppShell>
  );
}
