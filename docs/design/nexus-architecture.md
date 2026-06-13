# Nexus — Architecture & User Journey

**Status:** Canonical reference, supersedes piecemeal docs for new readers
**Date:** 2026-06-13
**Owner:** JZ
**Reads with:** `ADR-002-m3-memory-merge.md` (decision history),
                `m3-memory-architecture.md` v3 (deep memory spec),
                `nexus-ux-redesign-v2.md` (UX deep dive)

This document is the single read for understanding Nexus end-to-end. It
covers the product premise, the four-layer memory architecture, the
event-sourcing foundation, the imaging multimodal layer, the data
sovereignty model, the agent retrieval pipeline, the frontend surface,
and the seven canonical user journeys. Every section has pointers back
to the deeper docs.

---

## 0. TL;DR (read this if nothing else)

Nexus is a **clinical workflow agent** for radiologists / hospitalists,
running as a **Tauri 2.0 + React desktop app** on the medic's Mac,
backed by a **FastAPI + SQLite server** also on-device. The agent helps
the medic interpret studies, draft reports, surface relevant prior
findings, and accumulate practice patterns over time.

**Four memory layers**:

* **Layer 1 — Patient graph** (per `patient_hash`): findings, measurements,
  studies, encounters, semantic facts. PHI-bearing. The deep record.
* **Layer 2 — Practitioner memory** (per `user_id`, PHI-stripped): style,
  workflow, practice patterns, calibration — the medic's accumulated
  habits, surfaced for confirmation before activation.
* **Layer 3 — Reference KB** (universal, version-pinned): RadLex,
  RxNorm, ACR-AC guidelines, lab reference ranges.
* **Layer 4 — Case library** (opt-in, de-identified, **deferred**):
  cross-patient similar-case retrieval. v2 work.

**Single source of truth**: `twin_event_log` is **the** canonical store
(ADR-002 Rev-8). Every other table is a projection — drop them, replay
event_log, byte-identical rebuild. Verified by a golden replay CI test.

**Imaging**: three layers per Rev-9 — visual embeddings, multimodal LLM
attaches pixels to chat, structured radiology features (HU stats /
enhancement curves / morphology). Mac-only constraints kept the heavy
3D models on a deferred "inference companion" — VISTA-3D etc. ship in
M10.

**Data sovereignty** (Rev-7): two contracts. (A) The medic owns their
data — Tier 4 export bundle is self-contained, open formats, no Nexus
code required to read. (B) `twin_event_log` is append-only ground truth.

---

## 1. Product premise

The medic spends 8–10 hours/day in front of imaging studies and lab
results. The current tools fragment their attention: one viewer for
DICOM, one EHR for chart notes, one chat tool for asking colleagues, one
Word doc for draft reports. Each tool has its own conception of "the
patient" and they don't talk.

Nexus puts the patient at the centre and makes the agent a continuous
collaborator across the medic's workflow. Three commitments shape every
design decision:

1. **The medic always wins.** Every agent suggestion is flag-then-decide.
   The agent never silently overrides a clinical fact.
2. **Provenance is the price of trust.** Every claim cites a verbatim
   source one click away — slice, chat span, or guideline reference.
3. **Your data is yours.** Sovereign export bundle in open formats; the
   medic can leave with everything readable by standard tools.

---

## 2. System topology

```
        ┌────────────────────────────────────────────────────────┐
        │                  Medic's Mac laptop                    │
        │                                                        │
        │  ┌───────────────────────┐  ┌────────────────────────┐ │
        │  │  desktop-v2 (Tauri)   │  │  FastAPI server        │ │
        │  │  Rust shell + WebView │◄─┤  uvicorn on :8001      │ │
        │  │  React 18 + TS        │  │                        │ │
        │  │  ~80 MB resident      │  │  ~200 MB resident      │ │
        │  └───────────────────────┘  └────────────────────────┘ │
        │             ▲                          │                │
        │             │ HTTP + SSE               │                │
        │             └──────────────────────────┘                │
        │                                                        │
        │  ┌─────────────────────────────────────────────────┐   │
        │  │  ~/Library/Nexus/                               │   │
        │  │  ├── nexus.db          (SQLite + WAL — main DB) │   │
        │  │  ├── files/                                     │   │
        │  │  │   └── keyimage/<sha256>.png  (redacted)      │   │
        │  │  ├── twins/<user>/event_log/<agent>.db          │   │
        │  │  │      (legacy SDK EventLog — chat mirror)     │   │
        │  │  └── meta_layer/  (prompts + configs archive)   │   │
        │  │                                                 │   │
        │  │  ~/Documents/Nexus Archive/                     │   │
        │  │  ├── 2026-06-13.tar.zst  (Tier 2 daily)         │   │
        │  │  └── exports/                                   │   │
        │  │      └── nexus-export-…/  (Tier 4 sovereign)    │   │
        │  └─────────────────────────────────────────────────┘   │
        │                                                        │
        │  ┌─────────────────────────────────────────────────┐   │
        │  │  Optional Tier 3 cloud sync                      │   │
        │  │  iCloud Drive / S3 / Google Drive — age-encrypt │   │
        │  └─────────────────────────────────────────────────┘   │
        └────────────────────────────────────────────────────────┘
                          ▲
                          │ (M10 deferred)
                          │
                ┌─────────┴─────────┐
                │  Inference        │
                │  companion        │
                │  Linux + GPU      │
                │  VISTA-3D / MONAI │
                └───────────────────┘
```

Everything lives on the medic's Mac. The optional inference companion
(M10) is a separate GPU machine for heavy 3D imaging — deferred.

---

## 3. The four memory layers

### 3.1 Why four

| Layer | Question it answers | Privacy | Lifetime |
|---|---|---|---|
| **L1** Patient | "What do I know about this patient?" | PHI-bearing | per `(user_id, patient_hash)` forever |
| **L2** Practitioner | "What's this medic's style + practice patterns?" | PHI-stripped, per `user_id` | grows with caseload |
| **L3** Reference | "What does medicine in general say?" | public, versioned | static (snapshots) |
| **L4** Case Library | "What about similar cases historically?" | opt-in, de-identified | **DEFERRED v2** |

Plus a **Meta-layer** (`tools_evolve.py`) — the agent modifies its own
prompts, classifier thresholds, recipes based on telemetry.

### 3.2 Layer 1 — Patient graph

A per-patient entity-centric graph (ported from M3-Agent's `videograph`
with Rev-1 medical adaptations). 12 node types:

```
patient · study · series · key_image · anatomical_region · finding
measurement · med · lab · ddx · episodic_event · semantic_fact
```

Edges are typed (Rev-1): `mentions`, `imaging_of`, `finding_in`,
`localization_of`, `measurement_of`, `follow_up`, `same_finding`,
`cross_modality_same`, `treats`, `causes`, `contraindicates`,
`equivalence`, `superseded_by`.

Every `finding` / `measurement` / `semantic_fact` carries a typed
`node_provenance` row (Rev-2): `evidence_quote` (verbatim source span),
`source_kind/ref/locator`, `extraction_model`, `extraction_prompt_id`,
`confidence`, `redaction_version`. Write-time validation refuses
clinical-fact nodes without provenance.

Conflicts are resolved by a four-axis cascade (Rev-3):
**retraction → medic confirmation → evidence rank → recency**.
No axis decisive → `flag_for_medic`. Never silent override.

### 3.3 Layer 2 — Practitioner memory

Per-user, cross-patient, PHI-stripped. Three modules:

* **Extractor** — after every encounter, emits candidate observations
  ("medic chose MR before biopsy", "impression ends with `Recommend
  correlation`")
* **Distiller** — nightly aggregator promoting candidates to
  `practitioner_facts` only when `distinct_patient_count >= N_THRESHOLDS`
  (style=3, workflow=5, practice=5, calibration=8)
* **Composer** — at every agent turn, renders active confirmed facts as
  a ≤800-token system-prompt enrichment block

Privacy invariants enforced by Store at write time:
`pattern_value_json` scanned for hex hashes (patient_hash) + ISO dates.
Aggregation across patients IS the de-identification.

Medic confirmation is mandatory — candidates surface in the
"Nexus has learned" overlay; only confirmed patterns reach the agent.

### 3.4 Layer 3 — Reference knowledge

Single table, public, version-pinned. Populated from RadLex (anatomy),
RxNorm (drugs), ACR Appropriateness Criteria (guidelines), Mayo lab
reference ranges. Events record which version was in effect at write
time (Rev-7 / R7).

### 3.5 Layer 4 — Case library (deferred)

De-identified case archetypes for cross-patient similar-case retrieval.
Strong privacy requirements (HIPAA Safe Harbor or stricter, per-case
explicit medic archive consent, IRB review). Not in v1.

---

## 4. Event sourcing foundation (Rev-8 — the load-bearing decision)

### 4.1 Canonical vs. projection

Persistent state is split into two categories:

**Canonical** — three places only:

1. `twin_event_log` — append-only ledger of every mutation event
2. `~/Library/Nexus/files/<sha256>.bin` — content-addressed binary blobs
3. `meta_layer/{prompts,configs}/` — versioned prompt + config archive

**Projection** — everything else (graph nodes, edges, provenance,
cached_views, practitioner_facts, reference_knowledge, even legacy
`patients` / `dicom_studies`). Materialised views. Drop them, replay
event_log, rebuild byte-identical.

### 4.2 Five invariants

1. **Emit-event-then-apply** — every projection write is preceded by an
   `INSERT INTO twin_event_log` in the same SQLite transaction. The
   `Store.emit_and_apply()` method is the ONLY legal mutation entry
   point. CI lint (`scripts/lint_no_direct_projection_writes.py`)
   scans 100+ files and refuses direct INSERT/UPDATE/DELETE against
   projection tables.
2. **LLM outputs stored verbatim** — `ingestion_llm_response` events
   carry the raw model output unmodified. Replay reads the archive;
   never re-invokes Gemini / Claude. Non-determinism is bypassed by
   archive, not re-execution.
3. **Reference data by version pointer** — event records which version
   was in effect; payload is re-downloadable from authoritative source.
4. **Large binaries as content-addressed files** — events reference by
   SHA-256; replay needs files present on disk.
5. **Projections track replay position** — `projection_state` table
   records `last_applied_event_idx`. Incremental replay; full rebuild
   only on corruption / schema upgrade.

### 4.3 ~50 event kinds, all typed

Grouped: chat (5) · ingestion (4) · graph mutations (8) · derived
decisions (5) · Layer 2 (4) · Layer 3 (1) · meta-layer (3) ·
embeddings (3) · medic UI (7) · persistence (6) · schema (1) ·
imaging (6).

Each event has `event_kind`, `event_kind_version`, `user_id`, optional
`patient_hash`, `ts` (microseconds, monotonic), `payload_json`,
`caused_by`. JSON Schema validation at write time.

### 4.4 Replay is the audit machine

```python
drop_projections(conn)
replay(conn, from_event_idx=0)
# every projection table rebuilt byte-identical
```

Verified by the golden replay CI test
(`test_drop_replay_roundtrip_byte_identical`). PR cannot merge red.

Unknown `(kind, version)` → `UnknownEventKindError`. Silent skip is
forbidden (Rev-8 R23 mitigation).

---

## 5. Imaging memory (Rev-9)

Imaging-into-memory works in three layers per Rev-9:

* **Layer A — Visual embeddings.** Every `key_image` node carries a
  BiomedCLIP / CXR-CLIP visual embedding alongside the text-caption
  embedding. Cosine retrieval over visual space. ANE via CoreML on Mac.
* **Layer B — Multimodal LLM at retrieval.** Tier 2/3 retrievals attach
  the actual key-image PNG to the LLM message. Gemini 2.5 Flash /
  Claude 3.5+ accept image inputs natively. `image_attached_to_context`
  events audit every attachment.
* **Layer C — Structured radiology features.** HU stats (CT), T1/T2
  signal (MR), enhancement Δ across phases, morphology classification —
  stored on `measurement` nodes. Enables "findings with HU > 30" SQL
  queries.

**Mandatory redaction (Rev-9 §5.5.7 #1)**: `image_extracted` cannot
commit before `image_redaction_applied` for the same target. Unredacted
pixels never reach the canonical file store. pydicom overlay strip +
PaddleOCR + per-modality face detection.

**M10 swap-in path**: Stage 2C of the DICOM ingester is currently
Gemini-Flash quick-scan wrapped in a Bundle. When the inference
companion ships, the Bundle's backend changes from
`gemini_flash_quick_scan` to `remote_monai_vista3d`. Graph schema and
downstream consumers unchanged.

---

## 6. The retrieval pipeline

Every agent turn classifies into one of three tiers:

```
                          tier_classifier(question)
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
            T1                     T2                     T3
       cached view           single-entity            Algorithm 1
       SQL ≤ 50ms           lookup ≤ 300ms        streamed 5–15s

   Pattern: "summary"     Pattern: single        Pattern: multi-hop
   "active findings"      named entity           "why" "explain"
   "current meds"         "left renal mass?"     "compare X to Y"
                                                  
   Output: pre-rendered  Output: graph        Output: SSE stream of
   markdown from         get_entity_info +    reasoning_chunk +
   cached_views          template synthesis   search_query +
                                              final_answer_chunk +
                                              citations
```

Composer enriches every turn's system prompt with active Layer 2
practitioner facts (≤800 tokens) + relevant Layer 3 reference snippets.

Speculative warm: patient-card focus pre-fetches Tier-1 views in
background; by the time the medic forms a question, cache is hot.

**Latency SLO** (p99): open patient ≤ 1.5s · T1 ≤ 150ms · T2 ≤ 900ms ·
T3 first-byte ≤ 2.5s, complete ≤ 30s.

---

## 7. Data sovereignty (Rev-7)

Five tiers of persistence:

```
T0  Hot SQLite                     running agent
T1  WAL + local snapshots          every 6h, 30d retention
T2  Daily archive tarballs         ~/Documents/Nexus Archive/
T3  Optional cloud sync            iCloud / S3, age-encrypted (D3)
T4  On-demand sovereign export     "Export all my data" (D2)
```

**Tier 4 sovereign export bundle** is the contract A surface. Directory
of open formats:

```
nexus-export-<date>/
├── README.md                  # human-readable format spec
├── MANIFEST.json              # SHA-256 of every file
├── checksums.sha256
├── layer1_patients/<hash>/
│   ├── graph.json
│   ├── provenance.jsonl
│   ├── summary.md
│   └── fhir-r5.json           # EHR interop (lossy)
├── layer1_event_log/events.jsonl
├── layer2_practitioner/
│   ├── facts.jsonl
│   └── observations.jsonl
├── layer3_reference/versions.json
├── meta_layer/
└── _sql_dump.sql              # `sqlite3 < this.sql` reconstitutes
```

Settings → Data UI carries the literal text **"Your data is yours.
Nexus going away does not take your records with it."** as
non-removable surface.

---

## 8. Frontend architecture

**Tauri 2.0 + React 18 + TypeScript + Tailwind + Radix.** Chosen over
Avalonia (XAML quirks ate dev velocity) and Flutter (no mature DICOM
ecosystem). Web stack matches Claude Desktop's design language; web
DICOM tools (cornerstone.js / OHIF) are battle-tested for radiology.

### 8.1 Shell

```
┌─ Header (48px, drag region) ─ ⌘K search · Nexus · ⊕ · 👤 ──┐
├──────────┬────────────────────────────┬───────────────────┤
│ Patients │       Main canvas          │   Context rail    │
│ sidebar  │       (one mode at a time) │   (optional)      │
│ (260px)  │       Tabs: Today /        │   - provenance    │
│          │       Patient / Encounter /│     drill-down    │
│          │       Imaging / Labs /     │   - key_image     │
│          │       Memory / Report      │     preview       │
└──────────┴────────────────────────────┴───────────────────┘
```

Plus two cross-cutting full-screen overlays:
* **Settings → Data** — backup status / export wizard / restore dialog
* **Nexus has learned** — Layer 2 candidate confirmation panel

### 8.2 Component vocabulary

8 primitives from U0 (Button, Card, Section, Chip, Input, StatusDot,
EmptyState, CitationChip 1.0) + U1 additions:

* **CitationChip 2.0** — hover-preview + click opens provenance card in rail
* **ProvenanceCard** — full provenance trail rendered in context rail
* **TierIndicator** — small T1/T2/T3 chip with elapsed seconds
* **ReasoningPane** — collapsible streaming reasoning
* **ConflictResolutionDialog** — four-axis conflict UI (M3 + U3)
* **PractitionerCandidateCard** — "Nexus has learned" row
* **KeyImageThumbnail / VisualSimilarSearchPanel / StudyComparePanel** — imaging (M1.5+ / M2+)
* **TimeTravelHeader / TimeTravelDateSlider** — M5+ advanced

### 8.3 State & deep linking

Zustand store keys: token / theme / activePatient / activeMode /
contextRailContent / conflicts / practitionerCandidates / timeTravel.

URL routing (`nexus://`):
* `nexus://today` · `nexus://patient/<hash>/{patient|encounter|imaging|labs|memory|report}` ·
  `nexus://practitioner` · `nexus://settings/data` · `nexus://timetravel/<event_idx>`

### 8.4 API + streaming

REST: ~30 endpoints under `/api/v1/`, half implemented (`memory_router_v2`
+ `chat_router_v2` shipped; persistence + imaging endpoints to land).

Chat: SSE stream of typed `ChatStreamChunk` events
(`turn_started → tier_classified → reasoning_chunk? → final_answer_chunk → citations → turn_complete`).

---

## 9. Seven user journeys

Each follows the same pattern: trigger → frames → events emitted → state.
Full mockups in `nexus-ux-redesign-v2.md` §15.

### 9.1 First sign-in → today

```
LoginView → POST /auth/login → setToken → MainShell → today mode
```
**Time to interactive**: <2s after credentials accepted.

### 9.2 New finding arrives → review → verify citation

```
DICOM upload completes
    ↓ (push event)
patient row blue dot
    ↓ (click)
Patient mode (4 parallel API calls, all T1 cached)
    ↓ (hover citation [2])
hovercard with verbatim quote + model + confidence
    ↓ (click)
context rail with full provenance card + key-image thumbnail
    ↓ (Open in Imaging →)
Imaging mode at the cited slice
    ↓ (Accept Nexus draft)
finding_accepted_by_medic event
```

The citation chain — verbatim quote, model + prompt id, confidence,
redaction version — is the **audit-grade trail** Rev-2 + Rev-9 set up.

### 9.3 Asking the agent → streamed Tier-3 answer

```
You · "compare today's CT to the index"
    ↓
POST /agent/chat (SSE)
    ↓
event: turn_started
event: tier_classified { tier: T3 }
event: reasoning_chunk × N    ← visible in collapsed ReasoningPane
event: search_results_summary  ← "found 2 studies, 1 same_finding chain"
event: final_answer_chunk × M  ← streamed token-by-token to bubble
event: citations { refs: [...] }
event: turn_complete { assistant_event_idx }
    ↓
assistant_response event in twin_event_log (verbatim text)
```

12-second answer feels acceptable because progress is streaming.

### 9.4 Resolving a memory conflict

```
DICOM ingest emits new measurement that contradicts older one
    ↓
conflict_resolver detect_and_resolve()
    ↓ axes 1-4 cascade; no axis decisive
event: conflict_detected
event: conflict_resolved { decision: flag_for_medic }
    ↓ (push event)
sidebar yellow dot
    ↓ (Memory mode → conflict panel)
side-by-side Ⓐ/Ⓑ with thumbnails + evidence quotes + weights
    ↓ (Medic clicks "keep Ⓐ")
POST /memory/conflicts/{id}/resolve
event: conflict_resolved { decision: prefer_a, axis_used: medic, auto: false }
    ↓
node_provenance[B].superseded_by_node = A
sidebar dot clears
```

### 9.5 Confirming "Nexus has learned"

```
Distiller nightly job: 6 distinct patients hit pattern
    ↓
event: practitioner_candidate_surfaced
    ↓ (push)
avatar dot
    ↓ (Account menu → Nexus has learned)
overlay shows 3 candidates
    ↓ (See cases →)
side drawer lists 6 patient_hashes + verbatim evidence_quotes
    ↓ (Confirm)
POST /memory/practitioner/practice/<key>/confirm
event: practitioner_fact_confirmed
    ↓
composer.build() now injects this fact into every agent turn's system prompt
```

### 9.6 Time travel (M5+ advanced)

```
Account menu → Time travel → Date picker → Apr 12, 2026
    ↓
all reads send ?as_of_event_idx=N
    ↓
backend replay(scratch_db, to_event_idx=N)
    ↓
Patient mode renders state as of that date
    ↓ (Exit time travel)
toast: "3 events recorded since you entered"
```

### 9.7 Sovereign export

```
Settings → Data → Export all my data → wizard step 1 (scope)
    ↓ step 2: PHI attestation + age-encryption (default ON)
    ↓ step 3: destination
    ↓
create_export_bundle(conn, user_id, output_dir)
    ↓
~/Documents/Nexus Archive/exports/<date>/
├── README.md / MANIFEST.json / checksums.sha256
├── layer1_patients/<hash>/...
├── layer1_event_log/events.jsonl
├── layer2_practitioner/{facts,observations}.jsonl
├── layer3_reference/versions.json
├── meta_layer/
└── _sql_dump.sql
    ↓
event: export_bundle_created { destination, includes_phi: true,
                                bundle_sha256 }
```

---

## 10. Implementation state (2026-06-13)

### 10.1 Backend shipped

**Foundation (M0)**:
* `event_sourcing/` — 5 modules (event_kinds, schema, store, replay, handlers)
* `clinical_graph.py` — vendored from M3, medical adaptations
* `tools_clinical_graph.py` — `search_node` + `search_encounter` tools
* `memorization/chat_ingester.py` — verbatim-quote verified Layer 1 derivation
* `lint_no_direct_projection_writes.py` — Rev-8 CI gate

**MONAI lightweight (M0.5)**:
* `monai_runtime/{bundle_loader, inference_backend}.py` + 4 backends
* `bundles/quick_scan_4x4_grid/` — first shipped Bundle (Apache-2.0)
* Rev-6 Bundle ↔ Provenance adapter (R16 closure)

**DICOM ingester (M1)**:
* `memorization/dicom_ingester.py` — full 9-stage modality-routing pipeline
* IM-1 redaction → image_extracted ordering invariant (Rev-9 §5.5.7 #1)

**Memory completeness**:
* `conflict_resolver.py` — four-axis cascade (Rev-3)
* `cached_views.py` — 5 view recipes + builder + invalidator (Rev-4)
* `practitioner/{extractor, distiller, composer}.py` — Layer 2 (Rev-5)
* `persistence/export_bundle.py` — Tier 4 sovereign export (Rev-7)
* `retrieval_tiers.py` — tier classifier + T1/T2/T3 yielders (Rev-4)

**HTTP surface**:
* `memory_router_v2.py` — 12 endpoints (projection / findings / citation / practitioner / audit)
* `chat_router_v2.py` — SSE streaming chat with tier classification
* main.py lifespan integrated

**Tests**: 98 / 98 passing (event_sourcing + chat_ingester + monai_runtime
+ memory_router_v2 + dicom_ingester + conflict_resolver + cached_views
+ practitioner + retrieval_and_persistence).

**CI**: pyflakes clean. Lint 110 files OK.

### 10.2 Frontend shipped (U0 + U1.1)

* Tauri 2.0 + Vite + React 18 + TypeScript scaffold (~30 files)
* 8 UI primitives + Login + 7 mode stubs/implementations
* `⌘K` palette / `⌘.` rail / `⌘B` sidebar / `⌘N` new patient
* Real ApiClient with full coverage of M0 endpoints + chat SSE
* TypeScript types mirror backend (`types.ts`)
* CitationChip 2.0 + ProvenanceCard + TierIndicator + ReasoningPane +
  ConflictInlineBanner + ContextRailContent

### 10.3 What's left

**Backend deferred to follow-up phases**:
* M1.5/M1.6/M1.7 — visual embedding pipeline (BiomedCLIP CoreML on Mac),
  multimodal LLM context attach, structured radiology features
* OHIF Label bridge — REST shim for medic-in-the-loop annotation capture
* D1 daily snapshots + D3 cloud sync
* Tier 2/3 real LLM-driven retrieval (current is templated; LLM swap is
  drop-in once `llm_gateway` is plugged into `retrieval_tiers.yield_t2/t3`)
* Schema migration registry (M5)
* Inference companion (M10)

**Frontend deferred (U2 / U3+)**:
* Imaging mode with cornerstone.js / OHIF Viewer
* Memory mode full UI (FindingRow / ConflictResolutionDialog / EditFindingInlineForm)
* "Nexus has learned" full-screen overlay
* Settings → Data panel + ExportWizardDialog
* Time travel surface
* Streamed chat real rendering (component scaffolded; not wired into EncounterMode yet)

---

## 11. The contracts (one-page reference)

| Contract | Origin | Code enforcement |
|---|---|---|
| Single source of truth | Rev-8 | golden replay test + CI lint |
| Verbatim quote required | Rev-2 / R13 | `QuoteVerificationError` at chat_ingester |
| Provenance on clinical facts | Rev-2 | `ProvenanceRequiredError` in `clinical_graph.add_node` |
| Four-axis conflict cascade | Rev-3 | `resolve_clinical_conflict()` tests |
| Tiered retrieval | Rev-4 | `tier_classifier` rules + tests |
| MONAI Bundle ↔ Provenance | Rev-6 / R16 | `bundle_to_provenance_refs` tests |
| Redaction before image_extracted | Rev-9 §5.5.7 #1 | `dicom_ingester._ingest_one_key_image` order |
| Replay handler coverage | Rev-8 / R23 | `verify_handler_coverage` import-time |
| Layer 2 PHI scrub | Rev-5 / R15 | `PrivacyInvariantViolation` in `Store._check_privacy_invariants` |
| Medic confirmation gate | Rev-5 | distiller writes `medic_confirmed_at = NULL` |
| Append-only event_log | Rev-8 | no UPDATE/DELETE; CI lint |
| Sovereign export contract | Rev-7 / Contract A | `create_export_bundle` + README literal text |

---

## 12. Reading order for new contributors

1. **This document** (`nexus-architecture.md`) — start here
2. `ADR-002-m3-memory-merge.md` — decision history Rev-1..Rev-9
3. `m3-memory-architecture.md` v3 — deep memory spec
4. `nexus-ux-redesign-v2.md` — frontend deep dive with mockups
5. Code: `event_sourcing/` → `memorization/` → `monai_runtime/` →
   `practitioner/` → `persistence/`
6. Tests: `tests/test_event_sourcing.py` (golden replay) →
   `tests/test_dicom_ingester.py` (end-to-end pipeline)

---

## 13. Glossary

* **Anchor entity** — root patient + persistent anatomical_region nodes
  that survive across studies (Rev-1 replacement for M3's face/voice).
* **Encounter** — one study, one chat session, or one lab posting.
  Replaces M3's `clip_id` (Rev-1).
* **Projection** — any non-event_log table; derived from event_log,
  drop-and-rebuildable (Rev-8).
* **Tier** — T1 (cached view) / T2 (single-entity) / T3 (multi-turn).
* **Bundle** — MONAI Bundle directory containing metadata.json +
  inference.json; wraps every extraction model (Rev-6).
* **Backend** — InferenceBackend implementation a Bundle dispatches to
  (gemini_flash_quick_scan / gemini_flash_2d / coreml_2d / stub).
* **Composer** — Layer 2 service that renders active practitioner
  facts into system-prompt enrichment (≤800 tokens).
* **Distiller** — Layer 2 nightly job that promotes observations to
  candidate facts when N-of-patients threshold is met.
* **Provenance** — typed audit row attached to every clinical-fact node;
  includes verbatim evidence_quote (Rev-2).
* **Sovereign export bundle** — self-contained directory of open
  formats; Contract A surface (Rev-7).
* **Inference companion** — deferred GPU sidecar machine for heavy 3D
  MONAI models (M10).

---

## 14. References

* ADR-002 (Rev-1..Rev-9) — `docs/adr/ADR-002-m3-memory-merge.md`
* Memory architecture v3 — `docs/design/m3-memory-architecture.md`
* UX redesign v2 — `docs/design/nexus-architecture.md`
* M3-Agent — <https://github.com/ByteDance-Seed/m3-agent>
* MONAI — <https://github.com/Project-MONAI/MONAI>
* Tauri 2.0 — <https://v2.tauri.app>
* OHIF / cornerstone.js — <https://ohif.org> / <https://cornerstonejs.org>
* RadLex · RxNorm · ACR-AC — see `m3-memory-architecture.md` §17
* HIPAA Safe Harbor — <https://www.hhs.gov/hipaa/for-professionals/privacy/special-topics/de-identification>
