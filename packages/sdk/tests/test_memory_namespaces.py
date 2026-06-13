"""Tests for the four Phase J namespace stores beyond Episodes —
Facts, Skills, Persona, Knowledge.

The pattern is the same in all four (working-file + VersionedStore
+ cheap upsert + heavyweight commit/rollback), so these tests
exercise the namespace-specific bits each store adds (categories,
strategy lookup by task_kind, persona auto-versioning, etc.) and
the shared versioning contract.

For end-to-end versioning behaviour (already covered exhaustively
by ``test_episodes.py``) we only smoke-test here — the underlying
``VersionedStore`` + the pattern itself are pinned in
``test_versioned.py`` and ``test_episodes.py``.
"""

from __future__ import annotations

import json
import time

import pytest

import nexus_core
from nexus_core.memory import (
    Fact, FactsStore,
    LearnedSkill, SkillsStore,
    PersonaVersion, PersonaStore,
    KnowledgeArticle, KnowledgeStore,
)


# ═════════════════════════════════════════════════════════════════════
# FactsStore
# ═════════════════════════════════════════════════════════════════════


def test_fact_validates_category_and_importance():
    with pytest.raises(ValueError, match="category"):
        Fact(content="x", category="not_a_category")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="importance"):
        Fact(content="x", importance=6)
    with pytest.raises(ValueError, match="importance"):
        Fact(content="x", importance=0)
    # Valid edges work
    Fact(content="x", importance=1)
    Fact(content="x", importance=5)


def test_facts_upsert_and_get(tmp_path):
    s = FactsStore(tmp_path)
    f = Fact(key="k1", content="user has peanut allergy",
             category="constraint", importance=5)
    s.upsert(f)
    assert s.get("k1").content == "user has peanut allergy"
    assert len(s) == 1


def test_facts_by_category(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="k1", content="likes sushi", category="preference"))
    s.upsert(Fact(key="k2", content="allergic to peanuts",
                  category="constraint", importance=5))
    s.upsert(Fact(key="k3", content="lives in Tokyo", category="fact"))

    prefs = s.by_category("preference")
    assert {f.key for f in prefs} == {"k1"}

    constraints = s.by_category("constraint")
    assert {f.key for f in constraints} == {"k2"}


def test_facts_by_importance_orders_correctly(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="lo", content="x", importance=2))
    s.upsert(Fact(key="hi", content="y", importance=5))
    s.upsert(Fact(key="mid", content="z", importance=3))

    out = s.by_importance(min_importance=3)
    assert [f.key for f in out] == ["hi", "mid"]   # desc by importance


def test_facts_search_substring(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="k1", content="user has peanut allergy"))
    s.upsert(Fact(key="k2", content="user lives in Tokyo"))
    assert {f.key for f in s.search("peanut")} == {"k1"}
    assert {f.key for f in s.search("Tokyo")} == {"k2"}
    assert s.search("") == []


def test_facts_ttl_filters_expired(tmp_path):
    s = FactsStore(tmp_path)
    past = time.time() - 1000
    future = time.time() + 100000

    s.upsert(Fact(key="expired", content="old", ttl=past))
    s.upsert(Fact(key="active", content="new", ttl=future))
    s.upsert(Fact(key="forever", content="permanent"))  # ttl=None

    assert {f.key for f in s.all()} == {"active", "forever"}
    assert {f.key for f in s.all(include_expired=True)} == {"expired", "active", "forever"}


def test_facts_touch_updates_last_used_at(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="k1", content="x"))
    assert s.get("k1").last_used_at == 0.0
    assert s.get("k1").access_count == 0

    assert s.touch("k1") is True
    f = s.get("k1")
    assert f.last_used_at > 0
    # Phase D 续: touch also bumps access_count so consolidation
    # can pick least-accessed eviction candidates.
    assert f.access_count == 1
    s.touch("k1")
    assert s.get("k1").access_count == 2
    assert s.touch("nonexistent") is False


def test_facts_touch_many_bulk_bumps(tmp_path):
    s = FactsStore(tmp_path)
    s.bulk_add([
        Fact(key="k1", content="a"),
        Fact(key="k2", content="b"),
        Fact(key="k3", content="c"),
    ])
    bumped = s.touch_many(["k1", "k2", "missing"])
    assert bumped == 2
    assert s.get("k1").access_count == 1
    assert s.get("k2").access_count == 1
    assert s.get("k3").access_count == 0


def test_facts_count_excludes_expired_by_default(tmp_path):
    s = FactsStore(tmp_path)
    past = time.time() - 1000
    s.upsert(Fact(key="active", content="x"))
    s.upsert(Fact(key="dead", content="y", ttl=past))
    assert s.count() == 1
    assert s.count(include_expired=True) == 2
    assert len(s) == 2  # __len__ keeps backward-compat behaviour


def test_facts_bulk_add_single_write(tmp_path):
    s = FactsStore(tmp_path)
    keys = s.bulk_add([
        Fact(key="k1", content="one"),
        Fact(key="k2", content="two"),
        Fact(key="k3", content="three"),
    ])
    assert keys == ["k1", "k2", "k3"]
    assert s.count() == 3
    assert {f.key for f in s.all()} == {"k1", "k2", "k3"}


def test_facts_bulk_add_replaces_existing_by_key(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="k1", content="original"))
    s.bulk_add([
        Fact(key="k1", content="replaced"),
        Fact(key="k2", content="brand new"),
    ])
    assert s.get("k1").content == "replaced"
    assert s.get("k2").content == "brand new"
    assert s.count() == 2


def test_facts_bulk_delete(tmp_path):
    s = FactsStore(tmp_path)
    s.bulk_add([
        Fact(key=f"k{i}", content=f"item {i}") for i in range(5)
    ])
    removed = s.bulk_delete(["k0", "k2", "k4", "missing"])
    assert removed == 3
    assert {f.key for f in s.all()} == {"k1", "k3"}


def test_facts_bulk_delete_empty_is_noop(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="k1", content="x"))
    assert s.bulk_delete([]) == 0
    assert s.count() == 1


def test_facts_search_compact_returns_ranked_summaries(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="travel", content="user prefers window seats on flights",
                  category="preference", importance=4))
    s.upsert(Fact(key="diet", content="user is allergic to peanuts",
                  category="constraint", importance=5))
    s.upsert(Fact(key="city", content="user lives in Singapore"))

    hits = s.search_compact("flights window")
    assert len(hits) == 1
    assert hits[0]["key"] == "travel"
    assert hits[0]["category"] == "preference"
    assert hits[0]["preview"].startswith("user prefers window seats")
    assert hits[0]["score"] > 0


def test_facts_search_compact_higher_importance_ranks_higher(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="low", content="user mentioned travel", importance=1))
    s.upsert(Fact(key="high", content="user travel allergy critical", importance=5))
    hits = s.search_compact("travel")
    # both match; the importance=5 fact should outrank importance=1
    assert hits[0]["key"] == "high"
    assert hits[1]["key"] == "low"


def test_facts_search_compact_empty_query_returns_empty(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="k1", content="anything"))
    assert s.search_compact("") == []
    # Single-letter token (≤1 char) gets filtered out → empty.
    assert s.search_compact("a") == []


def test_facts_search_compact_top_k_limits(tmp_path):
    s = FactsStore(tmp_path)
    for i in range(10):
        s.upsert(Fact(key=f"k{i}", content=f"travel fact number {i}"))
    hits = s.search_compact("travel", top_k=3)
    assert len(hits) == 3


def test_facts_get_least_accessed_orders_by_access_then_age(tmp_path):
    """Eviction candidates: least-accessed first, ties broken by
    older creation time. Mirrors MemoryProvider.get_least_accessed.
    """
    s = FactsStore(tmp_path)
    base = time.time()
    s.upsert(Fact(key="old_unread", content="oldest, never read",
                  created_at=base - 1000))
    s.upsert(Fact(key="new_unread", content="newest, never read",
                  created_at=base))
    s.upsert(Fact(key="old_read", content="oldest, read once",
                  created_at=base - 1000, access_count=1))
    s.upsert(Fact(key="hot", content="hot fact",
                  created_at=base - 500, access_count=10))

    candidates = s.get_least_accessed(limit=3)
    assert [f.key for f in candidates] == [
        "old_unread",  # access=0, oldest
        "new_unread",  # access=0, newer
        "old_read",    # access=1
    ]
    assert s.get_least_accessed(limit=0) == []
    assert len(s.get_least_accessed(limit=10)) == 4


def test_facts_prune_expired(tmp_path):
    s = FactsStore(tmp_path)
    past = time.time() - 1000
    future = time.time() + 100000
    s.upsert(Fact(key="e1", content="x", ttl=past))
    s.upsert(Fact(key="e2", content="y", ttl=past))
    s.upsert(Fact(key="active", content="z", ttl=future))

    removed = s.prune_expired()
    assert removed == 2
    assert {f.key for f in s.all(include_expired=True)} == {"active"}


def test_facts_commit_and_rollback(tmp_path):
    s = FactsStore(tmp_path)
    s.upsert(Fact(key="k1", content="initial"))
    v1 = s.commit()

    s.upsert(Fact(key="k2", content="added"))
    s.commit()
    assert len(s) == 2

    s.rollback(v1)
    assert len(s) == 1
    assert s.get("k1") is not None
    assert s.get("k2") is None


# ═════════════════════════════════════════════════════════════════════
# SkillsStore
# ═════════════════════════════════════════════════════════════════════


def test_learned_skill_validates_confidence():
    with pytest.raises(ValueError, match="confidence"):
        LearnedSkill(skill_name="x", confidence=1.5)
    with pytest.raises(ValueError, match="confidence"):
        LearnedSkill(skill_name="x", confidence=-0.1)


def test_learned_skill_success_rate():
    s = LearnedSkill(skill_name="x", success_count=3, failure_count=1)
    assert s.total_invocations == 4
    assert s.success_rate == 0.75

    empty = LearnedSkill(skill_name="y")
    assert empty.success_rate == 0.0   # no division-by-zero


def test_skills_upsert_and_get(tmp_path):
    s = SkillsStore(tmp_path)
    # SkillsStore is generic — the exact skill name / task_kinds here
    # are illustrative only. Used to mention smart_contract_audit
    # (the now-removed crypto pack); kept as code_review since it
    # still exists and the store doesn't care what task_kinds say.
    sk = LearnedSkill(
        skill_name="diff_review",
        strategy="check edge cases + tests",
        confidence=0.8,
        task_kinds=["code_review"],
    )
    s.upsert(sk)
    got = s.get("diff_review")
    assert got.strategy == "check edge cases + tests"
    assert got.confidence == 0.8


def test_skills_find_for_task_kind_orders_by_success_rate(tmp_path):
    s = SkillsStore(tmp_path)
    s.upsert(LearnedSkill(skill_name="lo", task_kinds=["x"],
                          success_count=1, failure_count=4, confidence=0.9))
    s.upsert(LearnedSkill(skill_name="hi", task_kinds=["x"],
                          success_count=4, failure_count=0, confidence=0.5))
    s.upsert(LearnedSkill(skill_name="other", task_kinds=["y"]))

    hits = s.find_for_task_kind("x")
    assert [h.skill_name for h in hits] == ["hi", "lo"]   # success-rate desc


def test_skills_record_outcome_increments_counters(tmp_path):
    s = SkillsStore(tmp_path)
    s.upsert(LearnedSkill(skill_name="travel"))

    assert s.record_outcome("travel", success=True, lesson="window seats") is True
    assert s.record_outcome("travel", success=True) is True
    assert s.record_outcome("travel", success=False) is True

    sk = s.get("travel")
    assert sk.success_count == 2
    assert sk.failure_count == 1
    assert sk.last_lesson == "window seats"

    # Nonexistent skill → False
    assert s.record_outcome("nonexistent", success=True) is False


def test_skills_search(tmp_path):
    s = SkillsStore(tmp_path)
    s.upsert(LearnedSkill(skill_name="solidity_review", strategy="check gas"))
    s.upsert(LearnedSkill(skill_name="travel_planning", strategy="window seats"))

    assert {x.skill_name for x in s.search("gas")} == {"solidity_review"}
    assert {x.skill_name for x in s.search("window")} == {"travel_planning"}


def test_skills_versioning(tmp_path):
    s = SkillsStore(tmp_path)
    s.upsert(LearnedSkill(skill_name="a"))
    v1 = s.commit()
    s.upsert(LearnedSkill(skill_name="b"))
    s.commit()
    assert len(s) == 2
    s.rollback(v1)
    assert len(s) == 1


# ═════════════════════════════════════════════════════════════════════
# PersonaStore
# ═════════════════════════════════════════════════════════════════════


def test_persona_starts_empty(tmp_path):
    p = PersonaStore(tmp_path)
    assert p.current() is None
    assert p.current_version() is None
    assert len(p) == 0


def test_persona_propose_version_makes_it_current(tmp_path):
    p = PersonaStore(tmp_path)
    v = p.propose_version(PersonaVersion(
        persona_text="You are helpful and concise.",
        changes_summary="initial",
        confidence=0.8,
    ))
    assert v == "v0001"
    assert p.current_version() == "v0001"
    assert p.current().persona_text == "You are helpful and concise."


def test_persona_every_update_is_a_new_version(tmp_path):
    """No working-file shortcut — propose_version is the only mutator."""
    p = PersonaStore(tmp_path)
    v1 = p.propose_version(PersonaVersion(persona_text="v1 prose"))
    v2 = p.propose_version(PersonaVersion(persona_text="v2 prose"))
    v3 = p.propose_version(PersonaVersion(persona_text="v3 prose"))
    assert (v1, v2, v3) == ("v0001", "v0002", "v0003")
    assert len(p) == 3


def test_persona_rollback_restores_prior_active_version(tmp_path):
    p = PersonaStore(tmp_path)
    p.propose_version(PersonaVersion(persona_text="kind",
                                      changes_summary="initial"))
    p.propose_version(PersonaVersion(persona_text="curt",
                                      changes_summary="evolver shifted to brief style"))

    # Roll back to v1 — UI revert action would do this
    prev = p.rollback("v0001")
    assert prev == "v0002"
    assert p.current().persona_text == "kind"
    # v0002 still on disk, audit-able
    assert p.get_version("v0002").persona_text == "curt"


def test_persona_history_audits_changes(tmp_path):
    p = PersonaStore(tmp_path)
    p.propose_version(PersonaVersion(
        persona_text="v1", changes_summary="initial", confidence=0.5,
        version_notes="seed",
    ))
    p.propose_version(PersonaVersion(
        persona_text="v2", changes_summary="more concise after user feedback",
        confidence=0.7, version_notes="round 1",
    ))

    h = p.history()
    assert len(h) == 2
    assert h[0]["changes_summary"] == "initial"
    assert h[1]["confidence"] == 0.7
    assert h[1]["version_notes"] == "round 1"


def test_persona_preserves_unknown_fields_in_extra(tmp_path):
    """Forward-compat: future schema bumps add fields, current
    impl swallows them into ``extra``."""
    pv = PersonaVersion.from_dict({
        "persona_text": "x",
        "future_field": 42,
    })
    assert pv.persona_text == "x"
    assert pv.extra == {"future_field": 42}


# ═════════════════════════════════════════════════════════════════════
# KnowledgeStore
# ═════════════════════════════════════════════════════════════════════


def test_knowledge_validates_visibility_and_confidence():
    with pytest.raises(ValueError, match="confidence"):
        KnowledgeArticle(title="x", confidence=2.0)
    with pytest.raises(ValueError, match="visibility"):
        KnowledgeArticle(title="x", visibility="weird")
    # Valid
    KnowledgeArticle(title="x", visibility="public")
    KnowledgeArticle(title="x", visibility="connections")


def test_knowledge_upsert_and_lookup(tmp_path):
    k = KnowledgeStore(tmp_path)
    a = KnowledgeArticle(
        article_id="art-1",
        title="User Travel Preferences",
        summary="Compiled overview of where the user likes to go.",
        content="# Travel\n\nThe user prefers …",
        tags=["travel", "preferences"],
    )
    k.upsert(a)
    assert k.get("art-1").title == "User Travel Preferences"
    assert k.get_by_title("User Travel Preferences").article_id == "art-1"
    assert {x.article_id for x in k.by_tag("travel")} == {"art-1"}


def test_knowledge_search_across_fields(tmp_path):
    k = KnowledgeStore(tmp_path)
    k.upsert(KnowledgeArticle(article_id="a1", title="Solidity",
                               summary="gas optimisation patterns",
                               content="…"))
    k.upsert(KnowledgeArticle(article_id="a2", title="Cooking",
                               summary="favourite cuisines",
                               content="japanese, italian",
                               tags=["food"]))

    assert {x.article_id for x in k.search("solidity")} == {"a1"}
    assert {x.article_id for x in k.search("gas")} == {"a1"}
    assert {x.article_id for x in k.search("food")} == {"a2"}
    assert {x.article_id for x in k.search("japanese")} == {"a2"}
    assert k.search("") == []


def test_knowledge_versioning(tmp_path):
    k = KnowledgeStore(tmp_path)
    k.upsert(KnowledgeArticle(article_id="a1", title="Alpha"))
    v1 = k.commit()
    k.upsert(KnowledgeArticle(article_id="a2", title="Beta"))
    k.commit()
    assert len(k) == 2
    k.rollback(v1)
    assert len(k) == 1
    assert k.get("a2") is None


# ═════════════════════════════════════════════════════════════════════
# Public API surface
# ═════════════════════════════════════════════════════════════════════


def test_top_level_exports():
    """All Phase J namespace types reachable via the package root."""
    assert nexus_core.Fact is Fact
    assert nexus_core.FactsStore is FactsStore
    assert nexus_core.LearnedSkill is LearnedSkill
    assert nexus_core.SkillsStore is SkillsStore
    assert nexus_core.PersonaVersion is PersonaVersion
    assert nexus_core.PersonaStore is PersonaStore
    assert nexus_core.KnowledgeArticle is KnowledgeArticle
    assert nexus_core.KnowledgeStore is KnowledgeStore


def test_schema_strings_are_pinned(tmp_path):
    """Each namespace stamps a stable schema string into its
    working file. External readers can rely on these to detect
    which schema they're parsing."""
    FactsStore(tmp_path / "f").upsert(Fact(content="x"))
    SkillsStore(tmp_path / "s").upsert(LearnedSkill(skill_name="x"))
    KnowledgeStore(tmp_path / "k").upsert(KnowledgeArticle(title="x"))

    f_data = json.loads((tmp_path / "f" / "facts" / "_working.json").read_text())
    s_data = json.loads((tmp_path / "s" / "skills" / "_working.json").read_text())
    k_data = json.loads((tmp_path / "k" / "knowledge" / "_working.json").read_text())

    assert f_data["schema"] == "nexus.memory.facts.v1"
    assert s_data["schema"] == "nexus.memory.skills.v1"
    assert k_data["schema"] == "nexus.memory.knowledge.v1"
