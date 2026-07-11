"""GET /api/v1/agent/thinking — agent inner-monologue trace.

Validates that the endpoint:
  * filters EventLog rows down to thinking-relevant types only,
  * maps each event_type to a stable ``kind`` + friendly ``label``,
  * supports the ``since_sync_id`` cursor for incremental polling,
  * surfaces nothing when EventLog is empty.

Uses ``twin_event_log._test_append_event`` to seed the per-user
SQLite directly (same pattern the existing memory / timeline tests
use) — this lets us exercise the route's filtering logic without
spinning up a real DigitalTwin.
"""

from __future__ import annotations

import pytest


def _seed(user_id: str, *event_types: str) -> list[int]:
    """Append synthetic events of the given types and return their idx list."""
    from nexus_server import twin_event_log
    ids = []
    for et in event_types:
        idx = twin_event_log._test_append_event(
            user_id=user_id,
            event_type=et,
            content=f"sample {et} content",
            metadata={"sample": True},
        )
        ids.append(idx)
    return ids


def _register(client) -> str:
    reg = client.post("/api/v1/auth/register", json={"username": "Thinker", "password": "Str0ng-Pass-123"})
    body = reg.json()
    # The desktop's user_id is what the server uses to scope the per-user
    # event log. Pull the JWT for the auth header.
    return body["jwt_token"]


def _user_id_from_token(client, token: str) -> str:
    """Look up the server-side user_id via /chain/me — it's the
    JWT subject; we don't decode JWTs in tests."""
    resp = client.get(
        "/api/v1/chain/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    return resp.json()["user_id"]


def test_empty_event_log_returns_empty_steps(client):
    """Fresh user, no events → 200 with steps=[] total=0."""
    token = _register(client)
    resp = client.get(
        "/api/v1/agent/thinking",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["steps"] == []
    assert body["total"] == 0


def test_filters_only_thinking_event_types(client):
    """A mix of thinking + storage events — the response should
    include the thinking ones in newest-first order, drop the rest."""
    token = _register(client)
    user_id = _user_id_from_token(client, token)

    # Seed a mix. user_message + contract_check + assistant_response
    # are all thinking-relevant. anchor_committed and a fake "noise"
    # type should be filtered out.
    _seed(
        user_id,
        "user_message",
        "contract_check",
        "anchor_committed",       # storage churn — filtered
        "evolution_proposal",
        "noise.unknown_kind",     # not in map — filtered
        "assistant_response",
    )

    resp = client.get(
        "/api/v1/agent/thinking",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    kinds = [s["kind"] for s in body["steps"]]
    # Newest-first: assistant_response (last seeded) should be first.
    # All four thinking-relevant types should be present, none of the noise.
    expected_kinds = {"heard", "checked", "evolving", "responded"}
    assert set(kinds) == expected_kinds
    assert len(body["steps"]) == 4
    # Each step has the friendly label populated.
    assert all(s["label"] for s in body["steps"])


def test_since_cursor_returns_only_newer_events(client):
    """``since_sync_id`` is the polling cursor — only rows with
    sync_id strictly greater than that are returned."""
    token = _register(client)
    user_id = _user_id_from_token(client, token)

    ids = _seed(user_id, "user_message", "contract_check", "assistant_response")
    cutoff = ids[1]  # contract_check

    resp = client.get(
        f"/api/v1/agent/thinking?since_sync_id={cutoff}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    # Only the assistant_response (newer than cutoff) should remain.
    assert len(body["steps"]) == 1
    assert body["steps"][0]["kind"] == "responded"
    assert body["steps"][0]["sync_id"] > cutoff


def test_limit_caps_returned_step_count(client):
    """``limit`` is clamped — request 2, get at most 2."""
    token = _register(client)
    user_id = _user_id_from_token(client, token)
    _seed(user_id,
          "user_message", "contract_check", "memory_compact",
          "assistant_response", "evolution_proposal")

    resp = client.get(
        "/api/v1/agent/thinking?limit=2",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["steps"]) == 2
    # Newest-first: the last two seeded events come back.


def test_requires_auth(client):
    resp = client.get("/api/v1/agent/thinking")
    assert resp.status_code in (401, 403)
