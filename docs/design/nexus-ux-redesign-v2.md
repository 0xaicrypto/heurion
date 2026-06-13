# Nexus UX/UI Redesign v2 — event-sourced, memory-aware, provenance-first

**Status:** Active spec — supersedes `nexus-ux-redesign.md` v1
**Date:** 2026-06-13
**Owner:** JZ
**Related:** ADR-002 (Rev-1..Rev-9), `m3-memory-architecture.md` v3, #197 (U0 shipped), #200 (U0 closeout), #204 (this doc)

## Diff from v1

v1 was written when the backend was still aspirational. We had no per-patient graph, no event sourcing, no Layer 2 practitioner memory, no Rev-9 multimodal imaging. The UI was designed around what we *might* serve.

Since then we've shipped M0 (#195) — `twin_event_log` is the single source of truth, Layer 1 graph projections are real tables, ChatIngester emits the full provenance chain, CitationChip can be backed by real Provenance rows, Tier 1/2/3 retrieval is a real classification, "Nexus has learned" candidates are real records.

v2 redesigns the frontend around what the backend now actually produces. Three things drive the diff:

- **Provenance is first-class.** Every clinical-fact node in memory carries a typed `node_provenance` row with verbatim `evidence_quote`, model id, prompt version, confidence, redaction status. CitationChip 1.0 was a stub showing `[N]` numbers; CitationChip 2.0 is a real lens onto medico-legal evidence.
- **Memory mode is no longer aspirational.** Layer 1 ClinicalGraph projections (active findings, current meds, conflicts, timeline) are now backed by SQL projections derivable from event_log. The UI renders them directly.
- **Rev-9 imaging.** Multimodal LLM at retrieval means agent messages can carry attached key-images. CitationChip on an imaging finding renders a thumbnail. Visual-similarity search exists as a primitive. OHIF + MONAI Label captures medic corrections as events.

What's preserved from v1: framework choice (Tauri 2.0 + React 18 + TS + Tailwind + Radix), personas (radiologist / hospitalist / resident), six design principles, visual language (warm neutrals + Google blue + Tiempos / system / JetBrains Mono + 8/12/16 radius), the 8 UI primitives, the shell architecture (header + sidebar + canvas + context rail).

v1 stays in git history. Implementations should target v2.

---

## 1. Backend reality the UI now serves

Before redesigning surfaces, here's the shape of what the backend now produces. Every frontend choice below is justified by an item here.

**Single source of truth.** Every state change is in `twin_event_log`. Drop projections → replay → byte-identical. **Implication for UI**: any historical state is reachable via `?as_of_event_idx=N` on read endpoints. Time travel is essentially free.

**Mandatory provenance.** Every `finding` / `measurement` / `semantic_fact` carries a `node_provenance` row with verbatim `evidence_quote`. **Implication**: every claim the agent surfaces is citable with a verbatim source quote. The UI MUST render citations as real evidence affordances, not decorative.

**Tiered retrieval.** Tier 1 = pre-cached views (≤50ms SQL hits), Tier 2 = single-entity graph lookup (≤300ms), Tier 3 = Algorithm 1 multi-turn streamed (5–15s). **Implication**: UI shows tier choice + progress for T3, instant for T1/T2.

**Conflict events.** Same finding with contradictory measurements → `memory_conflict` event surfaces. **Implication**: yellow badge on patient card + dedicated resolution dialog.

**Practitioner memory candidates.** After N patients hit the same pattern, candidate surfaces for medic confirmation. **Implication**: a top-level "Nexus has learned" surface where the medic accepts/rejects learned patterns.

**Multimodal context (M1.6+).** Key-images attached to agent messages. **Implication**: CitationChip on imaging shows thumbnails; Encounter mode renders image references inline.

**Data sovereignty (Rev-7).** Sovereign export bundle is on demand. **Implication**: Settings → Data is a real, designed surface (already specified in v1 §6.7a; preserved here).

---

## 2. Design principles — additions to v1

v1's six principles hold. Three additions reflect the new backend:

**Provenance is the price of trust.** Any clinical claim the agent makes is one click from its verbatim source. No claim escapes citation. If the citation rail is closed and the medic wants to verify, the friction is `⌘.` then click — not "scroll through chat".

**Audit > speed for clinical decisions.** When Tier 3 takes 12 seconds, that's fine — the UI shows the reasoning streaming and the cumulative evidence. When the medic gets the answer, they get the audit trail with it.

**The medic always wins.** Yellow badges, "Nexus has learned" candidates, conflict resolutions — these surface decisions the agent could make alone but doesn't. The agent flags; the medic decides. Surface design follows: confirm/reject buttons are 2-3× more prominent than the agent's recommended path.

---

## 3. Visual language — provenance ink + multimodal mark

v1's palette + typography stand. Two additions:

**Provenance ink.** A neutral subdued tone for citation chips and provenance traces. Light: `#76706A` border / `#F4EFE5` background. Dark: `#5A554E` border / `#2A2724` background. Never accent-coloured — citations are evidence, not action.

**Multimodal mark.** A small `📷` glyph (or `<KeyImage size={10}/>` from lucide) used to flag CitationChips that carry an image attachment. Distinguishes "this is text from chat" from "this is a slice from a CT". Renders as a faint badge on the chip.

---

## 4. Information architecture — preserved + two new top-level surfaces

v1's shell is unchanged: 48px global header / 260px patients sidebar / flexible main canvas / 320px optional context rail. The canvas has the same seven modes (Today / Patient / Encounter / Imaging / Labs / Memory / Report).

Two **new top-level surfaces** sit outside the canvas:

- **Settings · Data** (designed in v1 §6.7a; reached via AccountMenu → Settings) — preserved.
- **Nexus has learned** (new in v2; reached via AccountMenu → "Nexus has learned" or via the badge that appears on the avatar when candidates are pending) — full-screen overlay above the canvas. Closing returns to wherever the medic was.

Both surfaces are full-screen overlays, not new modes — they're cross-cutting (settings span all patients, Practitioner memory is cross-patient by construction).

---

## 5. Mode redesigns

For each mode: what stays from v1, what changes, what API endpoints back it, what new components are needed.

### 5.1 Today (default landing)

**Stays:** centered greeting, briefing card, pinned-patients list, "Ask Nexus" input.

**Changes:**
- Briefing card content comes from a Tier-1 cached view per medic, generated by the new `daily_briefing` view kind on M5+.
- Pinned-today list comes from sidebar pinned state (Layer 2 workflow fact `workflow/recent_focus`) once M7 ships, not from `lastSeenAt > 24h` heuristic.
- Avatar in account menu shows a small dot if `practitioner_candidates_pending > 0`.

**API:**
- `GET /api/v1/memory/views/daily_briefing` → markdown
- `GET /api/v1/memory/practitioner/pending_count` → integer

### 5.2 Patient overview

**Stays:** centered single-column document layout, sections for Summary / Timeline / Active concerns / Medications.

**Changes:**
- **Summary** is the literal output of `cached_views[view_kind='patient_summary']`. Render as markdown with inline CitationChips parsed from `[study:...]` / `[chat:event-N]` tokens.
- **Timeline** renders `nodes WHERE encounter_id IS NOT NULL` grouped by encounter, sorted by `created_at` desc. Each row is a TimelineRow component (new) showing date · encounter type · brief content + a Provenance ribbon on hover.
- **Active concerns / Medications** are direct projection reads on `clinical_graph_nodes` filtered by `node_type IN ('finding', 'med')` and not retracted.
- "Refresh" action invalidates the cached view server-side; client re-fetches.

**API:**
- `GET /api/v1/memory/patient/{hash}/summary` → cached view
- `GET /api/v1/memory/patient/{hash}/findings?status=active` → finding nodes with provenance refs
- `GET /api/v1/memory/patient/{hash}/medications` → med nodes
- `GET /api/v1/memory/patient/{hash}/timeline?limit=N` → grouped encounter list

**Components needed:** `MarkdownWithCitations`, `TimelineRow`.

### 5.3 Encounter (chat) — biggest U1 evolution

**Stays:** single-column message flow, input at bottom, citation chips inline.

**Changes:**

**Streaming with tier indicators.** Every message the agent emits goes through Tier 1/2/3 classification. The UI surfaces tier choice as a small inline status:

```
You · 10:42
  compare the latest CT to the index. what changed?

Nexus · routing…  (T3 — multi-step reasoning)
  ┊
  ┊ ▾ thinking (collapse)
  ┊   Searching for prior CT of left kidney…
  ┊   Found 2 studies: Feb 14, Jun 10. Comparing measurements…
  ┊   Found 1 same_finding chain, delta +0.3cm…
  ┊
  ┊ The left renal mass measured 2.1 cm on the index CT [1] and
  ┊ 2.4 cm on the latest [2] — a 0.3 cm interval increase over
  ┊ ~4 months, consistent with slow growth.
  ┊
  ┊ Differential narrows toward RCC; MR with contrast remains
  ┊ the recommended next step [3].
  ┊
  ┊ [1] study 1.2.840…7822 slice 142  📷
  ┊ [2] study 1.2.840…9104 slice 138  📷
  ┊ [3] guideline ACR-AC/renal-mass-incidental @ 2025-11
```

- `routing…` text appears for ~100ms then replaced by tier label.
- Tier 1 / Tier 2 answers stream as a single block (no reasoning pane visible).
- Tier 3 shows the collapsible Reasoning Pane streaming live. Default-folded for senior medics (account preference); default-open for residents.
- Citation chips with `📷` carry image attachments (M1.6+).
- "Streaming" is via SSE event stream — see API §8.

**Citation rail integration.** Clicking any chip slides open the right context rail with:

- For chat citation: the verbatim event_log entry (user turn + assistant turn) with the cited span highlighted.
- For imaging citation: the rendered key_image (PNG from `~/Library/Nexus/files/keyimage/<sha>.png`) + slice metadata + the redaction status badge.
- For guideline citation: the reference_knowledge content (markdown) with version + source.

**Conflict surfacing inline.** If the agent's response touches a finding currently in conflict, a yellow inline banner above the response:

```
⚠ The "left renal mass size" answer above references a finding
  with an unresolved conflict (CT Jun 10 vs CT Feb 14, ±0.3cm).
  Resolve → [opens Memory mode at the conflict]
```

**Components needed:** `TierIndicator`, `ReasoningPane`, `CitationChip` 2.0, `ConflictInlineBanner`, `MessageWithCitations`.

**API:**
- `POST /api/v1/agent/chat` → SSE stream (see §8 for event types)
- `GET /api/v1/memory/citation/{node_id}` → provenance + rendered source

### 5.4 Imaging

**Stays:** three-column layout (study list · viewport · findings/agent draft), keyboard-first navigation.

**Changes (M1.6+ Rev-9):**

- **Viewport powered by cornerstone.js + OHIF Viewer components** (U2).
- **Key-image strip below the viewport** showing the slices the ingester picked from the 4×4 grid + any slices the medic explicitly pinned. Each thumbnail has a `📷[N]` overlay matching its CitationChip number in the agent draft column.
- **Right column = agent draft findings**, every finding cited with a `📷[N]` chip pointing to the relevant key-image. Click a chip → viewport jumps to that slice + highlights ROI.
- **"Find similar"** corner action on each thumbnail → opens `VisualSimilarSearchPanel` (M1.5+) showing top-k visually similar key_images from this patient's history. Optional opt-in for cross-patient search ("my corpus").
- **"Compare with prior"** when a follow-up edge exists → opens `StudyComparePanel` (M2+) — synchronised dual viewport with linked scroll + auto-highlight of `same_finding` ROIs.
- **MONAI Label hook:** medic-drawn ROIs / annotations on the viewport are captured by the OHIF Label bridge → POST to `/api/v1/monai_label/correction` → backend emits `medic_correction` event. This is the medic-in-the-loop training signal. UI feedback: a small "✓ saved to memory" toast after each annotation persists.

**Components needed:** `OhifViewport`, `KeyImageStrip`, `KeyImageThumbnail`, `VisualSimilarSearchPanel`, `StudyComparePanel`, `useOhifMonaiLabelBridge` hook.

**API:**
- `GET /api/v1/memory/study/{study_uid}/key_images` → list of `{image_sha256, slice_no, sop_instance_uid, thumb_url}`
- `GET /api/v1/memory/keyimage/{sha256}` → PNG binary (redacted)
- `POST /api/v1/memory/search_image_similar` → `{hits: [{image_sha256, score}]}`
- `POST /api/v1/monai_label/correction` → emits `medic_correction` event

### 5.5 Labs

**Stays:** trend grid, sparklines, reference ranges, current values.

**Changes:**
- Data comes from Layer 1 `lab` and `episodic_event` nodes filtered by node_type.
- Nexus note section is a Layer 1 cached view, regenerated on `lab` node mutations.
- Trend ranges (3mo / 6mo / 1y) are URL params: `nexus://patient/{hash}/labs?range=6mo`.

**API:**
- `GET /api/v1/memory/patient/{hash}/labs?range=6mo` → array of lab nodes with values + ref ranges
- `GET /api/v1/memory/views/lab_trends_{range}/{hash}` → cached view

### 5.6 Memory — the biggest expansion

v1 sketched this mode as "graph projection + conflict resolution UI". v2 makes it concrete:

```
Memory · Patient 7a3f…
─────────────────────────────────────────

▼ Active findings (4)
  • Left renal mass 2.4 cm      [⚠ growing]      [→ MR pending]
    Evidence: 3 CTs · last seen Jun 10
    [📷 view sources]   [edit]   [retract]

  • Hypertension                [controlled]
    Evidence: 5 chat encounters · on lisinopril
    [edit]   [retract]

  • ...

▼ Medications (2)               [+ add]
  • Lisinopril 10 mg daily      since 2026-01-04
  • Atorvastatin 20 mg daily    since 2026-01-04

▼ Differential candidates (1)
  • RCC                         leading
    Evidence: discussed in chat 04-02 [📷 review]

▼ Allergies / contraindications (1)
  • Iodine contrast — mild reaction 2024

▼ Open threads / plan
  • MR with contrast — discussed 04-02, not scheduled

─────────────────────────────────────────

⚠ 1 unresolved conflict

┌────────────────────────────────────────────────────┐
│ Left renal mass — size                             │
│                                                    │
│ Ⓐ 2.4 cm   from CT Jun 10  [latest]  weight 4    │
│   📷 [thumbnail]                                   │
│   Evidence: "left renal mass measures 2.4 cm…"     │
│                                                    │
│ Ⓑ 2.1 cm   from CT Feb 14  [older]   weight 2    │
│   📷 [thumbnail]                                   │
│   Evidence: "left renal mass measured 2.1 cm…"     │
│                                                    │
│ Nexus auto-resolved using recency axis → Ⓐ.       │
│ Override?                                          │
│      [keep Ⓐ]  [pick Ⓑ]  [both are wrong]        │
└────────────────────────────────────────────────────┘

─────────────────────────────────────────

Audit
   3 mutations in the past 24h · last by Nexus 8h ago
   [open audit log →]
```

**Key behaviours:**

- Every section is a deterministic projection of Layer 1 graph state.
- `[edit]` opens a small inline editor that emits a `finding_edited_by_medic` event. The before/after state is in the event payload; replay reproduces.
- `[retract]` emits `node_retracted` with a reason. The node stays in the graph; provenance gets `retracted_at` stamped. UI shows retracted items in a separate "Retracted" expander (audit-friendly).
- `[📷 view sources]` opens the right rail showing every key_image and chat source backing this finding — the full provenance set.
- Conflict resolution buttons emit `conflict_resolved` events. The losing side gets `superseded_by` stamped via the existing handler. Yellow badge clears once all conflicts on the patient are resolved.
- `[open audit log →]` opens a full-screen audit view over `twin_event_log` for this patient.

**Components needed:** `FindingRow`, `MedicationRow`, `DdxRow`, `ConflictResolutionDialog`, `RetractFindingDialog`, `EditFindingInlineForm`, `AuditLogView`.

**API:**
- `GET /api/v1/memory/patient/{hash}/projection` → full Layer 1 state
- `GET /api/v1/memory/patient/{hash}/conflicts` → unresolved conflicts
- `POST /api/v1/memory/conflicts/{id}/resolve` → emit conflict_resolved
- `POST /api/v1/memory/node/{id}/edit` → emit finding_edited_by_medic
- `POST /api/v1/memory/node/{id}/retract` → emit node_retracted
- `GET /api/v1/memory/audit/{patient_hash}?limit=...` → event_log subset

### 5.7 Report

**Stays:** structured impression draft, pre-filled, edit-then-export, PDF/FHIR/DICOM-SR targets.

**Changes:**
- Impression auto-fills from active findings + the medic's Layer 2 `style/impression_template` if confirmed. So "Recommend correlation with prior imaging" appears automatically for an uncertain finding when that's this medic's confirmed style.
- Every section has a `[from memory]` chip you can click to see what graph nodes feed it.
- Export emits `export_bundle_created` (PDF/FHIR) and `impression_edited` (if the medic modified the auto-draft).

**API:**
- `GET /api/v1/report/{study_uid}/draft` → pre-filled impression draft
- `POST /api/v1/report/{study_uid}/export` → returns bundle URL (PDF/FHIR/DICOM-SR)

### 5.8 Settings · Data (preserved from v1 §6.7a)

No change from v1. Full design lives in v1 §6.7a — the cards (Automatic backups · Cloud sync · Export · Restore), the ExportWizardDialog with PHI attestation, the RestoreConfirmDialog with destructive-action confirmation, the literal Contract A text at the bottom. Ships in U3 alongside backend D1/D2.

---

## 6. The two new top-level surfaces

### 6.1 "Nexus has learned" — Practitioner Memory panel

**Trigger:** badge dot on the AccountMenu avatar when `practitioner_candidates_pending > 0`. Click avatar → menu shows "Nexus has learned (3)" → opens the full-screen overlay.

**Layout:** full-screen above canvas, dismissible via `Esc` or the X.

```
   Nexus has learned                                3 candidates  ✕
   ────────────────────────────────────────────────────────────────

   These are patterns Nexus has noticed in your cases. Confirm the
   ones you want Nexus to start using; reject the rest. You can
   always change your mind.

   ────────────────────────────────────────────────────────────────

   ▸ PRACTICE      observed in 8 of 10 cases · 5 patients · 4 weeks
     You usually order MR before biopsy for renal masses < 3 cm
     rated BI-RADS 4.

     [✓ confirm]    [✕ reject]    [ask me later]    [see cases →]

   ────────────────────────────────────────────────────────────────

   ▸ STYLE         observed in 12 of 14 reports · 8 patients · 6 wk
     Your impressions end with "Recommend correlation with prior
     imaging" when the finding is uncertain.

     [✓ confirm]    [✕ reject]    [ask me later]    [see cases →]

   ────────────────────────────────────────────────────────────────

   ▸ CALIBRATION   12 of 12 sessions · 9 patients · 6 weeks
     You consistently reject the suggestion 'recommend biopsy'
     for findings < 2 cm.

     [✓ confirm]    [✕ reject]    [ask me later]    [see cases →]

   ────────────────────────────────────────────────────────────────

   Active patterns (12)                                  [view all]
```

**Interaction:**

- `[✓ confirm]` emits `practitioner_fact_confirmed`. Pattern becomes active in the composer for next agent turn onward.
- `[✕ reject]` emits `practitioner_fact_rejected`. Pattern's `pattern_key` is permanently buried — never resurfaces.
- `[ask me later]` no-op; pattern re-evaluates when `distinct_patient_count` grows.
- `[see cases →]` opens a side drawer (visible only to the medic) listing the patient_hashes from `practitioner_observations` that triggered this candidate. **This drawer is the medic's own audit trail; never shown across users.** Per case shown: the encounter id + the verbatim evidence_quote.
- `[view all]` → second view showing all active confirmed patterns; each has a `[retract]` button that re-flips `medic_confirmed_at` to null + emits a new `practitioner_fact_rejected`.

**Privacy invariants enforced on this surface:**

- The "see cases" drawer queries `practitioner_observations` per-user; the API endpoint always asserts `user_id` in WHERE.
- Confirmed patterns never show the patient_hash list — only counts.
- No "see other medics' patterns" affordance exists. Cross-medic is Layer 4 deferred.

**Components needed:** `PractitionerHasLearnedView`, `PractitionerCandidateCard`, `PractitionerCasesDrawer`, `PractitionerActivePatternsList`.

**API:**
- `GET /api/v1/memory/practitioner/candidates` → list of unconfirmed candidates
- `GET /api/v1/memory/practitioner/active` → list of confirmed-active patterns
- `GET /api/v1/memory/practitioner/observations?fact_kind=&pattern_key=` → cases backing one candidate (per-medic audit)
- `POST /api/v1/memory/practitioner/{kind}/{key}/confirm`
- `POST /api/v1/memory/practitioner/{kind}/{key}/reject`

### 6.2 Time travel (M5+ advanced; can ship later)

Less prominent than Practitioner panel — surfaces via a date selector in the global header when the medic explicitly toggles "time travel" in Account menu.

```
   Nexus · viewing as of   Apr 12, 2026 ⇄ now      [exit time travel]
   ──────────────────────────────────────────────────────────────────

   [main canvas renders state as of that date]
```

Implementation: every read endpoint accepts `?as_of_event_idx=N`. Backend does `replay(to_event_idx=N)` against a scratch DB and returns projection state from there. Heavy; only entered explicitly.

Used for medico-legal review ("what did Nexus tell me on this date"), teaching ("how did my thinking on this case evolve"), or self-audit.

**Components needed:** `TimeTravelHeader`, `TimeTravelDateSlider`.

---

## 7. Component vocabulary — additions

v1 had 8 primitives. v2 adds 10+ provenance/memory/imaging-specific ones. Group by concern:

### 7.1 Provenance + citation

- **`CitationChip`** (rewrite of v1) — `[N]` inline reference. Hover reveals `provenance.evidence_quote[:60]` + source kind. Click opens context rail with full source. `📷` badge if the citation has image attachments. Faint multimodal mark when applicable.
- **`ProvenanceCard`** (new) — full provenance display rendered in the right context rail. Shows: source preview (chat snippet / key_image / lab value), evidence_quote verbatim, extraction model + prompt id + version, confidence, redaction status. Has a `[copy reference]` button outputting a canonical citation string.
- **`MarkdownWithCitations`** (new) — markdown renderer that recognises `[study:UID]` / `[chat:event-N]` / `[guideline:slug]` tokens and replaces them with CitationChip. Used in Patient summary, Memory sections, agent answers.

### 7.2 Agent reasoning surface

- **`TierIndicator`** (new) — small status chip near the agent message showing T1/T2/T3 + progress (T3 shows elapsed seconds with a cancel button). Default-off animation; reduces motion for the senior persona.
- **`ReasoningPane`** (new) — collapsible "agent's thinking" panel above each Tier-3 message. Streams reasoning_chunk + search_query + search_results_summary SSE events. Default-folded for senior medics; default-open for residents (preference in Account settings).
- **`StreamedMessage`** (new) — message bubble that updates as final_answer_chunk events arrive. Smooth append, no flicker.

### 7.3 Memory / conflict

- **`FindingRow`** (new) — one row in Memory mode's active findings list. Shows finding label, status badges (growing / controlled / retracted), evidence summary, key-image thumbnails preview, action buttons.
- **`ConflictResolutionDialog`** (new) — Radix Dialog. Shows side-by-side Ⓐ/Ⓑ with thumbnails, evidence quotes, weights. Three primary buttons: keep Ⓐ / pick Ⓑ / both are wrong. Footer explains the axis Nexus tried to auto-resolve on.
- **`ConflictInlineBanner`** (new) — yellow warning that appears in Encounter when an agent answer touches a finding currently in conflict. Click → Memory mode at the conflict.
- **`RetractFindingDialog`** (new) — destructive-action dialog requiring reason. Emits `node_retracted`.
- **`EditFindingInlineForm`** (new) — inline editor for finding content. Diff before/after emitted on save.
- **`AuditLogView`** (new) — paginated table over `twin_event_log` filtered by patient_hash. Shows event kind / ts / payload preview / caused_by link. JSON-toggle for raw view.

### 7.4 Practitioner Memory

- **`PractitionerCandidateCard`** (new) — one row in "Nexus has learned" view. Confirm/reject/later buttons + "see cases" drawer trigger.
- **`PractitionerCasesDrawer`** (new) — side drawer listing patient_hashes + evidence_quotes feeding a candidate. Per-medic audit only.
- **`PractitionerActivePatternsList`** (new) — confirmed-active patterns with `[retract]` action.

### 7.5 Imaging (M1.5+/M2+)

- **`OhifViewport`** (new) — wraps cornerstone.js / OHIF viewer; binds to a key_image set.
- **`KeyImageThumbnail`** (new) — small image with `📷[N]` overlay + click-to-jump + "find similar" corner action.
- **`KeyImageStrip`** (new) — horizontal strip below viewport showing all key_images from current study.
- **`VisualSimilarSearchPanel`** (new, M1.5+) — overlay panel showing top-k visually similar key_images with scope toggle (this patient / my corpus).
- **`StudyComparePanel`** (new, M2+) — dual synchronised viewports with linked scroll + auto-highlight of `same_finding` ROIs.

### 7.6 Time travel (M5+)

- **`TimeTravelHeader`** — replaces global header chrome when active.
- **`TimeTravelDateSlider`** — date picker + replay progress indicator.

Total new components: ~22. They compose from the v1 primitives plus a small set of new building blocks (Drawer, Slider).

---

## 8. API contract — frontend ↔ backend

The complete endpoint map for U1–U4. Every endpoint goes through the existing FastAPI router; auth by JWT bearer.

### 8.1 REST endpoints

**Auth (existing, no change):**
- `POST /api/v1/auth/login` → `{access_token}`

**Patient list (existing, extending):**
- `GET /api/v1/dicom/patients` → list (existing)
- `POST /api/v1/patients` → new patient (existing; emits `patient_registered`)

**Layer 1 projection reads:**
- `GET /api/v1/memory/patient/{hash}/summary`
- `GET /api/v1/memory/patient/{hash}/projection` — full state
- `GET /api/v1/memory/patient/{hash}/findings?status={active|retracted}`
- `GET /api/v1/memory/patient/{hash}/medications`
- `GET /api/v1/memory/patient/{hash}/labs?range={3mo|6mo|1y}`
- `GET /api/v1/memory/patient/{hash}/timeline?limit=N`
- `GET /api/v1/memory/patient/{hash}/conflicts`
- `GET /api/v1/memory/views/{view_kind}/{hash}` — generic cached view
- `GET /api/v1/memory/views/daily_briefing` — per-medic, cross-patient

**Provenance / citation drill-down:**
- `GET /api/v1/memory/citation/{node_id}` → provenance row + rendered source
- `GET /api/v1/memory/study/{study_uid}/key_images`
- `GET /api/v1/memory/keyimage/{sha256}` → redacted PNG binary

**Memory mutations (all emit events):**
- `POST /api/v1/memory/node/{id}/edit` → emits `finding_edited_by_medic`
- `POST /api/v1/memory/node/{id}/retract` → emits `node_retracted`
- `POST /api/v1/memory/conflicts/{id}/resolve` → emits `conflict_resolved`

**Layer 2 practitioner:**
- `GET /api/v1/memory/practitioner/candidates`
- `GET /api/v1/memory/practitioner/active`
- `GET /api/v1/memory/practitioner/observations?fact_kind=&pattern_key=`
- `POST /api/v1/memory/practitioner/{kind}/{key}/confirm`
- `POST /api/v1/memory/practitioner/{kind}/{key}/reject`
- `GET /api/v1/memory/practitioner/pending_count` — for badge

**Imaging (M1.5+/M2+):**
- `POST /api/v1/memory/search_image_similar`
- `POST /api/v1/monai_label/correction` — OHIF→backend medic_correction

**Persistence (U3 / D1/D2):**
- `GET /api/v1/data/backup-status`
- `POST /api/v1/data/snapshots/list`
- `POST /api/v1/data/snapshots/{id}/restore`
- `POST /api/v1/data/export` → returns export job id
- `GET /api/v1/data/export/{job_id}` → status + bundle URL when ready
- `POST /api/v1/data/import` → multipart upload of bundle

**Time travel (M5+):**
- All reads above accept `?as_of_event_idx=N` query param.
- `GET /api/v1/memory/event-log/{event_idx}` — fetch one event row

### 8.2 Streaming chat — SSE event types

`POST /api/v1/agent/chat` accepts `{patient_hash, text}` and returns an SSE stream. Event types the frontend must handle:

```typescript
type ChatStreamChunk =
  | { type: 'turn_started', event_idx: number, patient_hash: string }
  | { type: 'tier_classified', tier: 'T1' | 'T2' | 'T3', view_kind?: string }
  | { type: 'reasoning_chunk', text: string }                   // T3 only
  | { type: 'search_query', tool: string, query: string }       // T3 only
  | { type: 'search_results_summary', count: number, preview: string }
  | { type: 'image_attached', image_sha256s: string[] }         // M1.6+
  | { type: 'final_answer_chunk', text: string }
  | { type: 'citations', refs: CitationRef[] }                  // appended after answer
  | { type: 'conflict_in_answer', conflict_id: string, finding_label: string }
  | { type: 'turn_complete', assistant_event_idx: number }
  | { type: 'error', message: string }
```

`final_answer_chunk` arrives token-by-token for the streamed bubble; `citations` arrives once at the end with the full reference list (so chips can attach to the right offsets in the text).

### 8.3 Push channel (long-poll / WS, M3+)

Some events benefit from being pushed to all open clients of a user (badge updates, conflict surfacing):

```
GET /api/v1/agent/push   (WebSocket or SSE)
```

Pushed event types:
- `memory_conflict_surfaced` → sidebar shows yellow dot
- `practitioner_candidate_surfaced` → avatar shows pending dot
- `quick_scan_complete` → patient row blinks unread

---

## 9. Frontend state evolution

The Zustand store grows from U0's auth+layout+dialogs to include:

```typescript
interface AppState {
  // ... existing (token, theme, sidebar, etc.) ...

  // NEW — memory + provenance
  activePatientProjection: PatientProjection | null;
  loadingProjection: boolean;
  fetchPatientProjection: (hash: string) => Promise<void>;

  // NEW — chat streaming
  activeChatStream: ChatStreamState | null;
  startChatStream: (text: string) => Promise<void>;
  cancelChatStream: () => void;

  // NEW — citation drill-down
  contextRailContent:
    | { kind: 'closed' }
    | { kind: 'citation', nodeId: number }
    | { kind: 'image', sha256: string }
    | { kind: 'chat_snippet', eventIdx: number };

  // NEW — conflicts
  conflicts: Record<string, MemoryConflict[]>;  // by patient_hash
  resolveConflict: (id: string, decision: ResolveDecision) => Promise<void>;

  // NEW — practitioner panel
  practitionerCandidates: PractitionerCandidate[];
  practitionerActiveCount: number;
  practitionerPendingCount: number;
  refreshPractitioner: () => Promise<void>;
  confirmPractitionerFact: (kind: string, key: string) => Promise<void>;
  rejectPractitionerFact: (kind: string, key: string, reason?: string) => Promise<void>;

  // NEW — time travel
  timeTravel: { active: boolean; asOfEventIdx: number | null };
  enterTimeTravel: (idx: number) => void;
  exitTimeTravel: () => void;
}
```

Persistence keys for new state: `nexus.timeTravel`, `nexus.reasoningPaneDefault` (user preference).

---

## 10. URL routing — deep linking

Tauri WebView accepts `nexus://` protocol URLs. The shell maps them to state:

```
nexus://today
nexus://patient/<hash>                       → Patient mode
nexus://patient/<hash>/encounter             → Encounter (newest open)
nexus://patient/<hash>/encounter/<event_idx> → specific encounter
nexus://patient/<hash>/imaging?study=<uid>   → Imaging mode + open study
nexus://patient/<hash>/labs?range=6mo
nexus://patient/<hash>/memory                → Memory mode
nexus://patient/<hash>/memory/conflict/<id>  → focus conflict
nexus://patient/<hash>/report/<study_uid>
nexus://practitioner                         → "Nexus has learned"
nexus://settings/data
nexus://timetravel/<event_idx>               → enter time travel at idx
```

Back/forward in the global header uses this URL history. Each navigation pushes to a Zustand history slice; ⌘← and ⌘→ traverse.

`⌘K` palette can suggest URLs as one autocomplete category.

---

## 11. Phased delivery — aligned with backend M phases

| Phase | Frontend scope | Backend prerequisite | Weeks |
|---|---|---|---|
| **U0** | scaffold (done) | — | 1 |
| **U1.1** | Real ApiClient + provenance types + Today/Patient/Encounter projection wiring | M0 ✓ shipped | 4 days |
| **U1.2** | Streaming chat + TierIndicator + ReasoningPane + CitationChip 2.0 + ProvenanceCard + ConflictInlineBanner | M0 ✓ + chat-ingester wired | 1 week |
| **U2** | Imaging mode (basic — OHIF Viewer + KeyImageStrip, no visual similar yet) | M1 DICOM ingester | 1.5 weeks |
| **U3.1** | Memory mode full UI (FindingRow / ConflictResolutionDialog / EditFindingInlineForm / RetractFindingDialog / AuditLogView) | M3 four-axis conflicts | 1 week |
| **U3.2** | "Nexus has learned" view (PractitionerHasLearnedView / CandidateCard / CasesDrawer) | M7 distiller + composer | 4 days |
| **U3.3** | Settings → Data (backup status / export wizard / restore dialog) | D1/D2 persistence | 1 week |
| **U3.4** | Labs + Report modes | M5 lab ingester | 4 days |
| **U4** | Cutover (Avalonia retired, signed installer, notarisation) | M5 ✓ | 0.5 week |
| **U5+** | Imaging Rev-9 (VisualSimilarSearchPanel + StudyComparePanel + KeyImage thumbnails on citations + MONAI Label hook) | M1.5/M1.6/M1.7 | 1 week |
| **U6+** | Time travel | optional M5+ | 1 week |

Total to U4 cutover: ~6.5 dev-weeks for solo dev (after U0). Aligned with backend M0–M9 timing (~13.5 weeks); frontend ships ~7 weeks behind earliest possible backend ship because UI integrates many backend deliverables per phase.

---

## 12. Open questions

1. **Streaming chat protocol** — SSE vs WebSocket. SSE simpler, server-pushed only. WebSocket bi-directional (cancellation). Resolution: SSE for chat (one-way); WebSocket for push channel (§8.3). Decide in U1.2.

2. **Reasoning pane default** — fold or open. Senior medics want folded; residents want open. Account preference; default = folded.

3. **Time travel scope** — does time travel affect ALL modes or just Memory? Probably all, but Imaging needs care (key_image files at past dates must still exist). Resolve when M5 lands.

4. **"See cases" drawer privacy** — if the medic shares their screen, the drawer would expose patient_hashes from prior cases. Mitigation: drawer requires re-auth or a confirmation modal "this drawer contains patient identifiers".

5. **CitationChip behaviour on imaging citations without M1.5** — between M1 ingester ship and M1.5 visual encoder ship, citations point at key_images that have an `image_sha256` but no `embedding_ref_visual`. UI: chip shows thumbnail; "find similar" action is disabled with a tooltip.

6. **Conflict surfacing density** — what if a patient has 8 unresolved conflicts? List them all? Group by entity? Resolution: group by entity, show count badge per entity.

---

## 13. Risks specific to UI/data alignment

**U-R1 — Citation chip overload.** Some Tier-3 answers might cite 10+ sources. Render becomes cluttered.
Mitigation: collapse citations into a `[N citations ▾]` chip when count > 4; expand on click.

**U-R2 — Reasoning pane reveals raw internals.** Some medics will be alarmed by seeing "the LLM searched for X, found Y, decided Z." May undermine trust in the answer.
Mitigation: default folded for non-resident persona; account preference; tone the streamed text plainly.

**U-R3 — Conflict UI surfacing too aggressively.** Yellow badges everywhere cause alarm fatigue.
Mitigation: per Rev-3 + memory-design R11 (existing), conflict thresholds tuned; per-patient max-3 surfaced; auto-resolved-with-low-confidence flagged grey rather than yellow.

**U-R4 — Provenance card load time.** First click on a citation chip triggers an API call; if slow, the medic loses trust.
Mitigation: pre-fetch provenance for all citations rendered in the current viewport; subsequent clicks are instant.

**U-R5 — Streaming chat cancellation race.** Medic types follow-up before agent finishes streaming.
Mitigation: explicit cancel button on the streaming bubble; cancel emits a `turn_cancelled` event that the backend respects mid-loop.

**U-R6 — Time travel data freshness.** Medic enters time travel, makes a mental note, exits — but the projection at "now" has moved on. Confusing if not clearly indicated.
Mitigation: massive header banner during time travel, irreversible "Exit time travel" button, and on exit, a small toast "back to current state — 3 new events since you entered".

**U-R7 — OHIF Viewer license / packaging.** OHIF is MIT but bundles heavy deps; Tauri WebView may need adjustments to load cornerstone.js + WebGL contexts efficiently.
Mitigation: M2 spike (already on the backend phasing) validates packaging; spec says we adopt OHIF Viewer components, not the whole OHIF app shell.

---

## 14. Decision log

| Question | Decision | Why |
|---|---|---|
| Supersede v1 or amend? | New v2 file; v1 stays in git | v1 was pre-backend; rewrite cleaner |
| Memory mode aspirational or concrete? | Concrete in v2 | Backend now provides actual projections to render |
| Practitioner panel: mode or overlay? | Overlay, cross-cutting | Cross-patient by construction; not anchored to a single patient |
| Citation chip behaviour? | Hover preview + click rail | Two-level disclosure: glanceable + drillable |
| Reasoning pane default? | Folded for senior, open for resident | Account preference; respect senior persona's "show me the answer not the math" |
| SSE vs WebSocket for chat? | SSE | One-way streaming fits chat shape; WebSocket reserved for push channel |
| Time travel — first-class or hidden? | Hidden behind explicit toggle | Heavy + niche; don't clutter common path |
| New API endpoint count? | ~30 | Significant but each is thin (most are projection reads) |
| Citation pre-fetch? | Pre-fetch provenance for visible citations | Latency budget for hover preview |
| Practitioner "see cases" auth? | Re-confirmation modal | PHI surfaces only with explicit click + confirmation |
| Tier indicator placement? | Inline above agent message | Discoverable; doesn't distract |
| Imaging thumbnails on citation chips? | M1.6+ only | Backend prerequisite |
| Conflict UI density? | Group by entity | Avoid surface alarm fatigue |

---

## 15. User flows — annotated mockups

The mode-by-mode descriptions above show what each surface looks like at rest. This section shows what happens **as the medic moves through them** — six flows that cover the high-value journeys. Each frame is a stylised ASCII mockup; the right-hand column lists the backend events / state transitions firing at that step. Together they should let any reader simulate a session in their head.

Conventions used:

- `┌─ Header ─┐` denotes the always-visible global header chrome.
- `[Sidebar]` denotes the patients sidebar; collapsed for brevity in most frames.
- `╔═══╗` blocks call out **what the medic is doing right now** on that frame.
- `⤷ events:` lists `twin_event_log` events that fire as a result.
- `⤷ state:` lists Zustand store transitions.
- `⤷ api:` lists backend HTTP calls.

### 15.1 First sign-in and landing

**Goal:** the medic launches Nexus for the first time and lands on a useful Today screen within ~2 seconds of credentials accepted.

**Frame 1 — LoginView (the first thing they see)**

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                         Nexus                            │
│                 Clinical workflow agent                  │
│                                                          │
│              ╔══════════════════════════════╗            │
│              ║  Email                       ║            │
│              ║  ┌────────────────────────┐  ║            │
│              ║  │ dr.chen@hospital.org   │  ║            │
│              ║  └────────────────────────┘  ║            │
│              ║                              ║            │
│              ║  Password                    ║            │
│              ║  ┌────────────────────────┐  ║            │
│              ║  │ ••••••••••             │  ║            │
│              ║  └────────────────────────┘  ║            │
│              ║                              ║            │
│              ║  ┌────────────────────────┐  ║            │
│              ║  │       Sign in          │  ║  ← submit  │
│              ║  └────────────────────────┘  ║            │
│              ╚══════════════════════════════╝            │
│                                                          │
│  By signing in you agree to use Nexus as decision-       │
│  support only, not as a substitute for clinical          │
│  judgement.                                              │
│                                                          │
└──────────────────────────────────────────────────────────┘

⤷ api:   POST /api/v1/auth/login  → { access_token }
⤷ state: setToken(access_token); store hydrate → bootHydrated=true
⤷ route: nexus://today
```

**Frame 2 — Today (within 800ms of sign-in)**

```
┌─ ◀ ▶  🔍 Search…  ⌘K       Nexus       ⊕ New patient  👤 ─┐
├──────────┬─────────────────────────────────────────────────┤
│ Pinned   │                                                 │
│ today    │             Good morning, Dr. Chen              │
│          │           Saturday · June 13, 2026              │
│ 7a3f…    │                                                 │
│ 9c12…    │  ┌─────────────────────────────────────────┐    │
│ bb04…    │  │ 📋  3 unread findings since you signed  │    │
│ ──────   │  │      off yesterday at 18:42             │    │
│ All      │  │                                          │    │
│ 4d2e…    │  │  • Patient 7a3f…  CT abdomen, BI-RADS   │    │
│ 6ab1…    │  │    upgrade flagged                      │    │
│ ...      │  │  • Patient 9c12…  creatinine trending up│    │
│          │  │  • Patient bb04…  chest pain follow-up  │    │
│          │  │    due                                  │    │
│          │  └─────────────────────────────────────────┘    │
│          │                                                 │
│          │  Pinned today                          [edit]   │
│          │  ─────────────                                  │
│          │  ◯ 7a3f…    M · 60-69    CT                     │
│          │  ◯ 9c12…    F · 45-54    labs                   │
│          │  ◯ bb04…    M · 70-79    chat                   │
│          │                                                 │
│          │  Ask Nexus about any patient                    │
│          │  ┌──────────────────────────────────────────┐   │
│          │  │ Type a question or paste an MRN…         │   │
│          │  └──────────────────────────────────────────┘   │
└──────────┴─────────────────────────────────────────────────┘

⤷ api:   GET /api/v1/memory/views/daily_briefing → markdown
         GET /api/v1/dicom/patients               → pinned/all
⤷ state: patients = [...]; activeMode='today'
```

### 15.2 New study arrives → reviewing it → verifying a citation

**Goal:** a DICOM study uploaded by tech surfaces as an unread finding; the radiologist opens the patient, sees Nexus's Quick-scan triage, drills into the cited slice, and accepts the read.

**Frame 1 — sidebar update (push event)**

```
[Sidebar]
─────────
Pinned today
  ◯ 7a3f…   M · 60-69   CT
  ● 9c12…   F · 45-54   labs   ← blue dot appears (push event)
  ◯ bb04…   M · 70-79   chat

⤷ push event: quick_scan_complete { patient_hash='9c12…' }
⤷ state: patients[9c12…].unreadAgent = true
```

**Frame 2 — patient clicked → Patient mode opens**

```
┌─ Header ─────────────────────────────────────────────────────┐
│  ─── Patient | Encounter | Imaging | Labs | Memory | Report ─│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│           Patient 9c12a4f7e8b0d31a    F · 45-54              │
│                                                              │
│           Summary  ·  generated 2 min ago      [refresh]     │
│                                                              │
│           45-year-old female being followed for a non-       │
│           obstructing renal calculus. Today's labs show      │
│           creatinine 1.4 (baseline 0.9), trending up over    │
│           2 weeks. The most recent CT (Jun 12) flagged a     │
│           new 0.8 cm cortical defect in the upper pole       │
│           of the left kidney, not seen on prior. [1] [2]     │
│                                                              │
│           Sources: lab 8294 [1]    study 1.2.840…9183 [2]    │
│                                                              │
│           ─────────────────────────────────────              │
│                                                              │
│           Timeline                                           │
│            Jun 12 · CT abdomen w/o contrast    [📷 new] →    │
│            Jun 11 · Labs (CMP)                              →│
│            May 28 · Lisinopril dose ↑                       →│
│            ...                                              │
│                                                              │
│           Active concerns       Medications                  │
│            • Renal calculus      • Lisinopril 20 mg ↑       │
│            • HTN                 • Atorvastatin 20 mg       │
│                                                              │
│              [ Open with Nexus → ]                           │
└──────────────────────────────────────────────────────────────┘

⤷ api:   GET /api/v1/memory/patient/9c12…/summary
         GET /api/v1/memory/patient/9c12…/timeline?limit=10
         GET /api/v1/memory/patient/9c12…/findings?status=active
         GET /api/v1/memory/patient/9c12…/medications
```

**Frame 3 — citation [2] hovered (right rail not yet open)**

```
... Summary text ... [2]
                     ╔══════════════════════════════════════╗
                     ║ study 1.2.840…9183 / slice 124  📷  ║
                     ║                                      ║
                     ║ "Upper pole of left kidney — 0.8 cm  ║
                     ║  rounded cortical defect, not seen   ║
                     ║  on prior. Differential includes…"   ║
                     ║                                      ║
                     ║ Gemini-flash@2.5 / quick_scan_v3     ║
                     ║ confidence 0.81 · redacted phi-v2    ║
                     ╚══════════════════════════════════════╝

⤷ state: hovered citation pre-fetched on render to avoid pop-in.
```

**Frame 4 — citation [2] clicked → context rail opens**

```
┌─ Header ────────────────────────────────────────────────────┐
│ Patient | Encounter | Imaging | Labs | Memory | Report      │
├────────────────────────────────────┬────────────────────────┤
│ Patient 9c12…                      │ Context                │
│                                    │ ─────────────          │
│ ... summary continues ...          │                        │
│                                    │ Study 1.2.840…9183     │
│ Sources: [1]   [2]←  ← still       │  CT abdomen, w/o ctrast│
│             highlighted            │  Jun 12, 2026          │
│                                    │                        │
│                                    │  Slice 124 / 412       │
│                                    │  📷 [thumbnail render] │
│                                    │                        │
│                                    │  Evidence quote:       │
│                                    │  "Upper pole of left   │
│                                    │   kidney — 0.8 cm      │
│                                    │   rounded cortical     │
│                                    │   defect, not seen on  │
│                                    │   prior. Differential  │
│                                    │   includes …"          │
│                                    │                        │
│                                    │  Model: gemini-2.5     │
│                                    │   flash via Bundle     │
│                                    │   quick_scan_4x4_grid  │
│                                    │   @ 0.3.0              │
│                                    │  Prompt: quick_scan_   │
│                                    │   triage_v3 @ 3.0.0    │
│                                    │  Confidence: 0.81      │
│                                    │  Redacted: phi-v2      │
│                                    │                        │
│                                    │  [ Open in Imaging → ] │
│                                    │  [ Copy citation ]     │
└────────────────────────────────────┴────────────────────────┘

⤷ api:   GET /api/v1/memory/citation/<node_id>  → provenance + render
⤷ state: contextRailContent = { kind: 'citation', nodeId, image_sha }
```

**Frame 5 — "Open in Imaging" → Imaging mode at the cited slice**

```
┌─ Header ─────────────────────────────────────────────────────────┐
│  Patient | Encounter | [Imaging] | Labs | Memory | Report        │
├─────────────┬────────────────────────────┬───────────────────────┤
│ Studies     │                            │ Findings              │
│             │                            │                       │
│ ● Jun 12    │                            │ 0.8 cm cortical       │
│   CT abd    │       [DICOM slice 124]    │ defect, upper pole    │
│             │                            │ L kidney 📷 [2]       │
│ ○ Apr 03    │       w/o contrast         │                       │
│   CT abd    │       W: 400  L: 40        │ Margins: well-defined │
│             │                            │ Density: hypodense    │
│ ○ Sep 22    │       slice 124 / 412      │                       │
│   CT chest  │                            │ — Nexus draft         │
│             │                            │   [ accept ] [ edit ] │
│             │                            │                       │
│             │                            │ ───────────────       │
│             │                            │ ⌘+P to compare with   │
│             │                            │ prior CT (Apr 03)     │
└─────────────┴────────────────────────────┴───────────────────────┘
  tools: 📏 measure  ⊞ window  ◧ MPR  ▣ compare

╔══════════════════════════════════════════════════════════════════╗
║ Medic clicks [ accept ] on the Nexus draft                       ║
╚══════════════════════════════════════════════════════════════════╝

⤷ api:   POST /api/v1/memory/node/<id>/accept-by-medic
⤷ events: finding_accepted_by_medic { node_id, by_user='dr_chen' }
⤷ state: finding's medic_confirmed flag now true; conflict-resolution
         four-axis treats this as Axis-2 input on any future conflict.
```

### 15.3 Asking the agent → Tier 3 streamed answer

**Goal:** medic asks an open-ended question that needs multi-hop reasoning; sees the agent's progress in real time and ends with a cited, verifiable answer.

**Frame 1 — typing in Encounter**

```
┌─ Header ─────────────────────────────────────────────────────┐
│  Patient | [Encounter] | Imaging | Labs | Memory | Report    │
├──────────────────────────────────────────────────────────────┤
│  Patient 9c12… · CT comparison         [⌘. context]          │
│                                                              │
│  You · 14:08                                                 │
│   compare today's CT to the index from April — what changed │
│   and what would you order next?                             │
│                                                              │
│  ─────────────────────                                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Type a follow-up…                              ⏎     │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘

╔══════════════════════════════════════════════════════════════╗
║ Medic hits Enter                                             ║
╚══════════════════════════════════════════════════════════════╝
```

**Frame 2 — tier classifier picks T3, streaming begins (≤1s in)**

```
You · 14:08
 compare today's CT to the index from April — what changed
 and what would you order next?

Nexus · routing…  T3  ← multi-step reasoning · 1.2s
  ┊
  ┊  ▾ thinking
  ┊    Looking up prior CTs of left kidney for 9c12a4…
  ┊
```

**Frame 3 — mid-stream (~4s in)**

```
Nexus · 8.4s elapsed   [ cancel ]
  ┊
  ┊  ▾ thinking
  ┊    Looking up prior CTs of left kidney for 9c12a4…
  ┊    Found 2 studies: Apr 3, Jun 12.
  ┊    Comparing measurements for finding "left renal
  ┊    cortical defect"…
  ┊    Apr 3: not present
  ┊    Jun 12: 0.8 cm new
  ┊    Searching for guidelines: incidental renal lesion
  ┊    < 1 cm, no prior…
  ┊    Found 1 reference: ACR-AC renal mass incidental
  ┊    @ 2025-11
  ┊
  ┊  Today's CT shows a new 0.8 cm rounded cortical
  ┊  defect in the upper pole of the left kidney that was
  ┊  not present on the April CT [1][2].
```

**Frame 4 — answer complete, citations attached**

```
Nexus · 12.3s · T3 · 4 sources cited
  ┊
  ┊  ▸ thinking  (collapse)
  ┊
  ┊  Today's CT shows a new 0.8 cm rounded cortical
  ┊  defect in the upper pole of the left kidney that was
  ┊  not present on the April CT [1][2]. The differential
  ┊  is broad — small cortical scar, infarct, or
  ┊  incidentally-detected RCC. ACR appropriateness
  ┊  criteria for incidental renal lesions < 1 cm with
  ┊  no prior recommend follow-up CT or MR in 6 months
  ┊  rather than immediate biopsy [3].
  ┊
  ┊  Given the rising creatinine, an MR with low-dose
  ┊  gadolinium would also help characterise the lesion
  ┊  without further contrast nephrotoxicity [4].
  ┊
  ┊  [1] study 1.2.840…9183 slice 124  📷
  ┊  [2] study 1.2.840…6201 slice 118  📷
  ┊  [3] guideline ACR-AC/renal-mass-incidental @ 2025-11
  ┊  [4] lab 8294 (creatinine 1.4, baseline 0.9)

You · ▸                                              [⌘. context]
  ┌──────────────────────────────────────────────────────────┐
  │ Ask anything about this patient…                    ⏎    │
  └──────────────────────────────────────────────────────────┘

⤷ api:    POST /api/v1/agent/chat  → SSE stream
⤷ events: assistant_response { text, model, prompt_id, prompt_version,
                                citations, image_attachments_sha256 }
          image_attached_to_context { parent_event_idx, image_sha256s }
          (no user-visible event; audit-only)
```

### 15.4 Resolving a memory conflict

**Goal:** the same finding has two contradictory measurements from different studies; the medic resolves it and the resolution is recorded.

**Frame 1 — yellow badge appears in sidebar after ingestion**

```
[Sidebar]
Pinned today
  ⚠ 9c12…   F · 45-54   CT   ← yellow status dot
  ◯ 7a3f…   M · 60-69   CT
  ◯ bb04…   M · 70-79   chat

⤷ push event: memory_conflict_surfaced
                { patient_hash='9c12…', finding_label='renal lesion size' }
```

**Frame 2 — medic clicks patient → patient header shows banner**

```
┌─ Patient 9c12… ─────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ⚠ 1 unresolved memory conflict                          │ │
│ │   "Left renal cortical defect — size"                   │ │
│ │   [ resolve in Memory mode → ]                          │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ... rest of Patient overview ...                            │
└─────────────────────────────────────────────────────────────┘

╔══════════════════════════════════════════════════════════════╗
║ Medic clicks "resolve in Memory mode →"                      ║
╚══════════════════════════════════════════════════════════════╝
```

**Frame 3 — Memory mode, conflict panel focused**

```
┌─ Memory · Patient 9c12… ────────────────────────────────────┐
│                                                             │
│   ⚠ 1 unresolved conflict                                   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Left renal cortical defect — size                   │   │
│   │                                                     │   │
│   │ ┌─ Ⓐ ─────────────────┐  ┌─ Ⓑ ─────────────────┐   │   │
│   │ │ 0.8 cm              │  │ 0.6 cm              │   │   │
│   │ │ from CT Jun 12      │  │ from prior CT       │   │   │
│   │ │ [latest, weight 4]  │  │ Apr 03              │   │   │
│   │ │ 📷 [thumbnail]      │  │ [older, weight 2]   │   │   │
│   │ │                     │  │ 📷 [thumbnail]      │   │   │
│   │ │ Evidence:           │  │                     │   │   │
│   │ │ "0.8 cm rounded     │  │ Evidence:           │   │   │
│   │ │  cortical defect"   │  │ "0.6 cm cortical    │   │   │
│   │ │ confidence 0.81     │  │  defect, upper      │   │   │
│   │ │                     │  │  pole left kidney"  │   │   │
│   │ │                     │  │ confidence 0.74     │   │   │
│   │ └─────────────────────┘  └─────────────────────┘   │   │
│   │                                                     │   │
│   │ Nexus auto-resolved on the recency axis → Ⓐ.       │   │
│   │ The two CTs were ~2 months apart; size growth      │   │
│   │ within 90-day threshold is preferred as latest.    │   │
│   │                                                     │   │
│   │   [ keep Ⓐ ]   [ pick Ⓑ ]   [ both are wrong ]    │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘

╔══════════════════════════════════════════════════════════════╗
║ Medic clicks [ keep Ⓐ ] — agreeing with Nexus's auto-pick    ║
╚══════════════════════════════════════════════════════════════╝

⤷ api:    POST /api/v1/memory/conflicts/<id>/resolve
                    { decision: 'keep_a', reason: 'medic agreed' }
⤷ events: conflict_resolved { nodes:[A,B], decision:'prefer_a',
                              axis_used:'recency_with_medic_override',
                              auto_or_medic:'medic' }
⤷ state:  conflicts[9c12…] = [] (badge clears)
⤷ projection: node_provenance[B].superseded_by_node = A
```

### 15.5 Confirming a "Nexus has learned" pattern

**Goal:** Nexus has noticed Dr. Chen's MR-before-biopsy preference for small renal lesions; the medic confirms it as an active practitioner fact.

**Frame 1 — avatar shows pending dot**

```
┌─ Header ─────────────────────── Nexus ──── ⊕ New ─ 👤● ─┐
                                                       │
                                                       ↓
                                            avatar dot appears

⤷ push event: practitioner_candidate_surfaced
                { fact_kind:'practice', distinct_count:5 }
```

**Frame 2 — medic clicks avatar → menu**

```
                                            ┌──────────────────────┐
                                            │ Dr. Chen   signed in │
                                            │ ─────────────────────│
                                            │ ⚙  Settings · Data   │
                                            │ 🎓 Nexus has learned │
                                            │    (3 pending)       │
                                            │ ─────────────────────│
                                            │ 🌗 Dark mode         │
                                            │ ─────────────────────│
                                            │ 🚪 Sign out          │
                                            └──────────────────────┘
```

**Frame 3 — "Nexus has learned" full-screen overlay**

```
┌─────────────────────────────────────────────────────────────────────────┐
│   Nexus has learned                                3 candidates    ✕    │
│   ───────────────────────────────────────────────────────────────────   │
│                                                                         │
│   These are patterns Nexus has noticed in your cases. Confirm the       │
│   ones you want Nexus to start using; reject the rest. You can          │
│   always change your mind later.                                        │
│                                                                         │
│   ───────────────────────────────────────────────────────────────────   │
│                                                                         │
│   ▸ PRACTICE        8 of 10 cases · 5 patients · over 4 weeks           │
│     You usually order MR before biopsy for renal masses < 3 cm          │
│     rated BI-RADS 4.                                                    │
│                                                                         │
│     [✓ confirm]   [✕ reject]   [ask me later]    [see cases →]         │
│                                                                         │
│   ───────────────────────────────────────────────────────────────────   │
│                                                                         │
│   ▸ STYLE          12 of 14 reports · 8 patients · over 6 weeks         │
│     Your impressions end with "Recommend correlation with prior         │
│     imaging" when the finding is uncertain.                             │
│                                                                         │
│     [✓ confirm]   [✕ reject]   [ask me later]    [see cases →]         │
│                                                                         │
│   ───────────────────────────────────────────────────────────────────   │
│                                                                         │
│   ▸ CALIBRATION    12 of 12 sessions · 9 patients · over 6 weeks        │
│     You consistently reject the suggestion 'recommend biopsy' for       │
│     findings < 2 cm.                                                    │
│                                                                         │
│     [✓ confirm]   [✕ reject]   [ask me later]    [see cases →]         │
│                                                                         │
│   ───────────────────────────────────────────────────────────────────   │
│                                                                         │
│   Active patterns (12)                                       [view all] │
└─────────────────────────────────────────────────────────────────────────┘

╔══════════════════════════════════════════════════════════════════════════╗
║ Medic clicks [ see cases → ] on the PRACTICE candidate (to verify       ║
║ before confirming)                                                      ║
╚══════════════════════════════════════════════════════════════════════════╝
```

**Frame 4 — Cases drawer slides in from the right**

```
┌────────────────────────────────────────────────┬───────────────────────┐
│  Nexus has learned                             │ Cases for             │
│  ............................................. │ "MR before biopsy,    │
│                                                │  renal < 3 cm BI-4"   │
│   ▸ PRACTICE  8 of 10 cases · 5 patients      │                       │
│     You usually order MR before biopsy...     │ ⚠ PHI — your audit    │
│                                                │   trail only. Do      │
│     [✓]  [✕]  [later]  [see cases →]          │   not screen-share.   │
│  ............................................. │                       │
│                                                │ ─────────────────     │
│   ▸ STYLE     12 of 14 reports                 │                       │
│     ...                                        │ Patient 7a3f…         │
│                                                │  Encounter 2026-05-02 │
│                                                │  "MR with contrast    │
│                                                │   recommended over    │
│                                                │   biopsy."            │
│                                                │                       │
│                                                │ Patient ba01…         │
│                                                │  Encounter 2026-04-18 │
│                                                │  "Defer biopsy; MR    │
│                                                │   pending."           │
│                                                │                       │
│                                                │ Patient 4d2e…         │
│                                                │  Encounter 2026-04-09 │
│                                                │  "Order MR first."    │
│                                                │                       │
│                                                │ ...                   │
│                                                │ 5 more cases shown    │
│                                                │ in [view all]         │
└────────────────────────────────────────────────┴───────────────────────┘

╔══════════════════════════════════════════════════════════════════════════╗
║ Medic glances at the cases, confirms it's accurate, clicks [✓ confirm]  ║
║ on the candidate                                                        ║
╚══════════════════════════════════════════════════════════════════════════╝

⤷ api:    POST /api/v1/memory/practitioner/practice/<key>/confirm
⤷ events: practitioner_fact_confirmed
            { fact_kind:'practice', pattern_key:'.../next_step',
              by_user:'dr_chen' }
⤷ state:  candidate disappears from pending list
          activeCount += 1
          pending dot on avatar updates (or disappears if count → 0)
⤷ effect: from this turn onward, composer.build() injects this fact
          into every system prompt for dr_chen
```

### 15.6 Time travel — viewing the patient as of a past date (M5+ advanced)

**Goal:** medic wants to see what Nexus knew on April 12, 2026 about this patient — for medico-legal review or self-audit.

**Frame 1 — Account menu → enter time travel**

```
                                            ┌──────────────────────┐
                                            │ Dr. Chen   signed in │
                                            │ ─────────────────────│
                                            │ ⚙  Settings · Data   │
                                            │ 🎓 Nexus has learned │
                                            │ ⏳ Time travel       │
                                            │ ─────────────────────│
                                            │ 🌗 Dark mode         │
                                            │ ─────────────────────│
                                            │ 🚪 Sign out          │
                                            └──────────────────────┘
```

**Frame 2 — date picker overlay**

```
┌─────────────────────────────────────────────────────────────┐
│  Enter time travel                                       ✕  │
│  ───────────────────────────────────                        │
│                                                             │
│  Viewing memory state as of:                                │
│                                                             │
│   ◀ 2026   April            ▶                               │
│   ┌─────────────────────────┐                               │
│   │ Su Mo Tu We Th Fr Sa    │                               │
│   │           1  2  3  4    │                               │
│   │  5  6  7  8  9 10 11    │                               │
│   │ ●12 13 14 15 16 17 18   │ ← selected                    │
│   │ 19 20 21 22 23 24 25    │                               │
│   │ 26 27 28 29 30           │                               │
│   └─────────────────────────┘                               │
│                                                             │
│  All reads will reflect graph state as of this date.        │
│  No writes are allowed in time-travel mode.                 │
│                                                             │
│                              [ cancel ]   [ enter → ]       │
└─────────────────────────────────────────────────────────────┘
```

**Frame 3 — header bar transforms**

```
┌──────────────────────────────────────────────────────────────────┐
│  ⏳ Nexus · viewing as of Apr 12, 2026  ⇄ now    [exit time     │
│                                                   travel]        │
├──────────────────────────────────────────────────────────────────┤
│  Patient | Encounter | Imaging | Labs | Memory | Report          │
│                                                                  │
│  Patient 9c12… (state as of Apr 12, 2026)                        │
│                                                                  │
│  Summary  ·  reconstructed from event_log                        │
│                                                                  │
│  45-year-old female with non-obstructing renal calculus.         │
│  Stable since the index study.                                   │
│  No cortical defect noted at this time.                          │
│                                                                  │
│  Sources: study 1.2.840…6201 [1]                                 │
│                                                                  │
│  ──────────────────────                                          │
│                                                                  │
│  Active findings:                                                │
│    • Renal calculus (stable)                                     │
│                                                                  │
│  (No CT scheduled between Apr 12 and Jun 12 in this view.)       │
│                                                                  │
│  ──────────────────────                                          │
│                                                                  │
│  ⏳ READ-ONLY · this is a historical view                        │
└──────────────────────────────────────────────────────────────────┘

⤷ api:    GET /api/v1/memory/patient/9c12…/summary
                    ?as_of_event_idx=<idx_at_2026-04-12T23:59:59>
⤷ state:  timeTravel.active=true, asOfEventIdx=N
⤷ backend: replay(target=scratch_db, to_event_idx=N) executes
           returns projection state from that scratch DB
```

**Frame 4 — exit time travel (3 events fired meanwhile)**

```
   [ exit time travel ]  ← clicked
       ↓
┌────────────────────────────────────────────────────────────────────┐
│  ✓ Returned to current state                                       │
│  ───────────────────────                                           │
│  3 new events have been recorded for this patient since you        │
│  entered time travel:                                              │
│                                                                    │
│    • finding_accepted_by_medic   (you, 14:08)                      │
│    • conflict_resolved           (you, 14:09)                      │
│    • practitioner_fact_confirmed (you, 14:12)                      │
│                                                                    │
│                                            [ continue ]            │
└────────────────────────────────────────────────────────────────────┘
```

### 15.7 Exporting a sovereign data bundle (D2)

**Goal:** medic wants to take all their data with them — Contract A in action.

**Frame 1 — Settings → Data → Export now**

```
   ▾ Export all my data

   ┌─────────────────────────────────────────────┐
   │ Last full export    never                   │
   │ Estimated size      2.1 GB                  │
   │ Includes            7 patients              │
   │                     4 months of practitioner│
   │                       memory                │
   │                     complete event log      │
   │                     all prompts + configs   │
   │                                              │
   │ [ Export now… ]   [ Schedule monthly… ]     │
   └─────────────────────────────────────────────┘
```

**Frame 2 — wizard step 1 — scope**

```
┌─ Export wizard  ─────────────────────────────────────────────────┐
│                                                          1 / 3   │
│  What to include                                                 │
│  ────────────────                                                │
│                                                                  │
│  ◉ Everything (recommended for migration / vendor exit)          │
│                                                                  │
│  ◯ Selected patients only:                                       │
│      ☐ 7a3f…   ☐ 9c12…   ☐ bb04…   ☐ 4d2e…                       │
│                                                                  │
│  ◯ Time range only:                                              │
│      from [ 2026-01-01 ]  to [ 2026-06-13 ]                      │
│                                                                  │
│                                          [ cancel ]   [ next → ] │
└──────────────────────────────────────────────────────────────────┘
```

**Frame 3 — wizard step 2 — PHI attestation + encryption choice (the safety gate)**

```
┌─ Export wizard  ─────────────────────────────────────────────────┐
│                                                          2 / 3   │
│  PHI in transit                                                  │
│  ────────────────                                                │
│                                                                  │
│  ⚠ The export includes PROTECTED HEALTH INFORMATION (PHI):       │
│                                                                  │
│      • All patient hashes, demographics, findings, measurements  │
│      • Original DICOM files (redacted at burn-in level)          │
│      • Chat transcripts (verbatim)                               │
│      • Practitioner observations (your own audit, contains       │
│        patient_hash references)                                  │
│                                                                  │
│  Choose encryption:                                              │
│                                                                  │
│   ◉ age-encrypt with my macOS Keychain key   (recommended)       │
│       — only your own machine can read it                        │
│       — safe to share via cloud sync                             │
│                                                                  │
│   ◯ no encryption                                                │
│       — anyone with the file can read PHI                        │
│       — only choose this for offline-disk archival or migration  │
│         under your direct control                                │
│                                                                  │
│   ☑ I confirm I understand the PHI implications and accept       │
│      responsibility for safe handling.                           │
│                                                                  │
│                              [ ← back ]   [ next → ]             │
└──────────────────────────────────────────────────────────────────┘
```

**Frame 4 — wizard step 3 — destination**

```
┌─ Export wizard  ─────────────────────────────────────────────────┐
│                                                          3 / 3   │
│  Save to                                                         │
│  ────────                                                        │
│                                                                  │
│  ◉ ~/Documents/Nexus Archive/exports/                            │
│  ◯ pick a folder…                                                │
│  ◯ attach to a message in this app                               │
│  ◯ upload to my configured cloud sync (iCloud Drive)             │
│                                                                  │
│  Filename: nexus-export-2026-06-13-dr-chen.tar.zst.age           │
│                                                                  │
│                              [ ← back ]   [ start export ]       │
└──────────────────────────────────────────────────────────────────┘
```

**Frame 5 — progress + completion**

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│       Exporting…  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░  68%                    │
│                                                                  │
│       Wrote 7 patient graphs.                                    │
│       Wrote event log (148,302 events).                          │
│       Bundling DICOM files…                                      │
│       Estimated time remaining: 42 seconds                       │
│                                                                  │
│                                              [ cancel ]          │
└──────────────────────────────────────────────────────────────────┘

   ↓ (after ~1 minute)

┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   ✓ Export complete                                              │
│                                                                  │
│   Bundle:                                                        │
│     ~/Documents/Nexus Archive/exports/                           │
│     nexus-export-2026-06-13-dr-chen.tar.zst.age                  │
│                                                                  │
│   Size: 2.08 GB                                                  │
│   Checksum: sha256:a37f9c8d…                                     │
│                                                                  │
│   This bundle is self-contained. You can read it with any        │
│   standard tool — no Nexus code required. See the bundle's       │
│   README.md for the format documentation.                        │
│                                                                  │
│   [ open in Finder ]   [ verify checksum ]   [ done ]            │
└──────────────────────────────────────────────────────────────────┘

⤷ events: export_bundle_created { destination, included_event_count,
                                    includes_phi, bundle_sha256 }
```

---

## 16. References

- ADR-002 (Rev-1..Rev-9) — `docs/adr/ADR-002-m3-memory-merge.md`
- Memory architecture v3 — `docs/design/m3-memory-architecture.md`
- v1 UX redesign (superseded) — `docs/design/nexus-ux-redesign.md`
- Tauri 2.0 docs — <https://v2.tauri.app>
- OHIF Viewer — <https://ohif.org>
- Cornerstone.js — <https://www.cornerstonejs.org>
- Radix UI — <https://www.radix-ui.com>
- BiomedCLIP (Rev-9 / Layer A) — <https://huggingface.co/microsoft/BiomedCLIP-PubMedBERT_256-vit_base_patch16_224>
- #195 M0 (memory foundation) — completed
- #197 / #200 — desktop-v2 U0 scaffold (current shipped frontend)
- #204 — this design doc
