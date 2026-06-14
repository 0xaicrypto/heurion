"""
Regression test: _run_quick_scan_after_ingest must SELECT from the
SDK's per-user EventLog using the RIGHT table name.

Bug history (2026-06-14 production crash):
    files.py:_run_quick_scan_after_ingest ran
        SELECT payload FROM twin_event_log
        WHERE kind = 'assistant_response'
    against the connection returned by twin_event_log._open_readonly(user_id).
    But that opens the SDK's per-user EventLog SQLite, whose table is
    `events` (columns: idx, timestamp, event_type, content, metadata,
    agent_id, session_id) — defined by
    packages/sdk/nexus_core/memory/event_log.py.

    Result: every DICOM upload's Quick scan was reported as
    "🔍 Quick scan failed: OperationalError: no such table: twin_event_log"
    even though the actual triage worker had succeeded.

The test:
  1. Reads the post-ingest helper source and confirms it queries
     ``FROM events`` (the SDK schema), not ``FROM twin_event_log``.
  2. Confirms the metadata-extraction logic uses ``event_type =
     'assistant_response'`` (the SDK column) — and NOT ``kind =`` which
     belongs to a different schema entirely.
  3. Synthesises a fake SDK EventLog DB on disk with the right shape,
     plants a "quick_scan_report" assistant_response row, and
     verifies the helper's findings extraction works against the real
     SDK schema — caught only by running the SQL.
"""
from __future__ import annotations

import importlib
import json
import pathlib
import re
import sqlite3
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# Static guard — source-level
# ─────────────────────────────────────────────────────────────────────


def test_helper_uses_sdk_event_table_not_canonical_table():
    """``_run_quick_scan_after_ingest`` must SELECT FROM the SDK table
    (``events``), NOT the canonical-store table (``twin_event_log``).
    The two share a module name in our codebase but they're entirely
    different SQLite databases with different schemas."""
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "nexus_server" / "files.py").read_text()

    # Pull out just the helper body so we don't false-positive on
    # references elsewhere in the file (memory_router etc. legitimately
    # query the canonical twin_event_log in the MAIN DB).
    m = re.search(
        r"def _run_quick_scan_after_ingest\(.*?\n"
        r"(?P<body>.*?)\n(?:def |\Z)",
        src, re.DOTALL,
    )
    assert m, "could not locate _run_quick_scan_after_ingest in files.py"
    body = m.group("body")

    # Strip Python single-line ``#`` comments before scanning so the
    # bug-history note in the helper docstring/comments doesn't trip
    # the regression check.
    code_only = "\n".join(
        line.split("#", 1)[0]   # cut at the first '#' on each line
        for line in body.splitlines()
    )

    # The SQL must NOT reference the canonical table — that's a
    # cross-database typo that re-introduces the production crash.
    assert "FROM twin_event_log" not in code_only, (
        "Regression — _run_quick_scan_after_ingest is querying "
        "FROM twin_event_log against the SDK's per-user EventLog. "
        "That table doesn't exist there; the SDK schema names it "
        "``events`` (see nexus_core/memory/event_log.py:81). "
        "Use ``FROM events`` instead."
    )
    assert "FROM events" in code_only, (
        "_run_quick_scan_after_ingest must SELECT FROM events (the "
        "SDK EventLog's table). The fix changes the production "
        "'OperationalError: no such table: twin_event_log' Quick "
        "scan crash."
    )
    # The WHERE clause must use the SDK column name too.
    assert "event_type" in code_only, (
        "Helper still filtering by ``kind = …``? SDK column is "
        "``event_type``."
    )


# ─────────────────────────────────────────────────────────────────────
# Behavioural guard — run the helper against a real synthesised SDK DB
# ─────────────────────────────────────────────────────────────────────


def _make_sdk_event_log_db(path: pathlib.Path, rows: list[dict]) -> None:
    """Stand up a fake SDK per-user EventLog with the production schema
    (nexus_core/memory/event_log.py:_init_db) and pre-load some rows.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
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
    for r in rows:
        conn.execute(
            "INSERT INTO events (timestamp, event_type, content, metadata, agent_id, session_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                r.get("timestamp", 0.0),
                r["event_type"],
                r.get("content", ""),
                json.dumps(r.get("metadata", {})),
                r.get("agent_id", "test-agent"),
                r.get("session_id", ""),
            ),
        )
    conn.commit()
    conn.close()


def test_helper_extracts_findings_from_sdk_db(tmp_path, monkeypatch):
    """End-to-end: plant a quick_scan_report in a fake SDK DB and verify
    ``_run_quick_scan_after_ingest`` can locate the matching findings.
    Catches column-name typos that the source-grep test alone wouldn't.
    """
    from nexus_server import files, twin_event_log

    user_id  = "test-user-abc12345"
    study_id = "study-xyz"
    db_path  = tmp_path / user_id / "event_log" / "user-test-abc.db"

    findings = [
        {"verdict": "suspicious", "label": "nodule rul"},
        {"verdict": "clean",      "label": "left lung field"},
    ]
    _make_sdk_event_log_db(db_path, [
        # Unrelated event — should be ignored.
        {"event_type": "user_message", "content": "hello",
         "metadata": {}, "agent_id": "test-agent"},
        # The Quick scan report event.
        {"event_type": "assistant_response",
         "content": "🔍 Quick scan report",
         "metadata": {
             "kind":     "quick_scan_report",
             "study_id": study_id,
             "findings": findings,
         },
         "agent_id": "test-agent"},
    ])

    # Re-point the SDK DB resolver at our tmp path. We monkeypatch the
    # private helpers in twin_event_log so the helper's
    # ``_open_readonly`` returns our fake DB.
    monkeypatch.setattr(
        twin_event_log, "_db_path",
        lambda uid: db_path,
    )

    # Also short-circuit quick_scan._run_quick_scan_sync so the
    # behavioural test doesn't actually try to render DICOMs / talk
    # to Gemini — we ONLY exercise the post-scan event lookup path,
    # which was the broken bit.
    from nexus_server import quick_scan
    monkeypatch.setattr(
        quick_scan, "_run_quick_scan_sync",
        lambda user_id, study_id: None,
    )

    # The full helper also looks up the upload row for patient_hash.
    # In our minimal test we don't care about that — let it return
    # the default empty hash. The function should still produce the
    # summary string we're testing.
    summary = files._run_quick_scan_after_ingest(
        user_id=user_id, study_id=study_id,
    )

    # The summary should reflect that 1 finding was flagged (one
    # "suspicious" verdict in the fixture; "clean" doesn't count).
    assert "1 flagged" in summary, (
        f"helper failed to extract flagged findings from SDK event log; "
        f"got summary {summary!r}"
    )


def test_no_such_table_recovers_gracefully(tmp_path, monkeypatch):
    """Defensive: even if the SDK DB has no ``events`` table (legacy
    install, mid-migration race), the helper must NOT raise — it
    should log + continue with empty findings so the Quick scan row
    doesn't show 'failed: OperationalError'."""
    from nexus_server import files, twin_event_log, quick_scan

    user_id  = "test-user-zzz"
    study_id = "study-x"
    db_path  = tmp_path / user_id / "event_log" / "user-test-zzz.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # Create the file but with NO tables — emulates a corrupted DB.
    sqlite3.connect(str(db_path)).close()

    monkeypatch.setattr(twin_event_log, "_db_path", lambda uid: db_path)
    monkeypatch.setattr(
        quick_scan, "_run_quick_scan_sync",
        lambda user_id, study_id: None,
    )

    # Should not raise.
    summary = files._run_quick_scan_after_ingest(
        user_id=user_id, study_id=study_id,
    )
    # No findings → "no findings" path.
    assert "no findings" in summary or "0 flagged" in summary, (
        f"unexpected summary on legacy/corrupted DB: {summary!r}"
    )
