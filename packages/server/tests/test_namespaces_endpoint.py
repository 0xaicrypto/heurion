"""Phase J.8: GET /api/v1/agent/memory/namespaces.

Smoke + shape tests for the typed-namespace read endpoint that powers
the desktop's redesigned Memory panel. We use a minimal fake twin that
exposes the 5 store attributes that DigitalTwin._initialize sets up,
backed by real (tempdir-rooted) namespace stores so version_count /
current_version round-trip through VersionedStore.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from nexus_core.memory import (
    Episode, EpisodesStore,
    Fact, FactsStore,
    LearnedSkill, SkillsStore,
    PersonaVersion, PersonaStore,
    KnowledgeArticle, KnowledgeStore,
)


# ── Helpers ──────────────────────────────────────────────────────────


class FakeTwin:
    """The smallest object the namespaces endpoint expects.

    Exposes the 5 attributes assigned by ``DigitalTwin._initialize``
    in nexus/twin.py: episodes, facts, skills_memory, persona_store,
    knowledge.
    """
    def __init__(self, base_dir: str):
        self.episodes = EpisodesStore(base_dir=base_dir)
        self.facts = FactsStore(base_dir=base_dir)
        self.skills_memory = SkillsStore(base_dir=base_dir)
        self.persona_store = PersonaStore(base_dir=base_dir)
        self.knowledge = KnowledgeStore(base_dir=base_dir)

    async def close(self):  # twin_manager test_override expects it
        pass


def _populate(twin: FakeTwin) -> None:
    """Seed a couple of items per store + commit, so we exercise both
    working-state and committed-version code paths."""
    twin.episodes.upsert(Episode(session_id="s1", summary="Met user for first chat"))
    twin.episodes.upsert(Episode(session_id="s2", summary="Discussed travel preferences"))
    twin.episodes.commit()

    twin.facts.upsert(Fact(content="User prefers tea over coffee.", category="preference", importance=4))
    twin.facts.upsert(Fact(content="User lives in Tokyo.", category="fact", importance=5))
    twin.facts.commit()

    twin.skills_memory.upsert(LearnedSkill(skill_name="travel_query_handler", task_kinds=["travel"]))
    twin.skills_memory.commit()

    twin.persona_store.propose_version(
        PersonaVersion(persona_text="Helpful assistant", changes_summary="initial"),
    )
    twin.persona_store.propose_version(
        PersonaVersion(persona_text="Helpful assistant, concise", changes_summary="tightened tone"),
    )

    twin.knowledge.upsert(KnowledgeArticle(
        title="User's travel preferences",
        summary="Loves Tokyo, prefers cultural tours",
        content="Long-form synthesis here...",
    ))
    twin.knowledge.commit()


# ── Tests ────────────────────────────────────────────────────────────


def test_namespaces_endpoint_returns_all_five(client, tmp_path):
    """All 5 namespaces are listed with item_count + version_count."""
    from nexus_server import twin_manager

    twin = FakeTwin(base_dir=str(tmp_path / "twin_data"))
    _populate(twin)

    twin_manager._test_override = twin
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "NSUser", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]

        resp = client.get(
            "/api/v1/agent/memory/namespaces",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()

        names = [n["name"] for n in body["namespaces"]]
        # Order isn't critical but membership is.
        assert set(names) == {"episodes", "facts", "skills", "persona", "knowledge"}

        by_name = {n["name"]: n for n in body["namespaces"]}
        assert by_name["episodes"]["item_count"] == 2
        assert by_name["facts"]["item_count"] == 2
        assert by_name["skills"]["item_count"] == 1
        assert by_name["knowledge"]["item_count"] == 1
        # persona: 2 propose_version calls → 2 versions
        assert by_name["persona"]["item_count"] == 2
        assert by_name["persona"]["version_count"] == 2

        # Stores that committed have a current_version
        assert by_name["episodes"]["current_version"] is not None
        assert by_name["facts"]["current_version"] is not None
    finally:
        twin_manager._test_override = None


def test_namespaces_endpoint_includes_items_by_default(client, tmp_path):
    """``include_items=True`` (default) returns items keyed by namespace."""
    from nexus_server import twin_manager

    twin = FakeTwin(base_dir=str(tmp_path / "twin_data2"))
    _populate(twin)
    twin_manager._test_override = twin
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "ItemsUser", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]

        resp = client.get(
            "/api/v1/agent/memory/namespaces",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        items = body["items"]
        assert set(items.keys()) == {"episodes", "facts", "skills", "persona", "knowledge"}

        # Spot-check that persistence round-trips through to_dict
        fact_contents = {f["content"] for f in items["facts"]}
        assert "User lives in Tokyo." in fact_contents

        # Persona items are version history dicts (not PersonaVersion bodies)
        assert all("version" in v for v in items["persona"])
    finally:
        twin_manager._test_override = None


def test_namespaces_endpoint_can_omit_items(client, tmp_path):
    """``include_items=False`` keeps the response small (counts only)."""
    from nexus_server import twin_manager

    twin = FakeTwin(base_dir=str(tmp_path / "twin_data3"))
    _populate(twin)
    twin_manager._test_override = twin
    try:
        reg = client.post("/api/v1/auth/register", json={"username": "ItemsOffUser", "password": "Str0ng-Pass-123"})
        token = reg.json()["jwt_token"]

        resp = client.get(
            "/api/v1/agent/memory/namespaces?include_items=false",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        # Five summaries still present
        assert len(body["namespaces"]) == 5
        # But items dict is empty
        assert body["items"] == {}
    finally:
        twin_manager._test_override = None


def test_namespaces_endpoint_requires_auth(client):
    """No bearer token → 401."""
    resp = client.get("/api/v1/agent/memory/namespaces")
    assert resp.status_code in (401, 403)
