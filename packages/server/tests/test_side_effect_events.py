"""Tests for the Phase B fix: chat responses carry side-effect events
(workflow_run cards) the agent's tools inserted mid-turn so the
desktop can render them inline immediately instead of waiting for the
next history refresh."""
from __future__ import annotations

import sqlite3

import pytest


@pytest.fixture
def fake_log(monkeypatch, tmp_path):
    """Seed a per-user twin DB so latest_event_idx /
    list_side_effect_events_since have something to read."""
    user_id = "alice"
    monkeypatch.setenv("NEXUS_TWIN_BASE_DIR", str(tmp_path))
    from nexus_server import twin_event_log
    db = twin_event_log._db_path(user_id)
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
          idx        INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          content    TEXT,
          timestamp  REAL,
          metadata   TEXT,
          session_id TEXT
        )
        """
    )
    conn.commit()
    conn.close()
    return user_id


def _append(user_id: str, event_type: str, content: str,
            session_id: str = "", metadata: str = "{}",
            ts: float = 0.0) -> int:
    from nexus_server import twin_event_log
    conn = sqlite3.connect(twin_event_log._db_path(user_id))
    cur = conn.execute(
        "INSERT INTO events (event_type, content, timestamp, metadata, session_id) "
        "VALUES (?, ?, ?, ?, ?)",
        (event_type, content, ts, metadata, session_id),
    )
    conn.commit()
    idx = cur.lastrowid
    conn.close()
    return idx


def test_latest_event_idx_empty_log(fake_log):
    from nexus_server import twin_event_log
    assert twin_event_log.latest_event_idx(fake_log) == 0


def test_latest_event_idx_after_inserts(fake_log):
    from nexus_server import twin_event_log
    _append(fake_log, "user_message", "hi")
    _append(fake_log, "assistant_response", "hello")
    assert twin_event_log.latest_event_idx(fake_log) == 2


def test_side_effect_events_picks_only_workflow_run(fake_log):
    """Only event types in the whitelist (workflow_run today) come back
    — not random chain_activity or persona events."""
    from nexus_server import twin_event_log
    pre = twin_event_log.latest_event_idx(fake_log)
    _append(fake_log, "user_message", "do thing", session_id="sess-A")
    _append(fake_log, "workflow_run", "Started workflow: X",
            session_id="sess-A",
            metadata='{"workflow_run_id":"run_1","workflow_name":"X","total_steps":3}')
    _append(fake_log, "chain_activity", "noise", session_id="sess-A")
    _append(fake_log, "assistant_response", "ok", session_id="sess-A")
    events = twin_event_log.list_side_effect_events_since(
        fake_log, "sess-A", pre,
    )
    assert len(events) == 1
    ev = events[0]
    assert ev["event_type"] == "workflow_run"
    assert ev["content"] == "Started workflow: X"
    assert ev["metadata"]["workflow_run_id"] == "run_1"
    assert ev["metadata"]["workflow_name"] == "X"
    assert ev["sync_id"] > pre


def test_side_effect_events_session_scoped(fake_log):
    """A workflow_run inserted in session-B should NOT leak into a
    session-A response."""
    from nexus_server import twin_event_log
    pre = twin_event_log.latest_event_idx(fake_log)
    _append(fake_log, "workflow_run", "in B", session_id="sess-B",
            metadata='{"workflow_run_id":"r"}')
    a_events = twin_event_log.list_side_effect_events_since(
        fake_log, "sess-A", pre,
    )
    b_events = twin_event_log.list_side_effect_events_since(
        fake_log, "sess-B", pre,
    )
    assert a_events == []
    assert len(b_events) == 1


def test_side_effect_events_excludes_pre_turn_rows(fake_log):
    """Events that landed BEFORE pre_turn_idx must not show up — they
    belong to a previous turn the client already rendered."""
    from nexus_server import twin_event_log
    _append(fake_log, "workflow_run", "old run", session_id="sess-A",
            metadata='{"workflow_run_id":"old"}')
    pre = twin_event_log.latest_event_idx(fake_log)
    _append(fake_log, "workflow_run", "new run", session_id="sess-A",
            metadata='{"workflow_run_id":"new"}')
    events = twin_event_log.list_side_effect_events_since(
        fake_log, "sess-A", pre,
    )
    assert len(events) == 1
    assert events[0]["content"] == "new run"


def test_side_effect_events_returned_in_idx_order(fake_log):
    from nexus_server import twin_event_log
    pre = twin_event_log.latest_event_idx(fake_log)
    _append(fake_log, "workflow_run", "first", session_id="s",
            metadata='{"workflow_run_id":"a"}')
    _append(fake_log, "workflow_run", "second", session_id="s",
            metadata='{"workflow_run_id":"b"}')
    events = twin_event_log.list_side_effect_events_since(fake_log, "s", pre)
    assert [e["content"] for e in events] == ["first", "second"]
