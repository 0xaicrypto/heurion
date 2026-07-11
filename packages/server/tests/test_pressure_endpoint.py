"""GET /api/v1/agent/evolution/pressure — Phase C2.

Smoke + shape tests for the Pressure Dashboard backend. We stub
out the twin's evolution engine + compactor so the endpoint sees
deterministic ``pressure_state()`` returns and we can assert on
the wire shape the desktop's gauges / lineage / histogram views
will bind to.
"""

from __future__ import annotations

import time

import pytest

from nexus_core.memory import EventLog


# ── Helpers ──────────────────────────────────────────────────────────


class _StubEvolver:
    """Returns a hard-coded pressure_state dict."""
    def __init__(self, payload: dict):
        self._payload = payload

    def pressure_state(self, *args, **kwargs) -> dict:
        return dict(self._payload)


class _StubCuratedMemory:
    def __init__(self, count: int = 0):
        self.memory_count = count
        self.user_count = 0


class _StubEvolutionEngine:
    """The 4 evolver attributes /evolution/pressure inspects."""
    def __init__(self, **evolvers):
        self.memory = evolvers.get("memory")
        self.skills = evolvers.get("skills")
        self.persona = evolvers.get("persona")
        self.knowledge = evolvers.get("knowledge")


class _StubDrift:
    def __init__(self, score: float = 0.0):
        self._score = score
        self.current = score

    def drift_score(self):
        return self._score


class FakeTwin:
    """Stub twin for the pressure endpoint. Exposes only the
    attributes get_evolution_pressure reaches for."""
    def __init__(
        self,
        tmp_path,
        memory_state: dict = None,
        skills_state: dict = None,
        persona_state: dict = None,
        knowledge_state: dict = None,
        compactor_state: dict = None,
        fact_count: int = 0,
        drift_score: float = 0.0,
        with_event_log: bool = True,
    ):
        memory = _StubEvolver(memory_state) if memory_state else None
        skills = _StubEvolver(skills_state) if skills_state else None
        persona = _StubEvolver(persona_state) if persona_state else None
        knowledge = _StubEvolver(knowledge_state) if knowledge_state else None
        self.evolution = _StubEvolutionEngine(
            memory=memory, skills=skills, persona=persona, knowledge=knowledge,
        )
        self._compactor = _StubEvolver(compactor_state) if compactor_state else None
        self.curated_memory = _StubCuratedMemory(count=fact_count)
        self.drift = _StubDrift(score=drift_score)
        self.event_log = (
            EventLog(base_dir=str(tmp_path / "elog"), agent_id="agent-x")
            if with_event_log else None
        )

    async def close(self):
        if self.event_log:
            self.event_log.close()


def _register(client) -> str:
    reg = client.post("/api/v1/auth/register", json={"username": "PressureUser", "password": "Str0ng-Pass-123"})
    return reg.json()["jwt_token"]


# ── Tests ────────────────────────────────────────────────────────────


def test_pressure_endpoint_returns_all_evolvers(client, tmp_path):
    """Endpoint surfaces every evolver that exposes pressure_state.
    The desktop's gauges section binds directly to ``evolvers[]``."""
    from nexus_server import twin_manager

    twin = FakeTwin(
        tmp_path,
        memory_state={
            "evolver": "MemoryEvolver", "layer": "L1",
            "accumulator": 12, "threshold": float("inf"),
            "unit": "turns", "status": "live",
            "fed_by": ["chat.turn"], "last_fired_at": None, "details": {},
        },
        compactor_state={
            "evolver": "EventLogCompactor", "layer": "L1",
            "accumulator": 8, "threshold": 20,
            "unit": "events", "status": "warming",
            "fed_by": ["chat.turn"], "last_fired_at": None, "details": {},
        },
        knowledge_state={
            "evolver": "KnowledgeCompiler", "layer": "L1",
            "accumulator": 9, "threshold": 10,
            "unit": "facts", "status": "warming",
            "fed_by": ["MemoryEvolver"], "last_fired_at": None, "details": {},
        },
        skills_state={
            "evolver": "SkillEvolver", "layer": "L2",
            "accumulator": 2, "threshold": 3,
            "unit": "topic_count", "status": "live",
            "fed_by": ["chat.turn"], "last_fired_at": None,
            "details": {"primary_topic": "code"},
        },
        persona_state={
            "evolver": "PersonaEvolver", "layer": "L0",
            "accumulator": 0.6, "threshold": 1.0,
            "unit": "ratio", "status": "warming",
            "fed_by": ["MemoryEvolver", "KnowledgeCompiler", "SkillEvolver"],
            "last_fired_at": None, "details": {"days_since_last": 18},
        },
    )

    twin_manager._test_override = twin
    try:
        token = _register(client)
        resp = client.get(
            "/api/v1/agent/evolution/pressure",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        evolvers = {e["evolver"]: e for e in body["evolvers"]}
        assert set(evolvers.keys()) == {
            "MemoryEvolver", "EventLogCompactor", "KnowledgeCompiler",
            "SkillEvolver", "PersonaEvolver",
        }
        # Layers correctly preserved (UI colour-codes by this).
        assert evolvers["PersonaEvolver"]["layer"] == "L0"
        assert evolvers["KnowledgeCompiler"]["layer"] == "L1"
        assert evolvers["SkillEvolver"]["layer"] == "L2"
        # Lineage arrows depend on this round-tripping intact.
        assert "MemoryEvolver" in evolvers["KnowledgeCompiler"]["fed_by"]
        # PersonaEvolver fed by ALL of L1/L2 (the AHE pyramid).
        for upstream in ("MemoryEvolver", "KnowledgeCompiler", "SkillEvolver"):
            assert upstream in evolvers["PersonaEvolver"]["fed_by"]
    finally:
        twin_manager._test_override = None


def test_pressure_endpoint_threshold_inf_serialises_safely(client, tmp_path):
    """MemoryEvolver returns threshold=inf (live, no accumulator).
    Pydantic must serialise this without crashing — UI will read
    "infinity" and render a flat "live" gauge instead of a percentage."""
    from nexus_server import twin_manager

    twin = FakeTwin(
        tmp_path,
        memory_state={
            "evolver": "MemoryEvolver", "layer": "L1",
            "accumulator": 5, "threshold": float("inf"),
            "unit": "turns", "status": "live",
            "fed_by": ["chat.turn"], "last_fired_at": None, "details": {},
        },
    )
    twin_manager._test_override = twin
    try:
        token = _register(client)
        resp = client.get(
            "/api/v1/agent/evolution/pressure",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # JSON spec doesn't allow Infinity literally, so Pydantic
        # serialises it as the JSON-compatible value. The point is
        # we don't 500 — the field is round-trippable.
        mem = next(e for e in body["evolvers"] if e["evolver"] == "MemoryEvolver")
        assert mem["status"] == "live"
    finally:
        twin_manager._test_override = None


def test_pressure_endpoint_skips_evolvers_without_pressure_state(client, tmp_path):
    """Endpoint must tolerate a partial evolution engine — old
    deployments won't have all evolvers, and tests / dev modes
    might run with only a subset."""
    from nexus_server import twin_manager

    twin = FakeTwin(tmp_path)  # no evolvers at all
    twin_manager._test_override = twin
    try:
        token = _register(client)
        resp = client.get(
            "/api/v1/agent/evolution/pressure",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Empty evolvers list, empty histogram — endpoint degrades
        # gracefully rather than erroring.
        assert body["evolvers"] == []
        assert body["histogram_24h"] == {}
    finally:
        twin_manager._test_override = None


def test_pressure_endpoint_aggregates_24h_histogram(client, tmp_path):
    """``histogram_24h`` is bucketed per evolver from
    evolution_verdict events. The UI uses it to draw the
    "pyramid shape" sparkline."""
    from nexus_server import twin_manager

    twin = FakeTwin(tmp_path)
    elog = twin.event_log
    now = time.time()

    # 3 verdicts for MemoryEvolver in last hour, 1 for PersonaEvolver
    # 12 hours ago. We need a matching proposal for each verdict so
    # the aggregator can resolve evolver names.
    def _add_pair(evolver: str, edit_id: str, verdict_offset_sec: float):
        elog.append(
            event_type="evolution_proposal",
            content="proposed",
            metadata={"edit_id": edit_id, "evolver": evolver},
        )
        elog.append(
            event_type="evolution_verdict",
            content="kept",
            metadata={"edit_id": edit_id, "decision": "kept"},
        )
        # Backdate the verdict's timestamp for histogram bucketing.
        elog._conn.execute(
            "UPDATE events SET timestamp = ? "
            "WHERE event_type = 'evolution_verdict' AND idx = "
            "(SELECT max(idx) FROM events WHERE event_type = 'evolution_verdict')",
            (now - verdict_offset_sec,),
        )
        elog._conn.commit()

    _add_pair("MemoryEvolver", "m1", 60)        # 1 min ago
    _add_pair("MemoryEvolver", "m2", 600)       # 10 min ago
    _add_pair("MemoryEvolver", "m3", 1800)      # 30 min ago
    _add_pair("PersonaEvolver", "p1", 12 * 3600)  # 12h ago

    twin_manager._test_override = twin
    try:
        token = _register(client)
        resp = client.get(
            "/api/v1/agent/evolution/pressure",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        hist = body["histogram_24h"]
        assert "MemoryEvolver" in hist
        assert "PersonaEvolver" in hist
        # Each row is exactly 24 buckets.
        assert len(hist["MemoryEvolver"]) == 24
        assert len(hist["PersonaEvolver"]) == 24
        # MemoryEvolver had 3 firings — they all fall in the LAST
        # bucket (within last hour).
        assert sum(hist["MemoryEvolver"]) == 3
        assert hist["MemoryEvolver"][-1] >= 1
        # PersonaEvolver fired exactly once.
        assert sum(hist["PersonaEvolver"]) == 1
    finally:
        twin_manager._test_override = None


def test_pressure_endpoint_requires_auth(client):
    resp = client.get("/api/v1/agent/evolution/pressure")
    assert resp.status_code in (401, 403)
