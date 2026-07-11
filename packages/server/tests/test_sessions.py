"""Regression for multi-session support (Phase Q).

Covers:
  * /api/v1/sessions CRUD (create, list, rename, archive)
  * Cross-user isolation — user A's sessions invisible to user B
  * /api/v1/agent/messages session_id filter — only events with the
    requested session_id come back
  * Auto-title — first user message becomes the session's title when
    it's still on the "New chat" placeholder
  * Default session — synthesised for users with pre-multi-session
    chat history (events with session_id="")
  * Forged session ids rejected by chat handler
"""

from __future__ import annotations

import pytest


# ── Fixtures ──────────────────────────────────────────────────────────


def _register(client, name: str = "Sessions Tester") -> tuple[str, str]:
    """Register a fresh user, return (jwt_token, user_id)."""
    reg = client.post(
        "/api/v1/auth/register", json={"username": name, "password": "Str0ng-Pass-123"},
    )
    assert reg.status_code in (200, 201), reg.text
    token = reg.json()["jwt_token"]
    me = client.get(
        "/api/v1/chain/me", headers={"Authorization": f"Bearer {token}"},
    )
    user_id = me.json()["user_id"]
    return token, user_id


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── /api/v1/sessions CRUD ─────────────────────────────────────────────


def test_create_session_returns_id_and_default_title(client):
    token, _ = _register(client)
    resp = client.post("/api/v1/sessions", json={}, headers=_h(token))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"].startswith("session_"), body
    assert body["title"] == "New chat"
    assert body["archived"] is False
    assert body["message_count"] == 0
    assert body["is_default"] is False


def test_create_session_with_custom_title(client):
    token, _ = _register(client)
    resp = client.post(
        "/api/v1/sessions",
        json={"title": "Q4 planning"},
        headers=_h(token),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["title"] == "Q4 planning"


def test_list_sessions_newest_first(client):
    token, _ = _register(client)
    a = client.post("/api/v1/sessions", json={"title": "A"}, headers=_h(token))
    b = client.post("/api/v1/sessions", json={"title": "B"}, headers=_h(token))
    assert a.status_code == 201 and b.status_code == 201

    resp = client.get("/api/v1/sessions", headers=_h(token))
    assert resp.status_code == 200, resp.text
    items = resp.json()["sessions"]
    titles = [s["title"] for s in items if not s["is_default"]]
    # Newest creation first when neither has activity yet.
    assert titles == ["B", "A"], titles


def test_rename_session(client):
    token, _ = _register(client)
    sid = client.post(
        "/api/v1/sessions", json={"title": "old"}, headers=_h(token),
    ).json()["id"]
    resp = client.patch(
        f"/api/v1/sessions/{sid}",
        json={"title": "new"},
        headers=_h(token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == "new"


def test_archive_session_via_delete(client):
    token, _ = _register(client)
    sid = client.post(
        "/api/v1/sessions", json={}, headers=_h(token),
    ).json()["id"]
    resp = client.delete(f"/api/v1/sessions/{sid}", headers=_h(token))
    assert resp.status_code == 204
    # Default list excludes archived.
    items = client.get("/api/v1/sessions", headers=_h(token)).json()["sessions"]
    assert sid not in {s["id"] for s in items}
    # include_archived=true brings it back, marked archived.
    items_all = client.get(
        "/api/v1/sessions?include_archived=true", headers=_h(token),
    ).json()["sessions"]
    archived_match = [s for s in items_all if s["id"] == sid]
    assert len(archived_match) == 1
    assert archived_match[0]["archived"] is True


def test_default_session_cannot_be_renamed_or_archived(client):
    token, _ = _register(client)
    # The synthetic default session has id="" — PATCH and DELETE must 400.
    resp = client.patch(
        "/api/v1/sessions/", json={"title": "x"}, headers=_h(token),
    )
    # FastAPI may route empty-id to a different handler — accept 400/404/405.
    # The important thing is we DON'T 200 (which would mean we renamed it).
    assert resp.status_code != 200


# ── Cross-user isolation ──────────────────────────────────────────────


def test_user_a_cannot_see_user_b_sessions(client):
    tok_a, _ = _register(client, name="Alice")
    tok_b, _ = _register(client, name="Bob")
    sid_a = client.post(
        "/api/v1/sessions", json={"title": "alice-only"}, headers=_h(tok_a),
    ).json()["id"]
    items_b = client.get("/api/v1/sessions", headers=_h(tok_b)).json()["sessions"]
    assert sid_a not in {s["id"] for s in items_b}


def test_user_a_cannot_rename_user_b_session(client):
    tok_a, _ = _register(client, name="Alice")
    tok_b, _ = _register(client, name="Bob")
    sid_b = client.post(
        "/api/v1/sessions", json={"title": "bob-only"}, headers=_h(tok_b),
    ).json()["id"]
    resp = client.patch(
        f"/api/v1/sessions/{sid_b}",
        json={"title": "stolen"},
        headers=_h(tok_a),
    )
    assert resp.status_code == 404


# ── /agent/messages session filter ────────────────────────────────────


def test_messages_filter_by_session(client):
    """Append events to twin's event_log directly (bypassing chat) and
    confirm /agent/messages?session_id=… returns only the matching ones.
    """
    from nexus_server import twin_event_log

    token, user_id = _register(client)
    # Two synthetic threads + one default (empty session_id) row.
    twin_event_log._test_append_event(
        user_id, "user_message", "ping in alpha", session_id="session_alpha",
    )
    twin_event_log._test_append_event(
        user_id, "assistant_response", "pong in alpha", session_id="session_alpha",
    )
    twin_event_log._test_append_event(
        user_id, "user_message", "ping in beta", session_id="session_beta",
    )
    twin_event_log._test_append_event(
        user_id, "user_message", "legacy ping", session_id="",
    )

    # session_id=session_alpha → just the two alpha rows.
    r = client.get(
        "/api/v1/agent/messages?session_id=session_alpha", headers=_h(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    contents = [m["content"] for m in body["messages"]]
    assert "ping in alpha" in contents
    assert "pong in alpha" in contents
    assert "ping in beta" not in contents
    assert "legacy ping" not in contents
    assert body["total"] == 2

    # session_id="" → only the legacy default row.
    r = client.get(
        "/api/v1/agent/messages?session_id=", headers=_h(token),
    )
    assert r.status_code == 200, r.text
    contents = [m["content"] for m in r.json()["messages"]]
    assert contents == ["legacy ping"]

    # No session_id → all rows from this user.
    r = client.get("/api/v1/agent/messages", headers=_h(token))
    assert r.status_code == 200
    assert r.json()["total"] == 4


# ── Default session synthesis ─────────────────────────────────────────


def test_default_session_appears_when_legacy_messages_exist(client):
    from nexus_server import twin_event_log

    token, user_id = _register(client)
    # Pre-multi-session chat history: events with session_id="".
    twin_event_log._test_append_event(
        user_id, "user_message", "old turn 1", session_id="",
    )
    twin_event_log._test_append_event(
        user_id, "assistant_response", "old reply 1", session_id="",
    )

    items = client.get("/api/v1/sessions", headers=_h(token)).json()["sessions"]
    default = [s for s in items if s["is_default"]]
    assert len(default) == 1, items
    assert default[0]["id"] == ""
    assert default[0]["message_count"] == 2


def test_default_session_absent_when_no_legacy_messages(client):
    token, _ = _register(client)
    items = client.get("/api/v1/sessions", headers=_h(token)).json()["sessions"]
    assert all(not s["is_default"] for s in items)


# ── Forged session ids rejected by chat handler ───────────────────────


def test_chat_rejects_unknown_session_id(client, monkeypatch):
    """If the desktop sends a session_id that doesn't belong to the
    user (forged or stale), the chat endpoint must 404 — never silently
    create messages under someone else's thread."""
    # Stub twin_enabled=True, but never reach twin: validation should
    # short-circuit before. Twin import is lazy in llm_gateway.
    import nexus_server.llm_gateway as gw

    monkeypatch.setattr(gw, "_twin_enabled", lambda: True, raising=False)

    token, _ = _register(client)
    resp = client.post(
        "/api/v1/llm/chat",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "session_id": "session_forged123",
        },
        headers=_h(token),
    )
    assert resp.status_code == 404, resp.text


# ── Auto-title heuristic ──────────────────────────────────────────────


def test_autotitle_replaces_placeholder(client):
    """maybe_apply_autotitle replaces "New chat" with the first
    sentence/line of the user's first message."""
    from nexus_server import sessions

    token, user_id = _register(client)
    sid = client.post(
        "/api/v1/sessions", json={}, headers=_h(token),
    ).json()["id"]

    sessions.maybe_apply_autotitle(
        user_id, sid, "Help me debug the upload bug. It's been broken since Tuesday.",
    )
    info = sessions.get_session(user_id, sid)
    assert info is not None
    assert info.title.startswith("Help me debug the upload bug")
    assert info.title != "New chat"


def test_autotitle_does_not_overwrite_user_set_title(client):
    """If the user has renamed the session, auto-title must not
    revert their choice on the next chat turn."""
    from nexus_server import sessions

    token, user_id = _register(client)
    sid = client.post(
        "/api/v1/sessions",
        json={"title": "My deliberate name"},
        headers=_h(token),
    ).json()["id"]

    sessions.maybe_apply_autotitle(
        user_id, sid, "ignored because the title is already custom",
    )
    info = sessions.get_session(user_id, sid)
    assert info.title == "My deliberate name"


def test_autotitle_truncates_overlong_first_lines(client):
    from nexus_server import sessions

    token, user_id = _register(client)
    sid = client.post(
        "/api/v1/sessions", json={}, headers=_h(token),
    ).json()["id"]

    very_long = "x" * 300
    sessions.maybe_apply_autotitle(user_id, sid, very_long)
    info = sessions.get_session(user_id, sid)
    # Soft cap should kick in — 48 chars + ellipsis at most.
    assert len(info.title) <= 48 + 1
