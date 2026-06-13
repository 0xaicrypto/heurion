/**
 * Memory-aware UI components (UX v2 §7).
 *
 * CitationChip 2.0   — hover preview + click opens context rail
 * ProvenanceCard     — full provenance trail rendered in the rail
 * TierIndicator      — small chip showing T1/T2/T3 with elapsed seconds
 * ReasoningPane      — collapsible streaming reasoning for T3
 * StreamedMessage    — agent bubble that updates as final_answer_chunk arrives
 *
 * All components close over the new ApiClient methods + types — see
 * src/lib/types.ts.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  Camera, FileText, ChevronDown, ChevronRight, Loader2, X,
} from 'lucide-react';
import { api } from '../lib/api-client';
import type { ProvenanceRow, TierKind } from '../lib/types';
import { useAppState } from '../store';
import { cn } from '../lib/util';

/* ───────────── CitationChip 2.0 ───────────── */

export function CitationChip2({
  index,
  nodeId,
  hint,
  hasImage = false,
}: {
  index: number;
  nodeId: number;
  hint?: string;
  hasImage?: boolean;
}) {
  const [prov, setProv] = useState<ProvenanceRow | null>(null);
  const openContext = useAppState((s) => s.openContextRailForCitation);

  // Pre-fetch on render to keep hover preview instant (UX v2 §13 R4).
  useEffect(() => {
    let cancelled = false;
    api.getCitation(nodeId).then(
      (p) => { if (!cancelled) setProv(p); },
      () => { /* silent — hint fallback */ },
    );
    return () => { cancelled = true; };
  }, [nodeId]);

  return (
    <button
      title={prov?.evidenceQuote.slice(0, 60) ?? hint ?? `citation ${index}`}
      onClick={() => openContext(nodeId)}
      className={cn(
        'inline-flex items-center gap-0.5 h-4 min-w-[16px] px-1 rounded-[4px]',
        'border border-border bg-surface align-super',
        'text-[10px] font-mono text-text-secondary',
        'hover:border-accent hover:text-accent transition-colors duration-80',
      )}
    >
      {index}
      {hasImage && <Camera size={9} aria-hidden />}
    </button>
  );
}

/* ───────────── ProvenanceCard ───────────── */

export function ProvenanceCard({ nodeId }: { nodeId: number }) {
  const [prov, setProv] = useState<ProvenanceRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProv(null);
    setError(null);
    api.getCitation(nodeId).then(
      (p) => { if (!cancelled) setProv(p); },
      (e) => { if (!cancelled) setError(String(e)); },
    );
    return () => { cancelled = true; };
  }, [nodeId]);

  if (error) {
    return (
      <div className="text-caption text-retract">Failed to load: {error}</div>
    );
  }
  if (!prov) {
    return (
      <div className="flex items-center gap-2 text-caption text-text-tertiary">
        <Loader2 size={12} className="animate-spin" /> loading provenance…
      </div>
    );
  }

  const isImaging = prov.sourceKind === 'study';

  return (
    <div className="flex flex-col gap-3 selectable">
      <div className="flex items-center gap-2 text-caption text-text-tertiary">
        {isImaging ? <Camera size={12} /> : <FileText size={12} />}
        <span className="font-mono">{prov.sourceKind}</span>
        <span>·</span>
        <span className="font-mono truncate">{prov.sourceRef}</span>
      </div>

      {/* Source-kind-specific preview */}
      {isImaging && (
        <div className="rounded-md border border-border bg-bg p-4 text-center text-text-tertiary">
          {prov.sourceLocator?.slice_no != null
            ? `slice ${String(prov.sourceLocator.slice_no)} (image not yet wired — M1.5)`
            : 'imaging source'}
        </div>
      )}

      {/* Verbatim evidence quote */}
      <div className="border-l-2 border-accent bg-accent-subtle/40 px-3 py-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-text-tertiary">
          evidence
        </div>
        <p className="text-body italic text-text-primary">
          {prov.evidenceQuote}
        </p>
      </div>

      {/* Metadata grid */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
        <dt className="text-text-tertiary">Bundle</dt>
        <dd className="font-mono text-text-secondary">{prov.extractionModel}</dd>
        <dt className="text-text-tertiary">Prompt</dt>
        <dd className="font-mono text-text-secondary">{prov.extractionPromptId}</dd>
        <dt className="text-text-tertiary">Confidence</dt>
        <dd className="font-mono text-text-secondary">{prov.confidence.toFixed(2)}</dd>
        <dt className="text-text-tertiary">PHI scrub</dt>
        <dd className="font-mono text-text-secondary">{prov.redactionVersion}</dd>
        <dt className="text-text-tertiary">Recorded</dt>
        <dd className="font-mono text-text-secondary">
          {new Date(prov.extractedAt * 1000).toLocaleString()}
        </dd>
      </dl>

      {prov.retractedAt && (
        <div className="rounded-sm border border-retract/40 bg-retract/10 px-3 py-2 text-caption text-retract">
          Retracted on {new Date(prov.retractedAt * 1000).toLocaleString()}
        </div>
      )}
    </div>
  );
}

/* ───────────── TierIndicator ───────────── */

export function TierIndicator({
  tier,
  elapsedMs,
  onCancel,
}: {
  tier: TierKind;
  elapsedMs?: number;
  onCancel?: () => void;
}) {
  const labels: Record<TierKind, string> = {
    T1: 'instant',
    T2: 'searching',
    T3: 'reasoning',
  };
  const showSeconds = tier === 'T3' && elapsedMs != null;
  return (
    <div className="inline-flex items-center gap-2 text-caption text-text-tertiary">
      <span
        className={cn(
          'inline-block w-1.5 h-1.5 rounded-full',
          tier === 'T1' && 'bg-confirmed',
          tier === 'T2' && 'bg-accent',
          tier === 'T3' && 'bg-caution animate-pulse',
        )}
      />
      <span className="font-mono">{tier}</span>
      <span>·</span>
      <span>{labels[tier]}</span>
      {showSeconds && (
        <>
          <span>·</span>
          <span className="font-mono">{(elapsedMs! / 1000).toFixed(1)}s</span>
        </>
      )}
      {onCancel && tier === 'T3' && (
        <button
          onClick={onCancel}
          className="ml-2 rounded-sm border border-border px-1.5 py-0.5 text-[10px] hover:border-border-strong"
        >
          cancel
        </button>
      )}
    </div>
  );
}

/* ───────────── ReasoningPane (collapsible) ───────────── */

export function ReasoningPane({
  steps,
  defaultOpen = false,
}: {
  steps: ReactNode[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (steps.length === 0) return null;
  return (
    <div className="mb-3 border-l-2 border-border pl-3 text-caption text-text-secondary">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 hover:text-text-primary"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span>thinking ({steps.length})</span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1">
          {steps.map((s, i) => (
            <li key={i} className="leading-relaxed">{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ───────────── ConflictInlineBanner ───────────── */

export function ConflictInlineBanner({
  count,
  onResolve,
}: {
  count: number;
  onResolve: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="mb-3 flex items-center justify-between rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-caption text-caution">
      <span>
        ⚠ This patient has {count} unresolved memory conflict{count > 1 ? 's' : ''}
      </span>
      <button
        onClick={onResolve}
        className="rounded-sm border border-caution/40 px-2 py-0.5 hover:bg-caution/10"
      >
        resolve →
      </button>
    </div>
  );
}

/* ───────────── ContextRailContent (renders ProvenanceCard) ───────────── */

export function ContextRailContent() {
  const content = useAppState((s) => s.contextRailContent);
  const close = useAppState((s) => s.closeContextRail);

  if (!content || content.kind === 'closed') return null;

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-bg">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
          Context
        </div>
        <button
          onClick={close}
          className="rounded-sm p-1 text-text-tertiary hover:bg-accent-subtle hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {content.kind === 'citation' && <ProvenanceCard nodeId={content.nodeId} />}
      </div>
    </aside>
  );
}
