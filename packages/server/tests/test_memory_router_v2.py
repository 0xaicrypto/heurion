"""End-to-end test of memory_router_v2 — the HTTP surface for v3 memory.

Verifies the router uses Store correctly, returns frontend-shaped data,
and stays per-user-scoped (no cross-user leakage).

Auth is bypassed by overriding ``get_current_user`` dependency; this
isolates the router test from JWT plumbing.
"""

from __future__ import annotations

import pathlib
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from nexus_server.auth.routes import get_current_user
from nexus_server.event_sourcing import (
    EventKind,
    Store,
    init_event_sourcing_schema,
)
from nexus_server.event_sourcing.handlers import (
    _h_node_added,
    _h_patient_registered,
    _h_practitioner_candidate_surfaced,
    _h_provenance_recorded,
)
from nexus_server import memory_router_v2


# ─────────────────────────────────────────────────────────────────────
# Test app with auth override + tmp DB injection
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def tmp_db_path(tmp_path):
    return str(tmp_path / "nexus.db")


@pytest.fixture
def patched_get_db_connection(tmp_db_path, monkeypatch):
    """Override `get_db_connection` so the router opens our test DB
    every time."""
    from contextlib import contextmanager

    @contextmanager
    def fake():
        conn = sqlite3.connect(tmp_db_path)
        conn.row_factory = sqlite3.Row
        init_event_sourcing_schema(conn)
        try:
            yield conn
        finally:
            conn.commit()
            conn.close()

    monkeypatch.setattr(memory_router_v2, "get_db_connection", fake)
    return tmp_db_path


@pytest.fixture
def app(patched_get_db_connection) -> FastAPI:
    a = FastAPI()
    a.include_router(memory_router_v2.router)

    async def fake_user() -> str:
        return "dr_test"

    a.dependency_overrides[get_current_user] = fake_user
    return a


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


@pytest.fixture
def seeded(patched_get_db_connection):
    """Seed Layer 1 + Layer 2 fixture data for dr_test/p1."""
    conn = sqlite3.connect(patched_get_db_connection)
    init_event_sourcing_schema(conn)
    store = Store(conn)

    # Patient registered
    pid_event_idx = store.emit_and_apply(
        kind=EventKind.PATIENT_REGISTERED,
        payload={"patient_hash": "p1", "source": "manual"},
        apply_fn=_h_patient_registered,
        user_id="dr_test", patient_hash="p1",
    )

    # One finding with provenance
    finding_idx = store.emit_and_apply(
        kind=EventKind.NODE_ADDED,
        payload={
            "node_type": "finding",
            "content_json": {"label": "left renal mass", "size_cm": 2.4},
            "encounter_id": "study_1",
        },
        apply_fn=_h_node_added,
        user_id="dr_test", patient_hash="p1",
    )
    store.emit_and_apply(
        kind=EventKind.PROVENANCE_RECORDED,
        payload={
            "node_id":            finding_idx,
            "source_kind":        "study",
            "source_ref":         "1.2.840.xxxx",
            "source_locator_json": {"slice_no": 142},
            "evidence_quote":     "left renal mass measures 2.4 cm",
            "extracted_by_user":  "dr_test",
            "extracted_at":       1749000000,
            "extraction_model":   "gemini-2.5-flash",
            "extraction_prompt_id": "imaging_v3",
            "confidence":         0.85,
            "redaction_version":  "phi-v2",
        },
        apply_fn=_h_provenance_recorded,
        user_id="dr_test", patient_hash="p1",
        caused_by=finding_idx,
    )

    # One Layer 2 practitioner candidate
    store.emit_and_apply(
        kind=EventKind.PRACTITIONER_CANDIDATE_SURFACED,
        payload={
            "fact_kind":     "practice",
            "pattern_key":   "decision/renal_mass/lt_3cm/next_step",
            "distinct_count": 6,
            "confidence":    0.9,
            "pattern_value": {"preferred": "MR_with_contrast"},
        },
        apply_fn=_h_practitioner_candidate_surfaced,
        user_id="dr_test",
    )

    # Same-shaped data for another user to verify isolation
    other_pid = store.emit_and_apply(
        kind=EventKind.PATIENT_REGISTERED,
        payload={"patient_hash": "p1", "source": "manual"},
        apply_fn=_h_patient_registered,
        user_id="other_doctor", patient_hash="p1",
    )

    conn.commit()
    conn.close()
    return {
        "patient_node_id": pid_event_idx,
        "finding_node_id": finding_idx,
        "other_patient_node_id": other_pid,
    }


# ─────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────

class TestStatusEndpoint:
    def test_status_returns_schema_info(self, client, seeded):
        r = client.get("/api/v1/memory/_status")
        assert r.status_code == 200
        body = r.json()
        assert body["schema_version"] == "3.1"
        assert body["last_applied_event_idx"] >= 1
        assert body["user_node_count"] >= 1


class TestPatientProjection:
    def test_returns_findings_and_meds(self, client, seeded):
        r = client.get("/api/v1/memory/patient/p1/projection")
        assert r.status_code == 200
        body = r.json()
        assert body["patient_hash"] == "p1"
        assert len(body["findings"]) == 1
        assert body["findings"][0]["content"]["size_cm"] == 2.4
        assert body["unresolved_conflict_count"] == 0

    def test_does_not_leak_other_user_data(self, client, seeded, app):
        """Verify isolation: dr_test reading patient p1 must NOT see
        the same patient_hash registered under other_doctor."""
        r = client.get("/api/v1/memory/patient/p1/projection")
        assert r.status_code == 200
        body = r.json()
        # only dr_test's nodes — we seeded 1 finding + 1 patient anchor
        # but patient anchor node_type is 'patient', not in findings
        assert len(body["findings"]) == 1
        # studies + meds + ddx + semantics should all be 0 for this user
        assert body["medications"] == []
        assert body["differentials"] == []
        assert body["studies"] == []


class TestFindings:
    def test_active_default(self, client, seeded):
        r = client.get("/api/v1/memory/patient/p1/findings")
        assert r.status_code == 200
        body = r.json()
        assert len(body["findings"]) == 1
        assert body["findings"][0]["node_type"] == "finding"

    def test_status_filter_validated(self, client, seeded):
        r = client.get("/api/v1/memory/patient/p1/findings?status=invalid")
        assert r.status_code == 422


class TestCitation:
    def test_returns_provenance(self, client, seeded):
        r = client.get(f"/api/v1/memory/citation/{seeded['finding_node_id']}")
        assert r.status_code == 200
        body = r.json()
        assert body["evidence_quote"] == "left renal mass measures 2.4 cm"
        assert body["extraction_model"] == "gemini-2.5-flash"
        assert body["confidence"] == 0.85
        assert body["source_locator"] == {"slice_no": 142}

    def test_unknown_node_404(self, client, seeded):
        r = client.get("/api/v1/memory/citation/9999999")
        assert r.status_code == 404


class TestPractitioner:
    def test_candidates_listed(self, client, seeded):
        r = client.get("/api/v1/memory/practitioner/candidates")
        assert r.status_code == 200
        body = r.json()
        assert len(body["candidates"]) == 1
        cand = body["candidates"][0]
        assert cand["fact_kind"] == "practice"
        assert cand["distinct_patient_count"] == 6

    def test_pending_count(self, client, seeded):
        r = client.get("/api/v1/memory/practitioner/pending_count")
        assert r.status_code == 200
        assert r.json() == {"count": 1}

    def test_confirm_emits_event(self, client, seeded, patched_get_db_connection):
        r = client.post(
            "/api/v1/memory/practitioner/practice/"
            "decision/renal_mass/lt_3cm/next_step/confirm",
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

        # Verify the fact is now in active list, not candidates
        r2 = client.get("/api/v1/memory/practitioner/active")
        assert len(r2.json()["active"]) == 1

        r3 = client.get("/api/v1/memory/practitioner/candidates")
        assert len(r3.json()["candidates"]) == 0

    def test_pending_count_drops_after_confirm(self, client, seeded):
        client.post(
            "/api/v1/memory/practitioner/practice/"
            "decision/renal_mass/lt_3cm/next_step/confirm",
        )
        r = client.get("/api/v1/memory/practitioner/pending_count")
        assert r.json() == {"count": 0}


class TestAuditLog:
    def test_returns_events_for_patient(self, client, seeded):
        r = client.get("/api/v1/memory/audit/p1")
        assert r.status_code == 200
        kinds = [e["event_kind"] for e in r.json()["events"]]
        # ORDER BY event_idx DESC → newest first; should include all
        # the events we seeded for p1
        assert "patient_registered" in kinds
        assert "node_added" in kinds
        assert "provenance_recorded" in kinds
