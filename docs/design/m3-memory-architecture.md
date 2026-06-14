# Nexus Memory Architecture v3 — Four-layer clinical memory (per-patient graph + per-medic learning + reference KB + opt-in case library)

**Status:** Design v3 — supersedes v2 of 2026-06-13 same day
**Date:** 2026-06-13
**Owner:** JZ
**Related:** ADR-002 (with Rev-1..Rev-4), #176, #135–#138, #194, #195, #198
**Scope:** Complete design for the clinical memory system: per-patient evidence graph, per-medic learned patterns, universal reference knowledge, and (deferred) opt-in case library. Plus the existing agent-self-improvement meta-layer.

**Diff from v2:** v2 designed the per-patient ClinicalGraph rigorously but had no answer to "how does the agent get smarter at *this medic's practice* as they accumulate cases." v3 adds **Practitioner Memory (Layer 2)** — a per-`user_id`, cross-patient, PHI-stripped store of style / workflow / practice / calibration patterns — plus the four-layer architecture that gives each kind of memory its proper home. Existing Layer 1 design (ClinicalGraph + Rev-1..Rev-4) is unchanged. v2 retained in git history; do not implement against it.

**Diff from v3 initial draft (incorporates ADR-002 Rev-6):** the imaging-ingestion pipeline now uses [Project-MONAI](https://github.com/Project-MONAI/MONAI) **scoped to its Mac-friendly lightweight layer** — DICOM I/O + Bundle packaging format + CoreML-converted 2D classifiers (running on Apple Neural Engine). Heavy 3D models (VISTA-3D, TotalSegmentator, registration) are explicitly **deferred to an "inference companion" architecture** for v2, because Mac (no CUDA, partial MPS) cannot run them at clinical latency. The DICOM ingester is rewritten to route by modality + volume size; 2D gets domain-tuned models, 3D stays on Gemini-Flash quick-scan until inference companion ships. Provenance schema and graph data model are unchanged.

---

## 1. Why we're doing this

The agent's working memory today fails four jobs:

- **Conflict resolution.** Two encounters disagree on a clinical fact; both lines coexist in flat markdown; nothing reconciles. *(addressed v2 §7)*
- **Entity grounding.** Same finding under different names ("left renal mass" vs "LK lesion") embeds to unrelated vectors; cross-encounter retrieval misses. *(addressed v2 §3.1 via `anatomical_region` anchor)*
- **Iterative reasoning.** Complex queries need multi-step retrieval; today's RAG is single-shot. *(addressed v2 §6 via tiered retrieval, T3 = Algorithm 1)*
- **Cross-patient learning.** After 200 patients the agent should know the medic's report structure, threshold preferences, accept/override patterns. It doesn't. The per-patient graph design *by construction* prevents this — patient stores are isolated. **This is what v3 addresses.**

ByteDance's [M3-Agent](https://github.com/ByteDance-Seed/m3-agent) gave us the per-entity graph primitives that solve the first three. The fourth requires a memory layer M3 doesn't have and was never going to give us — one that lives *above* any single patient.

---

## 2. Four layers + meta-layer

```
              Layer 3                    Layer 2                       Layer 1
            UNIVERSAL                PRACTITIONER                  PER-PATIENT
            (reference)              (cross-patient,               (evidence,
                                      learned)                      audit-grade)
        ┌───────────────────┐    ┌───────────────────────┐    ┌──────────────────────┐
        │ Guidelines        │    │ Style                 │    │ ClinicalGraph        │
        │   NCCN / ACR-AC   │    │   report structure    │    │  • patient anchor    │
        │ Drug DB           │    │   phrasing tics       │    │  • study / series    │
        │   RxNorm          │    │   abbreviation rules  │    │  • key_image         │
        │ Ontologies        │◄───┤                       │◄───┤  • anatomical_region │
        │   RadLex          │    │ Workflow              │    │  • finding           │
        │   SNOMED-CT       │    │   tool sequences      │    │  • measurement       │
        │ Lab ranges        │    │   view pinning        │    │  • med / lab / ddx   │
        │ ICD/CPT           │    │   hotkey heat-map     │    │  • episodic_event    │
        │                   │    │                       │    │  • semantic_fact     │
        │ (static,          │    │ Practice              │    │  • node_provenance   │
        │  versioned,       │    │   thresholds          │    │                      │
        │  shared across    │    │   follow-up intervals │    │ Per (user_id,        │
        │  all users)       │    │   ordering preferences│    │      patient_hash)   │
        │                   │    │                       │    │ PHI-bearing          │
        │                   │    │ Calibration           │    │                      │
        │                   │    │   accept ratio        │    │                      │
        │                   │    │   override ratio      │    │                      │
        │                   │    │   reject patterns     │    │                      │
        │                   │    │                       │    │                      │
        │                   │    │ Per user_id           │    │                      │
        │                   │    │ PHI-stripped          │    │                      │
        │                   │    │ Medic-confirmed       │    │                      │
        └───────────────────┘    └───────────┬───────────┘    └──────────┬───────────┘
                                             │ aggregation              │
                                             │ (N-of-patients           │
                                             │  threshold + medic        │
                                             │  confirmation gate)       │
                                             └───────────────────────────┘

                            Layer 4 (DEFERRED — see §12 out of scope)
                            CASE LIBRARY (opt-in, de-identified archetypes)
                            similar-case retrieval on current patient

                       ┌────────────────────────────────────────────────┐
                       │              META-LAYER                        │
                       │       Skill / Prompt / Policy Evolution         │
                       │                                                 │
                       │  • Prompt versioning (extraction templates)    │
                       │  • Tier classifier thresholds                  │
                       │  • Evidence-rank table tuning                  │
                       │  • Cached-view recipe pruning                  │
                       │  • Conflict thresholds per finding type        │
                       │                                                 │
                       │  Driven by: telemetry across all 4 layers      │
                       │  Existing infra: nexus_server/tools_evolve.py  │
                       │                                                 │
                       │  (Different from Layer 2: meta-layer is agent  │
                       │   modifying itself, Layer 2 is agent learning  │
                       │   the medic.)                                  │
                       └────────────────────────────────────────────────┘
```

How the runtime composes these:

```
       AGENT TURN
           │
           ▼
  tier_classifier(question)
   │
   ├── T1 cached view (SQL, ≤50ms)
   ├── T2 single-shot graph lookup (≤300ms)
   └── T3 Algorithm 1 (5–15s, streamed)
           │
           ▼
  system_prompt = compose(
        Layer 3 reference snippets (relevant guidelines / drug refs),
        Layer 2 active practitioner facts (this medic's confirmed patterns),
        question + retrieved Layer 1 context
  )
           │
           ▼
       LLM
           │
           ▼
   response + cited sources
           │
           ▼
   post-encounter ingesters:
     • patient_ingester  → Layer 1 graph mutations
     • practitioner_ingester  → Layer 2 candidate extraction
           │
           ▼
   periodic distillation (nightly):
     • Layer 1 → cached_views regeneration
     • Layer 2 → candidate promotion / pruning
     • meta-layer → telemetry-driven tuning
```

Six observations:

The graph (Layer 1) stays **derived** from `twin_event_log`. Same property holds for Layer 2 — it's derived from the union of all Layer 1 graphs plus interaction telemetry. Lose Layer 2, rebuild from Layer 1 ledgers.

Layer 2 is **per `user_id`** (per medic), not per `(user_id, patient_hash)`. One physical store per medic, populated by aggregation across all their patients.

Layer 2 entries are **never written without `distinct_patient_count ≥ N`** (default N=5). This is the structural privacy guarantee: no fact reaches Layer 2 until it's been observed across enough patients that the patient-level signal is washed out.

Layer 2 entries are **never activated without medic confirmation**. Agent does not start using a learned pattern silently. Surfaced in a `Nexus has learned` UI panel; medic explicitly accepts, rejects, or defers.

Layer 3 is **read-only reference** — guidelines, drug DB, ontologies. Versioned, shared across all users. Not learned; ingested from external sources. v3 lays the schema; population is a separate workstream.

Layer 4 (Case Library) is **explicitly deferred** to a 6-month+ horizon. The privacy/consent engineering for archived case archetypes is substantial; v3 designs around its absence.

---

## 3. Data model

### 3.1 Layer 1 node types — unchanged from v2

| `node.type` | What it represents | Created by | Lifetime |
|---|---|---|---|
| `patient` | The patient root anchor — PHI-hash | Manual registration or first DICOM ingest | Forever |
| `study` | One DICOM study (CT, MR, US, XR, MG, …) | dicom_ingester | Forever |
| `series` | One series within a study | dicom_ingester (optional) | Forever |
| `key_image` | A specific slice or view pinned as clinically significant | Quick scan or medic pin | Forever |
| `anatomical_region` | "Left kidney", "Mediastinum" — persistent spatial anchor | LLM extraction; reused on subsequent mentions | Forever |
| `finding` | A clinical observation | chat_ingester or dicom_ingester | Forever; merged via `refresh_equivalences` |
| `measurement` | Quantitative measurement on a finding | dicom_ingester, chat_ingester | Forever |
| `med` | A medication | chat_ingester or manual entry | Until discontinuation event |
| `lab` | A lab result | lab_ingester | Forever |
| `ddx` | A differential diagnosis candidate | chat_ingester | May be retracted |
| `episodic_event` | One thing that happened at one encounter | All ingesters | Forever; timestamped (not clip-id'd) |
| `semantic_fact` | A distilled, currently-believed patient-level fact | LLM summariser | Reinforced by re-mention; can be superseded |

Edge types and v2 changes are unchanged — see v2 §3.2 (preserved in git).

### 3.2 Layer 2 fact kinds

| `fact_kind` | What it captures | Example | Used to drive |
|---|---|---|---|
| `style` | Report structure, phrasing, abbreviation conventions | "Impressions end with 'recommend correlation' when uncertain" | Report draft alignment |
| `workflow` | Tool / view / hotkey sequences | "On opening Patient mode, jumps to Encounter within 4 s in 78% of sessions" | Today / Patient layout reorder |
| `practice` | Clinical thresholds and ordering preferences | "Renal mass < 3 cm, MR before biopsy in 8/10 BI-RADS-4 cases" | DDx ordering, recommendation surfacing |
| `calibration` | Accept / override / reject ratios for agent suggestions | "Rejects 'recommend biopsy' for findings < 2 cm in 12/12 cases" | Suggestion suppression / confidence floor |

### 3.3 SQLite schema

**Important per Rev-8 / §16.12**: every table below except `twin_event_log` is a **projection** — a materialised view derived from `twin_event_log` by replay. Drop any projection, replay event_log, rebuild byte-identical. The canonical schema is `twin_event_log` (specified in §16.12.6); the schemas below are read-side optimisations.

**Per Rev-9**: `clinical_graph_nodes.content_json` for `node_type='key_image'` now carries `image_sha256` (content-addressed file ref), `redaction` block, optional `visual_embedding` block, optional `features` block. Full shape in §5.5.3. M0 schema accepts all fields as optional / nullable so M1-M1.7 can populate them incrementally without migration.

Layer 1 tables are unchanged from v2 (`clinical_graph_nodes`, `clinical_graph_edges`, `node_provenance`, `cached_views`). Only Layer 2 schema is new:

```sql
-- The currently-active learned patterns about a medic.
-- A row exists here only after distinct_patient_count ≥ N AND medic
-- has explicitly confirmed (medic_confirmed_at != NULL).
CREATE TABLE practitioner_facts (
    user_id                TEXT NOT NULL,
    fact_kind              TEXT NOT NULL,    -- style|workflow|practice|calibration
    pattern_key            TEXT NOT NULL,    -- canonicalised structured key
    pattern_value_json     TEXT NOT NULL,    -- pattern payload — NO patient identifiers
    observed_count         INTEGER NOT NULL, -- total observations (across patients)
    distinct_patient_count INTEGER NOT NULL, -- distinct patient_hashes that triggered
    confidence             REAL NOT NULL,    -- 0..1
    first_observed_at      INTEGER NOT NULL,
    last_reinforced_at     INTEGER NOT NULL,
    medic_confirmed_at     INTEGER,          -- nullable
    medic_rejected_at      INTEGER,          -- nullable
    extraction_model       TEXT NOT NULL,
    extraction_prompt_id   TEXT NOT NULL,
    PRIMARY KEY (user_id, fact_kind, pattern_key)
);

CREATE INDEX idx_pf_user_kind   ON practitioner_facts(user_id, fact_kind);
CREATE INDEX idx_pf_active      ON practitioner_facts(user_id, medic_confirmed_at)
    WHERE medic_confirmed_at IS NOT NULL AND medic_rejected_at IS NULL;

-- The raw observation stream — every candidate pattern seen, before
-- promotion. This is what the distillation job aggregates into
-- practitioner_facts when N-of-patients threshold is hit.
--
-- NOTE: this table DOES carry patient_hash (for distinct-counting and
-- for the medic to audit "what cases led you to think this about me").
-- It is per-user; never aggregated across users.
CREATE TABLE practitioner_observations (
    user_id                TEXT NOT NULL,
    patient_hash           TEXT NOT NULL,
    fact_kind              TEXT NOT NULL,
    pattern_key            TEXT NOT NULL,
    observed_at            INTEGER NOT NULL,
    source_encounter_id    TEXT NOT NULL,    -- study_uid or chat session
    evidence_quote         TEXT NOT NULL,    -- verbatim substring (same Rev-2 rule)
    extraction_model       TEXT NOT NULL,
    extraction_prompt_id   TEXT NOT NULL,
    PRIMARY KEY (user_id, patient_hash, fact_kind, pattern_key, observed_at)
);

CREATE INDEX idx_po_distill ON practitioner_observations(user_id, fact_kind, pattern_key);
CREATE INDEX idx_po_patient ON practitioner_observations(user_id, patient_hash);

-- Layer 3 reference knowledge — populated from external sources, not learned.
-- Schema deliberately minimal; expand as we add source types.
CREATE TABLE reference_knowledge (
    kind        TEXT NOT NULL,           -- guideline|drug|ontology|lab_range
    key         TEXT NOT NULL,           -- e.g. RxNorm code, RadLex id
    content_json TEXT NOT NULL,
    source      TEXT NOT NULL,           -- provenance URL or citation
    version     TEXT NOT NULL,
    ingested_at INTEGER NOT NULL,
    PRIMARY KEY (kind, key, version)
);
```

Three structural notes:

`practitioner_observations` keeps `patient_hash` because the medic deserves to see "what made you think this about me?" — the audit ledger for Layer 2 itself. `practitioner_facts` does not — it's the de-identified aggregate.

Confirmed-active facts are the partial-indexed subset (`idx_pf_active`). The runtime composer (§6.7 below) queries that view by default; rejected and unconfirmed candidates don't reach the agent.

`reference_knowledge` is schema-only in v3. Population is a separate workstream (RadLex dump, RxNorm subset, locally-licensed guideline summaries). Listed here so the agent runtime contract knows where Layer 3 lives.

---

## 4. Module layout

```
packages/server/nexus_server/
├── mm_graph/                          # Layer 1 — unchanged from v2
│   ├── clinical_graph.py
│   ├── conflict.py
│   ├── control_loop.py
│   ├── retrieval_tiers.py
│   ├── cached_views.py
│   ├── provenance.py
│   ├── prompts.py
│   ├── store.py
│   └── entity_parser.py
│
├── practitioner/                       # NEW — Layer 2
│   ├── __init__.py
│   ├── facts.py                       # CRUD over practitioner_facts
│   ├── observations.py                # CRUD over practitioner_observations
│   ├── extractor.py                   # per-encounter candidate emitter (LLM)
│   ├── distiller.py                   # periodic promote/prune job
│   ├── composer.py                    # builds system prompt enrichment
│   └── prompts.py                     # extraction + distillation prompts
│
├── reference/                          # NEW — Layer 3
│   ├── __init__.py
│   ├── kb.py                          # lookup over reference_knowledge
│   └── loaders/                       # external-source importers
│       ├── radlex.py
│       ├── rxnorm.py
│       └── lab_ranges.py
│
├── monai_runtime/                      # NEW — MONAI lightweight layer (Rev-6)
│   ├── __init__.py
│   ├── transforms.py                   # wrappers over monai.transforms (DICOM/NIfTI I/O,
│   │                                   # windowing, resampling, intensity normalisation)
│   ├── bundle_loader.py                # MONAI Bundle parser; resolves Bundle metadata
│   │                                   # into our typed Provenance schema
│   ├── coreml_inference.py             # CoreML runtime for 2D bundles (ANE acceleration)
│   ├── ohif_label_bridge.py            # MONAI Label protocol hook for OHIF viewer —
│   │                                   # captures medic edits as retraining signals
│   └── bundles/                        # bundled Apache-2.0 model artifacts
│       ├── quick_scan_4x4_grid/        # our Gemini-Flash quick-scan wrapped as a Bundle
│       ├── chest_xray_triage/          # MONAI Model Zoo (CoreML-converted)
│       └── dermatology_lesion/         # MONAI Model Zoo (CoreML-converted)
│
├── memorization/                       # Layer 1 ingesters
│   ├── dicom_ingester.py               # MODIFIED — modality-routing per Rev-6
│   ├── chat_ingester.py
│   ├── lab_ingester.py
│   ├── anatomical_normalizer.py
│   ├── cross_study_compare.py
│   └── summarizer.py
│
├── tools_evolve.py                     # Meta-layer — pre-existing, extend
├── tools_memory.py                     # MODIFIED — now also exposes practitioner search
├── twin_manager.py                     # MODIFIED — agent loop wraps composer
├── twin_event_log.py                   # UNCHANGED
├── vector_index.py                     # UNCHANGED
└── database.py                         # MODIFIED — Layer 2 + Layer 3 tables added
```

### 4.1 What's actually new for v3

About 600 LOC of new code on top of v2:

| File | Role | LOC est. |
|---|---|---|
| `practitioner/extractor.py` | Per-encounter LLM call that emits candidate `(fact_kind, pattern_key, value)` tuples + evidence quote | 200 |
| `practitioner/distiller.py` | Nightly job: aggregate observations, apply N-of-patients threshold, surface candidates for medic confirmation | 150 |
| `practitioner/composer.py` | At every agent turn, builds the system-prompt enrichment block from active facts | 100 |
| `practitioner/facts.py` + `observations.py` | Type-safe CRUD with the privacy invariants enforced | 100 |
| `practitioner/prompts.py` | The extraction and distillation prompt templates | 50 |
| `reference/kb.py` + loader stubs | Schema-only initially | 50 |

Layer 2 extraction is **opt-in per fact_kind** during M0–M5 phases (see §9 revised), enabled progressively to limit blast radius.

---

## 5. Memorization (per-patient, Layer 1)

DICOM ingester is rewritten per Rev-6; chat / lab ingesters preserve v2 design. **All ingesters write through the store-layer `emit_and_apply()` per Rev-8 / §16.12** — no ingester writes to projection tables directly. The pseudocode below shows the protocol; concrete pipelines for each modality follow.

> **§5 runtime status (U3.3 — live in `main` as of this commit).** The
> ingester wiring previously existed only as classes in
> `nexus_server/memorization/`; nothing in production code called them.
> They are now invoked at the following points and the Memory tab
> populates as a result of any of these actions:
>
> | trigger | invoker | nodes emitted |
> |---|---|---|
> | `ASSISTANT_RESPONSE` event commits in chat_router_v2 | `_run_chat_ingester_safe` | `finding`, `med`, `ddx`, `measurement`, `semantic_fact` (verbatim-quoted from the chat turn) |
> | DICOM zip prerender finishes in `_run_dicom_prerender_async` | `_run_dicom_ingester_safe` | `patient`, `study`, `series`, `key_image`, `anatomical_region` |
> | Quick scan (Gemini Flash triage) fires post-ingest | `_run_quick_scan_after_ingest` | `finding` (confidence 0.5–0.6, status `unconfirmed`, source `quick_scan`) |
>
> Extractor used by `_run_chat_ingester_safe`:
> `memorization.llm_extractor.llm_chat_extractor` — wraps
> `llm_gateway.call_llm` (default provider per `ServerConfig`,
> `gemini-2.5-flash` by default). Output JSON parsed → each entity
> validated to have a verbatim `evidence_quote` substring of the source
> text (entities failing this drop, do not save).
>
> Quick scan's flagged regions are surfaced to the medic in three
> places simultaneously: the Imaging tab upload row (transient), the
> Patient tab's *Active findings* section (durable), and Memory · L1 ·
> Findings (durable). Status `unconfirmed` means the medic still has
> to accept/reject — see §6.3 (medic confirmation gate). Same gate
> applies whether the finding originated from a chat turn or a
> Quick scan.
>
> Failure modes are propagated to the desktop, never swallowed. The
> uploads row carries `memory_status` + `memory_summary` +
> `quick_scan_status` + `quick_scan_summary`; the
> `GET /files/{id}/prerender-progress` endpoint surfaces all four.
> The Imaging tab renders them as inline status lines below each
> upload card, so an LLM-call failure ("No module named nexus_core")
> shows up as `Memory failed: …` instead of the row going silent.

### 5.0 Ingester pattern (universal — per Rev-8)

Every ingester operation follows this shape:

```python
def ingest_one(input_ref: str, user_id: str, patient_hash: str) -> None:
    # 1. Announce the operation in the canonical log
    started_idx = store.emit_and_apply(
        kind="ingestion_started",
        payload={"kind": "dicom", "target_ref": input_ref,
                 "ingester_version": INGESTER_VERSION},
        apply_fn=lambda cur, idx, p: None,   # no projection write yet
        user_id=user_id, patient_hash=patient_hash,
    )

    # 2. Call the model(s) — and ARCHIVE the raw output BEFORE deriving anything
    raw = call_model(input_ref)
    store.emit_and_apply(
        kind="ingestion_llm_response",
        payload={"raw_output_text": raw.text, "model": raw.model,
                 "prompt_id": raw.prompt_id, "prompt_version": raw.prompt_version,
                 "tokens_in": raw.tokens_in, "tokens_out": raw.tokens_out,
                 "latency_ms": raw.latency_ms},
        apply_fn=lambda cur, idx, p: None,   # archive-only; no projection
        user_id=user_id, patient_hash=patient_hash,
        caused_by=started_idx,
    )

    # 3. Parse, then for each derived entity emit a typed mutation event.
    #    apply_fn writes the projection rows from the event payload.
    for finding in parse_findings(raw):
        store.emit_and_apply(
            kind="node_added",
            payload={"node_type": "finding", "content_json": finding.content,
                     "embedding_ref": finding.embedding_ref,
                     "originating_event_idx": started_idx},
            apply_fn=apply_node_added_v1,
            user_id=user_id, patient_hash=patient_hash,
            caused_by=started_idx,
        )
        # ... emit edges, provenance, etc. — same pattern

    store.emit_and_apply(
        kind="ingestion_completed",
        payload={"emitted_node_count": N, "errors": []},
        apply_fn=lambda cur, idx, p: None,
        user_id=user_id, patient_hash=patient_hash,
        caused_by=started_idx,
    )
```

Replay drops "step 2 — call model" entirely; it reads `raw_output_text` from the archived event. This is what makes replay LLM-free.

### 5.1 DICOM ingester — modality-routing pipeline

The ingester now classifies incoming studies by modality + volume size and routes each to the most appropriate extraction path. The graph schema downstream is unchanged — every path produces the same `study / series / key_image / anatomical_region / finding / measurement / episodic_event / semantic_fact` nodes with full `node_provenance` rows. What differs is where the extracted facts come from.

```
DICOM study arrives
   │
   ▼ (BackgroundTask)
dicom_ingester.ingest(study_uid, user_id, patient_hash)
   │
   ├── Stage 1: monai.transforms parse + canonicalise
   │     • read DICOM tags (modality, body part, study_date, series count)
   │     • apply windowing / resampling per modality preset
   │     • emit canonical NumPy/NIfTI for downstream
   │
   ├── Stage 2: route by (modality, volume_size)
   │
   │     2A — 2D modalities (CR / DX / DR / Photo / Fundus / single-frame US)
   │           │
   │           ▼
   │       coreml_inference.run(bundle_id, frame)
   │           • MONAI Bundle (CoreML-converted) on ANE
   │           • 1–3 s per frame
   │           • output: structured findings (class probs, ROI bbox)
   │
   │     2B — Cine ultrasound (multi-frame)
   │           │
   │           ▼
   │       Gemini Flash on representative frames (current path)
   │
   │     2C — 3D volumes (CT / MR / PET / 3D US)
   │           │
   │           ▼
   │       Quick-scan-bundle (Gemini-Flash on 4×4 grid of key slices)
   │           • current path, now wrapped in MONAI Bundle for provenance
   │           • SWAP-IN POINT: when inference companion ships (v2),
   │             this branch swaps to remote MONAI VISTA-3D /
   │             TotalSegmentator / specific-organ bundles
   │           • graph schema unchanged across the swap
   │
   ├── Stage 3: provenance writeback
   │     • bundle_loader extracts Bundle metadata
   │       (id, version, inference config) → Provenance row
   │     • for 2A: extraction_model = "monai-bundle://chest_xray_triage@1.2.0"
   │       evidence is the bundle output (class+confidence+ROI), serialised
   │     • for 2C: extraction_model = "monai-bundle://quick_scan_4x4_grid@0.3.0"
   │       evidence_quote = the Gemini Flash caption span (Rev-2 rule)
   │
   ├── Stage 4: graph node emission
   │     • findings → finding_node + finding_in / localization_of edges
   │     • measurements → measurement_node + measurement_of edges
   │     • anatomical regions → region nodes (text-normalised in 2A/2B/2C;
   │       voxel-grounded only when 3D MONAI ships in v2)
   │
   ├── Stage 5: cross_study_compare(patient_hash, new_study)
   │     • finds prior studies of same modality + body part
   │     • emits follow_up / same_finding edges via heuristic
   │       overlap (UPGRADE POINT: when MONAI registration ships
   │       in v2, switch to voxel-grounded matching)
   │
   ├── Stage 6: summariser distillation → semantic_facts
   │
   ├── Stage 7: conflict.scan_for_clinical_conflicts(...)
   │
   ├── Stage 8: cached_views.invalidate(...)
   │
   └── Stage 9: store.flush() (transactional)
```

Three architectural properties:

**MONAI Bundle as the uniform packaging boundary.** Every extraction model — including Gemini-Flash quick-scan wrapped in a Bundle — has the same provenance footprint: Bundle id + version + config hash → `node_provenance.extraction_model` + `extraction_prompt_id`. This collapses a heterogeneous "different models, different metadata schemas" problem into a single adapter (`monai_runtime/bundle_loader.py`).

**The 3D branch is a designed swap-in point.** Stage 2C is a Gemini-Flash quick-scan wrapped in a Bundle today. When the inference companion architecture ships (v2), the Bundle's inference target changes from "call Gemini Flash" to "call remote MONAI VISTA-3D"; the rest of the pipeline (provenance, graph emission, downstream consumers) does not change. Same for Stage 5 cross-study compare.

**OHIF / MONAI Label loop.** When the medic edits an agent-emitted finding in Imaging mode (cornerstone/OHIF), the OHIF Label bridge captures the diff and writes a `medic_correction` event into `twin_event_log`. These corrections are the future training signal for refining CoreML bundles. v3 ships the capture path; the retraining loop is v2.

### 5.2 Chat ingester — unchanged from v2

Verbatim-quote verification, per-turn extraction, structured output → graph nodes with full provenance. See v2 §5.2.

### 5.3 Lab ingester — unchanged from v2

Each lab posting becomes a `lab` node + `episodic_event`. See v2 §5.3.

### 5.4 Cached-view post-pass — unchanged from v2

See v2 §5.4. Layer 1 ingestion completion triggers cached_view_builder for affected view kinds.

### 5.5 Imaging memory — pixels in addition to text (per Rev-9)

#### 5.5.1 Motivation

Through Rev-8 the imaging path writes only text into memory — a caption from Gemini Flash, parsed into typed findings. This loses three things irrecoverably: (a) details Gemini Flash didn't write down; (b) pixel-level spatial reasoning across studies; (c) visual similarity search. Rev-9 fixes all three by extending DICOM ingestion through three layers (visual embedding, multimodal LLM at retrieval, structured radiology features) while preserving event-sourcing determinism.

#### 5.5.2 Three-layer pipeline

The DICOM ingester (§5.1) Stages 2A and 2C gain four extra sub-steps, inserted between Quick scan output and graph node emission:

```
                      ──── existing path ────
                          Quick scan picks N key slices
                                     │
                                     ▼
   ┌──────────────────────────────────────────────────┐
   │ IM-1   Render & redact      (mandatory; runs    │
   │        always)              before any other IM  │
   │                                                  │
   │   • Render each key slice as PNG at 512×512      │
   │     applying modality window/level preset        │
   │   • Strip DICOM dataset overlays (pydicom)       │
   │   • OCR-sweep pixel data (PaddleOCR / Tesseract) │
   │     classify each text region: PHI vs. medical   │
   │   • Blackout PHI regions; keep medical text      │
   │   • Compute sha256 of redacted PNG               │
   │                                                  │
   │   Events emitted:                                │
   │     image_redaction_applied  (before/after sha,  │
   │                              regions, engine ver)│
   │     image_extracted          (sha, path, dims,   │
   │                              window/level, src   │
   │                              study/series/slice) │
   │   File written: ~/Library/Nexus/files/keyimage/  │
   │                  <sha256>.png                    │
   └──────────────────────────────────────────────────┘
                                     │
        ┌────────────────────────────┼───────────────────────────────┐
        │                            │                               │
        ▼                            ▼                               ▼
  ┌───────────────┐         ┌────────────────┐               ┌────────────────┐
  │ IM-2 Layer A  │         │ IM-3 Layer C   │               │ existing path  │
  │ Visual encode │         │ Struct features│               │ caption → LLM  │
  │               │         │                │               │ extract        │
  │ • BiomedCLIP /│         │ • HU stats     │               │ → finding /    │
  │   CXR-CLIP /  │         │   (pydicom)    │               │   measurement  │
  │   MONAI img   │         │ • Enhancement Δ│               │   nodes        │
  │   encoder     │         │   (MONAI bundle)│              │   referencing  │
  │ • CoreML ANE  │         │ • Morphology   │               │   key_image    │
  │ • 512-d vec   │         │   classifier   │               │   sha256       │
  │               │         │                │               │                │
  │ Event:        │         │ Event ×N:      │               │ Events: existing│
  │  image_       │         │  image_feature_│               │  node_added    │
  │  embedding_   │         │  extracted     │               │  + provenance_ │
  │  computed     │         │                │               │  recorded      │
  │               │         │ Written to     │               │                │
  │ Written to    │         │ measurement    │               │                │
  │ vector_index  │         │ node           │               │                │
  │ (projection)  │         │ content_json   │               │                │
  └───────────────┘         └────────────────┘               └────────────────┘
                                     │
                                     ▼
                           Existing flow continues:
                           cross_study_compare, summariser,
                           conflict scan, cached_views invalidate,
                           store.flush()
```

IM-1 is **mandatory and always first**. IM-2, IM-3, and the caption path run in parallel after IM-1 commits.

#### 5.5.3 Updated `key_image` content_json shape

```json
{
  "image_sha256": "abc123...",
  "source_dicom": {
    "study_uid": "1.2.840.xxxx.9104",
    "series_uid": "1.2.840.xxxx.9104.3",
    "slice_no": 142,
    "sop_instance_uid": "1.2.840.xxxx.9104.3.142"
  },
  "rendered_at_resolution": [512, 512],
  "windowing_applied": {"width": 400, "level": 40},
  "redaction": {
    "applied": true,
    "regions": [{"bbox": [12, 8, 240, 32], "reason": "patient_name"}],
    "engine": "pydicom-overlay+paddleocr",
    "engine_version": "0.4.2"
  },
  "visual_embedding": {
    "encoder_bundle_id": "biomedclip",
    "encoder_version": "0.9.0",
    "embedding_version": "biomedclip@0.9.0",
    "vector_sha256": "def456..."
  },
  "features": {
    "hu_stats":          {"mean": 35.2, "std": 12.4, "min": -10, "max": 78},
    "enhancement_delta": {"arterial_minus_unenhanced": 28, "portal_minus_unenhanced": 41},
    "morphology":        {"class": "well_defined_round", "confidence": 0.86}
  },
  "pinned_by": "quick_scan_bundle@0.3.0"
}
```

All non-essential fields are nullable; M0 ships the schema, M1 ships IM-1 populating `image_sha256` + `redaction`, M1.5 adds `visual_embedding`, M1.7 adds `features`.

#### 5.5.4 Multimodal retrieval (Layer B)

§6 retrieval is extended at Tier 2 and Tier 3:

**Tier 2 single-shot, finding-anchored queries.** When the resolved anchor is a `finding` node, the composer pulls up to 3 linked `key_image` files and attaches them to the LLM message as multimodal parts. Composer prompt is appended with:

> "Some retrieved findings include the original key images. Examine them directly when texture, morphology, enhancement, or comparison with prior detail matters; do not rely solely on prior captions."

**Tier 3 iterative.** The control loop registers a new tool the LLM can call inside the loop:

```python
class GetKeyImageTool(BaseTool):
    """Fetch the actual pixel data of a key image referenced in
    prior search_node / search_encounter results. Use when text
    captions are insufficient — e.g. to verify a finding visually,
    to compare enhancement patterns, or to assess morphology."""
    name = "get_key_image"
    params = {"image_sha256": str}
```

Each call returns the PNG binary as a multimodal part the LLM can attend to in the next reasoning round. Budget: 16 images total per turn. Exceeding the budget returns a tool-error and the LLM must reason on what it has.

Every image attached to LLM context emits an `image_attached_to_context` event referencing the parent `assistant_response`. Replay knows exactly which images informed every historical agent response.

#### 5.5.5 Visual similarity retrieval

New tool surfaced at any tier:

```python
class SearchImageSimilarTool(BaseTool):
    """Find visually similar images across this patient's studies
    (default scope) or across the medic's entire case corpus
    (opt-in via settings flag). Returns top_k key_image refs
    by cosine similarity of visual embeddings."""
    name = "search_image_similar"
    params = {"reference_image_sha256": str, "top_k": int,
              "scope": Literal["this_patient", "my_corpus"]}
```

Implementation: `vector_index.chunks` already supports cosine search; we add an `embedding_kind` column (`'text' | 'visual'`) and the tool query is scoped to `embedding_kind='visual'` + `encoder_version = <current>`. Cross-encoder-version searches are explicitly rejected (returns empty + emits a `visual_search_blocked_version_mismatch` warning event).

Scope `my_corpus` is opt-in per Layer 4 / case-library concerns — when enabled, the medic's own (PHI-bearing) prior cases are searchable; cross-medic search is Layer 4 deferred per §12.

#### 5.5.6 Event-sourcing replay determinism

The five Rev-9 events satisfy the Rev-8 replay contract by construction:

| Event | Determinism guarantee on replay |
|---|---|
| `image_extracted` | Content-addressed by `image_sha256`. Replay verifies the file exists at `<store>/keyimage/<sha256>.png`. Missing file = loud error. |
| `image_redaction_applied` | Engine + version are pinned in the event. Replay can either trust `image_sha256_after` (default; fast) or re-run redaction and verify (CI-gated mode). |
| `image_embedding_computed` | Encoder weights + version pinned. Replay re-computes embedding from `<sha256>.png` and verifies `vector_sha256` matches. Mismatch = loud error (weights drift or version mis-recorded). |
| `image_feature_extracted` | Extractor version pinned. Same re-compute-and-verify pattern. |
| `image_attached_to_context` | Pure record event. Replay just inserts the row. |

The non-deterministic step — the multimodal LLM call — is captured exactly as the text-only case is: the LLM output is stored verbatim in the `assistant_response.payload.text` field. Replay reads that text; never invokes the LLM.

This means a five-year-old visual reasoning turn can be reproduced exactly: the canonical store has the redacted images, the embeddings, the structured features, the records of which images were attached, and the verbatim LLM response. Forensic replay equals a deep-equal SQL query against the rebuilt projections plus a file-existence check on the keyimage store.

#### 5.5.7 Privacy invariants (mandatory)

Three invariants enforced by the store layer:

1. **No image_extracted commit without preceding image_redaction_applied for the same target.** The store-layer `emit_and_apply` validates this ordering in the same transaction; violation aborts.
2. **Unredacted bytes never reach the canonical file store.** The redaction pipeline operates in memory; only the post-redaction bytes are SHA-256'd and written to disk.
3. **OCR + face-detection coverage matrices per modality.** Modalities prone to burned-in faces (dermatology, ophthalmology) require the face-detection sub-pass; modalities prone to burned-in text overlays (older US, mammography, dental) require enhanced OCR aggressiveness. Coverage matrix lives in `monai_runtime/redaction_policies.json`, versioned; changes emit `redaction_policy_changed` meta-layer events.

#### 5.5.8 Storage footprint

| Item | Size per unit | Annual scale (1k patients × 4 studies × 16 images) |
|---|---|---|
| `key_image` PNG (redacted, 512×512) | ~50 KB | ~3.2 GB |
| Visual embedding (512-d float32) | 2 KB | ~130 MB (in vector_index) |
| Structured features per image | ~500 B | ~30 MB |
| Image events in log (sha + metadata) | ~1 KB | ~65 MB |

Total ≈ 3.5 GB / year for an active medic. Bounded; fits within Mac SSD budgets for decades of practice.

---

## 6. Practitioner Memory (Layer 2) — the new v3 mechanism

### 6.1 Extraction — turning encounters into observations

After every patient encounter completes (chat turn finalised, study report signed, lab posted, agent suggestion accepted/rejected), `practitioner_ingester.extract()` runs as a BackgroundTask with full encounter context as input.

The extractor is a single LLM call with `prompt_extract_practitioner_signals`. Its output is a typed JSON list of candidate observations:

```json
[
  {
    "fact_kind": "style",
    "pattern_key": "impression_template/renal_mass/uncertain",
    "pattern_value": {
      "structure": ["measurement_first", "comparison_second", "ddx_third"],
      "closing_phrase": "Recommend correlation with prior imaging."
    },
    "evidence_quote": "1. Left renal mass, 2.4 cm, mildly enlarging from prior. RCC remains top differential. Recommend correlation with prior imaging.",
    "confidence": 0.82
  },
  {
    "fact_kind": "practice",
    "pattern_key": "decision/renal_mass/lt_3cm/birads4/next_step",
    "pattern_value": {
      "chose": "MR_with_contrast",
      "alternative": "biopsy",
      "size_cm": 2.4,
      "birads": "4"
    },
    "evidence_quote": "MR with contrast remains the recommended next step.",
    "confidence": 0.91
  },
  {
    "fact_kind": "calibration",
    "pattern_key": "agent_suggestion/biopsy_for_lt_2cm/outcome",
    "pattern_value": {
      "outcome": "rejected",
      "lesion_size_cm": 1.8
    },
    "evidence_quote": "I don't think we biopsy under 2 cm yet — let's monitor.",
    "confidence": 0.95
  }
]
```

Each observation is appended to `practitioner_observations` with `patient_hash` recorded for distinct-counting and medic audit. **Verbatim quote check** (Rev-2 rule) applies identically — extractor must quote actual encounter text.

The `pattern_key` is **canonicalised** — a hierarchical slug like `decision/renal_mass/lt_3cm/birads4/next_step`. This determines whether two observations are "the same pattern": same key → same pattern. The canonicalisation rules live in `practitioner/extractor.py` and are deterministic given the extracted entities; we don't rely on the LLM to consistently generate the key.

### 6.2 Distillation — promoting observations to facts

A nightly job (`practitioner/distiller.py`) walks `practitioner_observations` per user:

```python
for user_id in active_users:
    for (fact_kind, pattern_key), obs_group in observations_by_pattern(user_id):
        existing = facts.get(user_id, fact_kind, pattern_key)

        distinct_patients = len({o.patient_hash for o in obs_group})
        total_obs = len(obs_group)

        # Privacy gate — never write to Layer 2 below threshold
        if distinct_patients < N_THRESHOLDS[fact_kind]:
            continue

        # Aggregate the pattern_value across observations
        # (e.g. for `practice`: count how many times each `chose`
        # value appeared; pick majority + confidence)
        aggregated_value = aggregate_observations(obs_group)

        if existing is None:
            # New candidate, surface for medic confirmation
            facts.upsert(user_id, fact_kind, pattern_key,
                         value=aggregated_value,
                         observed_count=total_obs,
                         distinct_patient_count=distinct_patients,
                         confidence=score(obs_group),
                         medic_confirmed_at=None)
            emit_event("practitioner_candidate_surfaced", ...)
        else:
            # Reinforce existing
            facts.reinforce(user_id, fact_kind, pattern_key,
                            new_observations=obs_group)
```

`N_THRESHOLDS` is per-kind: `style` = 3 (style is high-signal per observation), `workflow` = 5, `practice` = 5, `calibration` = 8 (calibration patterns require strong signal because they suppress agent behaviour).

### 6.3 Medic confirmation gate

Candidates surface in a dedicated UI panel "Nexus has learned" (lives in the Memory mode of the desktop, per `nexus-ux-redesign.md` §6.6):

```
"Nexus has learned" (4 candidates pending)
─────────────────────────────────────────

▸ Practice pattern (5 patients, 4 weeks)
  You usually order MR before biopsy for renal
  masses < 3 cm rated BI-RADS 4.
  (8 of 10 such cases)
  [ confirm ]   [ reject ]   [ ask me later ]

▸ Style pattern (3 reports, 2 weeks)
  Your impressions end with "Recommend correlation
  with prior imaging" when the finding is uncertain.
  (12 of 14 uncertain impressions)
  [ confirm ]   [ reject ]   [ ask me later ]

▸ Calibration (8 sessions, 6 weeks)
  You consistently reject the suggestion "recommend
  biopsy" for findings < 2 cm.
  (12 of 12 such suggestions rejected)
  [ confirm ]   [ reject ]   [ ask me later ]
```

`confirm` → set `medic_confirmed_at = now`; fact starts being used by composer.
`reject` → set `medic_rejected_at = now`; fact never surfaces again for this pattern_key.
`ask me later` → no change; will reappear after `distinct_patient_count` grows further.

The medic can also drill into a candidate to see the underlying patient cases (audit view over `practitioner_observations`) before deciding.

### 6.4 Composer — how Layer 2 reaches the agent

Every agent turn (Tier 1, 2, or 3) builds its system prompt via `practitioner.composer.build(user_id)`:

```python
def build(user_id: str, context_budget_tokens: int = 800) -> str:
    """Return a system-prompt enrichment block listing active
    practitioner facts. Ordered by recency × confidence."""
    facts = practitioner_facts.list_active(user_id)
    sections = group_by_fact_kind(facts)
    rendered = render(sections, budget=context_budget_tokens)
    return rendered
```

Rendered output looks like:

```
You are assisting Dr. JZ. Their established preferences, learned from
their case history (medic-confirmed, may be questioned by you if a
specific case contradicts):

STYLE
  • Impressions follow: measurement → comparison → DDx, closing with
    "Recommend correlation with prior imaging" when uncertain.

PRACTICE
  • Renal mass < 3 cm rated BI-RADS 4 → MR before biopsy (8/10 cases).
  • Follow-up interval for stable renal mass: 6 months.

CALIBRATION
  • Do not suggest biopsy for findings < 2 cm — consistently rejected.
  • Suggest pulmonary embolism workup for unexplained dyspnea on
    appropriate-aged patients (accepted 11/12 times).

These are your learned defaults, not rules. Surface them when they
apply; do not surface them mechanically; flag if the current case
appears to contradict any of them.
```

The 800-token budget cap keeps prompt size bounded as the medic accumulates more facts. Selection is by `recency × confidence` with per-kind quotas (no single kind eats the whole budget). Facts that haven't been reinforced in 6 months drop to lower priority and may fall out of context.

### 6.5 Runtime telemetry — calibration's feedback loop

For `calibration` facts to learn anything, the agent must record every suggestion it makes and the medic's response (accept / override / ignore). This needs a small addition to `twin_event_log`:

```
event_type='agent_suggestion'  → metadata: {suggestion_text, suggestion_kind, context_summary}
event_type='suggestion_resolved' → metadata: {suggestion_event_idx, resolution: 'accepted'|'overridden'|'ignored', medic_response}
```

The `suggestion_resolved` event is fired by either explicit UI action (medic clicked accept / reject) or implicit timeout (suggestion never referenced again after N hours → `ignored`).

`practitioner_ingester.extract()` reads these pairs and emits `calibration` candidates.

### 6.6 Privacy properties

Three invariants `practitioner_facts.upsert()` enforces:

1. `distinct_patient_count >= N_THRESHOLDS[fact_kind]` — no row reaches the active table below threshold.
2. `pattern_value_json` is scanned for `patient_hash` patterns (64-char hex) at write time; matches → reject. Belt-and-braces against extractor leaking identifiers.
3. `pattern_value_json` is scanned for date strings within encounter date ranges; matches → reject. Belt-and-braces against extractor leaking dates that could re-identify.

`practitioner_observations` is per-user, not cross-user. There is no cross-user view, no admin endpoint that lists patterns across medics, no fleet-wide aggregation. Each medic's Layer 2 is theirs alone. If we ever build a "share my anonymous learned patterns to improve the model" opt-in path, it goes through Layer 4 (case library), not through Layer 2.

### 6.7 Connection to existing infrastructure

`tools_evolve.py` (already in the codebase) is the meta-layer — agent modifies its own prompts, classifier thresholds, view recipes based on usage telemetry. Different concern, different store. Both are driven by separate background jobs; both append to `twin_event_log` for audit. The composer (Layer 2) and the evolver (meta-layer) read independent state and may, in extreme cases, produce conflicting nudges — when that happens the medic's confirmed Layer 2 fact wins (medic sovereignty principle, same as Rev-3).

The old per-user `twin.curated_memory` MEMORY.md (pre-#176) was a primitive flat predecessor to Layer 2 — single-file, no schema, no promotion, no privacy gate. It is **deprecated** by Layer 2; the migration path is one-time extraction of distinct facts from the markdown body into `practitioner_observations` with the original markdown line as `evidence_quote`. Old `curated_memory` table stays read-only for one release as a safety net.

---

## 7. Retrieval — composed across layers

The tiered retrieval (T1/T2/T3) from v2 §6 is unchanged. What changes is **what each tier composes into the system prompt** before invoking the LLM:

| Tier | Prompt composition |
|---|---|
| T1 (cached view) | View template + `composer.build(user_id, budget=400)` enrichment |
| T2 (single-shot) | Entity context + `composer.build(user_id, budget=600)` enrichment |
| T3 (Algorithm 1) | Full retrieved context + `composer.build(user_id, budget=800)` enrichment |

T3 also gets Layer 3 reference snippets injected when the question touches guideline-shaped topics (e.g. "what's the standard follow-up interval for BI-RADS 3?"). The composer detects guideline-eligible patterns and pulls from `reference_knowledge`.

Latency budget from v2 §8 holds. The composer adds < 5 ms per call (SQL over a small table).

### 7.1 Multimodal context (Rev-9)

Tier 2 and Tier 3 retrieval **also attach key-image binaries** to the LLM message when the retrieved entities are imaging findings. Tier 2: composer auto-attaches up to 3 key_images per cited finding. Tier 3: the LLM may also call `get_key_image(sha256)` inside the iterative loop to pull additional images on demand, up to a 16-image budget per turn. Each attachment emits `image_attached_to_context` for audit.

This is the practical mechanism by which Rev-9's "agent sees the image, not just words about it" property is realised at retrieval time. The composer prompt is appended:

> "Some retrieved findings include the original key images. Examine them directly when texture, morphology, enhancement, or comparison with prior detail matters; do not rely solely on prior captions."

### 7.2 Imaging-aware tools (additions to v2 tool inventory)

On top of v2's `search_node` / `search_encounter` / `compare_studies` / `search_past_chats`, Rev-9 adds two imaging-focused tools:

- `search_image_similar(reference_image_sha256, top_k, scope)` — visual cosine similarity over `vector_index.chunks` filtered to `embedding_kind='visual'` + matching encoder version. Scope defaults to current patient; `my_corpus` opt-in via settings.
- `get_key_image(image_sha256)` — fetches the redacted PNG binary for inclusion in the next LLM round. Emits `image_attached_to_context`. Rejects requests for images that exist but whose redaction status is `redacted_at IS NULL` (defensive belt-and-braces).

---

## 8. Conflict resolution — unchanged from v2

Four-axis cascade (Rev-3) is unchanged. Layer 2 introduces **no new conflict types** — practitioner facts are about the medic, not about clinical facts; they can't contradict Layer 1 evidence. They can disagree with Layer 3 guidelines (medic's practice differs from guideline) — but that's not a conflict to resolve, it's information for the agent to weigh ("guideline says X; this medic does Y in 8/10 cases — flag if the current case is atypical").

---

## 9. Phased delivery — revised

v2 had M0–M5. v3 appends two phases for Layer 2:

| Phase | Scope | Weeks |
|---|---|---|
| **M0** — Event-sourcing foundation + skeleton | **expanded per Rev-8.** Event_log middleware (typed event taxonomy ~40 kinds, `event_kind_version` registry, JSON Schema validation at write time); `Store.emit_and_apply()` as the only legal mutation entry point + CI lint rule forbidding direct projection writes; `projection_state` table + replay infrastructure; golden replay test (CI gate); chat_ingester rewritten as first event-sourcing client to validate end-to-end; vendor M3 (clinical_graph + control_loop with LLM-client swap); provenance enforcement; T3-only `search_node` + `search_encounter` tools; ship full v3 SQLite schema including practitioner_facts / practitioner_observations / reference_knowledge tables (Layer 2/3 schema ready, code not yet) | 1.5–2 |
| **M0.5** — **MONAI lightweight spike** (Rev-6) | install MONAI on Mac; verify `monai.transforms` DICOM I/O; convert 1 × 2D Model Zoo bundle (chest X-ray triage) to CoreML, benchmark ANE latency on M2/M3; wrap our Gemini Flash quick-scan as a MONAI Bundle (`quick_scan_4x4_grid@0.3.0`); prototype OHIF Label bridge (capture path only) | 1 |
| **M1** — DICOM ingester (modality routing) | rewrite ingester for stages 1–9 of §5.1; Stage 2A 2D CoreML inference; Stage 2C Bundle-wrapped quick-scan; **plus IM-1 from §5.5.2** — render + redact + content-addressed PNG store + emit `image_extracted` / `image_redaction_applied` events; **no** cross-study compare yet; **no** visual embedding or structured features yet; provenance writeback through `bundle_loader` | 1.5 |
| **M1.5** — **Visual embeddings (Rev-9 / Layer A)** | model selection spike (BiomedCLIP / CXR-CLIP / MONAI image encoder); CoreML conversion + ANE latency benchmark; `image_embedding_computed` event handler; visual embedding stored in `vector_index.chunks` with `embedding_kind='visual'`; `search_image_similar` tool registered | 1 |
| **M1.6** — **Multimodal LLM context (Rev-9 / Layer B)** | Tier 2/3 composer attaches up to N key_images per turn; `get_key_image` tool registered for in-loop fetching; `image_attached_to_context` event emitted per attachment; composer prompt updated; token + image budget management with cost telemetry | 1 |
| **M1.7** — **Structured radiology features (Rev-9 / Layer C)** | HU stats extractor (pure pydicom, no model); 1–2 MONAI bundles for morphology / enhancement-pattern; `image_feature_extracted` event handler; values land on `measurement` node `content_json.features`; new query operators (e.g. "findings with HU > 30") usable from `search_node` filters | 1 |
| **M2** — Cross-study compare + same_finding union | heuristic anatomical-region overlap; voxel-grounded registration deferred to inference companion; **uses visual embeddings from M1.5** to score same_finding candidates more reliably than pure caption matching | 1 |
| **M3** — Conflict resolution v1 (four-axis) | | 1 |
| **M4** — Tiered retrieval (T1/T2 + classifier) | | 1 |
| **M5** — Cutover + lab ingester | | 0.5 |
| **M6** — Practitioner extraction (style + workflow) | observations table + extractor for lowest-risk kinds; no agent use yet | 1 |
| **M7** — Distiller + confirmation UI | distiller, "Nexus has learned" panel, composer using confirmed facts | 1 |
| **M8** — Practice + calibration extraction | higher-risk fact kinds added once M7 is stable | 1 |
| **M9** — Layer 3 schema + RadLex/RxNorm loaders | reference KB populated; composer wires to it | 0.5 |
| **M10** — *(deferred, post-v1)* Inference companion + heavy MONAI | remote 3D inference service (VISTA-3D / TotalSegmentator / registration); swap-in at Stage 2C and Stage 5 of dicom_ingester; v3 graph schema already accommodates without migration | — |

Total: 10.5 dev-weeks for a solo dev across the full v3 stack. M0–M5 (Layer 1 + lightweight MONAI) deliver standalone value; M6–M9 (Layers 2 + 3) extend incrementally; M10 (inference companion) is a post-v1 architecture extension.

**Why M0.5 sits between M0 and M1.** M1 rewrites the DICOM ingester around the modality-routing pipeline (§5.1) which assumes Bundle loading + CoreML inference + OHIF Label hook are working. M0.5 derisks all three on actual Mac hardware before M1 starts. If M0.5 finds that MPS/ANE latency for our chosen 2D bundles is unacceptable, M1 falls back to Gemini Flash for 2D as well — the schema and pipeline architecture survive unchanged.

**M6 specifically does NOT activate facts** — extraction runs, observations accumulate, but the composer is not yet enabled. This gives us a 1-week observation window to inspect what the extractor produces against real encounters before any of it reaches the agent. **Layer 2 has the highest "make it worse" risk** of the v3 surface, and this dry-run gate is non-negotiable.

---

## 10. Observability

v2's five signals plus three Layer 2 specific:

**Practitioner candidate rate** — candidates surfaced per medic per week. High rate = extractor is over-firing; low rate = under-firing or insufficient case volume.

**Confirmation ratio** — confirmed / (confirmed + rejected) per fact_kind. Low confirmation = the extractor is hallucinating patterns; investigate.

**Active facts size** — total confirmed facts per medic, tokens consumed in composer output. Watch for prompt-bloat once a medic crosses 50+ active facts.

---

## 11. Risks & mitigations

R1–R11 from v2 — unchanged. Plus:

**R12 — Layer 2 entrenches bias.** If the medic has a non-evidence-based practice habit, Layer 2 reinforces it.
Mitigation: composer prompt explicitly says "these are defaults, not rules; flag contradictions to current case." Layer 3 guideline injection serves as the counterweight when the medic's practice diverges from guideline. Periodic anonymised review by the medic of their own active facts — most medics will spot the "I shouldn't be doing that" patterns themselves.

**R13 — Extractor hallucinates patterns.** Practitioner extractor invents a pattern the medic doesn't actually follow.
Mitigation: same `evidence_quote` verbatim verification as Layer 1 ingestion. `medic_rejected_at` is a final stop — rejected pattern_keys never reappear. Confirmation ratio metric (§10) flags the failure mode in aggregate.

**R14 — Prompt bloat as facts accumulate.** After 5 years of practice, composer output could be huge.
Mitigation: per-kind token budget caps + recency × confidence ordering + facts not reinforced in 6 months age out of prime context (still queryable on demand). Composer enforces a hard 800-token ceiling.

**R15 — Cross-user inference.** Even per-user Layer 2 could theoretically leak something if patterns ever crossed users (e.g., a "fleet-wide popular practice" feature).
Mitigation: explicit invariant — `practitioner_facts` queries always include `user_id` in WHERE; no admin endpoint can query without user_id. Documented in the module docstring; code review checklist item.

**R16 — MONAI Bundle ↔ provenance schema impedance (Rev-6).** MONAI Bundle metadata schema evolves independently of our `node_provenance` schema; future MONAI versions may change Bundle config fields we depend on.
Mitigation: `monai_runtime/bundle_loader.py` is a thin adapter that explicitly maps Bundle metadata fields → typed `Provenance` row. We pin a specific MONAI version per release; upgrades are deliberate. Compatibility test in CI loads every shipped Bundle and asserts adapter output matches a golden Provenance row. Drift is detected at CI time, not at runtime.

**R17 — Mac CoreML inference unavailable / slow on older hardware (Rev-6).** Our CoreML bundles target Apple Neural Engine; M1 has ANE but limited capacity, and Intel Macs have no ANE at all (Rosetta-emulated PyTorch CPU only).
Mitigation: Bundle inference is best-effort with explicit fallback. `coreml_inference.run()` measures hardware capability on first call; if ANE unavailable or latency exceeds 10× expected, routes to Stage 2C Gemini-Flash fallback automatically. Provenance records which path was taken (`extraction_model = "monai-bundle://chest_xray_triage@1.2.0/fallback-gemini-flash"`), preserving auditability across hardware tiers.

**R18 — Inference-companion swap-in regression (Rev-6 / M10).** When the inference companion ships and Stage 2C / Stage 5 swap from Gemini-Flash quick-scan to remote MONAI, downstream graph consumers may have implicitly depended on Gemini-Flash quirks (caption phrasing, finding granularity).
Mitigation: golden test set of (study, expected graph subgraph) pairs captured during v1; after the swap, the test set is re-run and graph diff is reviewed. If structural divergence is detected, swap is gated behind a per-user feature flag (`memory.use_inference_companion`) until reconciled.

**R22 — Projection rebuild duration on long event logs (Rev-8).** A medic with 5 years of accumulated history could have 100k+ events; a from-scratch projection rebuild may take many minutes.
Mitigation: `projection_state.last_applied_event_idx` checkpoints — normal-operation rebuilds are incremental. Full rebuild only on schema upgrade or corruption. Background-rebuild path keeps the old projection readable while the new one is being built; atomic swap on completion. Benchmark gate: 100k-event replay must complete in < 60 s on M-series SSD; if it slows, partition by `(user_id, patient_hash)` and rebuild in parallel.

**R23 — Event taxonomy drift (Rev-8).** New event kinds are added as the system evolves; replay code must handle every historical `(kind, version)` pair forever. A missing handler silently skipped at runtime would be catastrophic (replay would diverge invisibly).
Mitigation: replay handlers registered as a closed `(kind, version) → handler` table; unknown pairs raise `UnknownEventKindError` loudly. CI test enumerates every (kind, version) ever shipped (tracked in a registry file under version control) and asserts a handler exists. Removing a handler for an old version is a code-review hard fail.

**R24 — Visual encoder version drift (Rev-9).** Once visual embeddings are written, changing the encoder model invalidates the entire visual-similarity index — old vectors live in a different space than new vectors.
Mitigation: encoder version is part of `image_embedding_computed.encoder_version` and stamped on every chunk. On encoder upgrade, treat like text-embedding rotation (§16.7) — lazy re-embed on next access, keep old vector for 90 d. `search_image_similar` queries are scoped to a single encoder version; cross-version searches return empty + emit `visual_search_blocked_version_mismatch` warning.

**R25 — OCR-based redaction misses non-text PHI (Rev-9).** Patient face in a dermatology smartphone photo, visible tattoos, implanted-device serial numbers. OCR catches text but not faces / biometric features.
Mitigation: redaction pipeline runs a face-detection pass for ophthalmology / dermatology modalities (small CoreML face detector). Medic UI flags any image where the redaction policy detected uncertain regions and offers manual review before commit. Coverage matrix in `monai_runtime/redaction_policies.json` enumerates which passes apply to which modality. The matrix itself is versioned (events on change).

**R26 — Multimodal LLM token cost (Rev-9).** Images attached to LLM input consume tokens at higher cost than text. A medic asking heavy comparative questions could blow through monthly budget.
Mitigation: per-Tier image budget (T2 ≤ 3, T3 ≤ 16); composer estimates token cost pre-call; if a query would exceed a daily cost cap, falls back to text-only context with a `cost_degradation` event logged. Weekly cost telemetry surfaced in Settings → Data; medic can configure their own cap.

---

## 12. Out of scope (deferred)

Unchanged from v2 — **plus** explicitly:

**Layer 4 — Case Library**. De-identified case archetypes for similar-case retrieval. Substantial privacy/consent engineering required (HIPAA Safe Harbor or stricter, per-case explicit medic archive action, possibly institutional review). Deferred to a 6-month+ horizon, post-M9. The v3 module layout reserves the directory name (`packages/server/nexus_server/case_library/`) but does not implement.

**Cross-medic shared practitioner facts.** Even with explicit opt-in, this is a much larger design problem (would the medic want to see "23 other radiologists agree with this pattern"? what about medico-legal implications of agent suggesting based on aggregated peer practice?). Out of scope until we have clear product demand and legal review.

**Heavy 3D MONAI inference on the Mac (Rev-6).** VISTA-3D, TotalSegmentator, and image-registration networks require GPU acceleration that is not available on Mac (no CUDA; partial MPS). Inference on full-body CT in CPU/MPS mode runs in minutes to tens of minutes per study — incompatible with a 30-second radiology read. Deferred to the **inference companion** architecture (v3 phase M10, post-v1 ship). Until then, the DICOM ingester's Stage 2C uses Gemini-Flash quick-scan, and Stage 5 uses heuristic cross-study compare. Both are designed as explicit swap-in points so v2 work does not require schema migration. We accept that v3 R3/R8/R9/R13 risks are only *partially* closed (closed for 2D modalities where CoreML bundles ship; open for 3D modalities until M10).

**Inference companion architecture itself (M10).** v3 design preserves the *interfaces* a future companion will plug into (Bundle id at provenance, swap-in points in dicom_ingester), but does not specify the companion's deployment model (institution-hosted GPU server vs cloud vs Mac mini + eGPU sidecar), security model (mTLS, BAA scope), or discovery protocol (zeroconf vs configured endpoint). Those are M10 design problems.

---

## 13. Decision log — extended

| Question | Decision | Why |
|---|---|---|
| Add Layer 2 (practitioner memory)? | Yes | v2 had no answer to "agent gets smarter at the medic over time" |
| Layer 2 scope: per-user or shared? | Per-user only | Cross-medic inference too risky for v3; design Layer 4 separately if ever needed |
| Layer 2 activation: silent or confirmed? | Medic confirmation gate required | Agent must not silently start using learned patterns; trust + correctability |
| Layer 2 threshold for promotion? | N distinct patients per fact_kind | Privacy guarantee — no single patient's signal can populate Layer 2 alone |
| Per-kind N threshold values? | style=3, workflow=5, practice=5, calibration=8 | Empirical estimates; tunable via meta-layer; calibration highest because it suppresses |
| Layer 2 in M0 of phased plan? | No — phases M6–M8 | Layer 1 must be stable first; Layer 2 is the highest blast-radius surface |
| Activate extraction before composer? | Yes — M6 is dry-run | 1-week window to observe what gets extracted before any of it reaches the agent |
| Where does provenance for Layer 2 live? | `practitioner_observations` per-user | Mirrors `node_provenance` from Layer 1; medic can audit "what made you think this" |
| Layer 3 (reference KB)? | Schema in v3, population in M9+ | RadLex / RxNorm loaders are separable from the runtime contract |
| Layer 4 (case library)? | Deferred 6 months+ | Privacy/consent engineering is its own project |
| Deprecate old `twin.curated_memory`? | Yes — Layer 2 supersedes | One-time migration of distinct facts; read-only retention for one release |
| Composer token budget? | 800 max, per-kind quotas | Bounds prompt bloat as facts accumulate over years |
| Calibration requires suggestion logging? | Yes — new `agent_suggestion` event | Without it, calibration facts can't be extracted |
| **MONAI integration scope (Rev-6)** | **Lightweight layer only** — DICOM I/O + Bundle format + 2D CoreML + OHIF Label hook | Mac client has no CUDA; partial MPS makes heavy 3D inference infeasible at clinical latency |
| **Quick-scan packaging?** | Wrap Gemini-Flash quick-scan in a MONAI Bundle | Uniform provenance footprint across all imaging extractors; future inference-companion swap-in is a Bundle reference change, not a schema change |
| **Bundle ↔ provenance mapping?** | Adapter in `monai_runtime/bundle_loader.py` | Decouple MONAI Bundle metadata schema evolution from our typed Provenance schema |
| **MONAI Label retraining loop?** | Capture path in v3 (medic_correction events); retraining loop in v2 | Capture is cheap and forward-compatible; retraining requires MLOps infra we don't yet have |
| **CoreML failure-fallback policy?** | Auto-fallback to Gemini-Flash with provenance recording the path taken | Older Macs without ANE / Intel Macs must still work; auditability requires recording which path executed |
| **Heavy 3D MONAI (VISTA-3D etc.)?** | Deferred to M10 inference companion | Mac cannot run them; design preserves swap-in points without committing to companion architecture in v1 |
| **Inference companion architecture itself?** | M10 design problem | v3 must not prematurely fix deployment / security / discovery model for the companion |
| **Event sourcing as foundation (Rev-8)?** | Yes — `twin_event_log` is the canonical store; everything else is a projection | Rev-7's "rebuildable from event_log" was aspirational; honest audit showed only 40–50% reconstructible. Strong contract closes the gap |
| **LLM outputs in events?** | Verbatim, in `ingestion_llm_response.raw_output_text` | Replay must be LLM-free; non-determinism is bypassed by archive, not re-execution |
| **DICOM files in events?** | No — content-addressed on disk, referenced by SHA-256 from events | Events stay small; binary blobs live in `~/Library/Nexus/files/<sha>.bin` |
| **Reference KB payloads in events?** | No — only version pointers in events; payloads re-downloadable from authoritative source | RxNorm / RadLex / ACR-AC payloads are large, public, and re-fetchable; pointers preserve which version was in effect |
| **`emit_and_apply` as only mutation entry point?** | Yes — CI lint rule enforces; direct projection writes are a hard fail | Single chokepoint makes the invariant testable |
| **Golden replay test in CI?** | Yes — hard gate on every store-layer / ingester PR | Without it the invariant rots silently |
| **Event kind versioning?** | `event_kind_version` field per event; replay registers `(kind, version)` handler pairs | New event versions never break replay of old events |
| **M0 expanded scope?** | Yes — 1 week → 1.5–2 weeks; event-sourcing infra is M0 deliverable | Every later phase depends on it; cannot be deferred |
| **Imaging in memory — text only or pixels too (Rev-9)?** | All three layers (A visual embeddings + B multimodal LLM at retrieve + C structured features) | Caption-only loses what Gemini Flash didn't write down, blocks visual similarity, blocks pixel-level cross-study reasoning |
| **Where do key images live?** | Content-addressed under `~/Library/Nexus/files/keyimage/<sha256>.png`, referenced from events; export bundle includes them per-patient | Bounded storage (~3.5 GB / year), survives DB corruption, replay-friendly |
| **Redaction stance for burned-in DICOM PHI?** | Mandatory before any image_extracted commit; unredacted bytes never reach the file store | Burned-in PHI is a known clinical-imaging problem; no acceptable workaround |
| **Redaction engine?** | pydicom overlay strip + OCR (PaddleOCR / Tesseract) + per-modality face detection for dermatology / ophthalmology | Belt-and-braces; engine version + policy version both versioned in events |
| **Multimodal LLM at retrieval — auto-attach or tool-call?** | Both: T2 auto-attaches up to 3; T3 LLM also calls `get_key_image()` for additional ones, max 16/turn | Auto for common case; tool for iterative drilldown; budget protects cost |
| **Visual encoder choice?** | M1.5 spike picks among BiomedCLIP / CXR-CLIP / MONAI image encoder | License (Apache-2.0 or MIT preferred), Mac CoreML feasibility, clinical coverage |
| **Cross-encoder-version visual search?** | Blocked — explicit error event | Embeddings in different spaces are not comparable; would produce garbage results |
| **Image-attached audit events?** | Every attachment emits `image_attached_to_context` referencing parent assistant_response | Medico-legal: "what images did the agent base its 2026-04-12 advice on" must be answerable |

---

## 14. Open questions for M0 / M6 kick-off

1. Which LLM powers `practitioner_ingester.extract()` — Gemini Flash for cost, Claude Haiku for nuance? Extraction quality matters more for `practice` and `calibration` than for `style` / `workflow`. Lean Gemini Flash for M6 (style + workflow), benchmark before M8 to decide if `practice` / `calibration` need Haiku.

2. `pattern_key` canonicalisation rules per fact_kind — needs a small spec doc. Draft before M6, refine during dry-run window.

3. Composer ordering function — recency × confidence is the v3 default, but per-medic learning rate may differ. Telemetry from M7/M8 will inform whether we add per-medic weighting.

4. Suggestion-resolution event firing — UI affordances for "accept / override / ignore" need design alignment with `#196` UX redesign. Encounter mode currently has no explicit accept/reject affordance on agent messages.

5. "Nexus has learned" panel placement — Memory mode side panel vs full-screen view? Likely full-screen given content density; align with #196.

6. Migration path for the deprecated `twin.curated_memory` — distillation pass needs an LLM call per existing markdown body. Costs are bounded (one-time, per user); validate output quality on a test cohort before global rollout.

7. Layer 3 RadLex import — RadLex licensing terms allow ingestion but require attribution; need a `reference_knowledge.source` value convention.

8. **Which 2D MONAI bundles ship first (M0.5 / M1)** — candidates: chest X-ray triage (NIH-CXR + CheXpert weights), dermatology lesion classifier (ISIC), fundus screening (Kaggle DR). Pick by (a) license compatibility with Apache-2.0 / commercial use, (b) CoreML conversion feasibility, (c) clinical utility in our target user base. Resolve before M0.5 starts.

9. **Bundle license matrix.** MONAI core is Apache-2.0, but individual Model Zoo bundles have varying licenses (some bundles are CC-BY-NC, some are NVIDIA Source Code License). Need a per-bundle license review before any bundle ships in our `.dmg`. Resolve in M0.5.

10. **OHIF Label protocol fidelity.** MONAI Label's REST protocol is specified for server-resident deployments. Our deployment is Mac-local — does the existing OHIF Label JS client work against a local FastAPI endpoint, or do we need a thin protocol shim? Resolve in M0.5 prototype.

11. **CoreML conversion drift.** A bundle converted from PyTorch → ONNX → CoreML may have numerical drift vs the original. For 2D classifiers this is rarely clinically significant; need a sanity test (compare on a held-out set, assert agreement > 99%). Define the agreement metric and threshold in M0.5.

12. **Visual encoder selection (M1.5).** BiomedCLIP (Microsoft, MIT) vs CXR-CLIP (open) vs MONAI Image Encoder (in 1.6+, Apache-2.0). Need a 2-day comparative spike: clinical task agreement on a held-out validation set (renal mass vs healthy CT slices, simple binary task) + CoreML conversion feasibility + ANE latency. Resolve before M1.5 committed.

13. **Image attachment encoding for multimodal LLM (M1.6).** Gemini and Claude both accept image inputs, but encoding format differs (base64 vs URL refs vs file upload API). Need a thin adapter in `nexus_server/llm/multimodal_client.py`. Resolve in M1.6.

14. **Redaction confidence threshold.** OCR + classifier confidence below which the medic is asked to manually review. Too low = burnout; too high = PHI leakage. Start at 0.8; tune from M1 telemetry.

15. **Cross-medic visual similarity (Layer 4 / deferred).** Would benefit from the visual embedding work in M1.5, but raises strong privacy / consent concerns (image archetypes are more re-identifying than text archetypes). Deferred to v2 with the rest of Layer 4.

---

## 16. Data persistence, sovereignty, and event sourcing

The design above specifies what the data looks like and where it lives at runtime. This section covers what we guarantee about **not losing it**, **letting the medic take it away**, **reproducing past agent state** five years later, and — the architectural foundation that makes the others possible — **why `twin_event_log` is literally the single source of truth** with every other table being a derived projection. Codified at the ADR level in Rev-7 + Rev-8.

### 16.1 Two contracts

**Contract A — the medic owns their data, not us.** Any export produces a self-contained bundle in open documented formats. No proprietary binary anywhere. Nexus going away does not take the records.

**Contract B (strong, per Rev-8) — `twin_event_log` IS the single source of truth.** Every state-changing operation in the system is a typed event appended to `twin_event_log` in the same SQLite transaction as the corresponding mutation. All other persistent tables — `clinical_graph_nodes`, `clinical_graph_edges`, `node_provenance`, `cached_views`, `practitioner_facts`, `practitioner_observations`, `reference_knowledge`, even the existing `patients` / `dicom_studies` legacy tables — are **projections**, materialised views rebuildable on demand by replaying event_log against an empty database. LLM outputs are stored verbatim in events; replay never re-invokes a model. Reference KB data is stored by version pointer in events; payloads are re-downloadable from authoritative sources. Large binaries (DICOM files) are content-addressed by SHA-256 and referenced from events.

Mechanics specified in §16.12.

### 16.2 Threat model

Ranked by probability:

1. Local SQLite corruption / accidental file deletion.
2. Mac laptop loss / theft / hardware failure.
3. Schema-migration bugs in a Nexus version upgrade.
4. Embedding model / RxNorm / RadLex / guideline version rotation (orphaned vector refs, stale citations).
5. App-version incompatibility (medic upgrades to v4, old data won't load).
6. Nexus product itself ceasing to exist or being acquired-and-killed.
7. Long-horizon format obsolescence (10+ years).

The design below addresses all seven. The unusual one is (6) — most products design around (1)–(5) and treat (6) as "user's problem." We treat it as "our problem to design out of the relationship" via Contract A.

### 16.3 Five-tier persistence

```
Tier 0 — Hot SQLite                running agent's working state
Tier 1 — WAL + local snapshots     every 6h, ~/Library/.../snapshots/
                                   30-day rolling retention
Tier 2 — Daily archive tarballs    ~/Documents/Nexus Archive/YYYY-MM-DD.tar.zst
                                   30 daily / 12 weekly / 24 monthly
Tier 3 — Optional remote sync      rclone adapter → iCloud / Google Drive /
                                   OneDrive / S3, age-encrypted,
                                   keys in macOS Keychain (user-controlled)
Tier 4 — Sovereign export bundle   on-demand, "Settings → Data → Export"
                                   self-contained, open formats, no Nexus
                                   code required to read
```

Each tier addresses a different class of threat. Tier 0/1 cover (1) and (3); Tier 2 covers (1) and rollback; Tier 3 covers (2); Tier 4 covers (5), (6), (7) and (4) by versioning.

### 16.4 Sovereign export bundle format (Tier 4)

The bundle is a directory (optionally tarballed). Its top-level layout:

```
nexus-export-2026-06-13/
├── README.md                         # human-readable; explains every file
├── MANIFEST.json                     # schema versions, counts, SHA-256 of every file
├── checksums.sha256                  # standard sha256sum-compatible
│
├── layer1_patients/
│   └── <patient_hash>/
│       ├── graph.json                # nodes + edges
│       ├── provenance.jsonl          # one provenance row per node
│       ├── summary.md                # human-readable patient summary
│       ├── fhir-r5.json              # FHIR R5 Bundle — EHR-importable
│       ├── timeline.csv              # flat timeline; opens in Excel
│       └── studies/
│           └── *.dcm                 # original DICOM passthrough
│
├── layer1_event_log/
│   └── events.jsonl                  # the entire append-only ledger
│
├── layer1_cached_views/
│   └── views.jsonl                   # rebuildable; included for convenience
│
├── layer2_practitioner/
│   ├── facts.jsonl                   # active practitioner facts (PHI-stripped)
│   ├── observations.jsonl            # raw observations (carries patient_hash; medic-audit only)
│   └── HISTORY.md                    # "Nexus has learned" full timeline, prose
│
├── layer3_reference/
│   └── versions.json                 # which RadLex/RxNorm/guideline versions were used
│                                     # (payload not bundled — re-downloadable, public)
│
├── meta_layer/
│   ├── prompts/                      # every prompt version this medic's data was extracted with
│   │   ├── imaging_findings_v1.md
│   │   ├── imaging_findings_v2.md
│   │   └── ...
│   ├── configs/                      # evidence_rank / tier_rules / etc, time-versioned
│   └── skill_registry.jsonl
│
└── _sql_dump.sql                     # full SQLite .dump — format-independence fallback
```

Each `*.jsonl` file's first record is a `_meta` header carrying schema version + field definitions URL:

```jsonl
{"_meta": {"schema": "nexus.layer1.graph", "version": "3.1", "exported_at": "...", "field_defs_url": "https://docs.nexus.dev/schema/v3.1"}}
{"node_id": 142, "node_type": "finding", ...}
{"node_id": 143, ...}
```

The `README.md` is **not optional**. It walks a hypothetical engineer with no Nexus context through reconstructing the medic's records. If five years from now Nexus is gone and only the bundle remains, this file is what allows the records to live on.

`_sql_dump.sql` is the final backstop. Even if our JSON schemas drift or the field-defs URL stops resolving, `sqlite3 < _sql_dump.sql` reconstitutes the entire database into a stock SQLite, no Nexus tooling required.

### 16.5 FHIR R5 export contract

Layer 1 Graph nodes map to a FHIR R5 Bundle for EHR interop:

| Graph node | FHIR R5 resource |
|---|---|
| `patient` | `Patient` (de-identified per HIPAA Safe Harbor unless medic opts to include identifiers) |
| `study` | `ImagingStudy` |
| `finding` | `Condition` or `Observation.imaging` (depending on type) |
| `measurement` | `Observation` with quantitative value |
| `med` | `MedicationStatement` |
| `lab` | `Observation.laboratory` |
| `ddx` | `Condition.verificationStatus=differential` |
| `episodic_event` | `Provenance` resource pointing at parent |
| `semantic_fact` | `Composition` section text + linked `Provenance` |

This transformer is in `nexus_server/export/fhir_r5.py`. It is **lossy** by design — FHIR cannot represent everything in our graph (specifically: edge weights, conflict-resolution state, embedding refs). Those are preserved in `graph.json`. FHIR is the **interop layer**, not the canonical layer.

### 16.6 Schema evolution

Three invariants govern all migrations:

1. **Never delete columns.** Only `ADD COLUMN` and mark-as-deprecated. Old export bundles loaded into new app versions always resolve.
2. **Every record carries `_schema_version`.** Forward migration is automatic on app upgrade; backward migration is best-effort and tested for the last 3 minor versions.
3. **`twin_event_log` is migration-immutable.** Columns may be added; existing event content is never rewritten.

#### 16.6.1 Implementation — Alembic-managed main DB (U3.4)

Migrations live in `packages/server/nexus_server/migrations/versions/NNNN_*.py`. We use **Alembic** as the runner + version tracker (`alembic_version` table), but every migration body is **hand-written raw SQL** via `op.execute()` — there is no SQLAlchemy ORM layer in `nexus_server` and we don't add one.

Both **schema** changes (`ALTER`/`CREATE`/`DROP`) and **data** changes (`UPDATE`/backfill/`INSERT`) flow through the same framework. A migration file can mix both when they're conceptually one change ("add column and backfill it"). When the backfill is expensive (large row count, LLM-driven extraction), split into two migrations — the schema half lands fast on every install, the data half re-runs cheaply via `WHERE <not yet backfilled>` idempotency.

Boot pipeline (`main.py::lifespan`):

```
config.validate()
   ↓
alembic.command.upgrade(cfg, "head")          ← runs all pending NNNN_*.py
   ↓                                            in a single transaction each;
init_db()    ← belt-and-suspenders                failure raises → uvicorn refuses
   ↓                                              to start → desktop shows
twin reaper / vector index / async worker         "Backend down" banner
```

`render_as_batch=True` in `env.py` lets Alembic transparently rewrite SQLite tables when the change isn't expressible via plain `ALTER` (DROP COLUMN, CHANGE TYPE) — Alembic does CREATE NEW TABLE + INSERT SELECT + DROP OLD + RENAME under the hood.

**Failure mode the design refuses to allow:** a server that boots into a half-migrated DB. Either every pending migration applies cleanly or startup aborts. Half-states are debuggable for two minutes; let-the-app-run-with-broken-schema is debuggable for weeks.

#### 16.6.2 Adding a migration

```bash
# Schema change example: add a column
cp packages/server/nexus_server/migrations/versions/0002_template_data_backfill.py.example \
   packages/server/nexus_server/migrations/versions/0003_add_lab_panel_col.py

# Edit the file: revision = "0003"; down_revision = "0002" (or "0001"
# if you tag onto the initial); then write upgrade():
def upgrade():
    op.execute("ALTER TABLE labs ADD COLUMN panel TEXT NOT NULL DEFAULT ''")
    op.execute("CREATE INDEX idx_labs_panel ON labs(user_id, panel)")
    # Schema + data in one transaction:
    op.execute("UPDATE labs SET panel = 'cmp7' WHERE analyte IN ('Na','K','Cl','CO2','BUN','Cr','glu')")

# That's it. Next ./scripts/build-macos.sh ships it; every user's
# next launch runs it once and stamps alembic_version=0003.
```

#### 16.6.3 Event-log schema — out-of-band

`twin_event_log` is **per-user**, lives at `~/.nexus_server/twins/<user_id>/event_log/user-XXX.db`, and carries its own `event_log_schema_version` row (read by `twin_event_log.py` on connection open). We deliberately **do not** put the event log under Alembic for three reasons:

- **Per-user files**: maintaining an `alembic_version` for N user DBs adds startup time proportional to user count.
- **Append-only by design**: schema almost never changes; `event_kind_version` (§4.3) handles payload evolution without table changes.
- **Replay safety**: any operation that touches the canonical log must preserve byte-identical replay. Alembic's automatic batch-rewrite would violate that.

When event-log schema must change (rare; v2 → v3 only added columns), the upgrade is hand-coded in `twin_event_log.py` and gated by the version row.

#### 16.6.4 Rollback policy

`downgrade()` is implemented in every Alembic migration BUT **never runs in production**. Why:

- Reverting a deployed migration usually requires data loss (which rows did the new code touch? we don't know).
- Forward fixes are cheaper to reason about: write `NNNN+1_revert_NNNN.py` that's an explicit "undo what NNNN did to the state we have now".
- `alembic downgrade` is a developer tool — useful during migration authoring, not as a recovery mechanism.

### 16.7 Embedding rotation — lazy migration

`vector_index.chunks` carries an `embedding_version` column. When Gemini's `text-embedding` model rotates:

- Existing chunks keep their old vector + version pointer.
- New chunks created after the rotation use the new model.
- On retrieval, if a chunk's `embedding_version` is older than the current model's version, the chunk's text is re-embedded **on access** and the new vector replaces the old. The old vector is kept for 90 days as a rollback safety net (`embedding_v_prev` column).
- The original `content_text` + `evidence_quote` are preserved regardless of embedding version. **Embeddings are not the evidence**; the quoted text is.

Result: no thundering-herd re-embedding cost on model rotation; retrieval quality recovers gradually as data is touched.

### 16.8 Medico-legal replay

Five years after Dr. Chen's encounter on 2026-04-12, a question arises: "What exactly did Nexus tell you, and on what evidence?" Reconstruction protocol:

1. From `twin_event_log` (in any Tier 1-4 backup): locate `assistant_response` event on that date → retrieve verbatim text.
2. From `node_provenance`: retrieve every node cited in the response — get `extraction_model`, `extraction_prompt_id`, `evidence_quote`, `extracted_at`.
3. From `meta_layer/prompts/`: load the exact prompt version active that day.
4. From `meta_layer/configs/evidence_rank_2026-03.json`: load conflict-resolution policy active that day.
5. From `layer3_reference/versions.json`: identify which guideline / drug-DB / ontology versions were in effect.

**The LLM does not need to be re-run.** The verbatim response is in the event log; the verbatim evidence is in provenance; the prompt and config that produced both are in the meta-layer archive. These together constitute a complete chain of custody for the agent's reasoning.

This is the load-bearing reason why `twin_event_log` is append-only forever, why provenance fields are mandatory at write time, and why old prompts are preserved verbatim in the meta-layer rather than overwritten.

### 16.9 UI surface — Settings → Data

The medic's view of all this is intentionally simple — three sections in a single Settings panel:

```
Settings → Data → Backup & Export

▾ Automatic backups (local)
  Last snapshot       2026-06-13 06:00 (8 hr ago)
  Storage used        1.8 GB across 30 daily / 12 weekly / 24 monthly
  [ Open Archive folder ]   [ Configure retention… ]

▾ Cloud sync (optional)
  Status              [ ] not configured
  [ Set up cloud sync… ]

▾ Export all my data
  Last full export    never
  Estimated size      2.1 GB
  Includes            7 patients · 4 months practitioner memory ·
                      complete event log · all prompts and configs
  [ Export now… ]   [ Schedule monthly export… ]

▾ Restore from backup
  [ Restore from local snapshot… ]
  [ Import from archive bundle… ]

──────────────────────────────────
Your data is yours. The export format is open and documented.
Nexus going away does not take your records with it.
```

The trailing italic paragraph is **not marketing copy**; it is the literal user-facing surface of Contract A. The link below it goes to a public documentation page that explains the bundle format and how to read it without Nexus.

### 16.10 Risks specific to this layer

**R19 — Backup-restore round-trip drift.** Snapshot taken at time T; medic restores at T+1 day; current state is now T+2. Restoring may collide with newer state.
Mitigation: snapshots are explicit **forks** (named, dated). Restore is a **destructive replace** operation, not a merge. The current state is itself snapshotted before the restore overwrites, so the operation is itself reversible.

**R20 — Export bundle PHI in transit when shared.** Medic emails an export to a colleague without realising it contains full PHI for every patient.
Mitigation: the export wizard surfaces this prominently with a checkbox attestation. Offers an **age-encrypted variant** by default. Never auto-uploads anywhere — even cloud sync requires an explicit one-time consent flow.

**R21 — Format documentation rot.** Schema documentation at `field_defs_url` is hosted on Nexus infrastructure; if Nexus disappears, the URL 404s.
Mitigation: the **complete schema definitions are embedded in the bundle itself** (in `MANIFEST.json` and `README.md`). The URL is a convenience, not a dependency. README is verbose enough to reconstruct interpretation without any external reference.

### 16.11 Phasing

| Phase | Scope | Weeks |
|---|---|---|
| **D0** | folded into M0 — SQLite WAL mode, checkpoint cadence, `_schema_version` table, migrations registry skeleton | 0 |
| **D1** | Tier 2 local archival — BackgroundTask daily tarball, retention policy, Backup & Export UI card. Ships after M5 | 1 |
| **D2** | Tier 4 sovereign export — bundle writer (FHIR R5 + JSON schemas + `_sql_dump.sql` + README), import-from-bundle path, migration framework finalised. Parallel with D1 | 1.5 |
| **D3** | Tier 3 optional cloud sync — rclone adapter, age encryption, Keychain, UI configuration. **Post-v1; off the critical path** | 1 |

Total: ~3.5 dev-weeks of new work. D0 is zero-marginal-cost; D1+D2 run in parallel with M6–M8 (Layer 2 work) since both walk the same SQLite tables. D3 is explicitly post-v1.

### 16.12 Event sourcing — the mutation ledger contract

The architectural foundation Contract B sits on. Specified at ADR level in Rev-8.

#### 16.12.1 Canonical vs. projected state

Persistent state in Nexus is split into two categories.

**Canonical state** — lives in three places only:

```
1. twin_event_log                  append-only, immutable, every mutation event
2. ~/Library/Nexus/files/<sha>.bin content-addressed binary blobs (DICOM, PDFs)
3. meta_layer/{prompts,configs}/   versioned prompt + config archive
```

**Projected state** — everything else. Materialised views derived from canonical state by replay. Drop, replay, rebuild byte-identical (modulo schema version):

```
clinical_graph_nodes / edges       Layer 1 graph
node_provenance                    Layer 1 audit trail
cached_views                       Tier-1 retrieval cache
practitioner_facts / observations  Layer 2
reference_knowledge                Layer 3 (cached from authoritative sources)
patients / dicom_studies           legacy front-loaded tables — migrated to
                                   projections in M0
```

#### 16.12.2 Complete event taxonomy

Every event has the shape:

```
{
  event_idx        : INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind       : TEXT (one of the kinds below),
  event_kind_version: TEXT (semver, e.g. "1.0"),
  user_id          : TEXT,
  patient_hash     : TEXT (nullable for non-patient-scoped events),
  ts               : INTEGER (unix microseconds; monotonically nondecreasing),
  payload_json     : TEXT (kind-specific structure),
  caused_by        : INTEGER (nullable; event_idx that triggered this one)
}
```

Event kinds, grouped by concern:

```
─ chat ──────────────────────────────────────────────────────────
user_message                  text, session_id
assistant_response            text, model, prompt_id, prompt_version,
                              retrieved_context_refs, citations
tool_call                     tool_name, args_json, response_json, latency_ms
agent_suggestion              text, kind, context_event_idx
suggestion_resolved           suggestion_event_idx, outcome, response

─ ingestion ─────────────────────────────────────────────────────
dicom_uploaded                study_uid, modality, body_part, sha256, file_size
ingestion_started             kind, target_ref, ingester_version
ingestion_llm_response        raw_output_text (VERBATIM), model, prompt_id,
                              prompt_version, tokens_in, tokens_out, latency_ms
ingestion_completed           kind, target_ref, emitted_node_count, errors

─ Layer 1 graph mutations ───────────────────────────────────────
node_added                    node_id, node_type, content_json, embedding_ref,
                              originating_event_idx
node_updated                  node_id, before_state_json, after_state_json
node_weight_changed           node_id, before_weight, after_weight, reason
node_retracted                node_id, retracted_by_user, reason
edge_added                    src, dst, kind, weight
edge_updated                  src, dst, kind, before_weight, after_weight
edge_removed                  src, dst, kind, reason
provenance_recorded           node_id, full Provenance row

─ Layer 1 derived decisions ─────────────────────────────────────
anatomical_region_normalized  raw_label, canonical_label, radlex_id, was_new
equivalence_merged            merger (refresh_equivalences|llm|medic),
                              nodes_unioned, character_id_assigned
conflict_detected             nodes, detector (rule|llm), rule_id, evidence
conflict_resolved             nodes, decision, axis_used, auto_or_medic, reasoning
cross_study_compare_run       new_study, priors_considered, matches_found,
                              follow_up_edges_emitted, same_finding_edges_emitted

─ Layer 2 practitioner ──────────────────────────────────────────
practitioner_observation_emitted   user_id, patient_hash, fact_kind,
                                   pattern_key, evidence_quote
practitioner_candidate_surfaced    fact_kind, pattern_key, distinct_count,
                                   confidence
practitioner_fact_confirmed        fact_kind, pattern_key, by_user, when
practitioner_fact_rejected         fact_kind, pattern_key, by_user, reason

─ Layer 3 reference ─────────────────────────────────────────────
reference_version_ingested    kind, key, version, source_url, content_sha256

─ Meta-layer ────────────────────────────────────────────────────
prompt_version_changed        prompt_id, old_version, new_version,
                              content_sha256, change_summary
config_changed                config_id, before_json, after_json
skill_registered              skill_id, version

─ Embeddings ────────────────────────────────────────────────────
embedding_model_changed       old_model, new_model
chunk_embedded                chunk_id, source_text_sha256, model_version,
                              vector_sha256
chunk_re_embedded             chunk_id, old_model_version, new_model_version

─ Imaging (Rev-9) ───────────────────────────────────────────────
image_redaction_applied       image_sha256_before, image_sha256_after,
                              redacted_regions: [{bbox, reason}],
                              engine, engine_version,
                              ocr_hits: [...], face_detections: [...]
image_extracted               study_uid, series_uid, slice_no,
                              sop_instance_uid, image_sha256, file_path,
                              dimensions, rendered_at_resolution,
                              windowing_applied, pinned_by
image_embedding_computed      image_sha256, encoder_bundle_id,
                              encoder_version, embedding_version,
                              vector_sha256, latency_ms
image_feature_extracted       image_sha256, feature_kind (hu_stats|
                              enhancement|morphology|...),
                              values_json, extractor_bundle_id,
                              extractor_version
image_attached_to_context     parent_event_idx (the assistant_response or
                              tool_call), image_sha256s_included,
                              total_image_tokens_estimate
redaction_policy_changed      modality, old_policy_version,
                              new_policy_version, summary

─ Medic UI actions (any persistent change) ──────────────────────
patient_registered            patient_hash, demographics_json, source (manual|dicom)
patient_pinned / unpinned     patient_hash
finding_accepted_by_medic     node_id, by_user
finding_edited_by_medic       node_id, before_state, after_state
impression_edited             study_uid, before_text, after_text
medic_correction              source_node_id, correction_text, action_taken

─ Persistence operations ────────────────────────────────────────
snapshot_taken                tier, location, sha256, db_size_bytes
backup_completed              location, archive_sha256
restore_performed             snapshot_ref, restored_at_event_idx, restore_kind
export_bundle_created         destination, included_event_count, includes_phi
import_bundle_started         source_ref, schema_version
import_bundle_completed       events_imported, conflicts_resolved

─ Schema ────────────────────────────────────────────────────────
schema_migration_applied      migration_id, version_before, version_after
```

Approximately 40 event kinds. Each is versioned (`event_kind_version`); new versions never break replay of old events.

#### 16.12.3 Write protocol — emit-event-then-apply

The single rule: **no projection write happens without an event in the same transaction.** Codified in the store layer:

```python
class Store:
    def emit_and_apply(
        self,
        kind: str,
        payload: dict,
        apply_fn: Callable[[Cursor, int, dict], None],
        *,
        user_id: str,
        patient_hash: Optional[str] = None,
        caused_by: Optional[int] = None,
    ) -> int:
        """The only legal entry point for mutations.
        Returns the event_idx of the emitted event."""
        with self.db.transaction() as cur:
            # 1. Append event to canonical store
            cur.execute(
                "INSERT INTO twin_event_log "
                "(event_kind, event_kind_version, user_id, patient_hash, ts, "
                " payload_json, caused_by) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (kind, EVENT_KIND_VERSIONS[kind], user_id, patient_hash,
                 monotonic_now_us(), json.dumps(payload), caused_by),
            )
            event_idx = cur.lastrowid

            # 2. Apply mutation to projection(s) — provided by caller
            apply_fn(cur, event_idx, payload)

            # 3. Both committed atomically (SQLite ensures)
            return event_idx
```

Every ingester / conflict resolver / Layer 2 distiller / medic UI handler calls `emit_and_apply`. There is **no other write path** to projection tables. Direct INSERT to `clinical_graph_nodes` is a code review hard-fail; a CI lint rule scans for it.

#### 16.12.4 Replay protocol

```python
def replay(
    event_log_path: str,
    target_db: Connection,
    from_event_idx: int = 0,
    to_event_idx: Optional[int] = None,
) -> None:
    """Rebuild projection tables from event_log.
    target_db should have empty projection tables; event_log table itself
    is not rewritten (it already contains the events being replayed)."""
    for event in iter_events(event_log_path, from_event_idx, to_event_idx):
        handler = REPLAY_HANDLERS.get((event.kind, event.kind_version))
        if handler is None:
            raise UnknownEventKind(event.kind, event.kind_version)
        handler(target_db, event)
        target_db.execute(
            "UPDATE projection_state SET last_applied_event_idx = ? "
            "WHERE projection_name = 'all'",
            (event.event_idx,),
        )

REPLAY_HANDLERS = {
    ("node_added", "1.0"): apply_node_added_v1,
    ("node_updated", "1.0"): apply_node_updated_v1,
    ("edge_added", "1.0"): apply_edge_added_v1,
    # ... one handler per (kind, version)
}
```

Key properties:

- **No LLM calls.** Handlers read `ingestion_llm_response.raw_output_text` directly; do not invoke models.
- **No network.** Reference data is replayed from version pointers; if the local mirror is missing a version, replay raises a loud error and lists what needs downloading.
- **Deterministic.** Same event_log + same handler versions + same starting state → byte-identical projections.
- **Incremental.** `projection_state.last_applied_event_idx` is the checkpoint; replay resumes from there. Full rebuild from event_idx 0 is the cold-start case (corruption / schema upgrade).
- **Composable.** Replay can target a fresh in-memory DB for testing, an export-bundle DB for migration, or the live DB after corruption.

#### 16.12.5 `projection_state` schema

```sql
CREATE TABLE projection_state (
  projection_name        TEXT PRIMARY KEY,    -- 'all' | per-projection name
  schema_version         TEXT NOT NULL,
  last_applied_event_idx INTEGER NOT NULL,
  last_applied_ts        INTEGER NOT NULL,
  is_rebuilding          INTEGER NOT NULL DEFAULT 0,
  rebuilt_at             INTEGER
);
```

Default row inserted at M0:

```sql
INSERT INTO projection_state (projection_name, schema_version,
                              last_applied_event_idx, last_applied_ts)
VALUES ('all', '3.1', 0, 0);
```

Per-projection rows (for finer-grained replay) added when the projection-specific schema diverges from `all`.

#### 16.12.6 `twin_event_log` schema (the canonical table)

```sql
CREATE TABLE twin_event_log (
  event_idx          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind         TEXT NOT NULL,
  event_kind_version TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  patient_hash       TEXT,
  ts                 INTEGER NOT NULL,          -- unix microseconds, monotonic
  payload_json       TEXT NOT NULL,
  caused_by          INTEGER REFERENCES twin_event_log(event_idx)
);

CREATE INDEX idx_event_log_user_ts        ON twin_event_log(user_id, ts);
CREATE INDEX idx_event_log_patient_ts     ON twin_event_log(patient_hash, ts)
                                          WHERE patient_hash IS NOT NULL;
CREATE INDEX idx_event_log_kind           ON twin_event_log(event_kind, ts);
CREATE INDEX idx_event_log_caused_by      ON twin_event_log(caused_by);
```

Invariants (enforced at the store layer + checked by CI):

- `event_idx` is autoincrement; never reused; never decreases.
- `ts` is monotonically nondecreasing within a `user_id`; ties broken by `event_idx`.
- `payload_json` is type-validated against the `(event_kind, event_kind_version)` schema at write time via JSON Schema.
- No `UPDATE` or `DELETE` is ever issued against this table by application code. CI lint rule enforces.
- Migrations are strictly additive (new columns with default values); existing rows are never rewritten.

#### 16.12.7 CI gate: the golden replay test

For every PR that touches the store layer or any ingester:

```python
def test_golden_replay_roundtrip():
    # 1. Take a representative live DB snapshot from staging
    live_db = open_snapshot("staging-2026-06-05.db")

    # 2. Make a copy, drop all projection tables
    test_db = clone_db(live_db)
    drop_projections(test_db)

    # 3. Replay event_log against the empty projections
    replay(test_db.event_log_path, test_db, from_event_idx=0)

    # 4. Assert deep equality between rebuilt projections and originals
    for table in PROJECTION_TABLES:
        assert tables_equal(test_db, live_db, table), (
            f"{table} diverged after replay; event sourcing broken"
        )
```

Red test = PR cannot merge. This is the load-bearing test for Contract B.

#### 16.12.8 Implications for other sections

- **§3.3 (data model)** — every non-event_log table is annotated as projection. The `twin_event_log` schema above is the only canonical structure.
- **§5 (memorization)** — all ingesters call `Store.emit_and_apply()`; no direct table writes. Ingester pseudocode updated to show event emission as the first step.
- **§7 (retrieval)** — unchanged; reads from projections as before. Projections are reads-optimised; events are writes-optimised.
- **§8 (conflict resolution)** — `resolve_clinical_conflict()` emits `conflict_detected` and `conflict_resolved` events; the supersede/retract mutations are applied as projections of those events.
- **§9 (phased delivery)** — M0 expands to 1.5–2 weeks; event-sourcing infrastructure is M0 deliverable.
- **§16.8 (medico-legal replay)** — strengthened: replay is now deterministic and LLM-free, by virtue of `ingestion_llm_response` storing verbatim outputs.

## 17. References

- M3-Agent paper: <https://arxiv.org/abs/2508.09736>
- M3-Agent repo (Apache-2.0): <https://github.com/ByteDance-Seed/m3-agent>
- ADR-002 — Memory architecture decision (with Revisions Rev-1..Rev-4)
- ADR-001 — Turn boundary
- #176 — Per-patient MEMORY.md isolation
- #135–#138 — vector_index + RAG memory grounding
- #194 — M3 ↔ Nexus merge analysis
- #195 — M0 implementation task
- #198 — Cross-patient practitioner memory (this v3 extension)
- RadLex: <https://radlex.org>
- SNOMED CT body-structure hierarchy: <https://www.snomed.org>
- RxNorm: <https://www.nlm.nih.gov/research/umls/rxnorm/>
- HIPAA Safe Harbor de-identification: <https://www.hhs.gov/hipaa/for-professionals/privacy/special-topics/de-identification>
- Project-MONAI (Apache-2.0): <https://github.com/Project-MONAI/MONAI>
- MONAI Bundle specification: <https://monai.readthedocs.io/en/latest/bundle.html>
- MONAI Model Zoo: <https://github.com/Project-MONAI/model-zoo>
- MONAI Label (OHIF integration): <https://github.com/Project-MONAI/MONAILabel>
- VISTA-3D (deferred to M10): <https://github.com/Project-MONAI/VISTA>
- Apple CoreML / ANE deployment: <https://developer.apple.com/documentation/coreml>
- BiomedCLIP (Microsoft, MIT): <https://huggingface.co/microsoft/BiomedCLIP-PubMedBERT_256-vit_base_patch16_224>
- CXR-CLIP: <https://github.com/Soongja/basic-image-eda>
- MONAI Image Encoders (v1.6 release notes): <https://github.com/Project-MONAI/MONAI/releases>
- PaddleOCR for redaction: <https://github.com/PaddlePaddle/PaddleOCR>
- pydicom overlay handling: <https://pydicom.github.io/pydicom/>
- #199 — MONAI lightweight integration task
- #203 — Imaging three-layer understanding (Rev-9)
