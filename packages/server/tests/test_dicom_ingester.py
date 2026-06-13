"""DICOM ingester end-to-end tests (M1 / Rev-6 + Rev-9)."""

from __future__ import annotations

import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest

from nexus_server.event_sourcing import Store, init_event_sourcing_schema
from nexus_server.event_sourcing.replay import full_rebuild
from nexus_server.event_sourcing.schema import PROJECTION_TABLES
from nexus_server.memorization import (
    DicomIngester,
    KeySliceInput,
    StudyInput,
    make_test_study,
    route_modality,
    stub_redactor,
)


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    init_event_sourcing_schema(c)
    return c


@pytest.fixture
def store(conn):
    return Store(conn)


class TestModalityRouting:
    def test_ct_routes_to_2c(self):
        assert route_modality("CT", 400) == "2C"

    def test_mr_routes_to_2c(self):
        assert route_modality("MR", 200) == "2C"

    def test_cr_routes_to_2a(self):
        assert route_modality("CR", 1) == "2A"

    def test_us_single_frame_routes_to_2a(self):
        assert route_modality("US", 1) == "2A"

    def test_us_multi_frame_routes_to_2b(self):
        assert route_modality("US", 60) == "2B"

    def test_unknown_modality_high_frame_routes_to_2c(self):
        assert route_modality("UNKNOWN", 200) == "2C"


class TestIngestion:
    def test_ct_emits_full_chain(self, store, conn):
        study = make_test_study(modality="CT", frame_count=400, key_slice_count=3)
        ingester = DicomIngester(store, conn)
        summary = ingester.ingest(
            user_id="dr_test", patient_hash="p_ct", study=study,
        )
        assert summary["route"] == "2C"
        assert len(summary["key_image_node_ids"]) == 3
        assert summary["extraction_model"] == (
            "monai-bundle://quick_scan_4x4_grid@0.3.0"
        )

        kinds = [
            r[0] for r in conn.execute(
                "SELECT event_kind FROM twin_event_log "
                "WHERE user_id = 'dr_test' ORDER BY event_idx"
            )
        ]
        # Required event sequence per design v3 §5.1
        assert kinds[0] == "dicom_uploaded"
        assert "patient_registered" in kinds
        # Redaction must precede image_extracted
        for i, k in enumerate(kinds):
            if k == "image_extracted":
                preceding = kinds[:i]
                assert "image_redaction_applied" in preceding, (
                    "Rev-9 §5.5.7 #1: redaction must commit first"
                )
                break
        assert "ingestion_started" in kinds
        assert "ingestion_llm_response" in kinds
        assert "ingestion_completed" in kinds

    def test_xray_routes_to_2a(self, store, conn):
        study = make_test_study(modality="CR", frame_count=1, key_slice_count=1)
        ingester = DicomIngester(store, conn)
        summary = ingester.ingest(
            user_id="dr_test", patient_hash="p_xr", study=study,
        )
        assert summary["route"] == "2A"

    def test_key_image_nodes_have_redaction_metadata(self, store, conn):
        study = make_test_study()
        ingester = DicomIngester(store, conn)
        ingester.ingest(user_id="dr_test", patient_hash="p_red", study=study)
        rows = conn.execute(
            "SELECT content_json FROM clinical_graph_nodes "
            "WHERE user_id = 'dr_test' AND node_type = 'key_image'"
        ).fetchall()
        assert len(rows) > 0
        import json
        for row in rows:
            content = json.loads(row[0])
            assert content["redaction"]["applied"] is True
            assert content["redaction"]["engine"]


class TestReplay:
    def test_dicom_ingestion_replay_roundtrip(self, store, conn):
        study = make_test_study(key_slice_count=2)
        ingester = DicomIngester(store, conn)
        ingester.ingest(user_id="dr_test", patient_hash="p_rb", study=study)

        before = {
            t: conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2, 3").fetchall()
            for t in PROJECTION_TABLES
        }
        full_rebuild(conn)
        after = {
            t: conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2, 3").fetchall()
            for t in PROJECTION_TABLES
        }
        for t in PROJECTION_TABLES:
            assert before[t] == after[t], (
                f"projection {t} diverged after DICOM ingester replay"
            )


class TestRedactionInvariant:
    def test_custom_redactor_records_regions(self, store, conn):
        from nexus_server.memorization.dicom_ingester import RedactionResult

        def detector(b):
            return RedactionResult(
                redacted_bytes=b"REDACTED-" + b,
                redacted_regions=[{"bbox": [0, 0, 100, 20], "reason": "patient_name"}],
                ocr_hits=["Smith, John"],
                face_detections=[],
            )

        study = make_test_study(key_slice_count=1)
        ingester = DicomIngester(store, conn, redact=detector)
        ingester.ingest(user_id="dr_test", patient_hash="p_redact", study=study)

        # Look for image_redaction_applied event with our regions recorded
        import json
        rows = conn.execute(
            "SELECT payload_json FROM twin_event_log "
            "WHERE event_kind = 'image_redaction_applied'"
        ).fetchall()
        assert len(rows) == 1
        payload = json.loads(rows[0][0])
        assert payload["redacted_regions"][0]["reason"] == "patient_name"
        assert payload["ocr_hits"] == ["Smith, John"]
