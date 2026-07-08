"""Tier classifier + chat SSE + export bundle (Rev-4 + Rev-7)."""

from __future__ import annotations

import json
import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from nexus_server.auth.routes import get_current_user
from nexus_server import chat_router
from nexus_server.cached_views import build_view
from nexus_server.event_sourcing import EventKind, Store, init_event_sourcing_schema
from nexus_server.event_sourcing.handlers import _h_node_added, _h_patient_registered
from nexus_server.persistence import create_export_bundle
from nexus_server.retrieval_tiers import (
    Tier,
    classify,
    retrieve,
)


# ─────────────────────────────────────────────────────────────────────
# Tier classifier
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def seeded_conn():
    conn = sqlite3.connect(":memory:")
    init_event_sourcing_schema(conn)
    store = Store(conn)
    store.emit_and_apply(
        kind=EventKind.PATIENT_REGISTERED,
        payload={"patient_hash": "p1", "source": "manual"},
        apply_fn=_h_patient_registered,
        user_id="dr_test", patient_hash="p1",
    )
    store.emit_and_apply(
        kind=EventKind.NODE_ADDED,
        payload={
            "node_type": "finding",
            "content_json": {"label": "left renal mass", "size_cm": 2.4},
        },
        apply_fn=_h_node_added,
        user_id="dr_test", patient_hash="p1",
    )
    return conn


class TestTierClassifier:
    def test_t3_for_explain_question(self, seeded_conn):
        choice = classify(
            seeded_conn, user_id="dr_test", patient_hash="p1",
            question="why is this lesion getting bigger?",
        )
        assert choice.tier == Tier.T3

    def test_t3_for_compare_question(self, seeded_conn):
        choice = classify(
            seeded_conn, user_id="dr_test", patient_hash="p1",
            question="compare the latest CT with the prior one",
        )
        assert choice.tier == Tier.T3

    def test_t2_for_single_entity_question(self, seeded_conn):
        choice = classify(
            seeded_conn, user_id="dr_test", patient_hash="p1",
            question="status of the left renal mass?",
        )
        assert choice.tier == Tier.T2
        assert choice.anchor_hint == "left renal mass"

    def test_t1_for_summary_with_fresh_view(self, seeded_conn):
        # Build the patient_summary view so T1 is eligible
        build_view(seeded_conn, user_id="dr_test", patient_hash="p1",
                   view_kind="patient_summary")
        choice = classify(
            seeded_conn, user_id="dr_test", patient_hash="p1",
            question="give me a summary",
        )
        assert choice.tier == Tier.T1
        assert choice.view_kind == "patient_summary"


class TestRetrievalDispatch:
    def test_t1_emits_cached_view(self, seeded_conn):
        build_view(seeded_conn, user_id="dr_test", patient_hash="p1",
                   view_kind="patient_summary")
        chunks = list(retrieve(
            seeded_conn, user_id="dr_test", patient_hash="p1",
            question="give me a summary",
        ))
        kinds = [c.kind for c in chunks]
        assert "tier_classified" in kinds
        assert "final_answer_chunk" in kinds
        assert "turn_complete" in kinds
        tier_chunk = next(c for c in chunks if c.kind == "tier_classified")
        assert tier_chunk.data["tier"] == "T1"

    def test_t2_emits_anchored_answer(self, seeded_conn):
        chunks = list(retrieve(
            seeded_conn, user_id="dr_test", patient_hash="p1",
            question="left renal mass?",
        ))
        tier_chunk = next(c for c in chunks if c.kind == "tier_classified")
        assert tier_chunk.data["tier"] == "T2"
        answer = next(c for c in chunks if c.kind == "final_answer_chunk")
        assert "left renal mass" in answer.data["text"].lower()

    def test_t3_emits_reasoning_trail(self, seeded_conn):
        chunks = list(retrieve(
            seeded_conn, user_id="dr_test", patient_hash="p1",
            question="why is this case interesting?",
        ))
        kinds = [c.kind for c in chunks]
        assert "reasoning_chunk" in kinds


# ─────────────────────────────────────────────────────────────────────
# Chat SSE end-to-end
# ─────────────────────────────────────────────────────────────────────

class TestChatSSE:
    @pytest.fixture
    def app(self, tmp_path, monkeypatch):
        # Wire a tmp DB for the chat router
        db_path = str(tmp_path / "chat.db")

        from contextlib import contextmanager

        @contextmanager
        def fake_conn():
            conn = sqlite3.connect(db_path)
            init_event_sourcing_schema(conn)
            try:
                yield conn
            finally:
                conn.commit()
                conn.close()

        monkeypatch.setattr(chat_router, "get_db_connection", fake_conn)

        a = FastAPI()
        a.include_router(chat_router.router)

        async def fake_user():
            return "dr_test"

        a.dependency_overrides[get_current_user] = fake_user
        return a

    def test_chat_streams_events_and_persists(self, app):
        client = TestClient(app)
        with client.stream(
            "POST",
            "/api/v1/agent/chat",
            json={
                "text": "give me a summary",
                "session_id": "s1",
                "patient_hash": "p_chat",
            },
        ) as r:
            assert r.status_code == 200
            events = []
            for line in r.iter_lines():
                if isinstance(line, bytes):
                    line = line.decode()
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
            assert events
            kinds = [e["type"] for e in events]
            assert kinds[0] == "turn_started"
            assert "tier_classified" in kinds
            assert kinds[-1] == "turn_complete"

    def test_empty_message_400(self, app):
        client = TestClient(app)
        r = client.post(
            "/api/v1/agent/chat",
            json={"text": "   ", "session_id": "s1"},
        )
        assert r.status_code == 400


# ─────────────────────────────────────────────────────────────────────
# Export bundle (Rev-7 / D2)
# ─────────────────────────────────────────────────────────────────────

class TestExportBundle:
    def test_creates_self_contained_directory(self, seeded_conn, tmp_path):
        out = tmp_path / "export-2026-06-13"
        result = create_export_bundle(seeded_conn, user_id="dr_test",
                                      output_dir=out)
        assert out.exists()
        assert (out / "README.md").exists()
        assert (out / "MANIFEST.json").exists()
        assert (out / "checksums.sha256").exists()
        assert (out / "_sql_dump.sql").exists()
        assert (out / "layer1_event_log" / "events.jsonl").exists()

        # Manifest is well-formed
        manifest = json.loads((out / "MANIFEST.json").read_text())
        assert manifest["bundle_format_version"]
        assert manifest["counts"]["event_count"] >= 2
        assert manifest["counts"]["patient_count"] == 1

    def test_includes_patient_subdir_with_graph(self, seeded_conn, tmp_path):
        out = tmp_path / "export"
        create_export_bundle(seeded_conn, user_id="dr_test", output_dir=out)
        patient_dir = out / "layer1_patients" / "p1"
        assert (patient_dir / "graph.json").exists()
        assert (patient_dir / "summary.md").exists()
        assert (patient_dir / "fhir-r5.json").exists()
        graph = json.loads((patient_dir / "graph.json").read_text())
        assert any(
            n["node_type"] == "finding" and "left renal mass" in str(n["content"])
            for n in graph["nodes"]
        )

    def test_fhir_export_lossy_but_valid_bundle(self, seeded_conn, tmp_path):
        out = tmp_path / "export"
        create_export_bundle(seeded_conn, user_id="dr_test", output_dir=out)
        fhir = json.loads(
            (out / "layer1_patients" / "p1" / "fhir-r5.json").read_text()
        )
        assert fhir["resourceType"] == "Bundle"
        assert any(e["resource"]["resourceType"] == "Patient" for e in fhir["entry"])
        assert any(e["resource"]["resourceType"] == "Condition" for e in fhir["entry"])

    def test_sha256_stable_across_two_exports(self, seeded_conn, tmp_path):
        a = tmp_path / "a"
        b = tmp_path / "b"
        # Two exports of the same data — file contents identical;
        # MANIFEST.json contains timestamps so we compare graph.json instead
        create_export_bundle(seeded_conn, user_id="dr_test", output_dir=a)
        create_export_bundle(seeded_conn, user_id="dr_test", output_dir=b)
        ga = (a / "layer1_patients" / "p1" / "graph.json").read_text()
        gb = (b / "layer1_patients" / "p1" / "graph.json").read_text()
        assert ga == gb
