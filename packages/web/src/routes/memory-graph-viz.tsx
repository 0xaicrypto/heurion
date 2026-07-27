import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import cytoscape from 'cytoscape';
import {
  Brain, BookOpen, Lightbulb, FileText, Wrench, Hexagon, AlertTriangle,
  RotateCcw, X, Filter, Eye, EyeOff, Maximize2,
} from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, Input, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';

interface MemoryNode {
  id: string;
  stableId: string;
  type: 'fact' | 'article' | 'gap' | 'document' | 'entity' | 'skill';
  status: 'current' | 'stale' | 'superseded' | 'pending_review';
  content: string;
  title?: string;
  category?: string;
  sourceType?: string;
  patientHash?: string;
  version?: number;
  importance?: number;
  updatedAt?: number;
  createdAt?: number;
  staleBecause?: string[];
  impact?: { factId: string; status: string; content: string; message: string }[];
}

interface MemoryRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
}

const NODE_TYPES: MemoryNode['type'][] = ['fact', 'article', 'gap', 'document', 'entity', 'skill'];
const NODE_STATUS: MemoryNode['status'][] = ['current', 'stale', 'superseded', 'pending_review'];

const TYPE_LABELS: Record<MemoryNode['type'], string> = {
  fact: 'Fact',
  article: 'Article',
  gap: 'Gap',
  document: 'Document',
  entity: 'Entity',
  skill: 'Skill',
};

const TYPE_ICONS: Record<MemoryNode['type'], React.ElementType> = {
  fact: Brain,
  article: BookOpen,
  gap: Lightbulb,
  document: FileText,
  entity: Hexagon,
  skill: Wrench,
};

function nodeLabel(n: MemoryNode): string {
  if (n.title) return n.title.length > 30 ? n.title.slice(0, 30) + '…' : n.title;
  const text = n.content || '';
  return text.length > 40 ? text.slice(0, 40) + '…' : text || n.stableId;
}

function formatDate(ts?: number) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString();
}

export function MemoryGraphVizPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const patientHash = searchParams.get('patient') || undefined;

  const [nodes, setNodes] = useState<MemoryNode[]>([]);
  const nodesRef = useRef<MemoryNode[]>(nodes);
  nodesRef.current = nodes;
  const [relations, setRelations] = useState<MemoryRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);
  const [search, setSearch] = useState('');
  const [filterTypes, setFilterTypes] = useState<Set<MemoryNode['type']>>(new Set(NODE_TYPES));
  const [filterStatus, setFilterStatus] = useState<Set<MemoryNode['status']>>(new Set(['current', 'stale', 'pending_review']));
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [showLabels, setShowLabels] = useState(true);

  const cyContainerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getMemoryGraph(patientHash, includeSuperseded);
      setNodes(data.nodes.map((n: any) => ({ ...n, stableId: n.stableId || n.id })));
      setRelations(data.relations.map((r: any) => ({ ...r, id: r.id || `${r.sourceId}-${r.relation}-${r.targetId}` })));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : t('settings.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [patientHash, includeSuperseded, t]);

  useEffect(() => {
    load();
  }, [load]);

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes.filter((n) => {
      if (!filterTypes.has(n.type)) return false;
      if (!filterStatus.has(n.status)) return false;
      if (q) {
        const text = `${n.content || ''} ${n.title || ''} ${n.stableId || ''}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }, [nodes, filterTypes, filterStatus, search]);

  const visibleNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.stableId)), [filteredNodes]);
  const visibleEdges = useMemo(
    () => relations.filter((r) => visibleNodeIds.has(r.sourceId) && visibleNodeIds.has(r.targetId)),
    [relations, visibleNodeIds],
  );

  // Initialize Cytoscape
  useEffect(() => {
    if (!cyContainerRef.current) return;
    const cy = cytoscape({
      container: cyContainerRef.current,
      style: [
        {
          selector: 'node',
          style: {
            label: showLabels ? 'data(label)' : '',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'font-size': '10px',
            'text-margin-y': 4,
            color: 'hsl(var(--text-primary))',
            'background-color': '#94a3b8',
            width: 28,
            height: 28,
            'border-width': 2,
            'border-color': 'transparent',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': 'hsl(var(--border-strong))',
            'target-arrow-color': 'hsl(var(--border-strong))',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.8,
            label: showLabels ? 'data(label)' : '',
            'font-size': '9px',
            color: 'hsl(var(--text-tertiary))',
            'text-background-color': 'hsl(var(--background))',
            'text-background-opacity': 0.8,
            'text-background-padding': '2',
            'text-background-shape': 'roundrectangle',
          },
        },
        { selector: '.type-fact', style: { 'background-color': '#3b82f6' } },
        { selector: '.type-article', style: { 'background-color': '#8b5cf6', width: 36, height: 36 } },
        { selector: '.type-gap', style: { 'background-color': '#f59e0b', shape: 'diamond' } },
        { selector: '.type-document', style: { 'background-color': '#64748b' } },
        { selector: '.type-entity', style: { 'background-color': '#f97316', shape: 'hexagon' } },
        { selector: '.type-skill', style: { 'background-color': '#06b6d4' } },
        { selector: '.status-stale', style: { 'border-color': '#f59e0b', 'border-width': 3, 'border-style': 'dashed' } },
        { selector: '.status-superseded', style: { 'background-opacity': 0.35, 'border-color': '#94a3b8', 'border-style': 'dashed' } },
        { selector: '.status-pending_review', style: { 'border-color': '#f97316', 'border-width': 3 } },
        { selector: '.relation-supersedes', style: { 'line-style': 'dashed', 'line-color': '#ef4444', 'target-arrow-color': '#ef4444' } },
        { selector: '.relation-answers', style: { 'line-color': '#22c55e', 'target-arrow-color': '#22c55e', 'line-style': 'dashed' } },
        { selector: '.relation-depends_on', style: { 'line-color': '#8b5cf6', 'target-arrow-color': '#8b5cf6' } },
        { selector: '.relation-derives_from', style: { 'line-style': 'dotted' } },
        { selector: '.highlight', style: { 'background-color': '#eab308', 'border-color': '#eab308', 'line-color': '#eab308', 'target-arrow-color': '#eab308' } },
        { selector: '.dimmed', style: { opacity: 0.15 } },
      ],
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.3,
    });

    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      const node = nodesRef.current.find((n) => n.stableId === id) || null;
      setSelectedNode(node);
    });

    cy.on('tap', (evt) => {
      if (evt.target === cy) setSelectedNode(null);
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, showLabels]);

  // Update elements when filtered data changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().remove();

    const cyNodes = filteredNodes.map((n) => ({
      data: {
        id: n.stableId,
        label: nodeLabel(n),
        type: n.type,
        status: n.status,
      },
      classes: [`type-${n.type}`, `status-${n.status}`],
    }));

    const cyEdges = visibleEdges.map((r) => ({
      data: {
        id: r.id,
        source: r.sourceId,
        target: r.targetId,
        label: r.relation,
        relation: r.relation,
      },
      classes: [`relation-${r.relation}`],
    }));

    cy.add([...cyNodes, ...cyEdges]);

    if (cyNodes.length > 0) {
      const layout = cy.layout({
        name: 'cose',
        animate: true,
        animationDuration: 500,
        fit: true,
        padding: 24,
        componentSpacing: 80,
        nodeRepulsion: 4000,
        idealEdgeLength: 80,
      });
      layout.run();
    }
  }, [filteredNodes, visibleEdges]);

  // Highlight neighborhood when selected node changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass('dimmed highlight');
    if (!selectedNode) return;
    const target = cy.getElementById(selectedNode.stableId);
    if (!target || target.length === 0) return;
    const neighborhood = target.closedNeighborhood();
    cy.elements().not(neighborhood).addClass('dimmed');
    neighborhood.addClass('highlight');
  }, [selectedNode]);

  const toggleType = (type: MemoryNode['type']) => {
    setFilterTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleStatus = (status: MemoryNode['status']) => {
    setFilterStatus((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const fitGraph = () => {
    cyRef.current?.fit(undefined, 24);
  };

  const regenerateArticle = async (id: string) => {
    await api.regenerateKnowledgeArticle(id);
    load();
  };

  const detailRail = selectedNode ? (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-center gap-2">
          {(() => {
            const Icon = TYPE_ICONS[selectedNode.type];
            return <Icon size={18} className="text-accent" />;
          })()}
          <h3 className="text-lg font-semibold text-text-primary">
            {TYPE_LABELS[selectedNode.type]}
          </h3>
        </div>
        <button onClick={() => setSelectedNode(null)} className="text-text-tertiary hover:text-text-primary">
          <X size={18} />
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-sm text-text-secondary">{selectedNode.title || selectedNode.content}</p>
          {selectedNode.title && selectedNode.content && (
            <p className="mt-2 text-xs text-text-tertiary line-clamp-4">{selectedNode.content}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-surface-elevated p-2">
            <span className="text-text-tertiary">Status</span>
            <div className="mt-1">
              <Badge variant={selectedNode.status === 'stale' ? 'warning' : selectedNode.status === 'superseded' ? 'default' : 'default'}>
                {selectedNode.status}
              </Badge>
            </div>
          </div>
          <div className="rounded-lg bg-surface-elevated p-2">
            <span className="text-text-tertiary">Version</span>
            <div className="mt-1 font-medium text-text-primary">v{selectedNode.version ?? 1}</div>
          </div>
          {selectedNode.category && (
            <div className="rounded-lg bg-surface-elevated p-2">
              <span className="text-text-tertiary">Category</span>
              <div className="mt-1 font-medium text-text-primary">{selectedNode.category}</div>
            </div>
          )}
          {selectedNode.importance != null && (
            <div className="rounded-lg bg-surface-elevated p-2">
              <span className="text-text-tertiary">Importance</span>
              <div className="mt-1 font-medium text-text-primary">{selectedNode.importance}/5</div>
            </div>
          )}
        </div>

        <div className="text-xs text-text-tertiary">
          <div>Updated: {formatDate(selectedNode.updatedAt || selectedNode.createdAt)}</div>
          <div className="mt-1 break-all">ID: {selectedNode.stableId}</div>
        </div>

        {selectedNode.status === 'stale' && selectedNode.impact && selectedNode.impact.length > 0 && (
          <div className="rounded-lg bg-warning/10 p-3">
            <div className="mb-2 flex items-center gap-1 text-xs font-medium text-warning">
              <AlertTriangle size={14} /> Stale because
            </div>
            <ul className="space-y-1 text-xs text-text-secondary">
              {selectedNode.impact.map((imp, idx) => (
                <li key={idx}>{imp.message}</li>
              ))}
            </ul>
          </div>
        )}

        {selectedNode.type === 'article' && selectedNode.status === 'stale' && (
          <Button size="sm" variant="secondary" onClick={() => regenerateArticle(selectedNode.stableId)}>
            <RotateCcw size={14} className="mr-1" /> Regenerate
          </Button>
        )}
      </div>
    </div>
  ) : null;

  return (
    <AppShell rail={detailRail}>
      <div className="flex h-full flex-col overflow-hidden">
        {/* Toolbar */}
        <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2">
          <div className="flex items-center gap-2">
            <Brain size={18} className="text-accent" />
            <h1 className="font-semibold text-text-primary">Memory Graph</h1>
            <Badge variant="default">{filteredNodes.length}</Badge>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Input
              type="text"
              placeholder="Search nodes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-48 text-sm"
            />

            <Button size="sm" variant="secondary" onClick={fitGraph}>
              <Maximize2 size={14} className="mr-1" /> Fit
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowLabels((v) => !v)}>
              {showLabels ? <EyeOff size={14} className="mr-1" /> : <Eye size={14} className="mr-1" />}
              {showLabels ? 'Hide labels' : 'Show labels'}
            </Button>
            <Button size="sm" variant="secondary" onClick={load}>
              <RotateCcw size={14} className="mr-1" /> Refresh
            </Button>
          </div>
        </header>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/50 px-4 py-2 text-xs">
          <Filter size={14} className="text-text-tertiary" />
          {NODE_TYPES.map((type) => (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-1 transition-colors',
                filterTypes.has(type)
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text-tertiary hover:text-text-secondary',
              )}
            >
              {(() => {
                const Icon = TYPE_ICONS[type];
                return <Icon size={12} />;
              })()}
              {TYPE_LABELS[type]}
            </button>
          ))}
          <div className="mx-2 h-4 w-px bg-border" />
          {NODE_STATUS.map((status) => (
            <button
              key={status}
              onClick={() => toggleStatus(status)}
              className={cn(
                'rounded-full border px-2 py-1 transition-colors',
                filterStatus.has(status)
                  ? 'border-text-primary bg-surface-elevated text-text-primary'
                  : 'border-border text-text-tertiary hover:text-text-secondary',
              )}
            >
              {status}
            </button>
          ))}
          <label className="ml-2 flex items-center gap-1 text-text-secondary">
            <input
              type="checkbox"
              className="rounded border-border"
              checked={includeSuperseded}
              onChange={(e) => setIncludeSuperseded(e.target.checked)}
            />
            Include superseded
          </label>
        </div>

        {/* Canvas */}
        <div className="relative flex-1 bg-background">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
              <Card className="p-6 text-center">
                <Skeleton className="mx-auto mb-3 h-8 w-8 rounded-full" />
                <p className="text-sm text-text-secondary">Loading memory graph...</p>
              </Card>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 p-6">
              <Alert variant="error" className="max-w-md">{error}</Alert>
            </div>
          )}
          <div ref={cyContainerRef} className="h-full w-full" />
        </div>
      </div>
    </AppShell>
  );
}
