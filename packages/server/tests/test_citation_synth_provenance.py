"""
Regression tests for `GET /api/v1/memory/citation/{node_id}` (memory_router_v2).

Bug history (2026-06-14):
    The Memory tab in the desktop shows nodes like CT WHOLEBODY (node 67)
    created by the DICOM ingester. Clicking a citation chip on a study
    node fires GET /api/v1/memory/citation/67 → 404 "no provenance for
    node", which the right-rail rendered as a red "Failed to load"
    message.

    Root cause: ClinicalGraph.add_node only emits the matching
    PROVENANCE_RECORDED event when ``provenance`` is passed; the
    DICOM ingester doesn't pass it for non-clinical-fact nodes
    (``study``, ``key_image``, ``patient``, …). Those node types are
    correctly NOT in PROVENANCE_REQUIRED per Rev-2, but the citation
    endpoint hard-404'd anyway — making every DICOM study look broken
    from the Memory UI's perspective.

    Fix: the endpoint now has a second-tier resolver that synthesises
    a provenance row from ``clinical_graph_nodes`` itself when no
    ``node_provenance`` row exists.

Tests guard the three resolution tiers:
  1. Real provenance row present → returned verbatim.
  2. No provenance row, but node exists → synthesised row.
  3. Node truly doesn't exist → 404.
"""
from __future__ import annotations

import importlib
import json
import pathlib
import sqlite3
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _setup_app(tmp_path, monkeypatch):
    """Boot a FastAPI test client backed by a tmp SQLite at head."""
    db = tmp_path / "memrouter.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    from nexus_server.config import ServerConfig
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")

    # Run migrations to head so clinical_graph_nodes + node_provenance
    # tables exist.
    from nexus_server.migrations.runner import run_migrations
    run_migrations()

    # Seed a test user so auth dependency resolves.
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO users(id, display_name, jwt_secret, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("test-user", "Test", "secret-xxx", "2026-06-14", "2026-06-14"),
        )
        c.commit()

    # Reset the cached app + force-import the router so the patched
    # config is honoured.
    for mod in list(sys.modules):
        if mod.startswith("nexus_server"):
            sys.modules.pop(mod, None)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from nexus_server.auth.routes import get_current_user
    from nexus_server import memory_router_v2

    app = FastAPI()
    app.include_router(memory_router_v2.router)

    # Bypass auth dependency for the test.
    app.dependency_overrides[get_current_user] = lambda: "test-user"

    return TestClient(app), db


def _insert_node(
    db_path,
    *,
    user_id: str,
    patient_hash: str,
    node_id: int,
    node_type: str,
    content: dict,
    originating_event_idx: int = 0,
):
    """Insert directly into clinical_graph_nodes — bypasses the event
    store, but that's fine for testing the read-side endpoint."""
    with sqlite3.connect(db_path) as c:
        c.execute(
            "INSERT INTO clinical_graph_nodes "
            "(user_id, patient_hash, node_id, node_type, content_json, "
            " embedding_ref, weight, encounter_id, created_at, updated_at, "
            " originating_event_idx) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                user_id, patient_hash, node_id, node_type,
                json.dumps(content), None, 1.0, None,
                1700000000, 1700000000,
                originating_event_idx,
            ),
        )
        c.commit()


def _insert_provenance(
    db_path,
    *,
    user_id: str,
    patient_hash: str,
    node_id: int,
    source_kind: str = "report",
    source_ref: str = "src-1",
    evidence_quote: str = "verbatim text",
):
    with sqlite3.connect(db_path) as c:
        c.execute(
            "INSERT INTO node_provenance "
            "(user_id, patient_hash, node_id, source_kind, source_ref, "
            " source_locator_json, evidence_quote, extracted_by_user, "
            " extracted_at, extraction_model, extraction_prompt_id, "
            " confidence, redaction_version) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                user_id, patient_hash, node_id, source_kind, source_ref,
                json.dumps({"k": "v"}),
                evidence_quote, "system:test", 1700000000,
                "gpt-test", "prompt-test", 0.9, "1",
            ),
        )
        c.commit()


# ─────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────


def test_citation_real_provenance_returned_verbatim(tmp_path, monkeypatch):
    """Tier 1 — a real provenance row wins. Tests that the
    synthesised-fallback path doesn't accidentally pre-empt the
    canonical data."""
    client, db = _setup_app(tmp_path, monkeypatch)
    _insert_node(
        db, user_id="test-user", patient_hash="p1",
        node_id=42, node_type="finding",
        content={"label": "nodule rul"},
        originating_event_idx=10,
    )
    _insert_provenance(
        db, user_id="test-user", patient_hash="p1", node_id=42,
        source_kind="report", source_ref="report-001",
        evidence_quote="A 7mm nodule is seen in the RUL.",
    )

    r = client.get("/api/v1/memory/citation/42")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["node_id"] == 42
    assert body["source_kind"] == "report"
    assert body["source_ref"] == "report-001"
    assert body["evidence_quote"] == "A 7mm nodule is seen in the RUL."
    assert body["extracted_by_user"] == "system:test"
    # Synthesis markers MUST NOT appear for real rows.
    assert body["extraction_model"] != "(synthesized)"


def test_citation_synthesises_from_node_when_provenance_missing(tmp_path, monkeypatch):
    """Tier 2 — a study node has NO node_provenance row (per Rev-2
    the DICOM ingester doesn't emit one). The endpoint must still
    return a citation, synthesised from clinical_graph_nodes."""
    client, db = _setup_app(tmp_path, monkeypatch)
    _insert_node(
        db, user_id="test-user", patient_hash="p1",
        node_id=67, node_type="study",
        content={
            "study_uid": "1.2.840.113619.2.55.3.604688.1234",
            "modality":  "CT",
            "body_part": "WHOLEBODY",
        },
        originating_event_idx=55,
    )

    r = client.get("/api/v1/memory/citation/67")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["node_id"] == 67
    # Synthesised → source_kind matches node_type.
    assert body["source_kind"] == "study"
    # source_ref carries the originating event idx so the UI can
    # link back to the event_log audit.
    assert body["source_ref"] == "55"
    # Evidence quote should contain the user-facing fields, not raw JSON.
    assert "WHOLEBODY" in body["evidence_quote"] or "study_uid=" in body["evidence_quote"]
    # Clear synthesis markers so the UI can show "best-effort" labels.
    assert body["extraction_model"] == "(synthesized)"
    assert body["extracted_by_user"] == "system:synthesized"
    assert body["confidence"] == 1.0
    # Source locator must include the event_idx so audit drill-down works.
    assert body["source_locator"]["event_idx"] == 55
    assert body["source_locator"]["kind"] == "event_log"


def test_citation_true_404_when_node_does_not_exist(tmp_path, monkeypatch):
    """Tier 3 — no provenance, no node → still 404. The synthesised
    fallback must not invent rows out of thin air."""
    client, _ = _setup_app(tmp_path, monkeypatch)
    r = client.get("/api/v1/memory/citation/99999")
    assert r.status_code == 404, r.text
    # Detail text changed from "no provenance for node" → "no such
    # node" (the prior message was misleading — provenance might
    # legitimately be missing but the node could still exist).
    assert "no such node" in r.json()["detail"]
