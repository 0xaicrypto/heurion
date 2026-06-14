"""
Two unrelated post-launch fixes (#197):

A. DICOM viewer 404 — the FastAPI app mounts ``nexus_server/static`` at
   ``/dicom-viewer/`` with StaticFiles(html=True). That makes a request
   to ``/dicom-viewer/`` look for ``static/index.html`` — but the file
   was named ``dicom-viewer.html``. So clicking "Open viewer" from
   the Imaging card hit a 404. Fix = rename to ``index.html`` AND
   bundle the static dir in the PyInstaller spec (it was missing
   entirely, so the .app shipped without any viewer assets at all).

B. Quick scan summary lied — ``_run_quick_scan_after_ingest`` rendered
   "no findings" whether every grid came back ``clean`` (genuinely
   unremarkable image) or every grid came back ``error`` (Gemini API
   key dead, quota burned, network out). The medic couldn't tell the
   two apart. Fix = read summary_counts.error from the metadata and
   surface "scan failed on N/M grids" when errors dominate.

These tests guard the contract; the behavioural side of B requires
running the full Gemini stack, which we cover with a synthesised SDK
EventLog row.
"""
from __future__ import annotations

import json
import pathlib
import re
import sqlite3
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# A. Viewer 404 — static dir layout + spec bundling
# ─────────────────────────────────────────────────────────────────────


def test_static_dir_has_index_html_for_dicom_viewer():
    """FastAPI mounts ``static/`` at ``/dicom-viewer/`` with html=True.
    Without ``static/index.html`` the mount returns 404 for the
    canonical ``/dicom-viewer/?studyId=…`` URL the desktop builds."""
    static_dir = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "static"
    )
    assert (static_dir / "index.html").exists(), (
        "static/index.html missing — StaticFiles(html=True) returns 404 "
        "for /dicom-viewer/ without it. The viewer link from the "
        "Imaging card now 404s. Either rename the viewer HTML to "
        "index.html, or add an index that includes/redirects to it."
    )
    # The previous filename should NOT also exist (a leftover would
    # silently shadow the rename in future merge resolutions).
    assert not (static_dir / "dicom-viewer.html").exists(), (
        "Both static/index.html AND static/dicom-viewer.html exist — "
        "drop the legacy filename so the rename is final."
    )


def test_pyinstaller_spec_bundles_static_dir():
    """The bundled .app must include nexus_server/static/ so the
    server's mount finds the viewer files at runtime. Without this,
    the desktop build's FastAPI mounts an empty dir and every viewer
    URL returns 404 — even though running the server from source works.

    Sibling of test_pyinstaller_spec_bundles_migrations_under_nexus_server_prefix —
    the same destination-prefix discipline applies."""
    spec = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus-server.spec"
    ).read_text()

    assert "static_data" in spec, (
        "spec lost its static_data list — viewer HTML won't ship in "
        "the bundle and /dicom-viewer/ will 404 in any .dmg build."
    )
    # The list must reference the static dir under NEXUS_SERVER, and
    # use relative_to(ROOT) so the bundle destination keeps the
    # ``nexus_server/static/`` prefix (matching the live mount point).
    m_block = re.search(
        r"static_data = \[\][\s\S]*?if static_root\.exists\(\):[\s\S]*?"
        r"static_data\.append\(",
        spec,
    )
    assert m_block, "static_data block missing or restructured"
    block = m_block.group(0)
    assert "relative_to(ROOT)" in block, (
        "static_data must use relative_to(ROOT) so the destination "
        "preserves the nexus_server/static/ prefix. Without it the "
        "files land at _MEIPASS/static/ but the mount expects "
        "_MEIPASS/nexus_server/static/."
    )
    # The Analysis(...) call must include static_data in its datas.
    assert "static_data" in spec.split("datas=", 1)[1].split(",", 1)[0] \
        or "static_data," in spec.split("datas=", 1)[1].split(")", 1)[0], (
            "Analysis(datas=...) doesn't list static_data — the spec "
            "defines the list but never plugs it in."
        )


# ─────────────────────────────────────────────────────────────────────
# B. Quick scan summary — distinguish 'clean' from 'errored out'
# ─────────────────────────────────────────────────────────────────────


def _stage_sdk_event_log(tmp_path, *, meta: dict, user_id="test-user"):
    """Plant a synthetic quick_scan_report row in a fake SDK EventLog DB."""
    db_path = tmp_path / user_id / "event_log" / "user-test.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE events (
            idx INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            event_type TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT DEFAULT '{}',
            agent_id TEXT NOT NULL,
            session_id TEXT DEFAULT ''
        )
    """)
    conn.execute(
        "INSERT INTO events (timestamp, event_type, content, metadata, agent_id) "
        "VALUES (?, ?, ?, ?, ?)",
        (1.0, "assistant_response", "report",
         json.dumps(meta), "agent-test"),
    )
    conn.commit()
    conn.close()
    return db_path


def _run_helper(tmp_path, monkeypatch, *, meta: dict) -> str:
    """Invoke _run_quick_scan_after_ingest with a pre-seeded SDK
    EventLog DB and stubbed worker; return the summary string."""
    db_path = _stage_sdk_event_log(tmp_path, meta=meta)
    from nexus_server import files, twin_event_log, quick_scan

    # Re-point the SDK DB resolver at the fake DB.
    monkeypatch.setattr(twin_event_log, "_db_path", lambda uid: db_path)
    # Skip the actual Gemini worker.
    monkeypatch.setattr(
        quick_scan, "_run_quick_scan_sync",
        lambda user_id, study_id: None,
    )

    return files._run_quick_scan_after_ingest(
        user_id="test-user", study_id="study-1",
    )


def test_summary_genuinely_clean_scan(tmp_path, monkeypatch):
    """All grids came back clean → summary says scan completed AND
    surfaces the counts so the medic knows it actually ran."""
    summary = _run_helper(tmp_path, monkeypatch, meta={
        "kind":     "quick_scan_report",
        "study_id": "study-1",
        "findings": [],
        "summary_counts": {
            "clean": 25, "error": 0, "unsure": 0,
            "critical": 0, "moderate": 0, "incidental": 0,
        },
    })
    assert "no flagged" in summary
    assert "25/25" in summary or "clean" in summary, (
        f"Summary should report scan coverage on a clean scan; got {summary!r}"
    )


def test_summary_all_grids_errored_raises(tmp_path, monkeypatch):
    """Every Gemini call failed → helper MUST raise. The caller's
    try/except writes ``quick_scan_status='error'`` (not 'ok'), which
    is what makes the UploadJobRow's Retry button render. If we kept
    returning a "scan failed" string with status='ok' the medic would
    see green badge + red text + no Retry — exactly the misleading
    state #197 reported."""
    with pytest.raises(RuntimeError, match=r"scan failed.*25/25.*GEMINI_API_KEY"):
        _run_helper(tmp_path, monkeypatch, meta={
            "kind":     "quick_scan_report",
            "study_id": "study-1",
            "findings": [],
            "summary_counts": {
                "clean": 0, "error": 25, "unsure": 0,
                "critical": 0, "moderate": 0, "incidental": 0,
            },
        })


def test_summary_mixed_some_errors_raises(tmp_path, monkeypatch):
    """Half errored, half clean → still raise so the medic can retry.
    A half-broken scan is NOT representative (some windows might have
    succeeded, others died) — we don't want to silently grade-A this."""
    with pytest.raises(RuntimeError, match=r"scan failed.*15/25"):
        _run_helper(tmp_path, monkeypatch, meta={
            "kind":     "quick_scan_report",
            "study_id": "study-1",
            "findings": [],
            "summary_counts": {
                "clean": 10, "error": 15, "unsure": 0,
                "critical": 0, "moderate": 0, "incidental": 0,
            },
        })


def test_summary_retry_caller_writes_error_status(tmp_path, monkeypatch):
    """Integration: when the helper raises, ``retry_quick_scan_for_study``
    must write ``quick_scan_status='error'`` to the uploads row, which
    is the state the Retry button gates on. Validates the end-to-end
    UX contract: scan fails → Retry shows → medic fixes key → click
    Retry → repeat."""
    import sqlite3 as _sqlite3
    from nexus_server import files, twin_event_log, quick_scan
    from nexus_server.config import ServerConfig
    from nexus_server.migrations.runner import run_migrations

    # Stand up a tmp DB with the schema + an uploads row in 'error' state.
    db = tmp_path / "qs.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")
    run_migrations()
    with _sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO uploads "
            "(file_id, user_id, name, mime, size_bytes, sha256, "
            " disk_path, created_at, dicom_study_id, dicom_status, "
            " memory_status, quick_scan_status, quick_scan_summary) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("file-x", "test-user", "ct.zip", "application/zip",
             1, "x", "/tmp/x.zip", "2026-06-14",
             "study-x", "rendered", "ok", "ok", "1 flagged"),
        )
        c.commit()

    # Stage SDK EventLog with all-error scan result.
    db_path = _stage_sdk_event_log(tmp_path, meta={
        "kind":     "quick_scan_report",
        "study_id": "study-x",
        "findings": [],
        "summary_counts": {
            "clean": 0, "error": 20, "unsure": 0,
            "critical": 0, "moderate": 0, "incidental": 0,
        },
    })
    monkeypatch.setattr(twin_event_log, "_db_path", lambda uid: db_path)
    monkeypatch.setattr(
        quick_scan, "_run_quick_scan_sync",
        lambda user_id, study_id: None,
    )

    files.retry_quick_scan_for_study("test-user", "study-x")

    with _sqlite3.connect(db) as c:
        row = c.execute(
            "SELECT quick_scan_status, quick_scan_summary FROM uploads "
            "WHERE file_id = 'file-x'"
        ).fetchone()
    assert row[0] == "error", (
        f"After all-error scan, quick_scan_status MUST be 'error' so "
        f"the Retry button appears; got {row[0]!r}"
    )
    assert "GEMINI_API_KEY" in row[1] or "scan failed" in row[1], (
        f"Error summary should hint at the API-key cause: {row[1]!r}"
    )


def test_live_gemini_api_key_picks_up_settings_save(tmp_path, monkeypatch):
    """Regression: GEMINI_API_KEY edits in $RUNE_HOME/.env (Settings ·
    LLM → Save writes there) MUST take effect on the next Quick scan
    without restarting the sidecar. Previously ``config.GEMINI_API_KEY``
    was captured at module import → medic had to Restart sidecar to
    pick up a fresh key, which is bad UX especially right after a
    failed scan triggered by the OLD dead key."""
    from nexus_server import quick_scan

    # Set up a fake RUNE_HOME with a new key in the .env file.
    rune_home = tmp_path / "RuneProtocol"
    rune_home.mkdir(parents=True)
    (rune_home / ".env").write_text(
        "# Saved by Settings · LLM\n"
        "GEMINI_API_KEY=NEW_KEY_FROM_SETTINGS_LLM\n"
    )
    monkeypatch.setenv("RUNE_HOME", str(rune_home))
    # Sanity: even if process env has an OLD key, the .env wins.
    monkeypatch.setenv("GEMINI_API_KEY", "STALE_PROCESS_ENV_KEY")

    got = quick_scan._live_gemini_api_key()
    assert got == "NEW_KEY_FROM_SETTINGS_LLM", (
        f"_live_gemini_api_key should prefer $RUNE_HOME/.env over the "
        f"cached process env, but got {got!r}. Medic's Settings · LLM "
        f"save won't take effect without sidecar restart."
    )


def test_live_gemini_api_key_falls_back_to_env_then_config(tmp_path, monkeypatch):
    """When ``$RUNE_HOME/.env`` is missing or has no GEMINI_API_KEY,
    fall through to ``os.environ`` then to the cached config — so
    headless test runs and CI still get a key from the standard
    Pydantic-settings path."""
    from nexus_server import quick_scan
    from nexus_server.config import ServerConfig

    # No RUNE_HOME → must fall through to env then config.
    monkeypatch.delenv("RUNE_HOME", raising=False)

    # Env has it → wins over the cached config.
    monkeypatch.setenv("GEMINI_API_KEY", "FROM_PROCESS_ENV")
    assert quick_scan._live_gemini_api_key() == "FROM_PROCESS_ENV"

    # Env missing → fall back to cached config.
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(ServerConfig, "GEMINI_API_KEY", "FROM_CACHED_CONFIG")
    assert quick_scan._live_gemini_api_key() == "FROM_CACHED_CONFIG"

    # Everything missing → empty string (NOT None — the caller does
    # ``if not api_key:`` and emits a friendly "GEMINI_API_KEY not
    # configured" finding).
    monkeypatch.setattr(ServerConfig, "GEMINI_API_KEY", None)
    assert quick_scan._live_gemini_api_key() == ""


def test_summary_findings_still_win_over_error_signal(tmp_path, monkeypatch):
    """Some flagged findings + some errors → the flagged count takes
    priority (we don't want to suppress real findings just because
    other grids errored)."""
    summary = _run_helper(tmp_path, monkeypatch, meta={
        "kind":     "quick_scan_report",
        "study_id": "study-1",
        "findings": [
            {"verdict": "suspicious", "finding": "RUL nodule", "urgency": "moderate"},
            {"verdict": "unsure",     "finding": "vague mediastinum", "urgency": ""},
        ],
        "summary_counts": {
            "clean": 5, "error": 18, "unsure": 1,
            "critical": 0, "moderate": 1, "incidental": 0,
        },
    })
    assert "2 flagged" in summary, (
        f"Real findings shouldn't be hidden by parallel errors; got {summary!r}"
    )
