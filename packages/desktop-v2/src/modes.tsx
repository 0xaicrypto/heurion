/**
 * Seven main-canvas modes. U1.1: Today/Patient/Encounter now real-backend.
 * U3.0: Memory rebuilt as layered view (L1 patient graph / L2 practitioner /
 *       L3 reference / meta). Report wired up as structured-impression
 *       composer with PDF / FHIR DiagnosticReport / DICOM SR export.
 *       Imaging/Labs remain stubs (U2/U3+).
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppState } from './store';
import { Button, Card, Chip, Section, EmptyState, Input } from './components/ui';
import {
  CitationChip2,
  ReasoningPane,
  TierIndicator,
  ConflictInlineBanner,
} from './components/memory-ui';
import { api, ApiError } from './lib/api-client';
import { MODE_LABELS, patientDisplayLabel, cn } from './lib/util';
import type {
  CitationRef,
  GraphNodeOut,
  PatientProjection,
  PractitionerCandidate,
  StudyInfo,
  TierKind,
} from './lib/types';

/* ─────────────── Today ─────────────── */

export function TodayMode() {
  const patients = useAppState((s) => s.patients);
  const setActivePatient = useAppState((s) => s.setActivePatient);
  const refreshPatients = useAppState((s) => s.refreshPatients);
  const llmStatus       = useAppState((s) => s.llmStatus);
  const llmChecked      = useAppState((s) => s.llmStatusChecked);
  const openSettings    = useAppState((s) => s.openSettingsOverlay);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    refreshPatients();
    api.practitionerPendingCount().then(setPendingCount).catch(() => {});
  }, [refreshPatients]);

  // Show a one-time, prominent setup card when no LLM key is configured
  // for the active provider. The top-of-screen banner ALSO fires (it
  // follows the medic everywhere), but landing right next to "Pinned
  // today" — the first thing seen on launch — makes the dependency
  // unmissable.
  const needsLlmSetup = llmChecked && llmStatus && llmStatus.advisory;

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return (
    <div className="mx-auto max-w-2xl px-10 py-16">
      <div className="text-center">
        <h1 className="font-display text-display text-text-primary">{greeting}</h1>
        <p className="mt-2 text-body text-text-secondary">{today}</p>
      </div>

      {needsLlmSetup && (
        <div className="mt-8">
          <Card className="!p-5 !border-caution/50 !bg-caution/5">
            <div className="text-caption font-medium text-caution">
              Set up an LLM API key to enable chat & reasoning
            </div>
            <p className="mt-2 text-body text-text-secondary">
              {llmStatus!.advisory} Keys are stored locally at
              {' '}<span className="font-mono">{llmStatus!.envFilePath}</span>{' '}
              — the same file v1 used. They never leave your machine.
            </p>
            <div className="mt-3">
              <Button variant="primary" onClick={openSettings}>
                Open Settings · LLM →
              </Button>
            </div>
          </Card>
        </div>
      )}

      {pendingCount > 0 && (
        <div className="mt-8">
          <Card className="!p-5 border-accent/40">
            <div className="text-caption font-medium text-accent">
              Nexus has learned {pendingCount} new pattern{pendingCount > 1 ? 's' : ''}
            </div>
            <p className="mt-2 text-body text-text-secondary">
              Review and confirm via your avatar → "Nexus has learned".
            </p>
          </Card>
        </div>
      )}

      <Section title="Pinned today">
        {patients.length === 0 ? (
          <p className="text-caption text-text-tertiary">
            No patients on file yet. Click "⊕ New patient" in the header to start.
          </p>
        ) : (
          <div className="space-y-1">
            {patients.slice(0, 5).map((p) => (
              <button
                key={p.patientHash}
                onClick={() => setActivePatient(p)}
                className="flex w-full items-center justify-between rounded-sm px-3 py-2 text-left hover:bg-accent-subtle"
              >
                <div className="flex items-center gap-3">
                  <span className="text-caption text-text-primary">
                    {patientDisplayLabel(p)}
                  </span>
                  <span className="text-caption text-text-tertiary">
                    {p.sex} · {p.ageGroup}
                  </span>
                </div>
                <Chip mono>{p.latestModality || '—'}</Chip>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="Ask Nexus about any patient">
        <Input placeholder="Type a question or paste an MRN…" />
      </Section>
    </div>
  );
}

/* ─────────────── Patient overview (real projection) ─────────────── */

export function PatientMode() {
  const p = useAppState((s) => s.activePatient);
  const setActiveMode = useAppState((s) => s.setActiveMode);
  const [proj, setProj] = useState<PatientProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!p) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getPatientProjection(p.patientHash).then(
      (r) => { if (!cancelled) { setProj(r); setLoading(false); } },
      (e) => { if (!cancelled) { setError(String(e)); setLoading(false); } },
    );
    return () => { cancelled = true; };
  }, [p]);

  if (!p) return <EmptyState title="No patient selected" />;

  return (
    <div className="mx-auto max-w-3xl px-10 py-12 selectable">
      <div className="mb-6">
        <h1 className="font-display text-display text-text-primary">
          {patientDisplayLabel(p)}
        </h1>
        <div className="mt-2 flex items-center gap-2 text-body text-text-secondary">
          <span>{p.sex || '—'}</span><span>·</span><span>{p.ageGroup || '—'}</span>
          <span>·</span>
          <span>{proj?.studies.length ?? '—'} studies</span>
        </div>
      </div>

      {proj && proj.unresolvedConflictCount > 0 && (
        <ConflictInlineBanner
          count={proj.unresolvedConflictCount}
          onResolve={() => setActiveMode('memory')}
        />
      )}

      {loading && (
        <p className="text-caption text-text-tertiary">Loading projection…</p>
      )}
      {error && (
        <p className="text-caption text-retract">Failed to load: {error}</p>
      )}

      {proj && (
        <>
          <Section title="Active findings">
            {proj.findings.length === 0 ? (
              <p className="text-caption text-text-tertiary">
                No active findings yet.
              </p>
            ) : (
              <ul className="space-y-1 text-body text-text-primary">
                {proj.findings.map((f) => (
                  <li key={f.nodeId} className="flex items-center gap-2">
                    <span>•</span>
                    <span>{(f.content as any).label ?? '(unlabeled)'}</span>
                    {(f.content as any).size_cm != null && (
                      <Chip variant="neutral">
                        {(f.content as any).size_cm} cm
                      </Chip>
                    )}
                    <CitationChip2 index={f.nodeId} nodeId={f.nodeId} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Medications">
            {proj.medications.length === 0 ? (
              <p className="text-caption text-text-tertiary">No medications recorded.</p>
            ) : (
              <ul className="space-y-1 text-body text-text-primary">
                {proj.medications.map((m) => (
                  <li key={m.nodeId}>• {(m.content as any).label ?? '?'}</li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Recent imaging">
            <RecentImagingSection patientHash={p.patientHash} />
          </Section>
        </>
      )}

      <div className="mt-10 flex justify-end">
        <Button variant="primary" onClick={() => setActiveMode('encounter')}>
          Open with Nexus →
        </Button>
      </div>
    </div>
  );
}

/* ─────────────── Recent imaging — DICOM previews ─────────────── */

/**
 * Lists every DICOM study for the patient (via /api/v1/dicom/patients/
 * {hash}/studies) and renders a thumbnail per study using the existing
 * /studies/{id}/series/{id}/render endpoint (4×4 grid preset — gives a
 * good "see the whole study at a glance" view for axial CT/MR).
 *
 * Preset rationale: backend's prerender pass writes 768 px PNGs to
 * <preview_dir>/slices/{idx}-{preset}.png at upload time (see dicom.py
 * eager cache lookup in /render). Hitting the render endpoint with
 * kind=grid does NOT use that cache — it composes per-call. For
 * thumbnails we want one image per study, so the grid preset is
 * acceptable cost (~50 ms server-side) and the resulting <img> can
 * cache via the browser.
 */
function RecentImagingSection({ patientHash }: { patientHash: string }) {
  const [studies, setStudies] = useState<StudyInfo[] | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStudies(null);
    setError(null);
    api.listPatientStudies(patientHash).then(
      (s) => { if (!cancelled) setStudies(s); },
      (e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
  }, [patientHash]);

  if (error) {
    return <p className="text-caption text-retract">Failed to load: {error}</p>;
  }
  if (studies === null) {
    return <p className="text-caption text-text-tertiary">Loading studies…</p>;
  }
  if (studies.length === 0) {
    return (
      <p className="text-caption text-text-tertiary">
        No DICOM studies yet — drop a <span className="font-mono">.zip</span>
        {' '}into <strong>Imaging</strong> and they'll appear here.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {studies.slice(0, 6).map((s) => (
        <StudyPreviewCard key={s.studyId} study={s} />
      ))}
    </div>
  );
}

function StudyPreviewCard({ study }: { study: StudyInfo }) {
  const [study2, setStudy2] = useState<StudyInfo | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);

  // We need a series_id to render. The list endpoint returns series=[]
  // for efficiency; re-fetch the full study lazily for the first card
  // mount.
  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;

    (async () => {
      try {
        const full = study.series.length > 0
          ? study
          : await api.getStudy(study.studyId);
        if (cancelled) return;
        setStudy2(full);

        // Prefer the primary series (largest instance count) for the
        // grid thumbnail — the prerender bundle key_image lives there.
        const primary = [...full.series]
          .sort((a, b) => (b.instanceCount || 0) - (a.instanceCount || 0))[0];
        if (!primary) {
          setImgErr('No series in study');
          return;
        }
        // Use the middle slice as the thumbnail.
        const mid = Math.max(0, Math.floor((primary.instanceCount || 1) / 2));
        const url = await api.renderBlobUrl(full.studyId, primary.seriesId, {
          kind:  'slice',
          slice: mid,
          window: 'default',
        });
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        blobUrl = url;
        setImgUrl(url);
      } catch (e) {
        if (!cancelled) {
          setImgErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [study.studyId]);

  const headerLeft = study.modality || study2?.modality || '?';
  const headerRight = study.studyDate || study2?.studyDate || '';
  const description = study.studyDescription || study2?.studyDescription || '';
  const seriesCount = (study2?.series.length ?? study.series.length) || 0;

  return (
    <a
      // Deep link to the backend's static Cornerstone viewer (mounted
      // at /dicom-viewer/?studyId=…). The browser opens it in a new
      // tab — full interactive viewing is out-of-scope for this card.
      href={`${api.baseUrl}/dicom-viewer/?studyId=${encodeURIComponent(study.studyId)}`}
      target="_blank"
      rel="noreferrer"
      className="block overflow-hidden rounded-md border border-border bg-surface transition-colors hover:border-border-strong"
    >
      <div className="relative aspect-square w-full bg-black">
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={`${headerLeft} ${headerRight}`}
            className="h-full w-full object-contain"
          />
        ) : imgErr ? (
          <div className="flex h-full w-full items-center justify-center p-3 text-caption text-retract">
            {imgErr}
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-caption text-text-tertiary">
            Rendering…
          </div>
        )}
        <div className="absolute left-2 top-2 flex items-center gap-1">
          <Chip mono variant="tinted">{headerLeft}</Chip>
        </div>
        {headerRight && (
          <div className="absolute right-2 top-2 font-mono text-[10px] text-text-tertiary">
            {headerRight}
          </div>
        )}
      </div>
      <div className="p-3">
        <div className="truncate text-body text-text-primary">
          {description || `Study ${study.studyId.slice(0, 8)}`}
        </div>
        <div className="mt-1 text-caption text-text-tertiary">
          {seriesCount} series · open viewer →
        </div>
      </div>
    </a>
  );
}

/* ─────────────── Encounter (real SSE) ─────────────── */

interface ChatMsg {
  role: 'user' | 'agent';
  text: string;
  ts: string;
  tier?: TierKind;
  reasoning?: string[];
  citations?: CitationRef[];
  elapsedMs?: number;
  streaming?: boolean;
}

export function EncounterMode() {
  const p = useAppState((s) => s.activePatient);
  const [draft, setDraft] = useState('');
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [sending, setSending] = useState(false);
  const [backendStatus, setBackendStatus] =
    useState<'ok' | 'unreachable' | 'unhealthy' | 'checking'>('checking');

  // Probe the backend once on mount. A failed probe lets us tell the
  // medic "backend not running" instead of the opaque "TypeError: Load
  // failed" that WebKit emits when fetch can't reach the sidecar.
  useEffect(() => {
    let cancelled = false;
    api.health().then((s) => { if (!cancelled) setBackendStatus(s); });
    return () => { cancelled = true; };
  }, []);

  if (!p) return <EmptyState title="No patient selected" />;

  async function send() {
    if (!draft.trim() || sending) return;
    const userText = draft;
    setDraft('');
    setMsgs((m) => [...m, { role: 'user', text: userText, ts: 'now' }]);
    setSending(true);

    const startTs = Date.now();
    const agentMsg: ChatMsg = {
      role: 'agent', text: '', ts: 'now',
      reasoning: [], citations: [], streaming: true,
    };
    setMsgs((m) => [...m, agentMsg]);

    const update = (mut: Partial<ChatMsg>) =>
      setMsgs((m) => {
        const last = m[m.length - 1];
        return [...m.slice(0, -1), { ...last, ...mut, elapsedMs: Date.now() - startTs }];
      });

    try {
      for await (const chunk of api.sendChat(userText, 'sess-encounter', p!.patientHash)) {
        switch (chunk.type) {
          case 'tier_classified':
            update({ tier: chunk.tier });
            break;
          case 'reasoning_chunk':
            setMsgs((m) => {
              const last = m[m.length - 1];
              return [
                ...m.slice(0, -1),
                { ...last, reasoning: [...(last.reasoning ?? []), chunk.text] },
              ];
            });
            break;
          case 'final_answer_chunk':
            setMsgs((m) => {
              const last = m[m.length - 1];
              return [
                ...m.slice(0, -1),
                { ...last, text: last.text + chunk.text },
              ];
            });
            break;
          case 'citations':
            update({ citations: chunk.refs });
            break;
          case 'turn_complete':
            update({ streaming: false });
            break;
          case 'error':
            update({ text: `[error: ${chunk.message}]`, streaming: false });
            break;
          default:
            break;
        }
      }
    } catch (err) {
      // Turn "TypeError: Load failed" into something the medic can act on.
      // The Tauri/WebKit fetch wrapper throws TypeError when the TCP
      // socket can't even be opened — almost always: backend sidecar
      // not running, or we're in `pnpm dev` without a separate FastAPI.
      let message: string;
      if (err instanceof ApiError) {
        message = err.message;
      } else if (err instanceof TypeError) {
        // Re-probe so the banner above updates too.
        api.health().then(setBackendStatus);
        message =
          'Backend is unreachable. Make sure the nexus-server sidecar is ' +
          'running (or launch FastAPI on http://127.0.0.1:8001 when using `pnpm dev`).';
      } else {
        message = String(err);
      }
      update({ text: `[connection error: ${message}]`, streaming: false });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col px-10 py-6">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-3 text-caption text-text-secondary">
        <span>{patientDisplayLabel(p)}</span>
        <span>{msgs.length} messages</span>
      </div>

      {backendStatus === 'unreachable' && (
        <div className="mb-3 flex items-center justify-between rounded-md border border-retract/40 bg-retract/5 px-3 py-2 text-caption text-retract">
          <span>
            Backend unreachable at <span className="font-mono">127.0.0.1:8001</span>.
            The nexus-server sidecar isn't responding — `pnpm tauri:dev` or
            launch the FastAPI server.
          </span>
          <button
            onClick={() => {
              setBackendStatus('checking');
              api.health().then(setBackendStatus);
            }}
            className="rounded-sm border border-retract/40 px-2 py-0.5 hover:bg-retract/10"
          >
            retry
          </button>
        </div>
      )}
      {backendStatus === 'unhealthy' && (
        <div className="mb-3 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-caption text-caution">
          Backend reachable but unhealthy. Check the sidecar logs.
        </div>
      )}

      <div className="flex-1 space-y-6 overflow-y-auto py-4 selectable">
        {msgs.length === 0 && (
          <p className="text-center text-caption text-text-tertiary">
            Ask Nexus anything about this patient. The agent uses the
            backend's tier-classified retrieval (T1 cached / T2 single-shot
            / T3 multi-turn streamed).
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i}>
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-caption font-medium text-text-primary">
                {m.role === 'user' ? 'You' : 'Nexus'}
              </span>
              <span className="text-caption text-text-tertiary">{m.ts}</span>
              {m.tier && (
                <TierIndicator tier={m.tier} elapsedMs={m.elapsedMs} />
              )}
            </div>
            {m.role === 'agent' && m.reasoning && m.reasoning.length > 0 && (
              <ReasoningPane steps={m.reasoning} defaultOpen={m.streaming} />
            )}
            <p className="text-body leading-relaxed text-text-primary whitespace-pre-wrap">
              {m.text || (m.streaming ? '…' : '')}
              {m.citations?.map((c, ci) => (
                <span key={c.node_id}>
                  {' '}
                  <CitationChip2 index={ci + 1} nodeId={c.node_id} />
                </span>
              ))}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="Ask anything about this patient…"
            disabled={sending}
          />
          <Button variant="primary" onClick={send} disabled={sending}
                  className="!px-5 !py-2">
            {sending ? '…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Memory mode (layered, per m3-memory-architecture.md) ─────────────── */

type LayerKey = 'L1' | 'L2' | 'L3' | 'meta';

interface LayerMeta {
  key: LayerKey;
  title: string;
  scope: string;           // chip — "per patient · PHI" etc.
  blurb: string;           // one-line explanation of what this layer holds.
}

const LAYERS: LayerMeta[] = [
  {
    key: 'L1',
    title: 'Layer 1 · Patient graph',
    scope: 'per patient · PHI',
    blurb:
      'Audit-grade clinical graph for THIS patient. Every node carries provenance back to a study, chat turn, or lab. Derived from twin_event_log; rebuildable byte-identical.',
  },
  {
    key: 'L2',
    title: 'Layer 2 · You (practitioner)',
    scope: 'per medic · cross-patient · PHI-stripped',
    blurb:
      'Patterns Nexus has learned about how YOU read — phrasing, workflow, thresholds, suggestion calibration. Aggregated across ≥N patients, only active after you confirm.',
  },
  {
    key: 'L3',
    title: 'Layer 3 · Universal reference',
    scope: 'shared · read-only · versioned',
    blurb:
      'NCCN / ACR-AC guidelines, RxNorm, RadLex, SNOMED-CT, ICD/CPT, lab reference ranges. Not learned — ingested from external sources; schema lives now, population is a separate workstream.',
  },
  {
    key: 'meta',
    title: 'Meta-layer · Evolution',
    scope: 'agent self-tuning · telemetry-driven',
    blurb:
      'Prompt versions, tier classifier thresholds, evidence-rank tuning, cached-view recipes, conflict thresholds. The agent modifying itself, fed by telemetry across all four layers.',
  },
];

/* node_type → human label + visual variant for L1 grouping */
const NODE_KIND_LABEL: Record<string, string> = {
  finding: 'Findings',
  med: 'Medications',
  ddx: 'Differentials',
  study: 'Studies',
  semantic_fact: 'Semantic facts',
  measurement: 'Measurements',
  lab: 'Labs',
  key_image: 'Key images',
  anatomical_region: 'Anatomical regions',
  episodic_event: 'Episodic events',
};

function LayerHeader({ meta, count }: { meta: LayerMeta; count?: number }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="font-display text-section text-text-primary">
        {meta.title}
        {count !== undefined && (
          <span className="ml-2 font-mono text-caption text-text-tertiary">
            ({count})
          </span>
        )}
      </h2>
      <Chip mono>{meta.scope}</Chip>
      <p className="basis-full text-caption text-text-secondary leading-relaxed">
        {meta.blurb}
      </p>
    </div>
  );
}

function LayerBand({
  meta,
  count,
  defaultOpen = true,
  children,
}: {
  meta: LayerMeta;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-8 rounded-md border border-border bg-surface/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-5 pt-4 pb-2 text-left hover:bg-accent-subtle/30"
      >
        <span className="mt-1 font-mono text-caption text-text-tertiary">
          {open ? '▾' : '▸'}
        </span>
        <div className="flex-1">
          <LayerHeader meta={meta} count={count} />
        </div>
      </button>
      {open && <div className="px-5 pb-5 pt-1">{children}</div>}
    </section>
  );
}

function L1NodeGroup({
  kind,
  nodes,
}: {
  kind: string;
  nodes: GraphNodeOut[];
}) {
  if (nodes.length === 0) return null;
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-caption font-medium text-text-primary">
          {NODE_KIND_LABEL[kind] ?? kind}
        </span>
        <span className="font-mono text-caption text-text-tertiary">
          ({nodes.length})
        </span>
      </div>
      <ul className="space-y-1 pl-3">
        {nodes.map((n) => {
          const c = n.content as Record<string, unknown>;
          const label =
            (c.label as string) ??
            (c.modality as string) ??
            (c.study_date as string) ??
            (c.name as string) ??
            `node #${n.nodeId}`;
          const detailParts: string[] = [];
          if (typeof c.size_cm === 'number' || typeof c.size_cm === 'string')
            detailParts.push(`${c.size_cm} cm`);
          if (kind === 'study' && typeof c.body_part === 'string')
            detailParts.push(c.body_part);
          if (kind === 'lab' && typeof c.value === 'string')
            detailParts.push(c.value);
          return (
            <li key={n.nodeId} className="flex items-center gap-2 text-body">
              <span className="text-text-tertiary">•</span>
              <span className="text-text-primary">{label}</span>
              {detailParts.map((d, i) => (
                <Chip key={i} variant="neutral">{d}</Chip>
              ))}
              <CitationChip2 index={n.nodeId} nodeId={n.nodeId} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function L1PatientGraph({ proj }: { proj: PatientProjection }) {
  // Group the projection arrays into one rendering loop so empty groups
  // just disappear instead of showing "(0)" rows everywhere.
  const groups: { kind: string; nodes: GraphNodeOut[] }[] = [
    { kind: 'finding',       nodes: proj.findings },
    { kind: 'med',           nodes: proj.medications },
    { kind: 'ddx',           nodes: proj.differentials },
    { kind: 'study',         nodes: proj.studies },
    { kind: 'semantic_fact', nodes: proj.semanticFacts },
  ];
  const total = groups.reduce((a, g) => a + g.nodes.length, 0);

  if (total === 0) {
    return (
      <p className="text-caption text-text-tertiary">
        No nodes yet. Drop a DICOM study, chat in Encounter, or paste a lab
        report — every ingester writes here.
      </p>
    );
  }
  return (
    <>
      {groups.map((g) => (
        <L1NodeGroup key={g.kind} kind={g.kind} nodes={g.nodes} />
      ))}
    </>
  );
}

const FACT_KIND_LABEL: Record<string, string> = {
  style:       'Style',
  workflow:    'Workflow',
  practice:    'Practice',
  calibration: 'Calibration',
};

function L2Practitioner() {
  const [cands, setCands] = useState<PractitionerCandidate[] | null>(null);
  const [err,   setErr]   = useState<string | null>(null);
  const openOverlay = useAppState((s) => s.openPractitionerOverlay);

  useEffect(() => {
    let cancelled = false;
    api.listPractitionerCandidates().then(
      (r) => { if (!cancelled) setCands(r); },
      (e) => { if (!cancelled) setErr(String(e)); },
    );
    return () => { cancelled = true; };
  }, []);

  if (err) {
    return <p className="text-caption text-retract">Failed to load: {err}</p>;
  }
  if (!cands) {
    return <p className="text-caption text-text-tertiary">Loading practitioner facts…</p>;
  }
  if (cands.length === 0) {
    return (
      <p className="text-caption text-text-tertiary">
        Nothing yet. Nexus needs to see a pattern across ≥5 patients before
        anything reaches here, and you'll be asked to confirm before it
        activates.
      </p>
    );
  }

  // Group by fact_kind.
  const byKind = new Map<string, PractitionerCandidate[]>();
  for (const c of cands) {
    if (!byKind.has(c.factKind)) byKind.set(c.factKind, []);
    byKind.get(c.factKind)!.push(c);
  }

  return (
    <>
      {Array.from(byKind.entries()).map(([kind, items]) => (
        <div key={kind} className="mb-4">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-caption font-medium text-text-primary">
              {FACT_KIND_LABEL[kind] ?? kind}
            </span>
            <span className="font-mono text-caption text-text-tertiary">
              ({items.length})
            </span>
          </div>
          <ul className="space-y-1 pl-3">
            {items.slice(0, 5).map((c) => (
              <li key={`${c.factKind}:${c.patternKey}`}
                  className="flex items-center gap-2 text-body">
                <span className="text-text-tertiary">•</span>
                <span className="text-text-primary truncate">{c.patternKey}</span>
                <Chip variant="neutral">
                  {c.distinctPatientCount} pt · conf {c.confidence.toFixed(2)}
                </Chip>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="mt-3">
        <Button variant="subtle" onClick={openOverlay}>
          Review & confirm →
        </Button>
      </div>
    </>
  );
}

const REFERENCE_SHELVES = [
  { id: 'nccn',   label: 'NCCN / ACR-AC',    note: 'Imaging-appropriateness + oncology guidelines' },
  { id: 'rxnorm', label: 'RxNorm',           note: 'Drug normalisation + interaction graph' },
  { id: 'radlex', label: 'RadLex',           note: 'Radiology terminology' },
  { id: 'snomed', label: 'SNOMED-CT',        note: 'Clinical findings + procedures' },
  { id: 'icd',    label: 'ICD / CPT',        note: 'Coding for billing + reporting' },
  { id: 'labs',   label: 'Lab ranges',       note: 'Age / sex stratified reference intervals' },
];

function L3Reference() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {REFERENCE_SHELVES.map((s) => (
        <Card key={s.id} className="!p-3">
          <div className="flex items-center justify-between">
            <span className="text-caption font-medium text-text-primary">
              {s.label}
            </span>
            <Chip variant="neutral">not yet populated</Chip>
          </div>
          <p className="mt-1 text-caption text-text-secondary">{s.note}</p>
        </Card>
      ))}
      <p className="col-span-full mt-1 text-caption text-text-tertiary">
        Schema lives; population is a separate workstream (M4). Once
        populated, Layer 3 snippets are composed into the system prompt
        whenever a turn cites a guideline-aware tool.
      </p>
    </div>
  );
}

function MetaLayer() {
  const items = [
    { label: 'Prompt versions',         note: 'Extraction template revisions' },
    { label: 'Tier thresholds',         note: 'T1 / T2 / T3 classifier cutoffs' },
    { label: 'Evidence-rank tuning',    note: 'Composer weight per source kind' },
    { label: 'Cached-view recipes',     note: 'Which projections are precomputed' },
    { label: 'Conflict thresholds',     note: 'Per-finding-type retraction sensitivity' },
  ];
  return (
    <ul className="space-y-1 text-body">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2">
          <span className="text-text-tertiary">•</span>
          <span className="text-text-primary">{i.label}</span>
          <span className="text-caption text-text-secondary">— {i.note}</span>
        </li>
      ))}
      <li className="mt-2 text-caption text-text-tertiary">
        Surfaces here read-only for now; tuning UI is Settings → Evolution
        (M5). See <span className="font-mono">docs/design/falsifiable-evolution.md</span>.
      </li>
    </ul>
  );
}

function RetrievalTierLegend() {
  const rows: { tier: TierKind; label: string; budget: string; example: string }[] = [
    { tier: 'T1', label: 'cached view',         budget: '≤ 50 ms',  example: '"how many studies?"' },
    { tier: 'T2', label: 'single-shot lookup',  budget: '≤ 300 ms', example: '"latest creatinine"' },
    { tier: 'T3', label: 'multi-turn reasoning', budget: '5–15 s',   example: '"what changed since the prior CT?"' },
  ];
  return (
    <div className="rounded-md border border-border bg-bg/40 px-4 py-3">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-text-tertiary">
        Retrieval tiers (how a turn composes the layers above)
      </div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.tier} className="flex flex-wrap items-center gap-2 text-caption">
            <TierIndicator tier={r.tier} />
            <span className="text-text-primary">{r.label}</span>
            <span className="text-text-tertiary">·</span>
            <span className="font-mono text-text-secondary">{r.budget}</span>
            <span className="text-text-tertiary">·</span>
            <span className="italic text-text-tertiary">{r.example}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MemoryMode() {
  const p = useAppState((s) => s.activePatient);
  const setActiveMode = useAppState((s) => s.setActiveMode);
  const [proj, setProj] = useState<PatientProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!p) return;
    let cancelled = false;
    setProj(null);
    setError(null);
    api.getPatientProjection(p.patientHash).then(
      (r) => { if (!cancelled) setProj(r); },
      (e) => { if (!cancelled) setError(String(e)); },
    );
    return () => { cancelled = true; };
  }, [p]);

  if (!p) return <EmptyState title="No patient selected" />;

  const l1Count = proj
    ? proj.findings.length + proj.medications.length + proj.differentials.length +
      proj.studies.length + proj.semanticFacts.length
    : undefined;

  return (
    <div className="mx-auto max-w-4xl px-10 py-12 selectable">
      <h1 className="font-display text-display text-text-primary">
        Memory · {patientDisplayLabel(p)}
      </h1>
      <p className="mt-2 text-caption text-text-secondary">
        Four-layer memory per <span className="font-mono">docs/design/m3-memory-architecture.md</span>.
        Layer 1 is this patient; Layer 2 is you across patients; Layer 3 is
        the world; meta-layer is how Nexus tunes itself.
      </p>

      {proj && proj.unresolvedConflictCount > 0 && (
        <div className="mt-4">
          <ConflictInlineBanner
            count={proj.unresolvedConflictCount}
            onResolve={() => setActiveMode('memory')}
          />
        </div>
      )}

      {error && (
        <p className="mt-4 text-caption text-retract">Failed to load: {error}</p>
      )}

      <div className="mt-8">
        <LayerBand meta={LAYERS[0]} count={l1Count}>
          {!proj
            ? <p className="text-caption text-text-tertiary">Loading patient graph…</p>
            : <L1PatientGraph proj={proj} />}
        </LayerBand>

        <LayerBand meta={LAYERS[1]} defaultOpen={false}>
          <L2Practitioner />
        </LayerBand>

        <LayerBand meta={LAYERS[2]} defaultOpen={false}>
          <L3Reference />
        </LayerBand>

        <LayerBand meta={LAYERS[3]} defaultOpen={false}>
          <MetaLayer />
        </LayerBand>
      </div>

      <div className="mt-8">
        <RetrievalTierLegend />
      </div>
    </div>
  );
}

/* ─────────────── Report mode (structured impression export) ─────────────── */

interface ReportDraft {
  clinicalInfo: string;
  selectedFindings: Set<number>;
  selectedDdx: Set<number>;
  impression: string;
  recommendation: string;
}

function buildImpressionDefault(proj: PatientProjection): string {
  if (proj.findings.length === 0) return '';
  const lines = proj.findings.slice(0, 5).map((f) => {
    const c = f.content as Record<string, unknown>;
    const label = (c.label as string) ?? '?';
    const size  = c.size_cm != null ? ` (${c.size_cm} cm)` : '';
    return `• ${label}${size}`;
  });
  return lines.join('\n');
}

function buildFhirDiagnosticReport(
  patientLabel: string,
  patientHash: string,
  proj: PatientProjection,
  draft: ReportDraft,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const pick = (arr: GraphNodeOut[], picked: Set<number>) =>
    arr.filter((n) => picked.has(n.nodeId));
  const findings = pick(proj.findings,      draft.selectedFindings);
  const ddx      = pick(proj.differentials, draft.selectedDdx);
  return {
    resourceType: 'DiagnosticReport',
    status: 'preliminary',
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: '18748-4',
          display: 'Diagnostic imaging report',
        },
      ],
    },
    subject: {
      identifier: { system: 'urn:rune:patient-hash', value: patientHash },
      display: patientLabel,
    },
    effectiveDateTime: now,
    issued: now,
    conclusion: draft.impression,
    conclusionCode: ddx.map((d) => ({
      text: (d.content as any).label ?? `node ${d.nodeId}`,
    })),
    result: findings.map((f) => ({
      reference: `Observation/${f.nodeId}`,
      display: (f.content as any).label ?? `node ${f.nodeId}`,
    })),
    presentedForm: [
      {
        contentType: 'text/plain',
        title: 'Clinical info',
        data: btoa(unescape(encodeURIComponent(draft.clinicalInfo))),
      },
      {
        contentType: 'text/plain',
        title: 'Recommendation',
        data: btoa(unescape(encodeURIComponent(draft.recommendation))),
      },
    ],
    extension: [
      {
        url: 'urn:rune:provenance-node-ids',
        valueString: findings.map((f) => f.nodeId).join(','),
      },
    ],
  };
}

function buildDicomSrStub(
  patientLabel: string,
  patientHash: string,
  proj: PatientProjection,
  draft: ReportDraft,
): Record<string, unknown> {
  // True DICOM SR (Part 3, TID 2000 "Basic Diagnostic Imaging Report") is
  // a binary DICOM dataset. The encoding requires pydicom on the server,
  // so for U3 we emit the SR content tree as JSON; backend M3.2 will turn
  // this into a real .dcm via tools/dicom_sr_writer.py.
  const pick = (arr: GraphNodeOut[], picked: Set<number>) =>
    arr.filter((n) => picked.has(n.nodeId));
  const findings = pick(proj.findings,      draft.selectedFindings);
  const ddx      = pick(proj.differentials, draft.selectedDdx);

  return {
    SOPClassUID:  '1.2.840.10008.5.1.4.1.1.88.33', // Comprehensive SR
    SOPInstanceUID: `urn:rune:sr:${patientHash}:${Date.now()}`,
    PatientID:    patientHash,
    PatientName:  patientLabel,
    StudyDate:    new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    ContentTemplateSequence: [
      { TemplateIdentifier: '2000', MappingResource: 'DCMR' },
    ],
    ContentSequence: [
      {
        ValueType:  'TEXT',
        ConceptNameCodeSequence: [{ CodeValue: '121060', CodingSchemeDesignator: 'DCM', CodeMeaning: 'History' }],
        TextValue:  draft.clinicalInfo,
      },
      {
        ValueType:  'CONTAINER',
        ConceptNameCodeSequence: [{ CodeValue: '121070', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Findings' }],
        ContinuityOfContent: 'SEPARATE',
        ContentSequence: findings.map((f) => ({
          ValueType: 'TEXT',
          ConceptNameCodeSequence: [{ CodeValue: '121071', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Finding' }],
          TextValue: (f.content as any).label ?? `node ${f.nodeId}`,
        })),
      },
      {
        ValueType:  'TEXT',
        ConceptNameCodeSequence: [{ CodeValue: '121072', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Impression' }],
        TextValue:  draft.impression,
      },
      {
        ValueType:  'CONTAINER',
        ConceptNameCodeSequence: [{ CodeValue: '121074', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Differential diagnosis' }],
        ContinuityOfContent: 'SEPARATE',
        ContentSequence: ddx.map((d) => ({
          ValueType: 'TEXT',
          ConceptNameCodeSequence: [{ CodeValue: '121075', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Differential' }],
          TextValue: (d.content as any).label ?? `node ${d.nodeId}`,
        })),
      },
      {
        ValueType:  'TEXT',
        ConceptNameCodeSequence: [{ CodeValue: '121076', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Recommendation' }],
        TextValue:  draft.recommendation,
      },
    ],
    _note: 'JSON content tree — backend M3.2 emits the real .dcm via pydicom.',
  };
}

function downloadBlob(filename: string, mime: string, body: string) {
  const blob = new Blob([body], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReportToggleList({
  title,
  nodes,
  selected,
  onToggle,
}: {
  title: string;
  nodes: GraphNodeOut[];
  selected: Set<number>;
  onToggle: (id: number) => void;
}) {
  if (nodes.length === 0) {
    return (
      <div className="mb-4">
        <div className="mb-1 text-caption font-medium text-text-primary">{title}</div>
        <p className="pl-3 text-caption text-text-tertiary">None on file.</p>
      </div>
    );
  }
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-caption font-medium text-text-primary">{title}</span>
        <span className="font-mono text-caption text-text-tertiary">
          ({selected.size}/{nodes.length})
        </span>
      </div>
      <ul className="space-y-1 pl-1">
        {nodes.map((n) => {
          const c     = n.content as Record<string, unknown>;
          const label = (c.label as string) ?? `node ${n.nodeId}`;
          const size  = (c.size_cm as number | string | undefined);
          const isOn  = selected.has(n.nodeId);
          return (
            <li key={n.nodeId}>
              <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent-subtle">
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={() => onToggle(n.nodeId)}
                  className="accent-accent"
                />
                <span className="text-body text-text-primary">{label}</span>
                {size != null && <Chip variant="neutral">{size} cm</Chip>}
                <CitationChip2 index={n.nodeId} nodeId={n.nodeId} />
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ReportMode() {
  const p = useAppState((s) => s.activePatient);
  const showToast = useAppState((s) => s.showToast);
  const [proj, setProj] = useState<PatientProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<ReportDraft>(() => ({
    clinicalInfo: '',
    selectedFindings: new Set(),
    selectedDdx: new Set(),
    impression: '',
    recommendation: '',
  }));

  useEffect(() => {
    if (!p) return;
    let cancelled = false;
    setProj(null);
    setError(null);
    api.getPatientProjection(p.patientHash).then(
      (r) => {
        if (cancelled) return;
        setProj(r);
        // Pre-fill: select every finding + ddx so the medic deselects
        // what they don't want rather than building the list from zero.
        setDraft((d) => ({
          ...d,
          selectedFindings: new Set(r.findings.map((f) => f.nodeId)),
          selectedDdx:      new Set(r.differentials.map((dx) => dx.nodeId)),
          impression: d.impression || buildImpressionDefault(r),
        }));
      },
      (e) => { if (!cancelled) setError(String(e)); },
    );
    return () => { cancelled = true; };
  }, [p]);

  const patientLabel = useMemo(() => (p ? patientDisplayLabel(p) : ''), [p]);

  if (!p) return <EmptyState title="No patient selected" />;
  if (error) return <p className="p-10 text-caption text-retract">Failed: {error}</p>;
  if (!proj) return <p className="p-10 text-caption text-text-tertiary">Loading projection…</p>;

  const toggle = (set: Set<number>, id: number) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };

  // Exports ───────────────────────────────────────────────────────────
  const exportPdf = () => {
    // Use the browser's print pipeline — print-only stylesheet in
    // index.css scopes the page to .report-print.
    document.body.classList.add('report-print-mode');
    setTimeout(() => {
      window.print();
      document.body.classList.remove('report-print-mode');
    }, 50);
  };

  const exportFhir = () => {
    const doc = buildFhirDiagnosticReport(patientLabel, p.patientHash, proj, draft);
    downloadBlob(
      `diagnostic-report-${p.patientHash.slice(0, 8)}.json`,
      'application/fhir+json',
      JSON.stringify(doc, null, 2),
    );
    showToast('FHIR DiagnosticReport downloaded', 'success');
  };

  const exportSr = () => {
    const doc = buildDicomSrStub(patientLabel, p.patientHash, proj, draft);
    downloadBlob(
      `dicom-sr-${p.patientHash.slice(0, 8)}.json`,
      'application/json',
      JSON.stringify(doc, null, 2),
    );
    showToast('DICOM SR content tree downloaded (JSON; M3.2 → .dcm)', 'success');
  };

  // Renders ────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 px-10 py-12 lg:grid-cols-[1fr_360px]">
      {/* LEFT: composer */}
      <div className="selectable">
        <h1 className="font-display text-display text-text-primary">
          Report · {patientLabel}
        </h1>
        <p className="mt-2 text-caption text-text-secondary">
          Structured impression composed from Layer 1 evidence. Every node
          you keep carries its citation into the export.
        </p>

        <Section title="Clinical information">
          <textarea
            value={draft.clinicalInfo}
            onChange={(e) => setDraft((d) => ({ ...d, clinicalInfo: e.target.value }))}
            rows={3}
            placeholder="Indication, prior treatment, comparison study…"
            className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-body text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </Section>

        <Section title="Findings">
          <ReportToggleList
            title="From Layer 1"
            nodes={proj.findings}
            selected={draft.selectedFindings}
            onToggle={(id) =>
              setDraft((d) => ({ ...d, selectedFindings: toggle(d.selectedFindings, id) }))
            }
          />
        </Section>

        <Section title="Impression">
          <textarea
            value={draft.impression}
            onChange={(e) => setDraft((d) => ({ ...d, impression: e.target.value }))}
            rows={5}
            placeholder="Synthesis — what the findings mean together."
            className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-body text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </Section>

        <Section title="Differential diagnosis">
          <ReportToggleList
            title="From Layer 1"
            nodes={proj.differentials}
            selected={draft.selectedDdx}
            onToggle={(id) =>
              setDraft((d) => ({ ...d, selectedDdx: toggle(d.selectedDdx, id) }))
            }
          />
        </Section>

        <Section title="Recommendation">
          <textarea
            value={draft.recommendation}
            onChange={(e) => setDraft((d) => ({ ...d, recommendation: e.target.value }))}
            rows={3}
            placeholder="Next steps, follow-up interval, recommended correlation…"
            className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-body text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </Section>
      </div>

      {/* RIGHT: live preview + export rail */}
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-md border border-border bg-surface p-5">
          <div className="mb-2 text-[10px] uppercase tracking-wider text-text-tertiary">
            Preview
          </div>
          <div className="report-print space-y-3">
            <div>
              <div className="text-caption text-text-tertiary">Patient</div>
              <div className="text-body text-text-primary">{patientLabel}</div>
            </div>
            {draft.clinicalInfo && (
              <div>
                <div className="text-caption text-text-tertiary">Clinical</div>
                <p className="whitespace-pre-wrap text-body text-text-primary">
                  {draft.clinicalInfo}
                </p>
              </div>
            )}
            <div>
              <div className="text-caption text-text-tertiary">Findings</div>
              {draft.selectedFindings.size === 0 ? (
                <p className="text-caption text-text-tertiary">None selected.</p>
              ) : (
                <ul className="text-body text-text-primary">
                  {proj.findings
                    .filter((f) => draft.selectedFindings.has(f.nodeId))
                    .map((f) => (
                      <li key={f.nodeId}>• {(f.content as any).label ?? `node ${f.nodeId}`}</li>
                    ))}
                </ul>
              )}
            </div>
            <div>
              <div className="text-caption text-text-tertiary">Impression</div>
              <p className="whitespace-pre-wrap text-body text-text-primary">
                {draft.impression || <span className="text-text-tertiary">—</span>}
              </p>
            </div>
            <div>
              <div className="text-caption text-text-tertiary">Differential</div>
              {draft.selectedDdx.size === 0 ? (
                <p className="text-caption text-text-tertiary">None selected.</p>
              ) : (
                <ul className="text-body text-text-primary">
                  {proj.differentials
                    .filter((d) => draft.selectedDdx.has(d.nodeId))
                    .map((d) => (
                      <li key={d.nodeId}>• {(d.content as any).label ?? `node ${d.nodeId}`}</li>
                    ))}
                </ul>
              )}
            </div>
            {draft.recommendation && (
              <div>
                <div className="text-caption text-text-tertiary">Recommendation</div>
                <p className="whitespace-pre-wrap text-body text-text-primary">
                  {draft.recommendation}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <Button variant="primary" className="w-full" onClick={exportPdf}>
            Export PDF
          </Button>
          <Button variant="subtle" className="w-full" onClick={exportFhir}>
            Export FHIR DiagnosticReport
          </Button>
          <Button variant="subtle" className="w-full" onClick={exportSr}>
            Export DICOM SR (JSON)
          </Button>
          <p className="pt-1 text-[11px] text-text-tertiary">
            PDF uses the system print pipeline. FHIR is a R4 DiagnosticReport.
            DICOM SR ships as the content tree; backend M3.2 renders the
            real .dcm.
          </p>
        </div>
      </aside>
    </div>
  );
}

/* ─────────────── Remaining stubs ─────────────── */

function ModeStub({ mode, note }: { mode: keyof typeof MODE_LABELS; note: string }) {
  return <EmptyState title={`${MODE_LABELS[mode]} mode`} description={note} />;
}

/* ─────────────── Imaging mode (DICOM zip upload) ─────────────── */

interface UploadJob {
  id: string;                  // local UUID; survives across renders.
  fileName: string;
  sizeBytes: number;
  // Upload phase
  uploadedBytes: number;
  uploadedTotal: number;
  uploadDone: boolean;
  // Backend file ID returned by POST /api/v1/files/upload
  fileId: string | null;
  // DICOM background parse (only for .zip / application/zip)
  parseState: 'idle' | 'queued' | 'parsing' | 'rendering' | 'done' | 'error';
  parseStage: string;
  parsePercent: number;
  parseStudyId: string | null;
  parseError: string | null;
}

function newJob(file: File): UploadJob {
  return {
    id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fileName: file.name,
    sizeBytes: file.size,
    uploadedBytes: 0,
    uploadedTotal: file.size,
    uploadDone: false,
    fileId: null,
    parseState: 'idle',
    parseStage: '',
    parsePercent: 0,
    parseStudyId: null,
    parseError: null,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function ImagingMode() {
  const p             = useAppState((s) => s.activePatient);
  const showToast     = useAppState((s) => s.showToast);
  const refreshPatients = useAppState((s) => s.refreshPatients);
  const [jobs, setJobs]   = useState<UploadJob[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // Run one upload job to completion: stream upload → poll parse.
  const runJob = async (job: UploadJob, file: File) => {
    const update = (mut: Partial<UploadJob>) =>
      setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, ...mut } : j)));

    try {
      const r = await api.uploadFile(file, file.name, {
        onProgress: (loaded, total) =>
          update({ uploadedBytes: loaded, uploadedTotal: total }),
      });
      update({
        uploadDone: true,
        uploadedBytes: r.sizeBytes,
        uploadedTotal: r.sizeBytes,
        fileId: r.fileId,
        parseState: r.dicomStatus === 'prerendering' ? 'queued' : 'idle',
        parseStudyId: r.dicomStudyId || null,
      });

      // Only poll the DICOM pipeline for zips / DICOM uploads.
      if (r.dicomStatus !== 'prerendering') {
        showToast(`Uploaded ${file.name}`, 'success');
        return;
      }

      // Poll until done / error / 60 ticks (~2 min at 2s) to keep the UI
      // honest if the backend's progress endpoint gets stuck.
      let ticks = 0;
      while (ticks++ < 60) {
        await new Promise((res) => setTimeout(res, 2000));
        try {
          const pr = await api.getPrerenderProgress(r.fileId);
          update({
            parseState:   pr.state as UploadJob['parseState'],
            parseStage:   pr.stage,
            parsePercent: pr.percent,
            parseStudyId: pr.studyId || null,
            parseError:   pr.error || null,
          });
          if (pr.state === 'done' || pr.state === 'error') break;
        } catch {
          // transient — keep polling
        }
      }
      // Refresh the patient list so a new DICOM-derived patient row
      // shows up in the sidebar immediately.
      refreshPatients();
      showToast(`Imported ${file.name}`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update({
        parseState: 'error',
        parseError: msg,
        uploadDone: false,
      });
      showToast(`Upload failed: ${msg}`, 'error');
    }
  };

  const acceptFiles = (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;
    setJobs((prev) => {
      const next = [...prev];
      for (const f of fileArr) {
        const job = newJob(f);
        next.unshift(job);
        // Kick off the upload outside of setState; we re-read the
        // freshly created job from the closure.
        queueMicrotask(() => runJob(job, f));
      }
      return next;
    });
  };

  const onDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) acceptFiles(e.dataTransfer.files);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) acceptFiles(e.target.files);
    // Reset so picking the same file again still triggers onChange.
    e.target.value = '';
  };

  return (
    <div className="mx-auto max-w-3xl px-10 py-12">
      <h1 className="font-display text-display text-text-primary">
        Imaging
      </h1>
      <p className="mt-2 text-body text-text-secondary">
        Drop a DICOM <span className="font-mono">.zip</span> here (or any
        clinical file). The server hashes it, parses DICOM headers, and
        derives the patient anchor from <span className="font-mono">PatientID</span>
        {' '}automatically — no need to pre-register the patient.
      </p>

      <label
        htmlFor="imaging-file-picker"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'mt-8 flex h-44 cursor-pointer flex-col items-center justify-center',
          'rounded-md border-2 border-dashed text-center transition-colors duration-100',
          dragOver
            ? 'border-accent bg-accent-subtle/50'
            : 'border-border hover:border-border-strong hover:bg-accent-subtle/20',
        )}
      >
        <div className="text-body text-text-primary">
          Drop DICOM <span className="font-mono">.zip</span> or click to choose
        </div>
        <div className="mt-1 text-caption text-text-tertiary">
          Multipart upload to <span className="font-mono">/api/v1/files/upload</span>
          {p && <> · binding to patient <strong>{patientDisplayLabel(p)}</strong></>}
        </div>
        <input
          id="imaging-file-picker"
          type="file"
          accept=".zip,application/zip,.dcm,application/dicom,*/*"
          multiple
          className="hidden"
          onChange={onPick}
        />
      </label>

      {jobs.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-caption font-medium uppercase tracking-wider text-text-tertiary">
            Uploads ({jobs.length})
          </h2>
          <div className="space-y-2">
            {jobs.map((j) => (
              <UploadJobRow key={j.id} job={j} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadJobRow({ job }: { job: UploadJob }) {
  const uploadPct = job.uploadedTotal > 0
    ? Math.min(100, (job.uploadedBytes / job.uploadedTotal) * 100)
    : 0;
  const isDicom    = job.parseState !== 'idle' || job.fileId === null;
  const isParsing  = job.parseState === 'queued' || job.parseState === 'parsing' || job.parseState === 'rendering';
  const isDone     = job.parseState === 'done' || (!isDicom && job.uploadDone);
  const isError    = job.parseState === 'error';

  let stateText: string;
  let stateChip: 'neutral' | 'tinted' | 'confirmed' | 'caution' | 'retract' = 'neutral';
  if (isError)              { stateText = 'Failed';             stateChip = 'retract'; }
  else if (isDone)          { stateText = isDicom ? 'Imported' : 'Uploaded'; stateChip = 'confirmed'; }
  else if (isParsing)       { stateText = job.parseStage || 'Parsing DICOM'; stateChip = 'tinted'; }
  else if (job.uploadDone)  { stateText = 'Queued for parse';   stateChip = 'neutral'; }
  else                      { stateText = `Uploading ${uploadPct.toFixed(0)}%`; stateChip = 'tinted'; }

  // Progress bar: upload bytes during upload, parse % afterwards.
  const barPct = !job.uploadDone
    ? uploadPct
    : (isParsing ? job.parsePercent : isDone ? 100 : 0);

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body text-text-primary">
            {job.fileName}
          </div>
          <div className="mt-0.5 text-caption text-text-tertiary">
            {formatBytes(job.sizeBytes)}
            {job.parseStudyId && (
              <> · study <span className="font-mono">{job.parseStudyId.slice(0, 12)}</span></>
            )}
          </div>
        </div>
        <Chip variant={stateChip}>{stateText}</Chip>
      </div>
      {(isParsing || !job.uploadDone) && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-border">
          <div
            className={cn(
              'h-full transition-all duration-200',
              isError ? 'bg-retract' : 'bg-accent',
            )}
            style={{ width: `${barPct}%` }}
          />
        </div>
      )}
      {isError && job.parseError && (
        <div className="mt-2 text-caption text-retract">{job.parseError}</div>
      )}
    </div>
  );
}
export function LabsMode() {
  return <ModeStub mode="labs" note="Lab trends + reference ranges — U3." />;
}
