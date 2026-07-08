"""Regression tests for the 2026-06-15 imaging cross-patient
contamination bug.

Symptom (production):
    Doctor creates a new patient → uploads imaging → runs quick scan.
    The new patient's findings stay empty; an OLDER patient's findings
    silently gain entries. Patient-safety P0.

Three independent bugs interacted to produce this:
    Bug #1 — files._run_dicom_ingester_safe / _run_quick_scan_after_ingest
             looked up patient_hash by dicom_study_id (which was '' on
             the fresh upload row, so the query matched a stale row
             from a prior upload).
    Bug #2 — dicom.persist_study's UPSERT-UPDATE branch silently
             dropped patient_hash_override, so dicom_studies.patient_hash
             stayed bound to the previous patient.
    Bug #3 — the UPDATE uploads SET dicom_study_id happened AFTER the
             ingester + quick-scan helpers ran, defeating any
             dicom_study_id-based lookup.

See: docs/design/IMAGING_PATIENT_ISOLATION_BUGFIX.md
"""
from __future__ import annotations

import pathlib
import shutil
import sqlite3
import sys
import tempfile

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def isolated_rune_home(monkeypatch):
    """Point RUNE_HOME at a temp dir so the DICOM index DB
    (dicom._index_db_path) doesn't leak across tests or into ~/.rune."""
    tmp = tempfile.mkdtemp(prefix="nexus-isolation-test-")
    monkeypatch.setenv("RUNE_HOME", tmp)
    yield pathlib.Path(tmp)
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    """Build a tmp uploads DB at head."""
    db = tmp_path / "isolation.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    from nexus_server.config import ServerConfig
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")
    from nexus_server.migrations.runner import run_migrations
    run_migrations()
    return db


def _insert_upload_row(
    db: pathlib.Path,
    *,
    file_id: str,
    user_id: str,
    patient_hash: str,
    dicom_study_id: str = "",
    created_at: str = "2026-06-15T10:00:00",
    sha256: str = "deadbeef",
) -> None:
    """Insert a minimal uploads row for test seeding."""
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO uploads "
            "(file_id, user_id, name, mime, size_bytes, sha256, "
            " disk_path, created_at, dicom_study_id, dicom_status, "
            " patient_hash, memory_status, memory_summary, "
            " quick_scan_status, quick_scan_summary) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                file_id, user_id, "ct.zip", "application/zip",
                1_000_000, sha256, f"/tmp/{file_id}.zip", created_at,
                dicom_study_id, "rendered",
                patient_hash, "ok", "1 graph events",
                "", "",
            ),
        )
        c.commit()


# ─────────────────────────────────────────────────────────────────────
# Bug #2: persist_study UPSERT must honor patient_hash_override
# ─────────────────────────────────────────────────────────────────────


def test_persist_study_upsert_honors_patient_hash_override(
    isolated_rune_home, tmp_path,
):
    """Direct unit test on dicom.persist_study.

    First call binds the study to H_old. Second call (same
    StudyInstanceUID, different patient_hash_override=H_new) MUST
    rebind dicom_studies.patient_hash to H_new — the previous
    behaviour silently kept H_old because the UPSERT-UPDATE branch
    skipped the column.
    """
    from nexus_server.dicom import (
        init_dicom_index, _index_db_path, persist_study, DicomStudy,
    )

    init_dicom_index()

    H_old = "patient-hash-OLD-aaaa"
    H_new = "patient-hash-NEW-bbbb"
    study_uid = "1.2.3.4.5"

    base_study = DicomStudy(
        study_instance_uid=study_uid,
        study_date="20260601",
        study_description="CT chest",
        modality="CT",
        patient_hash=H_old,
        patient_age_group="60s",
        patient_sex="M",
        series=[],
    )

    # First upload — under H_old.
    sid1 = persist_study(
        "user-1", "file-old", base_study, tmp_path / "ex1",
        patient_hash_override=H_old,
    )

    with sqlite3.connect(_index_db_path()) as c:
        bound = c.execute(
            "SELECT patient_hash FROM dicom_studies WHERE study_id = ?",
            (sid1,),
        ).fetchone()[0]
    assert bound == H_old, "first insert should bind to H_old"

    # Second upload — same study_uid, override to H_new. This is the
    # exact production scenario: doctor re-uploads after switching to
    # a freshly-created patient.
    sid2 = persist_study(
        "user-1", "file-new", base_study, tmp_path / "ex2",
        patient_hash_override=H_new,
    )

    assert sid2 == sid1, "UPSERT should reuse the same study_id"

    with sqlite3.connect(_index_db_path()) as c:
        rebound = c.execute(
            "SELECT patient_hash FROM dicom_studies WHERE study_id = ?",
            (sid1,),
        ).fetchone()[0]

    assert rebound == H_new, (
        f"REGRESSION — persist_study's UPSERT-UPDATE branch dropped "
        f"patient_hash_override. Expected dicom_studies.patient_hash "
        f"to flip to H_new ({H_new!r}) but it stayed at {rebound!r}. "
        f"This is the exact mechanism by which findings leaked onto "
        f"the wrong patient when a DICOM was re-uploaded under a new "
        f"patient binding."
    )


def test_persist_study_upsert_empty_override_keeps_existing_hash(
    isolated_rune_home, tmp_path,
):
    """Defensive: if a re-upload arrives with NO override (e.g. an
    automated batch import), the UPSERT-UPDATE branch must NOT wipe
    the existing patient_hash to empty. The COALESCE(NULLIF) keeps
    the prior value."""
    from nexus_server.dicom import (
        init_dicom_index, _index_db_path, persist_study, DicomStudy,
    )

    init_dicom_index()

    H_old = "patient-hash-keep-cccc"
    study_uid = "1.2.3.4.6"
    base_study = DicomStudy(
        study_instance_uid=study_uid,
        study_date="20260601",
        study_description="CT chest",
        modality="CT",
        patient_hash=H_old,
        patient_age_group="60s",
        patient_sex="M",
        series=[],
    )

    sid = persist_study(
        "user-1", "file-1", base_study, tmp_path / "ex1",
        patient_hash_override=H_old,
    )

    # Second insert with empty override AND empty study.patient_hash
    # (simulating a DICOM with no PatientID tag at all).
    empty_study = DicomStudy(
        study_instance_uid=study_uid,
        study_date="20260601",
        study_description="CT chest",
        modality="CT",
        patient_hash="",  # ← empty
        patient_age_group="",
        patient_sex="",
        series=[],
    )
    persist_study(
        "user-1", "file-2", empty_study, tmp_path / "ex2",
        patient_hash_override="",  # ← empty
    )

    with sqlite3.connect(_index_db_path()) as c:
        kept = c.execute(
            "SELECT patient_hash FROM dicom_studies WHERE study_id = ?",
            (sid,),
        ).fetchone()[0]
    assert kept == H_old, (
        f"Empty override should NOT erase the existing patient_hash. "
        f"Expected {H_old!r}, got {kept!r}."
    )


# ─────────────────────────────────────────────────────────────────────
# Bug #1: _run_dicom_ingester_safe must look up by file_id
# ─────────────────────────────────────────────────────────────────────


def test_run_dicom_ingester_safe_looks_up_by_file_id(
    isolated_rune_home, isolated_db, tmp_path, monkeypatch,
):
    """Two uploads rows share the same dicom_study_id but belong to
    DIFFERENT patients (H_old vs H_new). The helper must resolve
    patient_hash via the file_id we pass in, not via dicom_study_id —
    which would silently pick the wrong row.
    """
    from nexus_server import files
    from nexus_server.dicom import (
        init_dicom_index, _index_db_path, persist_study, DicomStudy,
    )

    init_dicom_index()

    H_old = "patient-hash-OLD"
    H_new = "patient-hash-NEW"
    user_id = "doctor-qian"
    study_uid = "1.2.3.4.99"

    # Seed dicom_studies (bound to H_new — this is what Fix-B
    # guarantees after the new upload).
    base_study = DicomStudy(
        study_instance_uid=study_uid,
        study_date="20260601",
        study_description="CT chest",
        modality="CT",
        patient_hash=H_new,
        patient_age_group="60s",
        patient_sex="M",
        series=[],
    )
    study_id = persist_study(
        user_id, "file-NEW", base_study, tmp_path / "ex",
        patient_hash_override=H_new,
    )

    # Seed BOTH uploads rows. Both point at the same study_id.
    # `created_at` deliberately puts R_old as the NEWEST so that the
    # legacy `ORDER BY created_at DESC LIMIT 1` query would resolve to
    # H_old — proving Fix-A actually does what it claims.
    _insert_upload_row(
        isolated_db, file_id="R-NEW", user_id=user_id,
        patient_hash=H_new, dicom_study_id=study_id,
        created_at="2026-06-15T10:00:00",
    )
    _insert_upload_row(
        isolated_db, file_id="R-OLD", user_id=user_id,
        patient_hash=H_old, dicom_study_id=study_id,
        created_at="2026-06-15T11:00:00",  # newer — would win on ORDER BY DESC
    )

    # Capture what patient_hash the ingester was called with.
    captured: dict = {}

    class FakeIngester:
        def __init__(self, **kw): pass
        def ingest(self, *, user_id, patient_hash, study):  # noqa: D401
            captured["patient_hash"] = patient_hash
            return {"nodes": 1}

    monkeypatch.setattr(
        "nexus_server.memorization.dicom_ingester.DicomIngester",
        FakeIngester,
    )

    files._run_dicom_ingester_safe(
        user_id=user_id,
        study_id=study_id,
        file_id="R-NEW",
        force_patient_hash=True,
    )

    assert captured.get("patient_hash") == H_new, (
        f"REGRESSION — _run_dicom_ingester_safe used the wrong "
        f"patient_hash. Expected {H_new!r} (looked up via file_id), "
        f"got {captured.get('patient_hash')!r}. This is exactly the "
        f"bug that caused new patients' imaging findings to land on "
        f"older patients."
    )


# ─────────────────────────────────────────────────────────────────────
# Bug #1 + Bug #3: _run_quick_scan_after_ingest fork
# ─────────────────────────────────────────────────────────────────────


def test_quick_scan_after_ingest_resolves_patient_via_file_id(
    isolated_rune_home, isolated_db, tmp_path, monkeypatch,
):
    """The patient_hash inside _run_quick_scan_after_ingest must be
    resolved via file_id, not via dicom_study_id ORDER BY DESC.

    Two upload rows, same study_id, different patients — calling with
    file_id=R_new must produce findings tagged with H_new.
    """
    from nexus_server import files, quick_scan
    from nexus_server import twin_event_log

    H_old = "patient-hash-OLD-bb"
    H_new = "patient-hash-NEW-cc"
    user_id = "doctor-qian"
    study_id = "study-xx-99"

    _insert_upload_row(
        isolated_db, file_id="R-OLD-FILE", user_id=user_id,
        patient_hash=H_old, dicom_study_id=study_id,
        created_at="2026-06-15T11:00:00",
    )
    _insert_upload_row(
        isolated_db, file_id="R-NEW-FILE", user_id=user_id,
        patient_hash=H_new, dicom_study_id=study_id,
        created_at="2026-06-15T10:00:00",  # older — would lose ORDER BY DESC
    )

    # Stub the actual Gemini sweep — we want to exercise the patient
    # routing path, not LLM I/O.
    monkeypatch.setattr(
        quick_scan, "_run_quick_scan_sync",
        lambda user_id, study_id: None,
    )

    # Seed a fake SDK EventLog with one assistant_response.quick_scan
    # report containing one flagged finding.
    db_path = tmp_path / user_id / "event_log" / "agent.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(str(db_path)) as c:
        c.execute(
            "CREATE TABLE events (idx INTEGER PRIMARY KEY, "
            "timestamp INTEGER, event_type TEXT, content TEXT, "
            "metadata TEXT, agent_id TEXT, session_id TEXT)"
        )
        import json as _json
        c.execute(
            "INSERT INTO events (idx, timestamp, event_type, content, "
            "metadata, agent_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                1, 0, "assistant_response", "(scan)",
                _json.dumps({
                    "kind": "quick_scan_report",
                    "study_id": study_id,
                    "findings": [
                        {"finding": "suspected 1cm RUL nodule",
                         "verdict": "suspicious",
                         "urgency": "moderate"},
                    ],
                    "summary_counts": {
                        "clean": 0, "suspicious": 1, "error": 0,
                    },
                }),
                "agent-1", "session-1",
            ),
        )
        c.commit()
    monkeypatch.setattr(
        twin_event_log, "_db_path", lambda uid: db_path,
    )

    # Capture every NODE_ADDED event emitted.
    emitted: list[dict] = []

    def fake_emit_and_apply(self, *, kind, payload, apply_fn,
                            user_id, patient_hash, **kwargs):
        emitted.append({
            "kind": kind, "patient_hash": patient_hash,
            "payload": payload,
        })

    monkeypatch.setattr(
        "nexus_server.event_sourcing.store.Store.emit_and_apply",
        fake_emit_and_apply,
    )

    files._run_quick_scan_after_ingest(
        user_id=user_id,
        study_id=study_id,
        file_id="R-NEW-FILE",
    )

    # Every NODE_ADDED for the finding must land on H_new — never H_old.
    finding_emits = [e for e in emitted
                     if e["payload"].get("node_type") == "finding"]
    assert finding_emits, "expected at least one finding NODE_ADDED"
    for e in finding_emits:
        assert e["patient_hash"] == H_new, (
            f"REGRESSION — finding node emitted under wrong patient. "
            f"Expected H_new={H_new!r}, got {e['patient_hash']!r}. "
            f"This means quick_scan resolved patient_hash via the "
            f"dicom_study_id row (which the legacy ORDER BY DESC "
            f"would pick) instead of the supplied file_id."
        )


def test_quick_scan_after_ingest_with_no_file_id_refuses_ambiguous(
    isolated_rune_home, isolated_db, tmp_path, monkeypatch,
):
    """Fix-D guardrail: when called WITHOUT file_id, if uploads has
    multiple distinct patient_hash bindings for the same study_id,
    the helper MUST raise — refusing to silently pick a "winner".
    Patient safety > automation.
    """
    from nexus_server import files, quick_scan
    from nexus_server import twin_event_log

    user_id = "doctor-qian"
    study_id = "study-ambig"

    _insert_upload_row(
        isolated_db, file_id="A", user_id=user_id,
        patient_hash="hash-A", dicom_study_id=study_id,
    )
    _insert_upload_row(
        isolated_db, file_id="B", user_id=user_id,
        patient_hash="hash-B", dicom_study_id=study_id,
    )

    monkeypatch.setattr(
        quick_scan, "_run_quick_scan_sync",
        lambda user_id, study_id: None,
    )

    # Fake empty SDK event log so we get past the SDK query before
    # hitting the patient-resolution code.
    db_path = tmp_path / user_id / "event_log" / "agent.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(str(db_path)) as c:
        c.execute(
            "CREATE TABLE events (idx INTEGER PRIMARY KEY, "
            "timestamp INTEGER, event_type TEXT, content TEXT, "
            "metadata TEXT, agent_id TEXT, session_id TEXT)"
        )
        import json as _json
        c.execute(
            "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)",
            (1, 0, "assistant_response", "(scan)",
             _json.dumps({
                 "kind": "quick_scan_report",
                 "study_id": study_id,
                 "findings": [
                     {"finding": "x", "verdict": "suspicious",
                      "urgency": "moderate"},
                 ],
                 "summary_counts": {"clean": 0, "suspicious": 1},
             }),
             "a", "s"),
        )
        c.commit()
    monkeypatch.setattr(
        twin_event_log, "_db_path", lambda uid: db_path,
    )

    # No file_id passed; expect RuntimeError because two distinct
    # patient_hash values are bound to study_id.
    with pytest.raises(RuntimeError, match="ambiguous patient binding"):
        files._run_quick_scan_after_ingest(
            user_id=user_id, study_id=study_id,
            # NOTE: file_id intentionally omitted
        )


# ─────────────────────────────────────────────────────────────────────
# retry_quick_scan_for_study must refuse ambiguous bindings
# ─────────────────────────────────────────────────────────────────────


def test_retry_quick_scan_refuses_when_study_bound_to_multiple_patients(
    isolated_db, monkeypatch,
):
    """The manual retry path must NOT silently pick "the most recent"
    upload row when multiple distinct patient_hash values bind to the
    same dicom_study_id. That's exactly how findings leaked across
    patients in the original bug.
    """
    from nexus_server import files

    user_id = "doctor-qian"
    study_id = "study-leaky"

    _insert_upload_row(
        isolated_db, file_id="OLD", user_id=user_id,
        patient_hash="hash-OLD", dicom_study_id=study_id,
        created_at="2026-06-15T10:00:00",
    )
    _insert_upload_row(
        isolated_db, file_id="NEW", user_id=user_id,
        patient_hash="hash-NEW", dicom_study_id=study_id,
        created_at="2026-06-15T11:00:00",
    )

    # If the function DID try to run, this would explode loudly.
    def boom(**kwargs):
        raise AssertionError(
            f"retry_quick_scan_for_study INVOKED the worker despite "
            f"ambiguous binding: kwargs={kwargs}"
        )

    monkeypatch.setattr(files, "_run_quick_scan_after_ingest", boom)

    # Must NOT raise — silent no-op + log. (The error is loud in logs.)
    files.retry_quick_scan_for_study(user_id, study_id)

    # And critically, neither uploads row had its status flipped to
    # pending — because we refused to retry at all.
    with sqlite3.connect(isolated_db) as c:
        for fid in ("OLD", "NEW"):
            r = c.execute(
                "SELECT quick_scan_status FROM uploads WHERE file_id = ?",
                (fid,),
            ).fetchone()
            assert r[0] != "pending", (
                f"row {fid} got flipped to pending despite the "
                f"ambiguity guard."
            )
