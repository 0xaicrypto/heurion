"""Layer 2 — practitioner extractor + distiller + composer (Rev-5)."""

from __future__ import annotations

import pathlib
import sqlite3
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest

from nexus_server.event_sourcing import EventKind, Store, init_event_sourcing_schema
from nexus_server.event_sourcing.handlers import _h_practitioner_fact_confirmed
from nexus_server.practitioner import (
    Candidate,
    build_prompt_enrichment,
    distill,
    extract_from_encounter,
)


def _seed_observations(
    store: Store,
    user_id: str,
    *,
    fact_kind: str = "practice",
    pattern_key: str = "decision/test",
    patient_count: int = 5,
):
    """Helper: emit observations across N distinct patients."""

    def custom_extractor(_conn, uid, ph, sid):
        return [Candidate(
            fact_kind=fact_kind,
            pattern_key=pattern_key,
            evidence_quote=f"verbatim from {sid}",
            source_encounter_id=sid,
        )]

    conn = store._conn  # internal handle
    for i in range(patient_count):
        ph = f"p_{i}"
        extract_from_encounter(
            store, conn,
            user_id=user_id, patient_hash=ph,
            source_encounter_id=f"sess-{i}",
            extractor=custom_extractor,
        )


class TestExtractor:
    def test_emits_observation_event(self):
        conn = sqlite3.connect(":memory:")
        init_event_sourcing_schema(conn)
        store = Store(conn)

        def yields_one(_c, _u, _p, sid):
            return [Candidate(
                fact_kind="style",
                pattern_key="impression_template/uncertain",
                evidence_quote="Recommend correlation",
                source_encounter_id=sid,
            )]

        idxs = extract_from_encounter(
            store, conn,
            user_id="dr_test", patient_hash="p1",
            source_encounter_id="sess-1",
            extractor=yields_one,
        )
        assert len(idxs) == 1
        kinds = [
            r[0] for r in conn.execute(
                "SELECT event_kind FROM twin_event_log "
                "WHERE event_kind = 'practitioner_observation_emitted'"
            )
        ]
        assert kinds == ["practitioner_observation_emitted"]


class TestDistiller:
    def test_below_threshold_does_not_surface(self):
        conn = sqlite3.connect(":memory:")
        init_event_sourcing_schema(conn)
        store = Store(conn)
        _seed_observations(store, "dr_test", patient_count=2)  # < 5
        result = distill(store, conn, user_id="dr_test")
        assert result.candidates_surfaced == 0

    def test_above_threshold_surfaces_candidate(self):
        conn = sqlite3.connect(":memory:")
        init_event_sourcing_schema(conn)
        store = Store(conn)
        _seed_observations(store, "dr_test", patient_count=6)  # ≥ 5 (practice threshold)
        result = distill(store, conn, user_id="dr_test")
        assert result.candidates_surfaced == 1

        # Fact should now be in practitioner_facts (unconfirmed)
        row = conn.execute(
            "SELECT distinct_patient_count, medic_confirmed_at "
            "FROM practitioner_facts WHERE user_id = ?",
            ("dr_test",),
        ).fetchone()
        assert row is not None
        assert row[0] == 6
        assert row[1] is None  # not yet confirmed

    def test_rejected_pattern_never_resurfaces(self):
        conn = sqlite3.connect(":memory:")
        init_event_sourcing_schema(conn)
        store = Store(conn)
        _seed_observations(store, "dr_test", patient_count=6)
        distill(store, conn, user_id="dr_test")
        # Reject via event-sourced path (Contract B — Rev-8)
        from nexus_server.event_sourcing.handlers import (
            _h_practitioner_fact_rejected,
        )
        store.emit_and_apply(
            kind=EventKind.PRACTITIONER_FACT_REJECTED,
            payload={
                "fact_kind": "practice",
                "pattern_key": "decision/test",
                "by_user": "dr_test",
                "reason": "test-reject",
            },
            apply_fn=_h_practitioner_fact_rejected,
            user_id="dr_test",
        )
        # Add more observations
        _seed_observations(store, "dr_test", patient_count=3)
        result = distill(store, conn, user_id="dr_test")
        # Should not re-surface
        assert result.candidates_surfaced == 0
        assert result.candidates_reinforced == 0


class TestComposer:
    def test_empty_when_no_active_facts(self):
        conn = sqlite3.connect(":memory:")
        init_event_sourcing_schema(conn)
        text = build_prompt_enrichment(conn, user_id="dr_test")
        assert text == ""

    def test_renders_confirmed_fact(self):
        conn = sqlite3.connect(":memory:")
        init_event_sourcing_schema(conn)
        store = Store(conn)
        _seed_observations(store, "dr_test", patient_count=6)
        distill(store, conn, user_id="dr_test")
        # Confirm via event
        store.emit_and_apply(
            kind=EventKind.PRACTITIONER_FACT_CONFIRMED,
            payload={
                "fact_kind": "practice",
                "pattern_key": "decision/test",
                "by_user": "dr_test",
            },
            apply_fn=_h_practitioner_fact_confirmed,
            user_id="dr_test",
        )
        text = build_prompt_enrichment(conn, user_id="dr_test")
        assert "PRACTICE" in text
        assert "established preferences" in text
