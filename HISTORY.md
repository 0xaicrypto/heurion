# History

The codebase has a refactor history that's referenced throughout source
comments (e.g. `[S4]`, `Round 2-A`, `Bug 1`). This file is the canonical
glossary so those tags aren't insider knowledge.

If you grep `S4` in source, this is where you land.

> **Note**: an early version of this product included a blockchain
> anchoring layer (external ledger / object storage / identity registration)
> that has since been removed. History entries below that touched that layer
> are condensed accordingly.

## Phase 0 — origins

- SDK (`nexus_core`) and Nexus (`nexus`) existed first as a
  standalone CLI agent. No server, no desktop. You'd run `rune chat` and
  talk to your twin from a terminal.
- Server (`nexus_server`) was added later as a multi-tenant HTTP wrapper.
- Desktop (`RuneDesktop`) was added later still as an Avalonia C# UI.

In the early days the server had its own intelligence layer mirroring
Nexus — same memory pipeline, same compactor. **S0–S6 was a deliberate
campaign to retire that duplicate and make the server a pure HTTP
frontend over Nexus's twin.**

## The S-series (server cleanup)

Each S-step retired a piece of the server's parallel intelligence layer
in favour of routing through Nexus's `DigitalTwin`.

### S1 — kill the `/llm/chat` legacy fallback

Before S1, `/api/v1/llm/chat` had two paths:
1. New: route through `TwinManager.get_twin(user_id).chat(message)`.
2. Legacy: directly call Gemini/OpenAI/Anthropic, no contract checks, no
   memory, no event log.

If twin throws, the handler used to silently fall back to (2). That
produced answers the agent's contract / drift / memory pipeline never
saw — invisible state divergence.

**S1 deleted the fallback.** Twin failures now produce an HTTP 502 with
the twin's error in the body. The legacy path remains compiled in but
is reachable only when `USE_TWIN=0` (test-only).

### S2 — TwinManager auto-elects sync mode

Before S2, `TwinManager._create_twin` always built local-mode twins.
Sync + anchoring went through a separate (legacy) server-side
pipeline.

**S2 moved the sync/anchoring responsibility into Nexus** when the
server has the required credentials configured. This is the moment the
duplicate server-side sync layer started being retired.

### S3 — delete `memory_service.py`

The server had its own periodic memory compactor (`maybe_compact()`)
walking `sync_events` and projecting recent events into a single
`memory_compact` row. Twin's own `EventLogCompactor` (SDK) does the
same job.

**S3 removed the server's compactor.** Read helpers (`list_memory_compacts`,
`memory_compact_count`) moved to `agent_state.py`. The file
`memory_service.py` is now an `ImportError` tombstone — touching it
fails loudly.

### S4 — retire `sync_anchor` + `sync_hub.push`

Before S4 every desktop `/sync/push` triggered `enqueue_anchor`, which
asynchronously wrote the state snapshot. After S2 the twin's own backend
already does that on every `event_log.append` — double-write waste.

**S4 stopped enqueuing new anchors via `/sync/push`.** The retry daemon
became opt-in. `list_anchors_for_user` remains as a read-only view of
pre-S4 history.

### S5 — `/agent/state` & friends read from twin's event_log

Before S5 the agent_state HTTP endpoints (`/state`, `/timeline`,
`/memories`, `/messages`) read server's `sync_events` table — itself a
mirror of twin's writes via `_build_on_event`.

**S5 pivoted reads to twin's per-user EventLog SQLite directly.** A new
module `twin_event_log.py` opens each user's `events.db` read-only via
`sqlite3.connect("file:...?mode=ro")` — no DigitalTwin instantiation
overhead per request. The `sync_events` mirror is still written for
back-compat but no production read path consults it.

### S6 — twin identity bootstrapping

Before S6 the desktop called a server endpoint during onboarding to
register the agent identity; if skipped, the twin would also try
(background task), creating duplicate registrations.

**S6 introduced `bootstrap_identity(user_id)`** in `twin_manager` as
the single canonical registration entry point. The legacy endpoint is
marked deprecated and now delegates to it. DigitalTwin gained a
`cached_agent_id` parameter so when the server has already registered,
the twin pre-seeds its identity cache and skips its own background
registration.

## The Round 2 series (desktop thin-client)

The S-series refactored the server. **Round 2 refactored the desktop**
to match: stop holding state locally, pull everything from server.

### Round 2-A — `/agent/messages` and delete `LocalEventLog`

Before: desktop's `RuneEngine` owned a per-user SQLite `LocalEventLog`,
appending every chat turn locally and asynchronously pushing to
`/sync/push`. After login the engine rebuilt in-memory state from the
local file.

After: desktop pulls history from `GET /api/v1/agent/messages` on every
login. `LocalEventLog`, `RuneEngine`, the per-user data dir, the JWT
decoder for user-id scoping — all gone. Desktop is a pure view of server.

### Round 2-B — `/files/upload` + multipart

Before: file attachments were base64-encoded into the `/llm/chat` JSON
body. A 100 MB PDF became a ~134 MB string before the request even left
the client.

After: each file goes through `POST /api/v1/files/upload` as
`multipart/form-data` (streamed bytes), gets back a `file_id`, and the
chat request just references the id. Server's chat handler resolves the
id via `files.resolve_files()` and reads from disk.

### Round 2-C — final desktop simplification

Killed `RuneEngine`, `JwtPayload.ExtractUserId`, the `MainViewModel`'s
per-user data directory tree, the `_build_system_prompt` /
`_build_context_messages` logic (server-side twin owns prompt
construction now). `MainViewModel` is ~140 lines and just does:
set token → reset chat VM → background identity check.

## Bug 1 / 2 / 3 (post-S6 stability fixes)

A user reported sync failures spamming logs. Diagnosis surfaced
three intertwined bugs:

### Bug 1 — bucket auto-create missing for twin

`ensure_bucket()` lived in SDK but was only called from server's legacy
sync path. The twin's own backend went straight to PUT without checking
— the very first write for a freshly-registered agent failed with
"No such bucket".

**Fix**: added `_ensure_bucket_once()` (lazy + locked + cached) at the
top of the sync write path in SDK. All future SDK consumers benefit,
zero server changes needed.

### Bug 2 — twin double-registers identity

`bootstrap_identity` (server, S6) registered identity A. Then
`twin._register_identity` (Nexus, separate code path) ran in background
and registered identity B because its local cache file was empty.

**Fix**: added `cached_agent_id: Optional[int]` parameter to
`DigitalTwin.create`. When server pre-registered, it passes the token
in; twin pre-seeds its identity cache file and skips its own background
register.

### Bug 3 — UI silent on sync failures

`/agent/state` showed "0 anchored / 0 pending" for users even when the
twin was successfully writing snapshots. After S4 the legacy
`sync_anchors` table no longer accumulates rows for chat traffic, but
the UI only read from there.

**Fix**: a dedicated event table populated by a logging.Handler that
subscribes to the sync/backend loggers, parses the write result lines,
attributes by agent_id, persists. `/agent/state` and `/agent/timeline`
union legacy sync_anchors with the new event table.

## Layer-leakage cleanup

Two follow-ons to the S-series:

### Distiller move to SDK

`attachment_distiller.py` started life on the server. The text-extraction
+ LLM-summarisation logic (`extract_text`, `distill_attachment`) was
generic — only `record_distilled_event` (which writes `sync_events`) was
server-specific.

**Moved**: `nexus_core.distiller` (`distill`, `extract_text`, prompt
constants, `LlmFn` type). Server's `attachment_distiller.py` now imports
from SDK and only owns `record_distilled_event`.

### Network short-form helper hoisted

Three modules each had their own `"mainnet" in network_str` substring
check. A typo (`bsc_mainnet` with underscore) silently fell back to
testnet.

**Moved**: `config.network_short` property + network whitelist
validation in `config.validate()`. Misconfig now fails on startup.

## Naming legacy

The codebase started branded "Rune" everywhere — class names (`Rune`,
`RuneProvider`, `RuneChainClient`), Python modules (`nexus`,
`nexus_server`), C# projects (`RuneDesktop.*`), env vars (`RUNE_*`),
logger namespaces.

The naming reorg is **deferred** — see thread "去 Rune 化" for the
proposed mapping (`nexus` → `nexus`, `nexus_server` → `nexus_server`,
`Rune` builder → top-level functions, `RuneProvider` → `AgentRuntime`).
Existing code uses Rune-prefixed names; new code may use the eventual
Nexus naming.

## See also

- [`README.md`](README.md) — five-minute tour
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — current architecture
- [`ROADMAP.md`](ROADMAP.md) — what's next
