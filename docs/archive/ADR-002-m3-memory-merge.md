# ADR-002: Memory architecture — fork M3-Agent's entity-centric graph, layer it on top of existing twin_event_log + vector_index (do NOT replace)

**Status:** Proposed
**Date:** 2026-06-13
**Deciders:** JZ (architect), agent-runtime owners
**Related:** #194 (M3 merge analysis), #176 (per-patient MEMORY.md), #135–#138 (vector index + RAG), #162 (PHI-hash patient anchor)

## Context

The agent's "memory" today is three layers that grew independently:

1. **`twin_event_log.py`** — per-user SQLite append-only ledger of every event (`assistant_response`, `tool_call`, `memory_compact`, ...). FTS over message bodies via `search_messages`. ~815 LOC. Acts as the medico-legal raw record.
2. **`vector_index.py`** — Gemini text-embedding + sqlite-vec. Chunks anything ingested (notes, study reports, chat) into embedded fragments. Single-shot cosine retrieval through `SemanticSearchTool`. ~640 LOC.
3. **`patient_memory.py`** (#176) — per-`(user_id, patient_hash)` markdown blob. The agent appends one-line notes ("This patient has GLP-1 history…"); the medic can edit it via the Memory tab. Flat, unstructured.

This served us through the prototype, but three failures keep showing up once a patient accumulates more than ~5 encounters:

- **No conflict resolution.** When two encounters disagree ("BI-RADS 3" vs "BI-RADS 4"), both lines just coexist in `md_text`. Nothing flags it; the agent surfaces whichever the embedding retrieval ranks higher.
- **No entity grounding.** The agent says "the left renal mass" in one chat and "LK lesion" in the next. Two embeddings, no link. Retrieval misses the cross-reference.
- **Single-turn RAG.** `SemanticSearchTool` runs once per turn, returns top-k, the LLM writes an answer. No iterative drill-down ("first find the index study → then find the latest follow-up that referenced it → then check what we recommended").

ByteDance's [M3-Agent](https://github.com/ByteDance-Seed/m3-agent) (Apache-2.0, accepted to ICLR 2026) tackles all three with infrastructure we'd otherwise build ourselves:

- **Entity-centric multimodal graph** (`mmagent/videograph.py`): nodes = entities (face/voice anchor + episodic + semantic) connected by weighted edges. We can re-skin face/voice → patient/finding/med/lab.
- **Weight-based voting** (`fix_collisions`): when entities collide, the higher-weighted (more-reactivated) entry wins; conflicts are not silently merged.
- **Disjoint-set entity merging** (`refresh_equivalences`): face_X and voice_Y observed as the same person → union-find collapses to character_Z. We need this for "left renal mass" ≡ "LK lesion".
- **Algorithm 1 iterative control** (`mmagent/retrieve.py::answer_with_retrieval`): multi-turn `[SEARCH q]` / `[ANSWER a]` loop replaces single-shot RAG.

The user asked: **"我可以考虑直接使用 m3 替换现有的 agent memory 设计"** — full replacement. This ADR decides between full replacement and layered adoption.

### Constraints

- Single solo developer; weeks not quarters.
- Six+ months of historical `twin_event_log` data in production — cannot be dropped or risk losing chat audit trail.
- Medico-legal compliance: every fact surfaced by the agent must trace back to a citable source (study UID + slice, or chat event idx). M3 has no provenance concept.
- M3 ships pickled graphs (`data/memory_graphs/*.pkl`); we have SQLite-first persistence with transactional invariants shared across twin_event_log + sessions + vector_index.
- M3's released models (`M3-Agent-Memorization`, `M3-Agent-Control`) are Qwen2.5-Omni video-tuned — useless to us directly. Only the **framework code + prompts** is reusable; we run Gemini/Claude.
- Existing `tools_memory.SemanticSearchTool` is the agent's only memory surface today — anything new must either replace it cleanly or coexist.

## Decision

Adopt **Option B — fork M3's `videograph.py` + `retrieve.py` into `nexus_server/mm_graph/`, layer the resulting `ClinicalGraph` on top of `twin_event_log` (kept as raw ledger) and `vector_index` (kept as embedding service), and replace only `patient_memory.md_text` with a graph-projection view.**

Rationale: Full replacement (Option A) is fatal on three independent axes — loss of audit ledger, loss of transactional consistency with sessions/dicom_studies tables, and loss of the only data the medic can edit by hand (the markdown memory). M3's contribution is the **graph structure + conflict resolution + iterative control loop**, not the persistence model. Layering preserves what works (event log as evidentiary record, vector_index as embedding service) and adopts what's missing (entity graph, weight voting, multi-turn retrieval). The only thing actually replaced is the unstructured `md_text` blob, which becomes a deterministic markdown projection of the graph's semantic nodes — UI-compatible, downgradeable if the graph layer turns out badly.

## Options Considered

### Option A — Full replacement: M3 graph IS the memory

Drop `twin_event_log` and `patient_memory`. Every event flows through M3's memorization pipeline; the graph is the only source of truth. Use M3's pickle persistence.

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — migration of 6mo event_log to graph; rewrite of every memory consumer (chat tool, evolver, patient memory UI, compliance export) |
| Compliance | **Blocker** — no audit ledger means we can't reproduce "what did the agent say on date X about patient Y"; M3 graphs are lossy (semantic distillation throws away raw events) |
| Provenance | **Blocker** — M3 nodes have no source_ref field; medico-legal export needs every claim cited |
| Persistence | Pickle-only — incompatible with our SQLite transactional model; no row-level locks; corrupt pickle = full memory loss |
| Risk | Catastrophic — single-developer rewrite of three intertwined modules, no fallback |

**Rejected.** The benefit (architectural purity) is dwarfed by the audit-trail and rollback risk. M3 was designed for a personal assistant watching video, not a regulated clinical workflow.

### Option B — Layered adoption (chosen)

Vendor M3's graph + retrieve modules. Keep `twin_event_log` as raw ledger. Keep `vector_index` as embedding provider. Build `memorization/` ingesters that derive graph entries from event_log events (chat) + dicom_studies (imaging) + labs. Replace `patient_memory.md_text` with `ClinicalGraph → markdown` projection.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Med — ~600 LOC new (graph store + ingesters), ~200 LOC vendor-edit (entity-type swap, embedding-client swap, GPT-4o → our LLM client) |
| Compliance | event_log untouched; graph is derived, can be rebuilt from event_log + dicom_studies on demand |
| Provenance | Add mandatory `extra_data.source = {kind, ref}` field on every semantic node; reject writes without it |
| Persistence | New tables `clinical_graph_nodes` / `clinical_graph_edges` in same SQLite db — transactional with event_log |
| Risk | Low — graph is a derived view; corrupt graph → rebuild from ledger; old `patient_memory.md_text` stays as fallback during shakedown |

**Chosen.** Captures M3's actual value (graph structure + voting + iterative retrieval) without inheriting its operational liabilities (pickle, no provenance, no audit).

### Option C — Cherry-pick: only the iterative control loop, no graph

Take only `answer_with_retrieval` (Algorithm 1 multi-turn loop) from M3. Skip the graph. Wire the loop on top of current `SemanticSearchTool`.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — ~100 LOC; just a wrapper around existing tool |
| Benefit | Modest — multi-turn retrieval improves recall on complex queries, but the underlying memory is still flat embeddings; no conflict resolution, no entity linking |
| Long-term | Punts the hard problems (conflicts, aliases, provenance) to a later rewrite |

**Rejected as standalone, kept as fallback path.** The control loop change is in Option B anyway; doing only this leaves the entity-grounding problem unsolved.

### Option D — Build entity graph from scratch, ignore M3

Design our own clinical-graph schema, write conflict resolution and union-find ourselves.

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — re-deriving algorithms M3 already has working open-source code for |
| Benefit | Fully customised to medical entity types |
| Time | 4–6 weeks vs Option B's 1–2 weeks |

**Rejected.** M3's `videograph.py` is a single 700-line well-isolated file under Apache-2.0; the entity-type field is a string, swapping `'img'/'voice'` for `'patient'/'finding'/'med'/'lab'` is a half-day. Re-implementing for the sake of "ours" is not justified.

## Consequences

**What changes:**

- `packages/server/nexus_server/mm_graph/` (new) — vendored `clinical_graph.py` (fork of `videograph.py`), `control_loop.py` (fork of `retrieve.py`), `prompts.py` (medical re-wording), `store.py` (SQLite persistence).
- `packages/server/nexus_server/memorization/` (new) — `dicom_ingester.py`, `chat_ingester.py`, `lab_ingester.py`.
- `database.py` — adds `clinical_graph_nodes`, `clinical_graph_edges` tables.
- `tools_memory.py` — `SemanticSearchTool` split into `search_node` / `search_clip`, signatures aligned with M3 `retrieve.search()`. `SearchPastChatsTool` unchanged (complements graph search).
- `patient_memory.py::get_patient_memory()` — internal rewrite: now does `graph.get_entity_info([patient_node])` → markdown projection. External signature unchanged so UI doesn't break.
- `twin_manager.py` — chat loop wraps `answer_with_retrieval` as the primary path; old single-turn RAG becomes fallback when graph hydrate fails.

**What stays:**

- `twin_event_log.py` — fully unchanged. Continues to be the only legally-citable record.
- `vector_index.py` — fully unchanged. Becomes the embedding provider for the graph (replaces M3's `parallel_get_embedding("text-embedding-3-large", ...)` calls).
- `SearchPastChatsTool` — fully unchanged. FTS path complements graph retrieval.
- `patient_memory` REST surface (`GET/PUT/POST /api/v1/patients/{hash}/memory`) — bytes-identical responses.

**Constraints we accept:**

- Vendored M3 code carries Apache-2.0 LICENSE header (compatible with our license).
- Graph schema is **per-patient** (one `ClinicalGraph` per `(user_id, patient_hash)`) — avoids cross-patient leakage, matches #176 isolation contract.
- Every `add_text_node(type='semantic', ...)` call must include `extra_data['source'] = {kind: 'study'|'chat'|'lab', ref: <uid>}`; the store layer rejects writes that don't. Non-negotiable for medico-legal use.
- `fix_collisions` gets a new `mode='medical_audit'`: never silently override conflicting clinical facts; instead emit a `memory_conflict` event into `twin_event_log` and surface in UI for medic review.
- M3's RL-trained `M3-Agent-Control` model is **not** used. We run prompt-only via Gemini/Claude. If retrieval quality is inadequate we revisit, but model fine-tuning is out of scope for this ADR.

**Rollback plan:**

`patient_memory.md_text` stays present in the DB throughout the migration. If graph projection produces bad markdown, flip the feature flag `memory.use_graph_projection=false` and `get_patient_memory()` reverts to reading `md_text` directly. Worst case: drop the new tables, redeploy old code, no data loss.

## Open questions (resolve before #195 implementation)

1. **Graph hydrate cost.** Loading a 6mo-old patient's graph from SQLite on every chat turn could be slow. Need to benchmark — likely solution is in-process LRU cache keyed on `(user_id, patient_hash)` with TTL, invalidated on `add_*_node` calls.
2. **Embedding migration.** `vector_index` already holds embeddings for chat chunks. Should `ClinicalGraph` reuse those embeddings (lookup by source_ref) or compute its own? Reuse is cheaper but couples the two stores; separate is cleaner but doubles embedding cost.
3. **Memorization triggering.** Chat ingester runs after every `assistant_response`? Or batched nightly? Real-time is more responsive but costs LLM calls on every turn.
4. **Conflict UI.** `memory_conflict` events need a UI surface — likely a yellow badge on the patient card + a resolution dialog. Out of scope for the graph layer itself but blocks "production use" status.

## Revisions — 2026-06-13 (post-review)

Initial design (above) was reviewed by JZ and four issues with naive M3 adoption were identified. The decision to layer (Option B) stands, but the **scope of "what we vendor from M3" shrinks** and four medical-specific replacements are now load-bearing parts of this ADR.

### Rev-1 — Video clip atomicity does not apply to medical imaging

M3's `clip_id` is a first-class index across the graph (`text_nodes_by_clip`, `event_sequence_by_clip`, the `search_clip` retrieval tool). It assumes a 30-second video segment as the atomic memory unit, with continuous frame-level ingestion at 5fps.

This breaks for our data: CT/MR studies are spatial (not temporal) traversals; X-rays are single 2D images; longitudinal "time" in medicine is between studies (months/years), not within them (seconds). M3's `memorization_intermediate_outputs.py` (face detection + speaker diarization at 5fps) is **wholly inapplicable** and is dropped.

Decision: replace `clip_id` with `encounter_id` (one study, one chat session, or one lab posting = one encounter). Drop the `search_clip` tool name in favour of `search_encounter` and `search_study`. Drop the 5fps frame-sampling pipeline; ingestion is event-driven (BackgroundTasks fired on upload/save completion), not streaming. Add a new `compare_studies(entity, study_a, study_b)` retrieval primitive that M3 does not have — the radiology longitudinal-compare workflow has no analogue in video QA.

Add new node types: `study`, `series`, `key_image`, `anatomical_region`, `measurement`. The `anatomical_region` node ("left kidney", "mediastinum") is the **persistent spatial anchor** that lets the same lesion observed across multiple studies converge to a single graph identity — this is the medical replacement for M3's face/voice anchors. Detection of equivalence ("the lesion in Feb CT is the same lesion in Jun CT") reuses M3's disjoint-set `refresh_equivalences` data structure but **the equivalence-detection logic is new code** (anatomical-region overlap + finding-type match + temporal proximity), not vendored.

### Rev-2 — Provenance must be a typed first-class table, not extra_data dict

M3 stores provenance as a free-form JSON dict on `node.extra_data`. No schema, no index, no enforcement. Inadequate for medico-legal audit, which must answer queries like "list every claim about patient X derived from imaging study Y by Gemini Flash v2.5 before date Z."

Decision: provenance is promoted to its own table `node_provenance` with a typed schema enforced at write-time. Mandatory fields:

```
source_kind          ∈ {study, chat, lab, manual}
source_ref           e.g. study_uid | event_idx | lab_id
source_locator_json  e.g. {series_uid, slice_no} | {event_idx, span}
evidence_quote       verbatim substring of the source text — non-paraphrased
extracted_by_user    medic in whose session this was minted
extracted_at         unix ts
extraction_model     e.g. "gemini-2.5-flash-002" (version-pinned)
extraction_prompt_id slug into the versioned prompt registry
confidence           [0..1]
redaction_version    PHI-scrub version applied
superseded_by_node   nullable, set by conflict resolution
retracted_at         nullable, set by medic action
retracted_by_user    nullable
retracted_reason     nullable
```

The `evidence_quote` field is the most important: every extracted entity must quote a verbatim substring of the source. The chat_ingester post-processor verifies the quote is a literal substring; mismatch → reject the write. This closes the LLM-hallucinated-entity failure mode (ADR-002 R3) more firmly than the original mitigation.

Write-time enforcement: `ClinicalGraphStore.add_node()` requires a full `Provenance` for any `semantic_fact / finding / measurement` node, else raises `ProvenanceRequiredError`. `episodic_event` is allowed lighter provenance (it already points to an `event_log` row).

Indices: `(source_kind, source_ref)` for "show all derived claims from study X" and `(extraction_model, extraction_prompt_id)` for "show all claims from prompt vN that I now want to re-extract."

### Rev-3 — Conflict resolution is four-axis policy, not argmax

M3's `fix_collisions(mode='argmax')` picks the higher-weighted node when two semantic nodes collide. Catastrophic example: "left renal mass 2.1 cm" (5 historical reports, weight=5) vs "left renal mass 2.4 cm" (1 latest CT, weight=1) — M3 picks the stale value.

Decision: replace `argmax` for clinical fact collisions with `resolve_clinical_conflict(a, b)` returning one of `PREFER(node)` / `FLAG_FOR_MEDIC(a, b)` / `MERGE` based on a four-axis cascade:

1. **Explicit retraction** — any node with `retracted_at` always loses to an un-retracted counterpart. Medic sovereignty overrides everything else.
2. **Medic confirmation** — a node `accept`-ed by a medic outranks an LLM-auto-extracted node.
3. **Evidence-strength rank** — pathology (biopsy) > imaging (MR > CT > US > XR) > clinical exam > chat hypothesis. Rank gap ≥ 2 → high rank wins. Gap of 1 falls through.
4. **Recency, measurement-only** — `extracted_at` more recent wins, gated by per-fact-type thresholds (size: 90d, meds: 30d, labs: 7d).

If all four axes are inconclusive: **never silently override**. Both nodes stay alive, `twin_event_log` records a `memory_conflict` event, patient card surfaces a yellow badge, medic resolves via dialog. Only the medic's choice can mark a side `retracted_at`.

Conflict **detection** is also smarter than M3's cosine-similarity clustering. Structured rules dominate: same `anatomical_region` + same `finding_type` + contradictory `measurement_value` → conflict; same `medication_rxnorm` + overlapping time intervals + different `dose` → conflict; same `lab_loinc` + same `sample_ts` + different value → data quality (not a conflict, separate flow). LLM-based detection is fallback only for free-text contradictions that the structured rules miss.

M3's underlying disjoint-set / weight-arithmetic primitives are still vendored (`refresh_equivalences`, `reinforce_node`, `weaken_node`) — the wrapping policy `resolve_clinical_conflict` is the new code.

### Rev-4 — Retrieval is three-tier; Algorithm 1 is opt-in for hard queries only

Algorithm 1's 5–10 round loop costs 2–20 s of wall-clock. Radiology reads complete in 30 s; this latency is incompatible with the workstation use case.

Decision: introduce a three-tier retrieval scheduler, agent (or rule-based classifier) picks tier per query.

**Tier 1 — Pre-cached canned views (target ≤ 50 ms).** Common views — `patient_summary`, `active_findings`, `current_meds`, `lab_trends`, `compare_with_prior_<modality>` — are pre-generated as BackgroundTasks at ingestion completion and stored in a `cached_views` table. Query-time path is pure SQL. Invalidation: any graph mutation touching covered entities marks affected views stale; next access regenerates.

**Tier 2 — Single-shot graph lookup (target ≤ 300 ms).** For single-entity queries, classify the anchor node, run `graph.get_entity_info(anchor)`, template-format. One LLM call total (final answer generation); no iterative loop.

**Tier 3 — Algorithm 1 multi-turn, streamed (5–15 s, SSE).** Only for complex multi-hop reasoning (`"why is this lesion behaving this way"`, `"compare three CTs and explain trajectory"`). Streams reasoning + retrieved snippets to the UI within ~1 s; final answer in 5–15 s. Visible-progress UX is what makes this latency tolerable.

Classifier (rule-based initially): single-entity-NP queries → T2; cached-view templates → T1; "why / explain / compare N / synthesise" → T3; default → T2.

**Speculative warm:** patient-card focus triggers all stale T1 views to refresh in the background. By the time the medic forms their first question, the cache is hot. This covers ~90% of the "30-second read" use case from T1.

Latency SLO (written into observability):
- Open patient → T1 ready ≤ 500 ms
- Single-entity query → T2 ≤ 300 ms
- Multi-hop reasoning → T3 first-byte ≤ 1 s, complete ≤ 15 s
- p99 ≤ 3× the targets above

### What "vendor from M3" now means, after revisions

| M3 component | Status after revisions |
|---|---|
| `VideoGraph` data structure (nodes + weighted edges) | **Vendor** |
| `add_text_node` / `update_node` / `reinforce_node` / `weaken_node` primitives | **Vendor** |
| `refresh_equivalences` disjoint-set union-find (mechanism) | **Vendor** |
| `fix_collisions` weight arithmetic | **Vendor** (as low-level primitive only) |
| `search_text_nodes` cosine retrieval | **Vendor** |
| `get_entity_info` | **Vendor** |
| Algorithm 1 `answer_with_retrieval` control loop | **Vendor** (Tier 3 only) |
| Prompt scaffolding (REASONING / [SEARCH] / [ANSWER]) | **Vendor** (medical reword) |
| `clip_id` indexing / `text_nodes_by_clip` / `event_sequence_by_clip` | **Drop** — replaced by `encounter_id` event model |
| `memorization_intermediate_outputs.py` (face + voice extraction at 5fps) | **Drop** — replaced by event-driven ingesters |
| `fix_collisions(mode='argmax')` as default policy | **Drop** — replaced by `resolve_clinical_conflict` |
| `extra_data` as provenance store | **Drop** — replaced by `node_provenance` table |

Net effect: we vendor the **graph primitives** and **iterative control loop** (~700 LOC of M3) and write the **medical adaptation layer** (~1200 LOC of new code) on top. The ratio is closer to 40/60 vendored/new than the original estimate of 80/20.

## References

- M3-Agent paper: <https://arxiv.org/abs/2508.09736>
- M3-Agent repo (Apache-2.0): <https://github.com/ByteDance-Seed/m3-agent>
- Internal #194 merge analysis (this conversation, 2026-06-13)
- ADR-001 (turn boundary) — sets context for why the control loop matters
- Revised design doc v3: `docs/design/m3-memory-architecture.md`

## Rev-5 — Four-layer memory (Layer 2 Practitioner Memory added) — 2026-06-13

This ADR initially scoped only the per-patient ClinicalGraph layer. Post-v2 review surfaced a gap: per-patient graphs don't answer "how does the agent get smarter at *this medic's practice* as their caseload grows." Layer 1 in isolation captures patient depth; it cannot capture cross-patient learning by design (per-patient isolation is part of the privacy contract).

Decision: extend the architecture to four layers + meta-layer. Full design lives in `docs/design/m3-memory-architecture.md` v3 §6. The ADR-level decisions:

- **Layer 2 (Practitioner Memory) added** — per-`user_id`, cross-patient, PHI-stripped store of `style / workflow / practice / calibration` patterns.
- **Two-table schema** — `practitioner_facts` (active, de-identified, agent-visible) and `practitioner_observations` (raw, per-patient-keyed, medic-audit-only). Privacy invariant: nothing reaches `practitioner_facts` until `distinct_patient_count >= N_THRESHOLDS[fact_kind]` AND medic explicit confirmation.
- **Layer 3 (Reference KB)** — read-only, version-pinned, shared across users. RadLex / RxNorm / lab ranges / guideline summaries. v3 ships schema only; population is M9+.
- **Layer 4 (Case Library)** — explicitly deferred 6+ months. Privacy/consent engineering for de-identified case archetypes is its own project.
- **Meta-layer** unchanged — `tools_evolve.py` continues to be the agent-self-improvement surface, distinct from Layer 2 (agent-learns-medic).
- **Phased delivery extended** — Layer 2 ships in M6–M8 *after* Layer 1 is stable (M0–M5). M6 is intentionally a dry-run (extraction without composer activation) to derisk Layer 2's higher blast radius.
- **Medic sovereignty preserved** — same principle as Rev-3: medic-rejected pattern_keys never resurface; composer flags rather than overrides when a current case appears to contradict an active practitioner fact.

## Rev-6 — MONAI integration, scoped to Mac lightweight layer — 2026-06-13

Post-v3 review surfaced [Project-MONAI](https://github.com/Project-MONAI/MONAI) (Apache-2.0, NVIDIA + Consortium) as a domain-specific medical-imaging framework that closes several v3 risks (R3 LLM hallucination on findings, R8 anatomical normaliser misses, R9 cross-study compare false positives, R13 extraction hallucination) by replacing LLM-derived imaging interpretations with model-derived structured outputs (segmentation masks, geometric measurements, registration).

The naive integration — run VISTA-3D and TotalSegmentator on DICOM ingestion — assumes a GPU-equipped backend. **Nexus is deployed on the medic's Mac laptop**, not a server. CUDA does not exist; Apple Silicon MPS has incomplete coverage for MONAI's 3D ops; a full-body CT segmentation on M3 Max takes 2–8 minutes, on M3 Air 15–40 minutes or OOM. This is incompatible with a 30-second radiology read.

Decision: **adopt MONAI's lightweight layer only**, defer heavy 3D inference to a future "inference companion" architecture (v2 work, post-v1 ship).

In scope for v3 (Mac-native):

- **MONAI DICOM I/O + transforms** — `monai.transforms` for windowing, resampling, intensity normalisation, NIfTI conversion. Pure CPU, milliseconds. Replaces our home-grown DICOM parsing.
- **MONAI Bundle format** — adopted as the standard packaging for any imaging extraction model we ship. The format carries version + inference config + metadata, which maps cleanly into `node_provenance.extraction_model` and `node_provenance.extraction_prompt_id` (Bundle id + bundle-internal config id). Even our Gemini-Flash-backed Quick scan gets wrapped in a Bundle for provenance uniformity.
- **CoreML-converted 2D bundles** — selected lightweight 2D models from MONAI Model Zoo (chest X-ray triage, dermatology lesion classifier, fundus screening) converted to CoreML, run on Apple Neural Engine in 1–3 seconds. These replace Gemini-Flash for 2D modalities where a domain-tuned classifier is available.
- **MONAI Label OHIF hook** — when the medic edits an agent-emitted finding in the Imaging mode (cornerstone/OHIF), MONAI Label's protocol records the correction. This is the **medic-in-the-loop training signal** that feeds future model refinement (deferred to v2 — schema in place, retraining loop not yet).

Out of scope for v3 (deferred to inference companion):

- **VISTA-3D whole-body anatomy** — heavyweight 3D, GPU required.
- **TotalSegmentator** — same constraint.
- **Image registration** for cross-study compare (Rev-1). v3 retains the heuristic anatomical-region-overlap approach; registration upgrades the same edge type later without schema changes.
- **MONAI Deploy App SDK** — Linux-only runtime; deployment model differs from Tauri-on-Mac.

Architectural reservation: an **"inference companion" path** is preserved in v3 design without being implemented. The DICOM ingester routes by modality + volume size; the 3D-heavy branch is currently a `Gemini-Flash on 4×4 grid` placeholder (current Quick scan). When inference companion ships (v2), this branch swaps in remote MONAI inference without altering the graph schema or downstream consumers.

Implications for risks:

- R3 (LLM extractor hallucination) — **partially** closed for 2D modalities where a CoreML bundle replaces the LLM; remains for 3D + chat extraction.
- R8 (anatomical normaliser misses) — unchanged; resolves when VISTA-3D ships in v2.
- R9 (cross-study compare false positives) — unchanged; resolves when MONAI registration ships in v2.
- R13 (extraction hallucination) — partially closed; same scope as R3.
- New R16 — MONAI Bundle ↔ our provenance schema impedance. Mitigation: a thin adapter layer in `nexus_server/monai_runtime/bundle_loader.py` reads Bundle metadata, writes our typed `Provenance` row. Drift between MONAI Bundle spec version and our adapter is a versioning issue, not a data-loss risk.

Implications for phasing: insert **M0.5 MONAI lightweight spike** (1 week, between M0 and M1) — validate Bundle loading on Mac, convert one 2D bundle to CoreML and measure ANE latency, prototype MONAI Label hook into OHIF. M1 DICOM ingester is then rewritten to use the modality-routing architecture.

## Rev-7 — Data sovereignty & long-term persistence — 2026-06-13

Initial v3 design specified Layer 1–4 data structures rigorously but said nothing about preserving them across machine loss, app upgrades, schema evolution, embedding model deprecation, or — worst case — Nexus itself ceasing to exist. For a clinical product targeting solo practitioners who accumulate **years of patient records and learned practice patterns**, this is a load-bearing concern, not an operational footnote. A medic who has used Nexus for three years and lost their data, their device, or their vendor has lost something that cannot be reconstructed.

Decision: adopt **two product-level contracts** plus a **five-tier persistence model**. These are ADR-level decisions — not implementation choices — because they commit the product to a philosophy of medic data ownership.

### Contract A — The medic owns their data, not us

Every byte produced by Nexus can be exported, at any time, into a **self-contained bundle in open documented formats**: JSON for graph data, Markdown for human-readable summaries, JSONL for the event log, FHIR R5 Bundle for EHR interop, raw DICOM for imaging passthrough, and a `_sql_dump.sql` as a belt-and-braces format-independence fallback. No proprietary binary representation. No requirement to run Nexus code or contact a Nexus server to read the data.

The export bundle's `README.md` is the load-bearing artifact for vendor-failure recovery: it explains, in human-readable prose, every file in the archive and how to interpret it. If five years from now Nexus is gone and the bundle is the only thing left, a competent engineer with no prior Nexus context should be able to reconstruct what the medic's records contained.

This contract is surfaced in the app UI itself — Settings → Data → Backup & Export carries the literal text **"Your data is yours. The export format is open and documented. Nexus going away does not take your records with it."**

### Contract B — `twin_event_log` is append-only ground truth

The event log is the **only** layer with no schema migrations, no derivation from other state, no permitted alteration after write. Every other layer (ClinicalGraph, Practitioner Memory, cached views, reference snapshots) is **derivable** from the union of (event_log + ingester replay + reference-knowledge versions in use). If every derived table corrupts, the entire agent state can be reconstructed from the event log.

This contract has two corollaries: (1) the event log is the **medico-legal record** — five years later a doctor reproducing "what did Nexus say on 2026-04-12" reads it here, not from derived state; (2) the event log gets the most aggressive durability — it is the only layer that ships in **all five persistence tiers** from day one.

### Five-tier persistence model

| Tier | Mechanism | Threat addressed |
|---|---|---|
| **0** | Hot SQLite, WAL mode, agent in-process | (none — running state) |
| **1** | WAL checkpoint cadence + local rolling snapshots (every 6h, 30d retention) | App crash, sudden power loss, SQLite corruption |
| **2** | Daily compressed archive tarball to `~/Documents/Nexus Archive/` (30 daily / 12 weekly / 24 monthly) | Accidental deletion, ransomware, retention rollback need |
| **3** | Optional user-controlled remote sync — rclone-adapter to iCloud Drive / Google Drive / OneDrive / S3, age-encrypted with keys in macOS Keychain | Laptop loss / theft / failure |
| **4** | On-demand sovereign export bundle — Settings → Data → Export | App-version incompatibility, vendor exit, EHR migration, medico-legal disclosure |

Each tier addresses a different threat; ownership of a tier (`5` is "Nexus loses access entirely") cannot regress to a lower tier without explicit medic action.

### Schema evolution invariants

To make the contracts durable across years of code changes, three invariants apply to all migrations:

1. **Migrations never delete columns.** Only `ADD` and mark-as-deprecated. Old export bundles loaded into new app versions always resolve.
2. **Every record carries `_schema_version`.** Forward migration (loading old data into new app) and best-effort backward migration (rollback safety) are both supported.
3. **`twin_event_log` is migration-immutable.** Columns may be added; existing event content is never rewritten. Old events read as old events forever.

### Embedding model rotation

`vector_index.chunks` carries an `embedding_version` column. When Gemini's embedding model rotates, existing graph nodes keep their old vectors + version pointer; **lazy re-embedding** happens on next retrieval, not in a batch migration. The old vectors are retained for 90 days as a rollback path. The original text + verbatim `evidence_quote` are preserved regardless of embedding version — they are the medico-legal evidence, not the embeddings.

### Phasing

| Phase | Scope | Weeks |
|---|---|---|
| **D0** | Integrated into M0 — SQLite WAL mode + checkpoint discipline + `_schema_version` table + migration registry skeleton | 0 (folded into M0) |
| **D1** | Tier 2 local archival — BackgroundTask daily tarball, retention policy, Backup & Export UI card. Ships after M5 | 1 |
| **D2** | Tier 4 sovereign export — full bundle writer (FHIR R5 transformer + JSON schema headers + `_sql_dump.sql` + `README.md` + checksums), import-from-bundle path, schema migration framework finalised. Parallel with D1 | 1.5 |
| **D3** | Tier 3 optional cloud sync — rclone-adapter, age encryption, Keychain-stored keys, UI configuration flow. Post-v1 — not on the critical path | 1 |

Total: ~3.5 dev-weeks of new work. D0 is zero-marginal-cost (folded into M0); D1+D2 can run in parallel with M6–M8 (Layer 2 work) since both need to walk the same SQLite db. D3 is explicitly post-v1.

### What this changes in the rest of the v3 design

Design doc v3 §16 (new) details the implementation: threat model, bundle file layout, FHIR R5 mapping, UI surface in Settings → Data. The data model in §3 is unchanged; persistence is **layered on top** without touching the schema. The phased delivery in §9 is amended to include D0–D3.

Risks added: **R19 — backup-restore round-trip drift** (snapshot taken at time T, restored later may collide with newer state; mitigation: snapshots are explicit forks, restore is destructive replace not merge); **R20 — export bundle PHI in transit when shared** (medic may email an exported bundle without realising it contains full PHI; mitigation: export wizard surfaces this explicitly, offers age-encrypted variant, never auto-uploads).

## Rev-8 — Event sourcing as architectural foundation: event_log IS the single source of truth — 2026-06-13

Rev-7 introduced Contract B (`twin_event_log` as append-only ground truth) but qualified it: "all derived layers reconstructible from event_log + reference snapshots + DICOM files." Honest design-review audit showed this was aspirational. The DICOM ingester wrote directly to graph tables. The chat_ingester's structured extraction outputs (the `finding` / `semantic_fact` lists) never landed in event_log. Conflict-resolution decisions, equivalence merges, medic confirmation actions, weight reinforcement — none of these produced events with replay-sufficient payloads. Audit estimated **only ~40–50% of derived state** was actually rebuildable from event_log without re-running non-deterministic models.

This is unacceptable for a clinical product where medico-legal replay must be **exact**, not approximate, and where the medic's trust in "you can always take your data and reconstruct everything" depends on it being literally true.

Decision: commit to **strong event sourcing**. `twin_event_log` is no longer "the chat ledger plus some mutation events." It IS the **canonical store**. Every other persistent table is a **projection** — a materialised view rebuildable on demand by replaying event_log against an empty database.

### Strong Contract B (supersedes Rev-7 Contract B)

The canonical state of the system lives in three places, and three places only:

1. **`twin_event_log`** — append-only, immutable, every state-changing operation as a typed event with full payload. Schema-versioned, migration-immutable.
2. **Content-addressed file blobs** at `~/Library/Nexus/files/<sha256>.bin` — DICOM files, attached PDFs, large binary inputs. Events reference these by SHA-256.
3. **Versioned meta-layer archive** — `meta_layer/prompts/*.md` and `meta_layer/configs/*.json`. Every version of every prompt and every config that has ever been used is preserved verbatim; events reference these by `(prompt_id, version)` tuple.

Everything else is projection. `clinical_graph_nodes`, `clinical_graph_edges`, `node_provenance`, `cached_views`, `practitioner_facts`, `practitioner_observations`, `reference_knowledge`, even the existing `patients` and `dicom_studies` tables — all projections. Drop them at any time; replay event_log against an empty database; they come back byte-identical (modulo schema version).

### Five invariants

1. **Emit-event-then-apply**. Every write to any projection is preceded, in the same SQLite transaction, by an `INSERT INTO twin_event_log`. The mutation is the **application** of the event; the event is the truth.

2. **LLM outputs stored verbatim in events**. Replay never re-invokes any LLM. Non-determinism is bypassed by archive, not by re-execution. An `ingestion_llm_response` event carries the raw model output, the prompt id + version, the model name + version. Replay reads that field; it does not call Gemini.

3. **Reference data stored by version pointer**. RxNorm 2026-04, RadLex 4.1, ACR-AC 2025-11 — events record which version was in effect; the payload is re-downloadable from the authoritative source (and snapshotted into the export bundle for archive completeness). The event ensures replay knows which version's semantics applied.

4. **Large binaries stored as content-addressed files, referenced from events**. A `dicom_uploaded` event records `{study_uid, modality, sha256, file_size}` — the file itself sits at `files/<sha256>.dcm`. Replay needs the file present on disk; the event tells replay what to do with it.

5. **Projections track their replay position**. A `projection_state` table records `(projection_name, last_applied_event_idx)` per projection. Replay is **incremental** — restart from the last checkpoint; full rebuild only when the projection is dropped.

### Consequences

- **M0 scope expands from 1 to 1.5–2 weeks.** event_log middleware, event taxonomy (~35 typed event kinds), the emit-then-apply store layer, `projection_state` infrastructure, and a CI golden replay test become M0 deliverables. Cannot be deferred — every later phase relies on this foundation.

- **Schema migrations on projection tables become trivial.** Add a new derived column → bump projection schema version → drop projection → replay event_log → projection is rebuilt with the new column populated. No bespoke migration code per projection. Migrations now exist almost exclusively for `twin_event_log` itself, where they remain strictly additive per the existing invariant.

- **Write performance: +1 SQLite INSERT per mutation.** Negligible for chat-shaped workflows. For bulk DICOM ingestion (thousands of `node_added` events per study), batch event emission into a single transaction with the corresponding bulk projection apply. Budget: write throughput target ≥ 5000 events/sec on M-series SSD — empirically achievable for SQLite with WAL.

- **Auditability becomes a SQL query**. "Show me everything Nexus ever did about patient X" = `SELECT * FROM twin_event_log WHERE payload_json LIKE '%<patient_hash>%' ORDER BY event_idx`. Forensic, regulatory, and personal-audit use cases collapse to a single primitive.

- **Testing: golden replay test in CI as a hard gate.** Take a representative live DB + its event_log → drop all projections → run `replay_all()` → assert deep equality against the originals. Runs on every PR that touches the store layer or any ingester. PR cannot merge red.

### What this changes downstream

Memory design v3 gets a new **§16.12** specifying the complete event taxonomy, the emit-then-apply protocol, the replay protocol, and the `projection_state` schema. Existing §3.3 (data model) is updated to note all tables besides `twin_event_log` are projections. §5 ingester patterns are updated to use emit-then-apply. §9 phased delivery is updated to expand M0.

Task #195 (M0 implementation) is rewritten: M0 is no longer "vendor M3 + provenance + chat_ingester." M0 is **the event-sourcing foundation that all subsequent phases plug into**. Specifically: event_log middleware, store layer that enforces emit-then-apply, replay infrastructure, golden test, and chat_ingester rewritten as the first event-sourcing client to validate the pattern end-to-end.

Risks added: **R22 — projection rebuild duration on large event logs.** A patient with 5 years of history could have 100k+ events; full rebuild may take minutes. Mitigation: `projection_state` checkpoints; rebuilds are incremental in normal operation; full rebuild only on schema upgrade. Background rebuild option with old projection still readable in the meantime. **R23 — event taxonomy drift.** New event kinds added over time; old replay code must handle them all. Mitigation: event kinds are versioned (`event_kind_version`); replay registers a handler per `(kind, version)` pair; unhandled kinds raise loud errors in CI, never silently skipped at runtime.

## Rev-9 — Imaging memory: pixels in addition to text — 2026-06-13

The v3 design (through Rev-8) writes imaging into memory exclusively as **text** — Gemini-Flash caption of a 4×4 grid → LLM-extracted findings → graph nodes carrying text content. The raw pixels are never re-touched by any downstream consumer. Three failure modes follow from this:

1. **What the caption misses doesn't exist in memory.** A small contralateral nodule not mentioned by Gemini Flash is permanently absent. The original CT still has it; memory does not.
2. **Cross-study spatial reasoning is impossible.** "Is this lesion growing concentrically or eccentrically?" needs pixel-level comparison; memory has two diameter scalars.
3. **Visual similarity retrieval has no substrate.** "Find renal masses I've previously seen that look like this one" requires image embedding similarity; memory has only text embeddings of captions.

Decision: extend imaging memory through **three layers**, each addressing a different failure mode, while preserving Rev-8 event sourcing.

### Layer A — Visual embeddings at ingestion

Every `key_image` node gains a **visual embedding** in addition to its existing text-caption embedding. Source: a medical CLIP-style encoder (BiomedCLIP / CXR-CLIP / MONAI image encoder), CoreML-converted to run on Apple Neural Engine in 1–2 s per slice. Stored in `vector_index.chunks` with an `embedding_kind` discriminator distinguishing text/visual. Surfaced via a new retrieval tool `search_image_similar(reference_image_sha256, top_k)`.

### Layer B — Multimodal LLM at retrieval time

At Tier 2 / Tier 3 retrieval, alongside text context, the actual **key-image binary** of every cited finding is attached to the LLM message. Gemini 2.5 Flash and Claude 3.5+ both accept multimodal inputs natively. The LLM **looks at the image** rather than reasoning from a stale caption. Budget: 1–3 images for Tier 2; up to 16 for Tier 3 across iterative rounds. Each attachment emits an `image_attached_to_context` event into the canonical log — replay knows exactly which images informed any historical agent response.

This is the **highest-leverage** of the three layers: it converts imaging from a lossy text snapshot into a re-examinable evidence record, and it unblocks fine-grained visual reasoning that no amount of caption refinement can match.

### Layer C — Structured radiology features at ingestion

Beyond captions and embeddings, modality-specific **structured features** are extracted and stored on `measurement` nodes:

| Modality | Features |
|---|---|
| CT | HU mean/std/range, multi-phase enhancement Δ, three-dim size, morphology class, contour features |
| MR | T1/T2 signal characteristics, ADC, enhancement curve, volume |
| US | Echogenicity class, posterior acoustic features, Doppler when present |
| XR | Opacity, position, boundary, contrast metrics |

Extractors are small MONAI bundles or pure-Python computations (HU stats from pydicom). These features make graph queries that **today are impossible** ("retrieve all heterogeneously-enhancing CT lesions with HU > 30") trivial.

### Event sourcing extension

Imaging gains **five new event kinds** (specified at the design-doc level in §16.12.2):

```
image_extracted             — key slice rendered, file written content-addressed
image_redaction_applied     — burned-in PHI stripped; before/after sha256 recorded
image_embedding_computed    — visual encoder ran; vector_sha256 + encoder version
image_feature_extracted     — structured feature computed; values + extractor id
image_attached_to_context   — at retrieval, which images went into LLM context
```

All five satisfy the Rev-8 replay-determinism contract:

- **image_extracted** is content-addressed: replay verifies the file exists at the recorded path.
- **image_redaction_applied** is deterministic given engine version + input bytes; replay either trusts the recorded `image_sha256_after` or re-runs to verify (configurable).
- **image_embedding_computed** is deterministic given encoder weights + version; replay re-computes and verifies the recorded `vector_sha256` matches. Mismatch raises loud error (weights drift or version mis-recorded).
- **image_feature_extracted** is deterministic given extractor version; same verification.
- **image_attached_to_context** is pure record; replay just records.

The LLM call itself (when images attached) is non-deterministic, so its output is stored verbatim in the existing `assistant_response` event — same pattern as text-only LLM calls. Replay reads the recorded output; never re-invokes Gemini / Claude.

### Mandatory redaction — non-negotiable

DICOM has well-known burned-in PHI problems (especially ultrasound, mammography, dental imaging). Any pipeline that writes pixel files to `~/Library/Nexus/files/keyimage/` without first removing burned-in PHI is a compliance failure. Therefore:

**Invariant**: `image_extracted` cannot commit before `image_redaction_applied` commits. The redacted bytes are what get stored; the unredacted bytes never touch the canonical file store. The redaction event records the engine version + detected regions, so future audits can answer "which redaction pass produced this image."

Redaction pipeline: pydicom overlay strip → OCR sweep (PaddleOCR or similar) → classifier flagging PHI text regions → blackout → hash.

### Storage footprint

- ~16 key images per study × ~50 KB PNG ≈ 800 KB/study
- 1000 patients × 4 studies avg × 0.8 MB ≈ 3.2 GB total
- Content-addressed: `~/Library/Nexus/files/keyimage/<sha256>.png`
- Export bundle includes them under `layer1_patients/<hash>/key_images/`

Bounded; well within Mac SSD budget.

### Phasing

Three new sub-phases inserted between M1 and M2:

- **M0** (existing scope) — `key_image` content_json schema extended with placeholders (`image_sha256`, `visual_embedding`, `features` fields, all nullable); event taxonomy registers the five new kinds with v1.0 handlers as no-ops except for the basic `image_extracted` write
- **M1** (already extended for MONAI in Rev-6) — DICOM ingester implements rendering + redaction + content-addressed storage; emits `image_extracted` + `image_redaction_applied`; no embedding, no features yet
- **M1.5** (1 week, NEW) — Visual embedding pipeline: model selection spike (BiomedCLIP / CXR-CLIP / MONAI image encoder), CoreML conversion, `image_embedding_computed` event handler, `search_image_similar` tool registration
- **M1.6** (1 week, NEW) — Multimodal LLM context assembly: image attachment in Tier 2/3, `image_attached_to_context` event, composer prompt update, token + image budget management
- **M1.7** (1 week, NEW) — Structured radiology feature extraction: HU stats (pure pydicom), 1–2 MONAI bundles for morphology / enhancement, `image_feature_extracted` event handler

Total addition: 3 weeks. v3 project total moves from 10.5 → 13.5 dev-weeks.

### Risks added

**R24 — Visual encoder version drift.** Once embeddings are written, changing the encoder model invalidates the entire visual similarity index.
Mitigation: encoder version is part of `image_embedding_computed.encoder_version`. On encoder upgrade, treat like embedding rotation (§16.7) — lazy re-embed on next access, keep old vector for 90 d. Visual similarity searches are scoped to a single encoder version.

**R25 — OCR-based redaction misses non-text PHI.** Patient face in a smartphone-captured dermatology photo, or visible tattoos, or implanted-device serial numbers. OCR catches text; doesn't catch images-of-faces.
Mitigation: redaction pipeline includes a face-detection pass for ophthalmology / dermatology modalities; medic UI flags any image where redaction detected uncertain regions and offers manual review before commit. Out-of-scope modalities (most CT/MR/XR) skip the face pass.

**R26 — Multimodal LLM token cost.** Image inputs to Gemini / Claude consume tokens at higher cost than text.
Mitigation: budget per Tier — Tier 2 max 3 images, Tier 3 max 16. Composer logs estimated token cost per call; if a query systematically blows budget, falls back to text-only context with a logged degradation event. Cost telemetry surfaces per-week.
