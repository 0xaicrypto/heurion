"""
Regression tests for the manual Quick scan retry flow.

Surface area:
  * Backend helper ``files.retry_quick_scan_for_study`` — must (1) flip
    the uploads row to ``pending`` before running, (2) call the same
    post-ingest pipeline that the Tier-A auto-fire uses, (3) write back
    ``ok`` + summary on success or ``error`` + traceback on failure.
  * Backend route ``POST /api/v1/dicom/studies/{study_id}/quick-scan``
    — must delegate to ``retry_quick_scan_for_study`` via BackgroundTasks
    (not the bare ``trigger_quick_scan`` worker, which would leave the
    uploads row stuck at the previous 'error' state — invisible retry).
  * Frontend wire-up — ``api.triggerQuickScan(studyId)`` must exist on
    the desktop ApiClient, and the UploadJobRow must render a Retry
    button when ``quickScanStatus === 'error'``.

The frontend assertions are source-level greps (we don't run vitest
yet), but they catch the key contract: "Retry button is wired to the
study id". Without that, the user is stuck on the red error forever.
"""
from __future__ import annotations

import pathlib
import re
import sqlite3
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _setup_db(tmp_path, monkeypatch, study_id="study-1"):
    """Build a tmp DB at head + insert a fake uploads row whose Quick
    scan previously failed."""
    db = tmp_path / "retry.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    from nexus_server.config import ServerConfig
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")

    from nexus_server.migrations.runner import run_migrations
    run_migrations()

    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO uploads "
            "(file_id, user_id, name, mime, size_bytes, sha256, "
            " disk_path, created_at, dicom_study_id, dicom_status, "
            " memory_status, memory_summary, "
            " quick_scan_status, quick_scan_summary) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "file-abc", "test-user", "ct.zip", "application/zip",
                1_000_000, "deadbeef",
                "/tmp/fake-disk-path.zip",
                "2026-06-14T10:00:00",
                study_id, "rendered",
                "ok", "6 graph events",
                # The state we're retrying from — the old failure left
                # this red. After retry runs, both should flip.
                "error", "OperationalError: no such table: twin_event_log",
            ),
        )
        c.commit()

    return db


# ─────────────────────────────────────────────────────────────────────
# Backend behavioural tests
# ─────────────────────────────────────────────────────────────────────


def test_retry_quick_scan_for_study_flips_to_pending_then_ok(
    tmp_path, monkeypatch,
):
    """Happy path: a previously-failed uploads row gets flipped to
    pending while the worker runs, then to ok+summary at the end.

    We stub the actual ``_run_quick_scan_after_ingest`` so the test
    doesn't try to render DICOMs / talk to Gemini — we ONLY exercise
    the status-bookkeeping side, which is what was broken before.
    """
    db = _setup_db(tmp_path, monkeypatch)

    from nexus_server import files

    # Track whether the pending status was visible at the moment the
    # worker started — that's the contract the frontend's poll relies on.
    seen_pending: list[str] = []

    def fake_run(*, user_id: str, study_id: str) -> str:
        with sqlite3.connect(db) as c:
            row = c.execute(
                "SELECT quick_scan_status FROM uploads WHERE file_id = 'file-abc'"
            ).fetchone()
            seen_pending.append(row[0] if row else "<missing>")
        return "1 flagged finding(s)"

    monkeypatch.setattr(files, "_run_quick_scan_after_ingest", fake_run)

    files.retry_quick_scan_for_study("test-user", "study-1")

    # ── Pending was visible mid-flight ──
    assert seen_pending == ["pending"], (
        "retry_quick_scan_for_study didn't mark uploads.quick_scan_status "
        "= 'pending' before invoking the worker. Without this, the desktop "
        "Imaging card's poll never sees the in-progress state and the "
        "Retry button stays clickable (causing double-runs)."
    )

    # ── Final state is ok + summary ──
    with sqlite3.connect(db) as c:
        row = c.execute(
            "SELECT quick_scan_status, quick_scan_summary FROM uploads "
            "WHERE file_id = 'file-abc'"
        ).fetchone()
    assert row[0] == "ok"
    assert row[1] == "1 flagged finding(s)"


def test_retry_quick_scan_for_study_writes_error_on_exception(
    tmp_path, monkeypatch,
):
    """If the worker raises, the row must end up as ``error`` with the
    exception class + message — not stuck at 'pending' (which would
    leave the Retry button hidden and the medic without a way out)."""
    db = _setup_db(tmp_path, monkeypatch)

    from nexus_server import files

    def fake_run(*, user_id: str, study_id: str) -> str:
        raise RuntimeError("Gemini API rate-limited")

    monkeypatch.setattr(files, "_run_quick_scan_after_ingest", fake_run)
    files.retry_quick_scan_for_study("test-user", "study-1")

    with sqlite3.connect(db) as c:
        row = c.execute(
            "SELECT quick_scan_status, quick_scan_summary FROM uploads "
            "WHERE file_id = 'file-abc'"
        ).fetchone()
    assert row[0] == "error"
    assert "RuntimeError" in row[1]
    assert "Gemini API rate-limited" in row[1]


def test_retry_quick_scan_for_study_no_row_is_silent_noop(
    tmp_path, monkeypatch,
):
    """Retrying a study id that doesn't exist in uploads must not raise
    — the user could have deleted the upload between the failure and
    clicking retry."""
    _setup_db(tmp_path, monkeypatch)

    from nexus_server import files
    called = []
    monkeypatch.setattr(
        files, "_run_quick_scan_after_ingest",
        lambda **kw: called.append(kw) or "should not reach",
    )

    # Doesn't raise.
    files.retry_quick_scan_for_study("test-user", "study-does-not-exist")

    # And the worker is NOT invoked (no row → nothing to update).
    assert called == [], (
        "retry_quick_scan_for_study invoked the Gemini worker even "
        "when no uploads row matched the study id — wasted API call."
    )


def test_quick_scan_endpoint_delegates_to_retry_helper():
    """Source-level guard: the ``POST /studies/{id}/quick-scan`` route
    must use ``retry_quick_scan_for_study`` (which updates the uploads
    row) — NOT the bare ``trigger_quick_scan`` worker (which leaves the
    uploads row's quick_scan_status='error' stuck even after a successful
    retry, so the medic thinks Retry did nothing)."""
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "nexus_server" / "quick_scan.py").read_text()

    # Look at the post_quick_scan handler body.
    m = re.search(
        r"async def post_quick_scan\(.*?\n"
        r"(?P<body>.*?)\nasync def |\Z",
        src, re.DOTALL,
    )
    assert m, "could not locate post_quick_scan in quick_scan.py"
    body = m.group("body")

    assert "retry_quick_scan_for_study" in body, (
        "post_quick_scan must delegate to files.retry_quick_scan_for_study "
        "so the manual Retry button actually flips the uploads row "
        "back to pending → ok/error. Without this, the worker runs but "
        "the Imaging card UI never updates from the previous 'error' "
        "state."
    )


# ─────────────────────────────────────────────────────────────────────
# Frontend wire-up — source-level greps
# ─────────────────────────────────────────────────────────────────────


DESKTOP_SRC = (
    pathlib.Path(__file__).resolve().parents[2] / "desktop-v2" / "src"
)


def test_api_client_exposes_triggerQuickScan_method():
    """The ApiClient must define ``triggerQuickScan(studyId)`` so the
    Imaging mode's Retry handler has something to call. Without this
    method, the Retry button compiles but does nothing."""
    src = (DESKTOP_SRC / "lib" / "api-client.ts").read_text()
    assert "async triggerQuickScan(" in src, (
        "ApiClient is missing the triggerQuickScan method. The Retry "
        "button in UploadJobRow depends on it."
    )
    # And the URL pattern must match the server route exactly.
    assert re.search(
        r"/api/v1/dicom/studies/.+/quick-scan",
        src,
    ), (
        "triggerQuickScan doesn't POST to /api/v1/dicom/studies/"
        "{id}/quick-scan — that's the only retry-aware endpoint."
    )


def test_imaging_mode_renders_retry_button_for_failed_quick_scan():
    """UploadJobRow must render a Retry button when
    ``quickScanStatus === 'error'``. The button is the user-visible
    half of this feature; without it the api-client method is dead
    code."""
    src = (DESKTOP_SRC / "modes.tsx").read_text()

    # The retry callback must be wired through as a prop AND consumed.
    assert "onRetryQuickScan" in src, (
        "UploadJobRow has no onRetryQuickScan prop wired up — the Retry "
        "button can't trigger anything without it."
    )
    # The button must only render on the error state — pending/ok don't
    # want this affordance.
    assert re.search(
        r"quickScanStatus === ['\"]error['\"][^{]*onRetryQuickScan",
        src, re.DOTALL,
    ), (
        "Retry button isn't gated on quickScanStatus==='error'. Showing "
        "it on pending/ok would let the medic stack background tasks."
    )
    # And there must be an actual <button>Retry</button> wired to the
    # callback — guards against a stub render that just shows the text.
    assert "onRetryQuickScan(job)" in src or "onRetryQuickScan?.(job)" in src, (
        "Retry button isn't wired to onRetryQuickScan(job) — clicking "
        "it would be a no-op."
    )


def test_imaging_mode_has_polling_helper_for_retry():
    """The Retry handler must trigger a polling loop so the row's
    pending → ok/error transition shows up in the UI. Without polling,
    the row would sit at 'pending' forever after retry (until the medic
    refreshes the patient or restarts the app)."""
    src = (DESKTOP_SRC / "modes.tsx").read_text()
    assert "pollForJobProgress" in src or "pollPrerender" in src, (
        "ImagingMode is missing a per-job polling helper for the retry "
        "flow. Without it, the Retry button enqueues the work but the "
        "UI stays at 'pending' until the next page refresh."
    )
    # The helper must hit the same endpoint runJob uses — getPrerenderProgress.
    assert "getPrerenderProgress" in src, (
        "Retry polling doesn't go through getPrerenderProgress — that's "
        "the only endpoint that returns quick_scan_status."
    )
