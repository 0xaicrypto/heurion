# nexus_core

> The infrastructure layer for **persistent, self-evolving AI agents** on
> BNB Chain. `nexus_core` knows nothing about "agent" or "user" — it
> provides the durable substrate (chained logs, versioned stores,
> contracts, drift, on-chain anchoring, falsifiable-evolution
> primitives) that the framework above (`nexus`) and any other agent
> shell can build on.

```python
import nexus_core

runtime = nexus_core.local()                          # file-backed dev runtime
# or:    nexus_core.testnet(private_key="0x...")     # BSC testnet + Greenfield
# or:    nexus_core.builder().mock_backend().build() # in-memory unit tests
```

The returned `AgentRuntime` is a thin facade bundling five providers
(`runtime.sessions / memory / artifacts / tasks / impressions`). Storage
lives behind a `StorageBackend` strategy — `LocalBackend` for file mode,
`ChainBackend` for full BSC + Greenfield mode, `MockBackend` for tests.

---

## What "infrastructure for an immortal agent" means

Four guarantees, all enforced at the SDK layer so any framework on top
inherits them automatically:

1. **Append-only memory.** `EventLog` is a SQLite + FTS5 store. Events
   are never edited or deleted; the agent's history is a chained log.
2. **Versioned typed stores.** `VersionedStore` is the BEP-Nexus §3.3
   primitive: every commit is an immutable `v{N}.json` snapshot, plus a
   movable `_current.json` pointer. Rollback flips the pointer; no
   version is ever destroyed.
3. **Verifiable on-chain anchoring.** Every compaction round canonicalises
   a manifest (RFC 8785 JCS), hashes it (SHA-256), and writes the root
   to `AgentStateExtension` on BSC after the bytes land in the agent's
   own Greenfield bucket.
4. **Falsifiable self-evolution.** `EvolutionProposal` / `EvolutionVerdict` /
   `EvolutionRevert` dataclasses + `score_verdict()` implement the
   BEP-Nexus §3.4 normative rules — never revert on predicted
   regressions, only on observed ones (per the AHE paper's empirical
   finding).

---

## Modules at a glance

| Module | What it does |
|---|---|
| `memory/event_log.py` | Append-only EventLog (SQLite + FTS5) — the "chained log" |
| `memory/curated.py` | Legacy flat curated view (MEMORY.md / USER.md) — kept as fallback |
| `memory/compactor.py` | EventLogCompactor: read window → projection → snapshot |
| `memory/episodes.py` | EpisodesStore — session-level autobiographical |
| `memory/facts.py` | FactsStore — atomic claims, importance 1-5, optional TTL |
| `memory/skills.py` | SkillsStore — learned strategies per `task_kind` |
| `memory/persona.py` | PersonaStore — every update *is* a new version |
| `memory/knowledge.py` | KnowledgeStore — distilled long-form articles |
| `versioned.py` | VersionedStore primitive (immutable `v{N}.json` + movable pointer) |
| `evolution.py` | Phase O primitives: Proposal / Verdict / Revert + `score_verdict()` |
| `rlm.py` | Recursive Language Model primitive (chat-projection long-context engine) |
| `contracts/` | ABC: ContractEngine + DriftScore (warning / intervention thresholds) |
| `anchor.py` | BEP-Nexus chunked manifest + state-root computation |
| `core/providers.py` | AgentRuntime + 5 provider ABCs (Session/Memory/Artifact/Task/Impression) |
| `backends/` | Local / Chain / Mock storage strategies |
| `providers/` | Production provider implementations |
| `chain.py` | BSCClient — web3 wrapper for Identity + AgentState + TaskState |
| `greenfield.py` | GreenfieldClient — REST + persistent JS daemon |
| `state.py` | StateManager — combines BSC + Greenfield for the chain backend |
| `keystore.py` | Encrypted keystore (Web3 / EIP-2335-compatible) |
| `adapters/` | Google ADK, LangGraph, CrewAI, A2A protocol bridges |
| `social/` | Gossip protocol, social graph, agent profiles |
| `skills/`, `tools/`, `mcp/` | Skill manager, tool registry, MCP client |
| `utils/` | JSON repair (`robust_json_parse`), dotenv, agent_id ↔ uint256 |

---

## DPM (Deterministic Projection Memory)

The SDK doesn't store "memories" as a separate store. Memory **is** the
projection of an append-only event log. Two distinct projection paths
coexist:

```
EventLog (SQLite + FTS5)
   │
   ├─► chat projection      stochastic — uses RLM for long logs
   │   (single LLM call         purpose: maximise recall quality
   │    or root-LLM REPL)       lives in: nexus.evolution.projection
   │
   └─► anchor projection    deterministic — chunked manifest + JCS + SHA-256
       (purely computational)   purpose: maximise verifiability
                                lives in: nexus_core.anchor
```

Mixing them would be a bug — the chat projection can hallucinate, the
anchor projection cannot. See
[`docs/concepts/dpm.md`](../../docs/concepts/dpm.md) for the full model
and [`docs/design/nexus-architecture.md`](../../docs/design/nexus-architecture.md)
for the RLM design.

---

## Five-namespace memory (Phase J)

```python
from nexus_core.memory import (
    EpisodesStore, Episode,
    FactsStore, Fact,
    SkillsStore, LearnedSkill,
    PersonaStore, PersonaVersion,
    KnowledgeStore, KnowledgeArticle,
)

facts = FactsStore(base_dir=".agent")
facts.upsert(Fact(content="User prefers tea over coffee.",
                  category="preference", importance=4))
facts.commit()                 # snapshot: v0001
facts.upsert(Fact(content="User lives in Tokyo.",
                  category="fact", importance=5))
facts.commit()                 # snapshot: v0002

# Roll back if a verdict says v0002 introduced a regression
facts.rollback("v0001")        # _current.json now points back to v0001
                               # v0002 still on disk for audit
```

`PersonaStore` is special — every `propose_version` call IS a new
version (no working file). PersonaEvolver runs roughly monthly so
version inflation isn't a concern, and *every* persona change being
auditable is the point.

---

## Falsifiable evolution (Phase O)

```python
from nexus_core.evolution import (
    EvolutionProposal, EvolutionVerdict, score_verdict,
    TaskKindPrediction,
)

proposal = EvolutionProposal(
    edit_id="edit-A",
    evolver="PersonaEvolver",
    target_namespace="memory.persona",
    target_version_pre="v0003",
    target_version_post="v0004",
    change_summary="tightened tone for code-review tasks",
    rollback_pointer="v0003",
    predicted_fixes=[TaskKindPrediction(task_kind="code_review",
                                        reason="more concise responses")],
    predicted_regressions=[],   # AHE: predictions are noise, leave empty
    expires_after_events=100,
)
# emit as evolution_proposal event...

# After the window elapses, score against observed events
verdict = score_verdict(
    proposal=proposal,
    verdict_at_event=987,
    events_observed=120,
    observed_fixes=[("code_review", 4)],          # 4 successful turns
    observed_regressions=[("translation", 2,      # 2 hard violations
                           "high", "lost zh-CN voice")],
    abc_drift_delta=0.18,                          # > warning, < intervention
)
# verdict.decision is one of: kept / kept_with_warning / reverted
```

The decision rules are normative (BEP-Nexus §3.4) — implementations
must produce the same verdict for the same inputs. Tests pin them in
`tests/test_evolution.py`.

---

## Behavioural contracts (ABC)

```python
from nexus_core.contracts import ContractEngine, ContractSpec, DriftScore

spec   = ContractSpec.from_yaml("contracts/system.yaml")
engine = ContractEngine(spec, event_log=event_log)
drift  = DriftScore(
    compliance_weight=spec.compliance_weight,
    distributional_weight=spec.distributional_weight,
    warning_threshold=spec.warning_threshold,         # default 0.15
    intervention_threshold=spec.intervention_threshold, # default 0.35
)

# Pre-check on user input
pre = engine.pre_check(user_message)
if pre.blocked: return pre.reason

# Post-check on LLM output, then update drift
post = engine.post_check(response)
drift.update(post.details["hard_compliance"],
             post.details["soft_compliance"],
             "chat")

# Drift becomes an input to the falsifiable-evolution verdict scorer
# (high drift over the observation window → revert).
```

---

## On-chain anchoring (BEP-Nexus)

The SDK ships the canonical encoding so any third party can replay an
agent's bucket and recompute the same SHA-256 state root:

```python
from nexus_core import build_anchor_batch, canonicalize_manifest, ANCHOR_SCHEMA_V1
import hashlib, json

batch = build_anchor_batch(
    schema=ANCHOR_SCHEMA_V1,
    prev_root="0x" + "0" * 64,
    events=event_log.recent_canonical_form(limit=50),
    bucket="nexus-agent-866",
)
manifest_bytes = canonicalize_manifest(batch).encode()
state_root = "0x" + hashlib.sha256(manifest_bytes).hexdigest()
# state_root is what AgentStateExtension.updateStateRoot writes on BSC.
```

Seven test vectors that pin the canonical encoding live in
[`docs/BEP-nexus.md`](../../docs/BEP-nexus.md) and
`tests/test_anchor.py`.

---

## Framework adapters

| Framework | Adapter | What it bridges |
|---|---|---|
| Google ADK | `NexusSessionService` / `NexusMemoryService` / `NexusArtifactService` | ADK base service interfaces ↔ AgentRuntime providers |
| LangGraph | `LangGraphCheckpointer` | LangGraph checkpointing ↔ SessionProvider |
| CrewAI | `CrewAIMemoryAdapter` | CrewAI memory ↔ MemoryProvider |
| A2A protocol | `StatelessA2AAgent` / `BNBChainTaskStore` | A2A agent + on-chain TaskStore |

The ADK / A2A adapters sit behind optional pyproject extras
(`[adk]`, `[a2a]`); the rest of the SDK works without them. Tests for
those adapters skip cleanly when the extra isn't installed (see
`tests/conftest.py:collect_ignore_glob`).

---

## Tests

```bash
pytest packages/sdk/tests/        # 381 tests on core
# google-adk + a2a-sdk tests skip cleanly when those extras aren't installed
```

Coverage spans: VersionedStore + 5 namespace stores, EventLog,
CuratedMemory, EventLogCompactor, ContractEngine + DriftScore,
EvolutionProposal / Verdict / score_verdict, anchor manifest test
vectors, RLM runner, 4 framework adapters.

---

## Public-API stability

The module-level entry points (`nexus_core.local / testnet / mainnet /
builder`) and the `AgentRuntime` facade are the SDK's public surface.
Internal modules under `nexus_core.providers.*` and
`nexus_core.backends.*` may move between minor versions; everything
under `nexus_core.memory.*`, `nexus_core.evolution`, and
`nexus_core.anchor` is pinned by the BEP-Nexus spec and changes only
through a versioned schema bump.

---

## License

Apache 2.0.
