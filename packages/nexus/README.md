# nexus — DigitalTwin framework

> The agent layer of Nexus. `nexus_core` provides the durable substrate
> (chained log, versioned stores, contracts, drift, on-chain anchoring,
> falsifiable-evolution primitives). This package adds the *agent* on
> top of it: a `DigitalTwin` that runs a chat loop, projects memory for
> each turn, schedules four self-evolvers, and reconciles their edits
> through a verdict-driven rollback loop.

```python
from nexus import DigitalTwin

twin = await DigitalTwin.create(
    name="My Twin",
    llm_provider="gemini",
    llm_api_key="AIza...",
)

response = await twin.chat("What's the latest in cancer immunotherapy?")
```

That single `chat()` call drives a 9-step pipeline (contract pre-check
→ projection → LLM → contract post-check → drift → response append →
background evolution). Every persona / memory / skill / knowledge edit
the background work produces is logged as an `evolution_proposal`,
graded by `VerdictRunner` after its observation window, and either
kept, warned, or rolled back.

---

## What an "immortal, self-evolving" agent means here

The four guarantees the SDK gives you, made operational by this layer:

| Guarantee | How `nexus` honours it |
|---|---|
| **Append-only memory** | `DigitalTwin.event_log` is the single source of truth — projection / compaction / evolution all read from it, never mutate it |
| **Versioned typed stores** | Twin owns 5 namespace stores: `episodes / facts / skills_memory / persona_store / knowledge` — each its own VersionedStore |
| **Verifiable on-chain anchoring** | `_auto_compact()` calls SDK ChainBackend → state-root lands on BSC after each compaction round |
| **Falsifiable self-evolution** | 4 evolvers emit `evolution_proposal` before writing; `VerdictRunner` settles them at the next compaction; reverted verdicts trigger `store.rollback(rollback_pointer)` automatically |

---

## Anatomy of `DigitalTwin`

```
nexus/
├── twin.py                     DigitalTwin core (init, chat, lifecycle)
├── twin_commands.py            slash-command + formatter dispatch
│                               (Phase I extraction — keeps twin.py focused
│                               on runtime, not CLI presentation)
├── config.py                   TwinConfig, LLMProvider, projection mode
├── llm.py                      Multi-provider LLM facade
├── evolution/
│   ├── projection.py           DPM chat projection (single_call | rlm)
│   ├── engine.py               EvolutionEngine orchestrator
│   ├── memory_evolver.py       extracts facts → MemoryProvider + FactsStore
│   ├── skill_evolver.py        extracts skills → SkillsStore
│   ├── persona_evolver.py      monthly persona reflection → PersonaStore
│   ├── knowledge_compiler.py   memory clusters → KnowledgeStore articles
│   ├── verdict_runner.py       Phase O.4 closes the falsifiable loop
│   ├── skill_evaluator.py      LLM-as-judge skill scoring
│   └── social_engine.py        gossip + impressions + discovery
├── tools/
│   └── base.py                 ExtendedToolRegistry (MCP-aware)
└── cli.py                      python -m nexus entry point
```

`twin.py` after Phase I is ~1250 lines focused on the runtime; the
slash-command + formatter surface (~400 lines) lives in
`twin_commands.py` and only loads on demand.

---

## The 9-step chat flow

```
chat(user_message)
 │
 1. ContractEngine.pre_check(user_message)           ↳ block on hard violations
 2. EventLog.append("user_message", text)            ↳ chained log
 3. ProjectionMemory.project(event_log, query)       ↳ single_call OR rlm
 4. LLMClient.complete(prompt, tools=registry)       ↳ multi-provider
 5. ContractEngine.post_check(response)              ↳ regenerate on soft violations
 6. DriftScore.update(hard, soft, "chat")            ↳ rolling drift D(t)
 7. EventLog.append("assistant_response", text)
 8. BG: _post_response_work
        ├─ MemoryEvolver.extract_and_store
        │    ├─ rune.memory.bulk_add
        │    └─ facts_store.upsert    (Phase J typed dual-write)
        ├─ SkillEvolver.learn_from_conversation
        └─ persona/knowledge reflection (every N turns)
 9. BG: _auto_compact (every M turns)
        ├─ EventLogCompactor.compact
        ├─ ChainBackend writes state root to BSC
        └─ VerdictRunner.score_pending  ← Phase O.5
```

The whole flow is async, with steps 1-7 in the request path and 8-9
running in detached background tasks so chat latency isn't held back
by anchoring or evolution work.

---

## Self-evolution — the four evolvers

Each evolver runs at a different cadence and writes to a different
namespace. They all share the same Phase O contract: emit a
`evolution_proposal` event before the actual write, with `edit_id`,
`target_namespace`, `change_diff`, and `rollback_pointer` filled in.

| Evolver | Trigger | Target namespace | Notes |
|---|---|---|---|
| `MemoryEvolver` | every chat turn (background) | `memory.facts` (+ legacy MemoryProvider) | dual-write; legacy is source of truth, FactsStore is the typed projection |
| `SkillEvolver` | every chat turn (background) | `memory.skills` | learns from implicit task patterns + topic signals |
| `PersonaEvolver` | reflection cycle (~monthly) | `memory.persona` | highest-risk per AHE — `predicted_regressions` left empty by design |
| `KnowledgeCompiler` | reflection cycle | `memory.knowledge` | clusters memories → distilled articles |

`event_log` and the relevant store are passed in via `EvolutionEngine`
constructor; without them each evolver falls back to pre-Phase-O
behaviour (no events emitted, legacy writes only). This makes the
instrumentation strictly opt-in for embedders.

---

## Falsifiable verdict loop (Phase O.4 / O.5)

```python
from nexus.evolution.verdict_runner import VerdictRunner

runner = VerdictRunner(
    event_log=twin.event_log,
    stores={
        "memory.persona": twin.persona_store,
        "memory.facts":   twin.facts,
        "memory.episodes": twin.episodes,
        "memory.skills":   twin.skills_memory,
        "memory.knowledge": twin.knowledge,
    },
    drift=twin.drift,
)

verdicts = runner.score_pending()
# Each unsettled proposal whose window has elapsed is scored:
#   - observed contract violations in the window      → regressions
#   - drift_delta vs warning / intervention thresholds → severity gate
#   - SDK score_verdict() returns kept / warning / reverted
# Reverted decisions: store.rollback(proposal.rollback_pointer) is
#   called automatically and an evolution_revert event is emitted.
```

`DigitalTwin._auto_compact` instantiates and runs this every
compaction round, so verdicts ship at the same cadence as state-root
anchoring.

---

## Memory: typed namespaces

```python
twin.episodes        # EpisodesStore
twin.facts           # FactsStore (also dual-written by MemoryEvolver)
twin.skills_memory   # SkillsStore
twin.persona_store   # PersonaStore (every update is a new version)
twin.knowledge       # KnowledgeStore
```

The legacy `twin.curated_memory` (flat MEMORY.md / USER.md) is kept
as a fallback for the chat projection during the transition period.
After projection migration, namespace stores become the only source.

---

## RLM-based chat projection (Phase P)

Set `chat_projection_mode="rlm"` in `TwinConfig` to switch from the
single-call projection to a Recursive Language Model engine
([arXiv:2512.24601]). The root LLM treats the EventLog as a Python
REPL variable and writes code that recursively calls a cheaper
sub-LLM over chunks. Defaults are conservative — short logs always
take the single-call fast path; truncation / runtime errors fall back
to single-call. See
[`docs/design/nexus-architecture.md`](../../docs/design/nexus-architecture.md).

---

## Quick start

```bash
cd packages/nexus
echo "GEMINI_API_KEY=AIza..." > .env

# CLI
python -m nexus
```

> The desktop client (`packages/desktop`) and the FastAPI server
> (`packages/server`) are the supported front-ends. The legacy
> `demo/` folder has been retired — the test suite under
> `packages/nexus/tests/` is the canonical reference for embedders.

---

## Configuration

```env
# LLM
TWIN_LLM_PROVIDER=gemini
GEMINI_API_KEY=AIza...

# Chain mode (optional)
NEXUS_PRIVATE_KEY=0x...
NEXUS_TESTNET_RPC=https://data-seed-prebsc-1-s1.binance.org:8545

# Projection mode (Phase P)
NEXUS_CHAT_PROJECTION_MODE=single_call    # or "rlm"
NEXUS_RLM_FASTPATH_CHAR_THRESHOLD=16000

# Web search backends (optional)
TAVILY_API_KEY=tvly...
JINA_API_KEY=jina_...
```

---

## Tests

```bash
pytest packages/nexus/tests/      # 228 tests
```

Coverage spans: chat flow, projection mode switching (single_call ↔
RLM), 4 evolvers + dual-write, evolution_proposal emission for all 4
evolvers, VerdictRunner end-to-end (clean / soft / hard / drift /
malformed / no-store paths), social protocol.

---

## License

Apache 2.0.
