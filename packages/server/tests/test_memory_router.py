"""Phase C-2: tests for the user-facing memory management API.

The router reaches into the SDK's ``CuratedMemory`` private internals
to do full-list replacement (vs the SDK's add/remove primitives).
These tests use the real CuratedMemory backed by a tmp directory so
the on-disk persistence path is exercised end-to-end.
"""
from __future__ import annotations

import pytest

from nexus_core.memory.curated import CuratedMemory


# ─────────────────────────────────────────────────────────────────────
# Test twin / evolution stubs
# ─────────────────────────────────────────────────────────────────────


class _StubEvolution:
    def __init__(self, persona: str = ""):
        self._persona = persona

    def get_current_persona(self) -> str:
        return self._persona


class _StubTwin:
    def __init__(self, base_dir, persona: str = "I am a helpful agent."):
        self.curated_memory = CuratedMemory(base_dir=str(base_dir))
        self.evolution = _StubEvolution(persona)

    async def close(self):
        pass


def _register(client) -> str:
    reg = client.post(
        "/api/v1/auth/register", json={"display_name": "MemoryUser"},
    )
    return reg.json()["jwt_token"]


@pytest.fixture
def memory_client(client, tmp_path):
    """A client wired to a stub twin so memory_router endpoints hit
    a real on-disk CuratedMemory inside ``tmp_path``."""
    from nexus_server import twin_manager
    twin = _StubTwin(tmp_path, persona="Test persona.")
    twin_manager._test_override = twin
    yield client, twin
    twin_manager._test_override = None


# ─────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────


def test_get_memory_empty_returns_zero_entries(memory_client):
    client, twin = memory_client
    token = _register(client)
    resp = client.get(
        "/api/v1/agent/memory/",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["memory_entries"] == []
    assert body["user_entries"] == []
    assert body["persona"] == "Test persona."
    assert body["paused"] is False
    assert body["memory_chars_limit"] == 3000
    assert body["user_chars_limit"] == 2000


def test_put_memory_replaces_entries_and_persists(memory_client):
    client, twin = memory_client
    token = _register(client)
    resp = client.put(
        "/api/v1/agent/memory/memory",
        headers={"Authorization": f"Bearer {token}"},
        json={"entries": [
            "User prefers concise replies.",
            "Working on Nexus agent project.",
        ]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["memory_entries"] == [
        "User prefers concise replies.",
        "Working on Nexus agent project.",
    ]
    # Also persisted to disk
    cm2 = CuratedMemory(base_dir=str(twin.curated_memory._dir.parent))
    assert cm2.memory_entries == body["memory_entries"]


def test_put_user_entries(memory_client):
    client, twin = memory_client
    token = _register(client)
    resp = client.put(
        "/api/v1/agent/memory/user",
        headers={"Authorization": f"Bearer {token}"},
        json={"entries": ["JZ, building Nexus on BNB Chain."]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["user_entries"] == [
        "JZ, building Nexus on BNB Chain.",
    ]


def test_put_memory_dedupes_and_strips(memory_client):
    client, twin = memory_client
    token = _register(client)
    resp = client.put(
        "/api/v1/agent/memory/memory",
        headers={"Authorization": f"Bearer {token}"},
        json={"entries": [
            "  same line  ",
            "same line",      # duplicate after strip
            "",                # empty — dropped
            "different",
        ]},
    )
    assert resp.status_code == 200
    assert resp.json()["memory_entries"] == ["same line", "different"]


def test_put_memory_too_large_rejected(memory_client):
    client, twin = memory_client
    token = _register(client)
    big = "x" * 9000
    resp = client.put(
        "/api/v1/agent/memory/memory",
        headers={"Authorization": f"Bearer {token}"},
        json={"entries": [big]},
    )
    assert resp.status_code == 413


def test_pause_and_resume_flips_marker(memory_client):
    client, twin = memory_client
    token = _register(client)

    resp = client.post(
        "/api/v1/agent/memory/pause",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["paused"] is True
    assert (twin.curated_memory._dir / ".paused").exists()

    resp = client.post(
        "/api/v1/agent/memory/resume",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["paused"] is False
    assert not (twin.curated_memory._dir / ".paused").exists()


def test_delete_wipes_everything(memory_client):
    client, twin = memory_client
    token = _register(client)

    # Seed some content first
    client.put(
        "/api/v1/agent/memory/memory",
        headers={"Authorization": f"Bearer {token}"},
        json={"entries": ["fact one", "fact two"]},
    )
    client.put(
        "/api/v1/agent/memory/user",
        headers={"Authorization": f"Bearer {token}"},
        json={"entries": ["likes coffee"]},
    )

    resp = client.delete(
        "/api/v1/agent/memory/",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["memory_entries"] == []
    assert body["user_entries"] == []
    # Persona is untouched by reset
    assert body["persona"] == "Test persona."


def test_get_memory_requires_auth(memory_client):
    client, _ = memory_client
    resp = client.get("/api/v1/agent/memory/")
    assert resp.status_code in (401, 403)
