"""Phase O.5: GET /api/v1/agent/evolution/verdicts.

Sanity tests for the timeline endpoint that powers the desktop's
Evolution panel. We use the same FakeTwin pattern as the namespaces
endpoint test — a thin object exposing the attributes the route
reads, populated with real EventLog rows so the route exercises its
real parsing path.
"""

from __future__ import annotations

import pytest

from nexus_core.evolution import (
    EvolutionProposal, EvolutionVerdict, EvolutionRevert,
)
from nexus_core.memory import EventLog


# ── Helpers ──────────────────────────────────────────────────────────


class FakeTwin:
    """Minimum surface the evolution timeline route reads."""
    def __init__(self, event_log: EventLog):
        self.event_log = event_log

    async def close(self):
        pass


def _emit_proposal(log: EventLog, edit_id: str, evolver: str = "MemoryEvolver") -> int:
    p = EvolutionProposal(
        edit_id=edit_id,
        evolver=evolver,
        target_namespace="memory.facts",
        target_version_pre="(uncommitted)",
        target_version_post="(uncommitted)",
        change_summary=f"edit {edit_id}",
        rollback_pointer="(uncommitted)",
        expires_after_events=5,
    )
    return log.append(
        event_type="evolution_proposal",
        content=f"proposal {edit_id}",
        metadata=p.to_event_metadata(),
    )


def _emit_verdict(log: EventLog, edit_id: str, decision: str = "kept") -> int:
    v = EvolutionVerdict(
        edit_id=edit_id, verdict_at_event=10, events_observed=5,
        decision=decision,  # type: ignore[arg-type]
    )
    return log.append(
        event_type="evolution_verdict",
        content=f"verdict {edit_id}",
        metadata=v.to_event_metadata(),
    )


def _emit_revert(log: EventLog, edit_id: str) -> int:
    r = EvolutionRevert(
        edit_id=edit_id,
        rolled_back_to="v0001",
        rolled_back_from="v0002",
        trigger="verdict",
    )
    return log.append(
        event_type="evolution_revert",
        content=f"revert {edit_id}",
        metadata=r.to_event_metadata(),
    )


# ── Tests ────────────────────────────────────────────────────────────


def test_endpoint_returns_empty_when_no_events(client, tmp_path):
    """Fresh twin, no evolution activity → all-zero counts."""
    from nexus_server import twin_manager
    log = EventLog(base_dir=str(tmp_path / "elog1"), agent_id="agent-1")
    twin_manager._test_override = FakeTwin(log)
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "EvoEmpty", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]
        resp = client.get(
            "/api/v1/agent/evolution/verdicts",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["proposals"] == 0
        assert body["verdicts"] == 0
        assert body["reverts"] == 0
        assert body["events"] == []
        assert body["pending"] == []
    finally:
        twin_manager._test_override = None


def test_endpoint_classifies_kinds_and_pending(client, tmp_path):
    """Two proposals: one settled (proposal+verdict), one pending
    (proposal only). Endpoint should report counts + pending list."""
    from nexus_server import twin_manager
    log = EventLog(base_dir=str(tmp_path / "elog2"), agent_id="agent-1")
    _emit_proposal(log, "edit-A")
    _emit_verdict(log, "edit-A", decision="kept")
    _emit_proposal(log, "edit-B")  # pending — no verdict yet

    twin_manager._test_override = FakeTwin(log)
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "EvoPending", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]
        resp = client.get(
            "/api/v1/agent/evolution/verdicts",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["proposals"] == 2
        assert body["verdicts"] == 1
        assert body["reverts"] == 0
        assert body["pending"] == ["edit-B"]
        # Events present in newest-first order with right kinds
        kinds = [e["kind"] for e in body["events"]]
        assert set(kinds) == {"evolution_proposal", "evolution_verdict"}
        # Decision is surfaced on verdict rows for direct UI rendering
        verdict_rows = [e for e in body["events"] if e["kind"] == "evolution_verdict"]
        assert verdict_rows[0]["decision"] == "kept"
    finally:
        twin_manager._test_override = None


def test_endpoint_surfaces_revert_rows(client, tmp_path):
    """Reverted proposal: proposal + verdict(reverted) + revert event,
    counts increment correctly, no edit shows up as pending."""
    from nexus_server import twin_manager
    log = EventLog(base_dir=str(tmp_path / "elog3"), agent_id="agent-1")
    _emit_proposal(log, "edit-bad")
    _emit_verdict(log, "edit-bad", decision="reverted")
    _emit_revert(log, "edit-bad")

    twin_manager._test_override = FakeTwin(log)
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "EvoRevert", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]
        resp = client.get(
            "/api/v1/agent/evolution/verdicts",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["proposals"] == 1
        assert body["verdicts"] == 1
        assert body["reverts"] == 1
        assert body["pending"] == []
        # All three kinds appear
        kinds = {e["kind"] for e in body["events"]}
        assert kinds == {"evolution_proposal", "evolution_verdict", "evolution_revert"}
    finally:
        twin_manager._test_override = None


def test_endpoint_requires_auth(client):
    """Sanity: no token → unauthorized."""
    resp = client.get("/api/v1/agent/evolution/verdicts")
    assert resp.status_code in (401, 403)


# ── Phase O.6: manual approve / revert ──────────────────────────────


class FakeTwinWithStore:
    """Like FakeTwin but also exposes a PersonaStore so manual
    revert can exercise the rollback path end-to-end."""
    def __init__(self, event_log: EventLog, persona_store):
        self.event_log = event_log
        self.persona_store = persona_store

    async def close(self):
        pass


def test_manual_revert_rolls_back_persona_and_emits_events(client, tmp_path):
    """POST /evolution/{edit_id}/revert → verdict(reverted) +
    revert events written, PersonaStore actually rolls back."""
    from nexus_server import twin_manager
    from nexus_core.memory import PersonaStore, PersonaVersion

    persona_store = PersonaStore(base_dir=str(tmp_path / "p"))
    persona_store.propose_version(PersonaVersion(persona_text="v1"))
    v1 = persona_store.current_version()
    persona_store.propose_version(PersonaVersion(persona_text="v2"))
    v2 = persona_store.current_version()
    assert v2 != v1

    log = EventLog(base_dir=str(tmp_path / "elog_manual_rev"), agent_id="agent-1")
    # Proposal that would roll back to v1
    p = EvolutionProposal(
        edit_id="edit-revertme",
        evolver="PersonaEvolver",
        target_namespace="memory.persona",
        target_version_pre=v1,
        target_version_post=v1,
        change_summary="change",
        rollback_pointer=v1,
    )
    log.append(
        event_type="evolution_proposal",
        content="proposal",
        metadata=p.to_event_metadata(),
    )

    twin_manager._test_override = FakeTwinWithStore(log, persona_store)
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "EvoManualRev", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]
        resp = client.post(
            "/api/v1/agent/evolution/edit-revertme/revert",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["edit_id"] == "edit-revertme"
        assert body["decision"] == "reverted"
        assert body["rolled_back_to"] == v1
        # PersonaStore actually rolled back
        assert persona_store.current_version() == v1

        # Both verdict + revert events landed in the log
        kinds = [e.event_type for e in log.recent(limit=20)]
        assert "evolution_verdict" in kinds
        assert "evolution_revert" in kinds
    finally:
        twin_manager._test_override = None


def test_manual_approve_pins_kept_decision(client, tmp_path):
    """POST /evolution/{edit_id}/approve → verdict(kept) emitted,
    no revert event."""
    from nexus_server import twin_manager
    log = EventLog(base_dir=str(tmp_path / "elog_manual_appr"), agent_id="agent-1")
    _emit_proposal(log, "edit-keepme")

    twin_manager._test_override = FakeTwin(log)
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "EvoManualAppr", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]
        resp = client.post(
            "/api/v1/agent/evolution/edit-keepme/approve",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["decision"] == "kept"
        kinds = {e.event_type for e in log.recent(limit=20)}
        assert "evolution_verdict" in kinds
        assert "evolution_revert" not in kinds
    finally:
        twin_manager._test_override = None


def test_manual_decisions_are_idempotent(client, tmp_path):
    """A second approve/revert call after the first does NOT write
    duplicate events — it returns the existing decision."""
    from nexus_server import twin_manager
    log = EventLog(base_dir=str(tmp_path / "elog_idem"), agent_id="agent-1")
    _emit_proposal(log, "edit-idem")
    twin_manager._test_override = FakeTwin(log)
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "EvoIdem", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]
        h = {"Authorization": f"Bearer {token}"}

        first = client.post("/api/v1/agent/evolution/edit-idem/approve", headers=h)
        assert first.status_code == 200
        # Count verdict events after first call
        verdicts_after_first = sum(
            1 for e in log.recent(limit=50)
            if e.event_type == "evolution_verdict"
        )

        second = client.post("/api/v1/agent/evolution/edit-idem/approve", headers=h)
        assert second.status_code == 200
        assert "already settled" in second.json()["note"]

        # No new verdict event emitted on the second call
        verdicts_after_second = sum(
            1 for e in log.recent(limit=50)
            if e.event_type == "evolution_verdict"
        )
        assert verdicts_after_second == verdicts_after_first
    finally:
        twin_manager._test_override = None


def test_manual_revert_404_for_unknown_edit_id(client, tmp_path):
    """POSTing to a nonexistent edit_id → 404."""
    from nexus_server import twin_manager
    log = EventLog(base_dir=str(tmp_path / "elog_404"), agent_id="agent-1")
    twin_manager._test_override = FakeTwin(log)
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "Evo404", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]
        resp = client.post(
            "/api/v1/agent/evolution/does-not-exist/revert",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 404
    finally:
        twin_manager._test_override = None
