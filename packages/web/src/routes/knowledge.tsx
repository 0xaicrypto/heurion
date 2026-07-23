import { useEffect, useState } from 'react';
import { BookOpen, RotateCcw, AlertTriangle } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api-client';
import { Button, Card, Skeleton, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';

interface Article {
  id: string;
  title: string;
  content: string;
  sources: string[];
  version: number;
  status: string;
  staleBecause?: string[];
  createdAt: number;
  updatedAt: number;
}

export function KnowledgePage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadArticles = () => {
    setLoading(true);
    api.getKnowledge()
      .then(r => setArticles(r.articles))
      .catch(() => setError('No knowledge articles yet. Articles are auto-generated when 3+ related facts accumulate.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadArticles(); }, []);

  const staleCount = articles.filter(a => a.status === 'stale').length;

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <div className="flex items-center gap-3">
            <BookOpen size={20} className="text-accent" />
            <h1 className="font-semibold text-text-primary">Knowledge Base</h1>
            {staleCount > 0 && (
              <Badge variant="warning">
                <AlertTriangle size={12} className="mr-1" /> {staleCount} stale
              </Badge>
            )}
          </div>
        </header>

        <main className="p-6">
          {error && !loading && (
            <Card className="p-8 text-center">
              <BookOpen size={32} className="mx-auto mb-3 text-text-tertiary" />
              <p className="text-text-secondary">{error}</p>
              <p className="mt-1 text-sm text-text-tertiary">
                Start chatting or uploading files to accumulate knowledge.
              </p>
            </Card>
          )}

          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          ) : articles.length > 0 ? (
            <div className="space-y-4">
              {articles.map((a) => (
                <Card key={a.id} className={cn('p-4', a.status === 'stale' && 'border-warning/50')}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-text-primary truncate">{a.title || 'Untitled'}</h3>
                        <Badge variant="default">v{a.version || 1}</Badge>
                        {a.status === 'stale' && (
                          <Badge variant="warning">
                            <AlertTriangle size={10} className="mr-1" /> Stale
                          </Badge>
                        )}
                      </div>
                      {a.content && (
                        <p className="mt-1 text-xs text-text-tertiary line-clamp-2">{a.content.slice(0, 200)}</p>
                      )}
                      <p className="mt-1 text-xs text-text-tertiary">
                        {new Date(a.updatedAt || a.createdAt).toLocaleDateString()}
                        {a.sources?.length > 0 && ` · ${a.sources.length} sources`}
                      </p>
                      {a.status === 'stale' && a.staleBecause && (
                        <p className="mt-1 text-xs text-warning">
                          Dependent facts updated: {a.staleBecause.join(', ')}
                        </p>
                      )}
                    </div>
                    {a.status === 'stale' && (
                      <Button size="sm" variant="secondary" className="ml-3">
                        <RotateCcw size={14} className="mr-1" /> Regenerate
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          ) : null}
        </main>
      </div>
    </AppShell>
  );
}
