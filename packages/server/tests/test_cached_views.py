"""Cached views builder tests (Rev-4)."""

from __future__ import annotations

import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest

from nexus_server.cached_views import (
    RECIPES, build_view, get_view, invalidate_for_patient,
)
from nexus_server.event_sourcing import (
    EventKind, Store, init_event_sourcing_schema,
)
from nexus_server.event_sourcing.handlers import (
    _h_node_added, _h_patient_registered,
)


@pytest.fixture
def seeded():
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
            "encounter_id": "study_1",
        },
        apply_fn=_h_node_added,
        user_id="dr_test", patient_hash="p1",
    )
    store.emit_and_apply(
        kind=EventKind.NODE_ADDED,
        payload={
            "node_type": "med",
            "content_json": {"label": "lisinopril", "dose": "10 mg"},
        },
        apply_fn=_h_node_added,
        user_id="dr_test", patient_hash="p1",
    )
    store.emit_and_apply(
        kind=EventKind.NODE_ADDED,
        payload={
            "node_type": "study",
            "content_json": {
                "study_uid": "1.2.840.test",
                "modality": "CT", "study_date": "2026-06-13",
                "body_part": "ABDOMEN",
            },
            "encounter_id": "1.2.840.test",
        },
        apply_fn=_h_node_added,
        user_id="dr_test", patient_hash="p1",
    )
    return conn


class TestRecipes:
    def test_patient_summary_mentions_finding_and_med(self, seeded):
        md, sources = build_view(
            seeded, user_id="dr_test", patient_hash="p1",
            view_kind="patient_summary",
        )
        assert "left renal mass" in md
        assert "lisinopril" in md
        assert len(sources) >= 2

    def test_active_findings_lists_finding(self, seeded):
        md, _ = build_view(
            seeded, user_id="dr_test", patient_hash="p1",
            view_kind="active_findings",
        )
        assert "left renal mass" in md
        assert "2.4 cm" in md

    def test_imaging_chronology_lists_study(self, seeded):
        md, _ = build_view(
            seeded, user_id="dr_test", patient_hash="p1",
            view_kind="imaging_chronology",
        )
        assert "2026-06-13" in md
        assert "CT" in md

    def test_unknown_view_kind_errors(self, seeded):
        with pytest.raises(ValueError, match="unknown view_kind"):
            build_view(
                seeded, user_id="dr_test", patient_hash="p1",
                view_kind="not_a_view",
            )


class TestInvalidate:
    def test_invalidate_marks_stale(self, seeded):
        build_view(seeded, user_id="dr_test", patient_hash="p1",
                   view_kind="patient_summary")
        affected = invalidate_for_patient(
            seeded, user_id="dr_test", patient_hash="p1",
            view_kinds=["patient_summary"],
        )
        assert affected == 1

    def test_get_view_rebuilds_when_stale(self, seeded):
        build_view(seeded, user_id="dr_test", patient_hash="p1",
                   view_kind="patient_summary")
        invalidate_for_patient(
            seeded, user_id="dr_test", patient_hash="p1",
            view_kinds=["patient_summary"],
        )
        md, sources, generated_at = get_view(
            seeded, user_id="dr_test", patient_hash="p1",
            view_kind="patient_summary", rebuild_if_stale=True,
        )
        assert "left renal mass" in md

    def test_get_view_returns_none_for_missing_without_rebuild(self, seeded):
        result = get_view(
            seeded, user_id="dr_test", patient_hash="p1",
            view_kind="lab_trends_30d", rebuild_if_stale=False,
        )
        assert result is None
