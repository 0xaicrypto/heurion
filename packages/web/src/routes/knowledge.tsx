import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api-client';
import { Button, Card, Skeleton, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { BookOpen, Brain, Lightbulb, Wrench, AlertTriangle, RotateCcw, Check, Clock, FileText, Trash2, Edit3, User, Stethoscope, FlaskConical, Globe, X } from 'lucide-react';

interface Article {
  id: string; title: string; content: string; sources: string[];
  version: number; status: string; staleBecause?: string[];
  createdAt: number; updatedAt: number;
}
interface Fact {
  id: string; category: string; importance: number; content: string;
  count: number; sourceType?: string; patientHash?: string; studyId?: string;
  createdAt: number; updatedAt: number; lastSeenAt: number;
}
interface Gap {
  id: string; query: string; context: string; status: string; detectedAt: number;
}
interface Tool {
  id: string; name: string; description: string; language: string;
  enabled: boolean; createdAt: number;
}

type Tab = 'articles' | 'facts' | 'gaps' | 'tools' | 'files';

const TABS: { key: Tab; label: string; icon: typeof BookOpen }[] = [
  { key: 'articles', label: 'Articles', icon: BookOpen },
  { key: 'facts', label: 'Facts', icon: Brain },
  { key: 'gaps', label: 'Pending', icon: Clock },
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'files', label: 'Files', icon: FileText },
];

export function KnowledgePage() {
  const [tab, setTab] = useState<Tab>('articles');
  const [articles, setArticles] = useState<Article[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [files, setFiles] = useState<Array<{file_id: string; name: string; mime: string; size_bytes: number; created_at: string}>>([]);
  const [loading, setLoading] = useState(true);
  const [editingFact, setEditingFact] = useState<Fact | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editSource, setEditSource] = useState('general');

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      api.getKnowledge().then(r => setArticles(r.articles)).catch(() => {}),
      api.getFacts().then(r => setFacts(r.facts)).catch(() => {}),
      api.getKnowledgeGaps().then(r => setGaps(r.gaps)).catch(() => {}),
      api.getKnowledgeTools().then(r => setTools(r.tools)).catch(() => {}),
      api.listFiles().then(r => setFiles(r.files)).catch(() => {}),
    ]).finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, []);

  const staleCount = articles.filter(a => a.status === 'stale').length;
  const pendingCount = gaps.filter(g => g.status === 'pending').length;

  const resolveGap = async (gapId: string) => {
    await api.resolveKnowledgeGap(gapId).catch(() => {});
    loadAll();
  };

  const deleteFact = async (id: string) => {
    await api.deleteFact(id).catch(() => {});
    loadAll();
  };

  const saveFact = async () => {
    if (!editingFact) return;
    await api.updateFact(editingFact.id, { content: editContent, sourceType: editSource }).catch(() => {});
    setEditingFact(null);
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
                <div className="space-y-6">
                  {(['patient', 'doctor', 'research', 'general'] as const).map(sourceType => {
                    const groupFacts = facts.filter(f => f.sourceType === sourceType || (!f.sourceType && sourceType === 'general'))
                    if (groupFacts.length === 0) return null
                    const Icon = sourceType === 'patient' ? User : sourceType === 'doctor' ? Stethoscope : sourceType === 'research' ? FlaskConical : Globe
                    const label = sourceType === 'patient' ? 'Patient Facts' : sourceType === 'doctor' ? 'Doctor & Preferences' : sourceType === 'research' ? 'Research & Studies' : 'General'
                    return (
                      <div key={sourceType}>
                        <h3 className="flex items-center gap-2 mb-3 text-sm font-semibold text-text-secondary">
                          <Icon size={16} /> {label} ({groupFacts.length})
                        </h3>
                        <div className="space-y-2">
                          {groupFacts.map(f => (
                            <Card key={f.id} className="p-3">
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
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    className="p-1 rounded hover:bg-surface-elevated text-text-tertiary hover:text-text-primary"
                                    onClick={() => { setEditingFact(f); setEditContent(f.content); setEditSource(f.sourceType || 'general'); }}
                                  ><Edit3 size={14} /></button>
                                  <button
                                    className="p-1 rounded hover:bg-surface-elevated text-text-tertiary hover:text-error"
                                    onClick={() => deleteFact(f.id)}
                                  ><Trash2 size={14} /></button>
                                </div>
                              </div>
                            </Card>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {facts.length === 0 && (
                    <Card className="p-8 text-center">
                      <Brain size={32} className="mx-auto mb-3 text-text-tertiary" />
                      <p className="text-text-secondary">No facts stored yet.</p>
                      <p className="mt-1 text-sm text-text-tertiary">Facts are extracted from conversations and imported data.</p>
                    </Card>
                  )}

                  {/* Edit modal */}
                  {editingFact && (
                    <Card className="p-4 border-accent">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="font-medium text-sm">Edit Fact</h3>
                        <button onClick={() => setEditingFact(null)}><X size={16} className="text-text-tertiary" /></button>
                      </div>
                      <textarea
                        className="w-full rounded border border-border bg-surface-elevated p-2 text-sm mb-3 h-20"
                        value={editContent}
                        onChange={e => setEditContent(e.target.value)}
                      />
                      <div className="flex items-center gap-3 mb-3">
                        {(['patient', 'doctor', 'research', 'general'] as const).map(s => (
                          <label key={s} className="flex items-center gap-1 text-xs">
                            <input type="radio" name="sourceType" value={s} checked={editSource === s} onChange={() => setEditSource(s)} />
                            {s}
                          </label>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={saveFact}><Check size={14} className="mr-1" /> Save</Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditingFact(null)}>Cancel</Button>
                      </div>
                    </Card>
                  )}
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
              {/* ── Files ── */}
              {tab === 'files' && (
                <div className="space-y-3">
                  {files.length === 0 && (
                    <Card className="p-8 text-center">
                      <FileText size={32} className="mx-auto mb-3 text-text-tertiary" />
                      <p className="text-text-secondary">No uploaded files.</p>
                      <p className="mt-1 text-sm text-text-tertiary">Upload files via chat or the Files page.</p>
                    </Card>
                  )}
                  {files.map(f => (
                    <Card key={f.file_id} className="p-4">
                      <div className="flex items-center gap-3">
                        <FileText size={18} className="text-text-tertiary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-text-primary truncate">{f.name}</p>
                          <p className="text-xs text-text-tertiary">
                            {f.mime} · {(f.size_bytes / 1024).toFixed(1)} KB · {new Date(f.created_at).toLocaleDateString()}
                          </p>
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
