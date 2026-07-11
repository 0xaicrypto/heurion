# SPDX-License-Identifier: Apache-2.0
"""
test_session_sync — Verify session metadata is durably routed through
twin's EventLog and replayed correctly when the SQL table is wiped.

The whole point of session_sync is that you can:
  1. Create / rename / archive sessions
  2. Wipe the nexus_sessions SQL table
  3. Reconstruct the original state by replaying the EventLog

These tests prove that round-trip works for every action, in order.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from nexus_server import sessions
from nexus_server.session_sync import (
    SESSION_METADATA_EVENT,
    emit_session_metadata,
    replay_session_metadata,
)
from nexus_server.database import get_db_connection


# ── Helpers ───────────────────────────────────────────────────────────


def _register(client, name: str = "Sync Tester") -> tuple[str, str]:
    reg = client.post(
        "/api/v1/auth/register", json={"username": name, "password": "Str0ng-Pass-123"},
    )
    token = reg.json()["jwt_token"]
    user_id = client.get(
        "/api/v1/chain/me", headers={"Authorization": f"Bearer {token}"},
    ).json()["user_id"]
    return token, user_id


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _wipe_sessions_for(user_id: str) -> None:
    """Simulate a fresh DB / migrated server: drop all SQL session
    metadata rows for this user."""
    with get_db_connection() as conn:
        conn.execute(
            "DELETE FROM nexus_sessions WHERE user_id = ?",
            (user_id,),
        )
        conn.commit()


# ── Direct emit/replay (no HTTP) ──────────────────────────────────────


def test_emit_records_metadata_event_in_eventlog(client):
    """emit_session_metadata writes to twin's EventLog with the
    canonical event_type + structured metadata."""
    _, user_id = _register(client)

    # Reach the twin directly to verify event_log writes.
    import asyncio
    from nexus_server.twin_manager import get_twin
    twin = asyncio.new_event_loop().run_until_complete(get_twin(user_id))

    before = twin.event_log.count()
    emit_session_metadata(
        twin,
        session_id="session_abcd1234",
        action="create",
        title="Q4 planning",
    )
    after = twin.event_log.count()
    assert after == before + 1, "expected exactly one event appended"

    # Pull the latest event and verify its shape.
    rows = twin.event_log.recent(limit=1)
    ev = rows[-1]
    assert ev.event_type == SESSION_METADATA_EVENT
    assert ev.session_id == "session_abcd1234"
    assert ev.metadata["action"] == "create"
    assert ev.metadata["title"] == "Q4 planning"


def test_replay_reconstructs_table_after_wipe(client):
    """End-to-end: create + rename + archive a session via the API,
    wipe the SQL table, replay → expect the same SessionInfo back."""
    token, user_id = _register(client)

    # Create.
    r = client.post("/api/v1/sessions", json={"title": "Original"},
                    headers=_h(token))
    assert r.status_code == 201
    sid = r.json()["id"]

    # Rename + archive (two events).
    r = client.patch(f"/api/v1/sessions/{sid}",
                     json={"title": "Renamed"}, headers=_h(token))
    assert r.status_code == 200, r.text
    r = client.patch(f"/api/v1/sessions/{sid}",
                     json={"archived": True}, headers=_h(token))
    assert r.status_code == 200, r.text

    # Sanity: the row is in the right end state via the API.
    r = client.get(f"/api/v1/sessions?include_archived=true", headers=_h(token))
    rows = [s for s in r.json()["sessions"] if s["id"] == sid]
    assert rows and rows[0]["title"] == "Renamed"
    assert rows[0]["archived"] is True

    # ── Wipe the SQL row, then replay. The SessionInfo must come back. ──
    _wipe_sessions_for(user_id)
    # Sanity: wipe worked.
    r = client.get("/api/v1/sessions?include_archived=true", headers=_h(token))
    assert all(s["id"] != sid for s in r.json()["sessions"]), \
        "wipe should have removed the row before replay"

    # Now replay.
    import asyncio
    from nexus_server.twin_manager import get_twin
    twin = asyncio.new_event_loop().run_until_complete(get_twin(user_id))
    n = replay_session_metadata(user_id, twin)
    assert n >= 3, f"expected at least create+rename+archive events; got {n}"

    # Verify the row reappeared with the correct end state.
    r = client.get("/api/v1/sessions?include_archived=true", headers=_h(token))
    rows = [s for s in r.json()["sessions"] if s["id"] == sid]
    assert rows, "row missing after replay"
    assert rows[0]["title"] == "Renamed"
    assert rows[0]["archived"] is True


def test_replay_idempotent(client):
    """Running replay twice in a row produces the same end state."""
    token, user_id = _register(client)

    r = client.post("/api/v1/sessions", json={"title": "Foo"}, headers=_h(token))
    sid = r.json()["id"]

    import asyncio
    from nexus_server.twin_manager import get_twin
    twin = asyncio.new_event_loop().run_until_complete(get_twin(user_id))

    _wipe_sessions_for(user_id)
    n1 = replay_session_metadata(user_id, twin)
    rows1 = client.get("/api/v1/sessions", headers=_h(token)).json()["sessions"]

    n2 = replay_session_metadata(user_id, twin)
    rows2 = client.get("/api/v1/sessions", headers=_h(token)).json()["sessions"]

    # Same number of rows, same content.
    assert [s["id"] for s in rows1] == [s["id"] for s in rows2]
    assert n1 == n2  # both runs see the same event count


def test_delete_event_removes_row_on_replay(client):
    """A delete event must drop the row even if create/rename
    events for that session appear earlier in the log."""
    token, user_id = _register(client)

    r = client.post("/api/v1/sessions", json={"title": "Doomed"},
                    headers=_h(token))
    sid = r.json()["id"]

    # Hard delete the session.
    r = client.delete(f"/api/v1/sessions/{sid}?hard=true", headers=_h(token))
    assert r.status_code == 200, r.text

    # Wipe + replay. The replayed log contains create + delete.
    _wipe_sessions_for(user_id)
    import asyncio
    from nexus_server.twin_manager import get_twin
    twin = asyncio.new_event_loop().run_until_complete(get_twin(user_id))
    replay_session_metadata(user_id, twin)

    rows = client.get("/api/v1/sessions?include_archived=true",
                      headers=_h(token)).json()["sessions"]
    assert all(s["id"] != sid for s in rows), \
        "delete event should have kept the row out of the replay result"


def test_emit_handles_none_twin_silently():
    """No event_log → no crash. Best-effort sync."""
    # Should NOT raise.
    emit_session_metadata(
        None,
        session_id="session_xxx",
        action="create",
        title="Whatever",
    )


def test_replay_handles_none_twin_silently():
    """No event_log → returns 0. Best-effort sync."""
    n = replay_session_metadata("user-xyz", None)
    assert n == 0


def test_emit_unarchive_records_archived_false(client):
    """The 'unarchive' event must carry archived=False so replay
    flips the row back when applied."""
    token, user_id = _register(client)

    r = client.post("/api/v1/sessions", json={"title": "Toggle"},
                    headers=_h(token))
    sid = r.json()["id"]
    client.patch(f"/api/v1/sessions/{sid}",
                 json={"archived": True}, headers=_h(token))
    client.patch(f"/api/v1/sessions/{sid}",
                 json={"archived": False}, headers=_h(token))

    _wipe_sessions_for(user_id)
    import asyncio
    from nexus_server.twin_manager import get_twin
    twin = asyncio.new_event_loop().run_until_complete(get_twin(user_id))
    replay_session_metadata(user_id, twin)

    # The row should be back with archived=False.
    rows = client.get("/api/v1/sessions", headers=_h(token)).json()["sessions"]
    matching = [s for s in rows if s["id"] == sid]
    assert matching, "session missing after archive→unarchive replay"
    assert matching[0]["archived"] is False
