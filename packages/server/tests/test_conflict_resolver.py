"""Four-axis conflict resolution tests (Rev-3)."""

from __future__ import annotations

import pathlib
import sqlite3
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest

from nexus_server.conflict_resolver import (
    NodeWithProvenance,
    detect_and_resolve,
    resolve_clinical_conflict,
)
from nexus_server.event_sourcing import (
    EventKind, Store, init_event_sourcing_schema,
)
from nexus_server.event_sourcing.handlers import (
    _h_node_added, _h_patient_registered, _h_provenance_recorded,
)


def _node(
    *, node_id=1, node_type="finding", content=None, weight=1.0,
    extracted_at=1_000_000, extraction_model="gemini-2.5-flash",
    retracted_at=None, has_medic_confirmation=False,
    source_kind="study", source_ref="study_a",
):
    return NodeWithProvenance(
        node_id=node_id, node_type=node_type,
        content=content or {"label": "test"},
        weight=weight, extracted_at=extracted_at,
        extraction_model=extraction_model,
        retracted_at=retracted_at,
        has_medic_confirmation=has_medic_confirmation,
        source_kind=source_kind, source_ref=source_ref,
    )


class TestAxis1Retraction:
    def test_retracted_a_loses(self):
        a = _node(node_id=1, retracted_at=time.time())
        b = _node(node_id=2)
        d = resolve_clinical_conflict(a, b)
        assert d.kind == "prefer_b"
        assert d.axis_used == "retraction"
        assert d.auto_resolved is True

    def test_retracted_b_loses(self):
        a = _node(node_id=1)
        b = _node(node_id=2, retracted_at=time.time())
        d = resolve_clinical_conflict(a, b)
        assert d.kind == "prefer_a"


class TestAxis2MedicConfirmation:
    def test_confirmed_wins(self):
        a = _node(node_id=1, has_medic_confirmation=True)
        b = _node(node_id=2)
        d = resolve_clinical_conflict(a, b)
        assert d.kind == "prefer_a"
        assert d.axis_used == "medic_confirmation"


class TestAxis3EvidenceRank:
    def test_pathology_beats_chat(self):
        a = _node(node_id=1, content={"label": "biopsy result"}, source_kind="study")
        b = _node(node_id=2, source_kind="chat")
        d = resolve_clinical_conflict(a, b)
        assert d.kind == "prefer_a"
        assert d.axis_used == "evidence_rank"

    def test_rank_difference_must_be_2_or_more(self):
        # CT (3) vs US (2) — gap is 1, not decisive on axis 3.
        a = _node(node_id=1, content={"modality": "CT"}, source_kind="study")
        b = _node(node_id=2, content={"modality": "US"}, source_kind="study")
        d = resolve_clinical_conflict(a, b)
        assert d.kind == "flag_for_medic"


class TestAxis4Recency:
    def test_measurement_newer_wins(self):
        a = _node(node_id=1, node_type="measurement", extracted_at=2_000_000_000)
        b = _node(node_id=2, node_type="measurement", extracted_at=1_000_000_000)
        d = resolve_clinical_conflict(a, b)
        assert d.kind == "prefer_a"
        assert d.axis_used == "recency"

    def test_non_measurement_does_not_use_recency(self):
        a = _node(node_id=1, extracted_at=2_000_000_000)
        b = _node(node_id=2, extracted_at=1_000_000_000)
        d = resolve_clinical_conflict(a, b)
        assert d.kind == "flag_for_medic"


class TestFlagForMedic:
    def test_default_when_no_axis_decisive(self):
        a = _node(node_id=1)
        b = _node(node_id=2)
        d = resolve_clinical_conflict(a, b)
        assert d.kind == "flag_for_medic"
        assert d.auto_resolved is False


class TestEventSourcedFlow:
    def test_detect_and_resolve_emits_events(self):
        conn = sqlite3.connect(":memory:")
        init_event_sourcing_schema(conn)
        store = Store(conn)

        store.emit_and_apply(
            kind=EventKind.PATIENT_REGISTERED,
            payload={"patient_hash": "p1", "source": "manual"},
            apply_fn=_h_patient_registered,
            user_id="dr_test", patient_hash="p1",
        )
        a_id = store.emit_and_apply(
            kind=EventKind.NODE_ADDED,
            payload={"node_type": "finding", "content_json": {"label": "Ⓐ"}},
            apply_fn=_h_node_added,
            user_id="dr_test", patient_hash="p1",
        )
        b_id = store.emit_and_apply(
            kind=EventKind.NODE_ADDED,
            payload={"node_type": "finding", "content_json": {"label": "Ⓑ"}},
            apply_fn=_h_node_added,
            user_id="dr_test", patient_hash="p1",
        )
        for nid in (a_id, b_id):
            store.emit_and_apply(
                kind=EventKind.PROVENANCE_RECORDED,
                payload={
                    "node_id": nid, "source_kind": "chat",
                    "source_ref": "s", "source_locator_json": {},
                    "evidence_quote": "x",
                    "extracted_by_user": "dr_test",
                    "extracted_at": 1, "extraction_model": "x",
                    "extraction_prompt_id": "y", "confidence": 0.5,
                    "redaction_version": "phi-v2",
                },
                apply_fn=_h_provenance_recorded,
                user_id="dr_test", patient_hash="p1",
            )

        decision = detect_and_resolve(
            store, conn,
            user_id="dr_test", patient_hash="p1",
            node_a_id=a_id, node_b_id=b_id,
        )
        assert decision.kind == "flag_for_medic"

        kinds = [
            r[0] for r in conn.execute(
                "SELECT event_kind FROM twin_event_log "
                "WHERE event_kind IN ('conflict_detected', 'conflict_resolved') "
                "ORDER BY event_idx"
            )
        ]
        assert kinds == ["conflict_detected", "conflict_resolved"]
