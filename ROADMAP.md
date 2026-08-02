# Roadmap

What's next, in approximate order. Items in **Now** are actively being
worked on; **Next** is queued; **Later** is shape-known but not
prioritised.

## Now

### Reorg Phase A — docs resync

- Phase A1 — initial docs pass (Phase A description, ASCII diagrams).
  **Done** (earlier commits).
- Phase A2 — resync with desktop-v2 + clinical pivot (M0..M4, DICOM,
  MONAI, event-sourcing graph, research workspace). **Done in this
  cycle**: ARCHITECTURE.md rewritten; README five-minute tour + repo
  layout updated; DEPLOY.md desktop section pointed at desktop-v2.

### Reorg Phase B — delete dead code

- **Done**: removed `packages/desktop` (legacy Avalonia client); git
  tag `legacy/avalonia-final` preserves the last commit.
- **Done earlier**: `nexus_server/sync_hub.py` + `/sync/push` `/sync/pull`
  endpoints retired; `nexus_server/memory_service.py` placeholder
  removed (ImportError tombstone in earlier phase).
- **Open**: the legacy `sync_events` mirror writes — `/agent/*`
  endpoints read from the twin's own EventLog; the mirror is no longer
  consulted on the read path, but the table is still being written.

### Reorg Phase C — server internal grouping

Reorganise `nexus_server/*.py` flat layout into domain folders:
`auth/`, `twins/`, `chat/`, `views/`. Each with a one-page
README. Tests split by domain too.

## Next

### Chat context budget & auto-compaction

Design: [`docs/design/CHAT_CONTEXT_COMPACTION.md`](docs/design/CHAT_CONTEXT_COMPACTION.md).

Token-budgeted conversation history with automatic compression:

- **C.1** real token estimation (`estimateTokens` BPE-style) +
  `MODEL_CONTEXT_WINDOW`-relative budgets
- **C.2** auto-compact agent — structured clinical summary of older
  turns, async + idempotent, persisted as episodes
- **C.3** `compact_summary` injection into `buildHistoryMessages` +
  pinned-message preservation; dedupe projection layer1 vs raw history
- **C.4** `search_conversation` tool (semantic retrieval of older turns)
- **C.5** `context_usage` SSE chunk + frontend usage gauge
- **C.6** admin compaction events page + pin UI

### Phase P — Recursive Projection (RLM-style chat context)

Detailed design lives in
[`docs/design/nexus-architecture.md`](docs/design/nexus-architecture.md).

Replace the single-call chat projection with a Recursive Language
Model: load the EventLog as a REPL variable, let the root LLM write
code to slice / sub-LM-call / stitch. Inspired by Zhang, Kraska &
Khattab, *Recursive Language Models* (arXiv:2512.24601, Dec 2025),
which proved this pattern handles inputs ~2 orders of magnitude
beyond the base model's context window at the same or lower cost per
query.

Sub-phases (~3 weeks total):

- **P.1** `project_for_chat()` using `RLMRunner`; feature-flagged
  side-by-side dogfooding (1 wk)
- **P.2** verdict scorer built on `RLMRunner` for long observation
  windows (3 days)
- **P.3** Attachment-by-reference — drop upfront distillation,
  use RLM at chat time (1 wk, deferrable, gated on cost analysis)
- **P.4** Operator monitoring — RLM iterations / sub-calls /
  truncated runs metrics + alerts (3 days)

**Risks** (all with mitigations in design doc): cost variance
from long-tail runs (capped via `RLMConfig` budgets + per-day
ceiling); quality regression on short queries (fast-path: skip
RLM if EventLog < threshold); sub-LM hallucination (caught by
contract checks on final output).

## Later

### Planning support — the missing capability

Today the agent reacts. It doesn't plan. Add:

- `nexus_core.planning` — `Plan` / `PlanStep` data model,
  `EventLogPlanStore` (plans are events in the event log).
- `nexus.planning` — `Planner` (LLM decompose / re-plan) +
  `PlanExecutor` (run steps via tools, persist progress).
- `twin.chat` integration: detect planning intent → decompose →
  return "I've broken this into N steps" + run in background.
- `/agent/plans` server endpoint + desktop Plans panel.

### OpenAPI-driven view types

Server's view types (`ChatMessageView`, `MemoryEntry`,
`AgentStateSnapshot`, `FileUploadResponse`, …) are duplicated in the
desktop's C# code. Hand-maintained. When server adds a field, desktop
silently doesn't see it.

Generate C# DTO from server OpenAPI schema (via
`datamodel-code-generator` or similar). Keeps types in lockstep, no
silent drift.

### Test taxonomy cleanup

`test_server_regression.py` is 65 tests in one file (>2000 lines).
Split by domain matching the Phase C server reorg:
`test_auth.py`, `test_twins.py`, `test_chat.py`,
`test_views.py`. Plus `tests/integration/` for end-to-end SDK + Nexus
+ Server.

## Done (selected)

See [`HISTORY.md`](HISTORY.md) for the full chronology. Highlights:

- **S1–S6** — server-side cleanup. Each step retired a piece of the
  server's parallel intelligence layer in favour of routing through
  Nexus's `DigitalTwin`. The result: server is a pure HTTP frontend,
  Nexus is the single agent runtime.
- **Round 2-A/B/C** — desktop became a thin client. Deleted
  `LocalEventLog`, `RuneEngine`, JWT decoder for user-id scoping, the
  per-user data directory, the `_build_system_prompt` /
  `_build_context_messages` logic. `MainViewModel` is ~140 lines
  total now.
- **Bug 1/2/3** — post-S6 stability fixes around bucket auto-create
  and UI visibility into sync failures.
- **Distiller move to SDK** — `attachment_distiller`'s reusable
  pipeline lives in `nexus_core.distiller`; server keeps a thin shim
  for the `record_distilled_event` persistence half.
