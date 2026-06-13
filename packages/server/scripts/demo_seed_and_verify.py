#!/usr/bin/env python3
"""Demo: seed a test patient + verify backend M0 features end-to-end.

Run me after `uvicorn nexus_server.main:app --port 8001` is up. I will:

  1. Open the same SQLite DB the server uses and seed:
     - one patient (via PATIENT_REGISTERED event)
     - one finding with full Rev-2 provenance
     - one Layer 2 candidate that's surfaced for medic confirmation
  2. Verify the events landed (Contract B sanity)
  3. Demonstrate Tier 1 cached view generation
  4. Demonstrate conflict detection between two contradicting findings
  5. Demonstrate sovereign export bundle creation
  6. Print curl commands for trying the REST endpoints with a real token

Usage::

    cd packages/server
    python scripts/demo_seed_and_verify.py

Everything this script does goes through Store.emit_and_apply — so
running it gives you a database state that REPLAY would reproduce
byte-identical from event_log. That's the load-bearing M0 property.
"""

from __future__ import annotations

import json
import pathlib
import sqlite3
import sys
import tempfile
import time

# Run from repo's packages/server/
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from nexus_server.cached_views import build_view, get_view
from nexus_server.clinical_graph import ClinicalGraph, ensure_patient
from nexus_server.conflict_resolver import detect_and_resolve
from nexus_server.event_sourcing import (
    EventKind, Store, init_event_sourcing_schema,
)
from nexus_server.event_sourcing.handlers import (
    _h_practitioner_candidate_surfaced,
)
from nexus_server.event_sourcing.replay import full_rebuild
from nexus_server.event_sourcing.schema import PROJECTION_TABLES
from nexus_server.persistence import create_export_bundle


USER_ID = "dr_demo"
PATIENT_HASH = "demo_patient_001"
DEMO_DB = pathlib.Path("/tmp/nexus_demo.db")


def section(title: str) -> None:
    print(f"\n{'='*70}\n{title}\n{'='*70}")


def open_db() -> sqlite3.Connection:
    """Use a separate /tmp DB so demo data doesn't pollute the server's main
    nexus.db. If you'd rather inject into the live DB, point this at it."""
    if DEMO_DB.exists():
        DEMO_DB.unlink()
    conn = sqlite3.connect(DEMO_DB)
    init_event_sourcing_schema(conn)
    return conn


def seed(conn: sqlite3.Connection) -> dict:
    """Seed a patient + finding + provenance + Layer 2 candidate."""
    store = Store(conn)

    # 1. Patient
    patient_node_id = ensure_patient(
        store, USER_ID, PATIENT_HASH,
        source="manual",
        demographics={"sex": "F", "age_group": "50-59"},
    )

    # 2. Finding with full Rev-2 provenance
    graph = ClinicalGraph(store, conn, USER_ID, PATIENT_HASH)
    finding_id = graph.add_node(
        node_type="finding",
        content={
            "label": "left renal mass",
            "size_cm": 2.4,
            "presence": True,
        },
        encounter_id="study_demo_001",
        provenance={
            "source_kind":         "study",
            "source_ref":          "1.2.840.demo.001",
            "source_locator_json": {"slice_no": 142},
            "evidence_quote":      "Upper pole of left kidney 2.4 cm rounded "
                                   "cortical defect.",
            "extracted_by_user":   USER_ID,
            "extracted_at":        int(time.time()),
            "extraction_model":    "monai-bundle://quick_scan_4x4_grid@0.3.0",
            "extraction_prompt_id":"quick_scan_triage_v3@3.0.0",
            "confidence":          0.85,
            "redaction_version":   "phi-v2",
        },
    )
    graph.add_edge(src=patient_node_id, dst=finding_id, kind="mentions")

    # 3. Layer 2 candidate (the kind that surfaces in "Nexus has learned")
    store.emit_and_apply(
        kind=EventKind.PRACTITIONER_CANDIDATE_SURFACED,
        payload={
            "fact_kind":              "practice",
            "pattern_key":            "decision/renal_mass/lt_3cm/next_step",
            "distinct_count":         6,
            "observed_count":         8,
            "confidence":             0.9,
            "pattern_value":          {"preferred": "MR_with_contrast"},
            "extraction_model":       "stub-practitioner@0.1",
            "extraction_prompt_id":   "practitioner_signals_v1",
        },
        apply_fn=_h_practitioner_candidate_surfaced,
        user_id=USER_ID,
    )

    return {"patient_node_id": patient_node_id, "finding_id": finding_id}


def verify(conn: sqlite3.Connection, seeded: dict) -> None:
    """Read everything back through the projection tables to verify the
    write went through correctly."""
    section("Projection table state after seed")
    for table in PROJECTION_TABLES:
        n = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"  {table:32s} {n:4d} rows")

    section("Event log")
    rows = conn.execute(
        "SELECT event_idx, event_kind, event_kind_version "
        "FROM twin_event_log ORDER BY event_idx"
    ).fetchall()
    for idx, kind, version in rows:
        print(f"  #{idx:3d}  {kind:38s} @{version}")

    section("Finding projection content")
    row = conn.execute(
        "SELECT content_json FROM clinical_graph_nodes "
        "WHERE node_id = ?", (seeded["finding_id"],)
    ).fetchone()
    print(f"  {row[0]}")

    section("Provenance row (Rev-2 evidence trail)")
    prow = conn.execute(
        "SELECT evidence_quote, extraction_model, confidence "
        "FROM node_provenance WHERE node_id = ?", (seeded["finding_id"],)
    ).fetchone()
    print(f"  quote:      {prow[0]!r}")
    print(f"  model:      {prow[1]}")
    print(f"  confidence: {prow[2]}")


def demo_cached_view(conn: sqlite3.Connection) -> None:
    section("Tier 1 cached view — patient_summary")
    md, sources, _ts = get_view(
        conn, user_id=USER_ID, patient_hash=PATIENT_HASH,
        view_kind="patient_summary",
    )
    print(md)
    print(f"\n(view backed by {len(sources)} source nodes)")


def demo_conflict(conn: sqlite3.Connection, seeded: dict) -> None:
    section("Four-axis conflict resolution (Rev-3)")
    # Add a contradicting finding from chat — lower evidence rank
    store = Store(conn)
    graph = ClinicalGraph(store, conn, USER_ID, PATIENT_HASH)
    other_id = graph.add_node(
        node_type="finding",
        content={"label": "left renal mass", "size_cm": 2.1, "presence": True},
        encounter_id="chat_demo",
        provenance={
            "source_kind":         "chat",
            "source_ref":          "chat_demo",
            "source_locator_json": {"event_idx": 0},
            "evidence_quote":      "left renal mass 2.1 cm per prior",
            "extracted_by_user":   USER_ID,
            "extracted_at":        int(time.time()) - 86400 * 200,  # > 90d
            "extraction_model":    "stub",
            "extraction_prompt_id":"stub",
            "confidence":          0.5,
            "redaction_version":   "phi-v2",
        },
    )
    decision = detect_and_resolve(
        store, conn,
        user_id=USER_ID, patient_hash=PATIENT_HASH,
        node_a_id=seeded["finding_id"], node_b_id=other_id,
        detector="rule", rule_id="size_contradiction_demo",
    )
    print(f"  decision:      {decision.kind}")
    print(f"  axis_used:     {decision.axis_used}")
    print(f"  reason:        {decision.reason}")
    print(f"  auto_resolved: {decision.auto_resolved}")


def demo_replay(conn: sqlite3.Connection) -> None:
    section("Contract B sanity — drop projections + replay")
    before = {
        t: conn.execute(f"SELECT * FROM {t} ORDER BY 1,2,3").fetchall()
        for t in PROJECTION_TABLES
    }
    full_rebuild(conn)
    after = {
        t: conn.execute(f"SELECT * FROM {t} ORDER BY 1,2,3").fetchall()
        for t in PROJECTION_TABLES
    }
    for t in PROJECTION_TABLES:
        ok = "✓" if before[t] == after[t] else "✗ DIVERGED"
        print(f"  {t:32s}  {ok}  ({len(before[t])} rows)")


def demo_export(conn: sqlite3.Connection) -> None:
    section("Sovereign export bundle (Rev-7 / Tier 4)")
    out = pathlib.Path(tempfile.mkdtemp(prefix="nexus_demo_export_"))
    result = create_export_bundle(conn, user_id=USER_ID, output_dir=out)
    print(f"  bundle:        {result.bundle_path}")
    print(f"  size:          {result.size_bytes:,} bytes")
    print(f"  events:        {result.event_count}")
    print(f"  patients:      {result.patient_count}")
    print(f"  sha256:        {result.bundle_sha256[:24]}…")
    print(f"\n  Try:  ls -la {out}")
    print(f"        cat {out}/README.md")


def print_curl_examples() -> None:
    section("REST endpoint examples (replace TOKEN with a real JWT)")
    print("""
Once you have a JWT bearer token (POST /api/v1/auth/login), try:

# Memory layer status
curl -H 'Authorization: Bearer TOKEN' \\
     http://localhost:8001/api/v1/memory/_status

# Patient projection
curl -H 'Authorization: Bearer TOKEN' \\
     http://localhost:8001/api/v1/memory/patient/<HASH>/projection

# Provenance for a citation (full audit trail)
curl -H 'Authorization: Bearer TOKEN' \\
     http://localhost:8001/api/v1/memory/citation/<NODE_ID>

# Layer 2 candidates (what Nexus has learned)
curl -H 'Authorization: Bearer TOKEN' \\
     http://localhost:8001/api/v1/memory/practitioner/candidates

# Confirm a learned pattern
curl -X POST -H 'Authorization: Bearer TOKEN' \\
     http://localhost:8001/api/v1/memory/practitioner/practice/<KEY>/confirm

# Stream chat (Tier-classified SSE)
curl -N -X POST -H 'Authorization: Bearer TOKEN' \\
     -H 'Content-Type: application/json' \\
     -d '{"text":"summary","session_id":"s1","patient_hash":"<HASH>"}' \\
     http://localhost:8001/api/v1/agent/chat

# Audit log slice for a patient
curl -H 'Authorization: Bearer TOKEN' \\
     'http://localhost:8001/api/v1/memory/audit/<HASH>?limit=50'
""")


def main() -> int:
    print(f"\nNexus M0 demo · writing to {DEMO_DB}\n")
    conn = open_db()
    seeded = seed(conn)
    verify(conn, seeded)
    demo_cached_view(conn)
    demo_conflict(conn, seeded)
    demo_replay(conn)
    demo_export(conn)
    print_curl_examples()
    print(f"\nDemo DB:  {DEMO_DB}")
    print("Re-run anytime — it overwrites cleanly.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
