"""
Regression tests for Quick scan streaming progress (#198).

What we guard:
  - ``_set_quick_scan_progress`` builds the right shape on first push
    (the desktop's TypeScript ``QuickScanProgress`` interface depends
    on every documented key).
  - ``_push_recent__`` appends to a BOUNDED ring (otherwise a chest-CT
    triple-window scan with 75 lines would balloon the dict).
  - ``_clear_quick_scan_progress`` actually drops the entry — needed
    so a manual Retry starts at zero counters instead of inheriting
    the failed previous run's "8/75 grids" state.
  - The prerender-progress HTTP endpoint merges in
    ``quick_scan_progress`` when the upload's study has a live entry.
"""
from __future__ import annotations

import pathlib
import sqlite3
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# Module-level dict shape
# ─────────────────────────────────────────────────────────────────────


def test_set_progress_initial_shape():
    """First push must populate every key the desktop UI consumes."""
    from nexus_server import quick_scan
    quick_scan._clear_quick_scan_progress("study-1")

    quick_scan._set_quick_scan_progress(
        "study-1", stage="rendering", total_grids=75,
        presets=["lung", "mediastinum", "bone"],
        current_preset="lung",
    )

    snap = quick_scan.get_quick_scan_progress("study-1")
    assert snap is not None
    for key in ("stage", "started_at", "elapsed_s",
                "total_grids", "rendered_grids", "triaged_grids",
                "errors", "presets", "current_preset", "recent"):
        assert key in snap, (
            f"progress dict missing key {key!r} — desktop "
            "QuickScanProgress interface depends on it."
        )
    assert snap["stage"] == "rendering"
    assert snap["total_grids"] == 75
    assert snap["presets"] == ["lung", "mediastinum", "bone"]
    assert snap["current_preset"] == "lung"


def test_recent_ring_is_bounded():
    """Push more entries than the cap; only the most-recent ones
    should remain. Without this guard, a 75-grid chest CT trips the
    8-line limit but keeps growing the list (memory leak + UI render
    overflow)."""
    from nexus_server import quick_scan
    quick_scan._clear_quick_scan_progress("study-bound")

    for i in range(40):
        quick_scan._set_quick_scan_progress(
            "study-bound",
            __push_recent__={
                "slice_start": i, "slice_end": i + 15,
                "window": "lung", "verdict": "suspicious",
                "finding": f"line-{i}",
                "urgency": "moderate", "error": "",
            },
        )

    snap = quick_scan.get_quick_scan_progress("study-bound")
    assert snap is not None
    assert len(snap["recent"]) == quick_scan._QSP_RECENT_CAP, (
        f"recent buffer should cap at {quick_scan._QSP_RECENT_CAP}, "
        f"got {len(snap['recent'])}"
    )
    # And it must be the TAIL we kept (newest), not the head.
    assert snap["recent"][-1]["finding"] == "line-39"
    assert snap["recent"][0]["finding"] == \
        f"line-{40 - quick_scan._QSP_RECENT_CAP}"


def test_clear_progress_drops_entry():
    """Retry-flow contract: clearing makes the next get_… return None."""
    from nexus_server import quick_scan
    quick_scan._set_quick_scan_progress("study-x", stage="triaging")
    assert quick_scan.get_quick_scan_progress("study-x") is not None
    quick_scan._clear_quick_scan_progress("study-x")
    assert quick_scan.get_quick_scan_progress("study-x") is None


def test_stale_completed_entries_are_pruned():
    """Completed scans older than _QSP_TTL_SECONDS must be GC'd on
    each subsequent push so a chatty week of uploads doesn't leak the
    dict to thousands of entries."""
    from nexus_server import quick_scan

    quick_scan._set_quick_scan_progress("old-study", stage="complete")
    # Backdate the started_at past the TTL.
    snap = quick_scan._quick_scan_progress["old-study"]
    snap["started_at"] = 0  # epoch — clearly past TTL

    # Trigger any push that re-enters the GC branch.
    quick_scan._set_quick_scan_progress("new-study", stage="complete")
    assert "old-study" not in quick_scan._quick_scan_progress, (
        "Stale completed entry should have been GC'd."
    )
    quick_scan._clear_quick_scan_progress("new-study")


# ─────────────────────────────────────────────────────────────────────
# Endpoint merge — prerender-progress includes live quick_scan_progress
# ─────────────────────────────────────────────────────────────────────


def test_prerender_endpoint_surfaces_live_quick_scan_progress(
    tmp_path, monkeypatch,
):
    """Integration: when an uploads row's dicom_study_id matches a
    live ``_quick_scan_progress`` entry, the prerender-progress
    response must include it under ``quick_scan_progress``. This is
    the bridge that lets the desktop's 2-second poll get streaming
    grid counters into the UploadJobRow."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from nexus_server.auth.routes import get_current_user
    from nexus_server.config import ServerConfig
    from nexus_server.migrations.runner import run_migrations
    from nexus_server import files, quick_scan

    db = tmp_path / "qsp.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")
    run_migrations()
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO uploads "
            "(file_id, user_id, name, mime, size_bytes, sha256, "
            " disk_path, created_at, dicom_study_id, dicom_status, "
            " quick_scan_status, quick_scan_summary) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("file-poll", "u1", "ct.zip", "application/zip", 1, "x",
             "/tmp/x.zip", "2026-06-14",
             "study-live", "rendered", "pending", ""),
        )
        c.commit()

    # Plant a live progress entry as if the worker is mid-flight.
    quick_scan._clear_quick_scan_progress("study-live")
    quick_scan._set_quick_scan_progress(
        "study-live", stage="triaging", total_grids=75,
        rendered_grids=75, triaged_grids=23, errors=0,
        presets=["lung", "mediastinum", "bone"],
        current_preset="mediastinum",
        __push_recent__={
            "slice_start": 16, "slice_end": 31, "window": "lung",
            "verdict": "suspicious", "finding": "8mm RUL nodule",
            "urgency": "moderate", "error": "",
        },
    )

    app = FastAPI()
    app.include_router(files.router)
    app.dependency_overrides[get_current_user] = lambda: "u1"
    client = TestClient(app)
    r = client.get("/api/v1/files/file-poll/prerender-progress")
    assert r.status_code == 200, r.text
    body = r.json()

    assert "quick_scan_progress" in body, (
        "Endpoint response missing quick_scan_progress field; "
        "desktop's streaming UI will never get the live state."
    )
    qsp = body["quick_scan_progress"]
    assert qsp is not None, (
        "uploads.dicom_study_id is set AND a live progress entry "
        "exists — endpoint should NOT return null here."
    )
    assert qsp["stage"] == "triaging"
    assert qsp["triaged_grids"] == 23
    assert qsp["total_grids"] == 75
    assert qsp["current_preset"] == "mediastinum"
    assert len(qsp["recent"]) == 1
    assert "RUL nodule" in qsp["recent"][0]["finding"]

    # Cleanup so subsequent tests start clean.
    quick_scan._clear_quick_scan_progress("study-live")


def test_prerender_endpoint_returns_null_progress_when_none_active(
    tmp_path, monkeypatch,
):
    """A history row with no live scan must return null progress, not
    crash. The desktop treats null as "nothing to stream"."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from nexus_server.auth.routes import get_current_user
    from nexus_server.config import ServerConfig
    from nexus_server.migrations.runner import run_migrations
    from nexus_server import files

    db = tmp_path / "qsp2.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")
    run_migrations()
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO uploads "
            "(file_id, user_id, name, mime, size_bytes, sha256, "
            " disk_path, created_at, dicom_study_id, dicom_status, "
            " quick_scan_status, quick_scan_summary) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("file-q", "u1", "ct.zip", "application/zip", 1, "x",
             "/tmp/x.zip", "2026-06-14",
             "old-study-no-progress", "rendered", "ok", "no findings"),
        )
        c.commit()

    app = FastAPI()
    app.include_router(files.router)
    app.dependency_overrides[get_current_user] = lambda: "u1"
    client = TestClient(app)
    r = client.get("/api/v1/files/file-q/prerender-progress")
    assert r.status_code == 200
    body = r.json()
    assert body["quick_scan_progress"] is None
