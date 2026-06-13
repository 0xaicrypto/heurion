"""Tests for #137 — semantic_search tool.

We mock the vector_index.search_chunks to keep tests offline.
The tool's contract surface is:

  * required ``query`` arg, rejects empty
  * ``limit`` clamp [1, 20], default 8
  * ``kinds`` filter validation (drops unknown values)
  * EmbeddingUnavailable → friendly error pointing to search_past_chats
  * Empty hit list → readable no-match output
  * Hits serialised as JSON with rank, source_kind, source_id, text, distance
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        asyncio.set_event_loop(loop)


@dataclass
class _FakeHit:
    chunk_id: int
    source_kind: str
    source_id: str
    text_chunk: str
    distance: float
    chunk_index: int = 0
    created_at_ms: int = 1700000000000


def _patch_search(monkeypatch, hits=None, raise_with=None):
    """Replace vector_index.search_chunks for the duration of a test."""
    captured: dict = {}

    async def fake_search(
        user_id, query, *, k=10, source_kinds=None,
        embedding_client=None,
    ):
        captured["user_id"] = user_id
        captured["query"] = query
        captured["k"] = k
        captured["source_kinds"] = source_kinds
        if raise_with is not None:
            raise raise_with
        return hits or []

    import nexus_server.vector_index as vi
    monkeypatch.setattr(vi, "search_chunks", fake_search)
    return captured


def test_empty_query_returns_error(monkeypatch):
    from nexus_server.tools_memory import SemanticSearchTool
    _patch_search(monkeypatch)

    tool = SemanticSearchTool(user_id="u1")
    result = _run(tool.execute(query="   "))
    assert not result.success
    assert "required" in (result.error or "")


def test_basic_hit_payload(monkeypatch):
    from nexus_server.tools_memory import SemanticSearchTool

    hits = [
        _FakeHit(1, "caption", "file-aaa", "Chest CT axial...", 0.12),
        _FakeHit(2, "chat", "event-42", "I saw a chest CT...", 0.34),
    ]
    captured = _patch_search(monkeypatch, hits=hits)

    tool = SemanticSearchTool(user_id="u1")
    result = _run(tool.execute(query="that lung CT"))
    assert result.success
    payload = json.loads(result.output)

    assert payload["query"] == "that lung CT"
    assert len(payload["hits"]) == 2
    assert payload["hits"][0]["rank"] == 1
    assert payload["hits"][0]["source_kind"] == "caption"
    assert payload["hits"][0]["source_id"] == "file-aaa"
    assert payload["hits"][0]["distance"] == 0.12

    # The tool passed our user_id through to the index, not some
    # default — important for multi-tenant isolation.
    assert captured["user_id"] == "u1"


def test_limit_clamping(monkeypatch):
    """limit goes through min(20, max(1, limit))."""
    from nexus_server.tools_memory import SemanticSearchTool
    captured = _patch_search(monkeypatch, hits=[])

    tool = SemanticSearchTool(user_id="u1")

    # Negative gets clamped to 1
    _run(tool.execute(query="x", limit=-5))
    assert captured["k"] == 1

    # Too large gets clamped to 20
    _run(tool.execute(query="x", limit=999))
    assert captured["k"] == 20

    # Default of 8 when not provided
    _run(tool.execute(query="x"))
    assert captured["k"] == 8


def test_kinds_filter_rejects_unknown(monkeypatch):
    """Unknown source_kind names are silently dropped, not passed through."""
    from nexus_server.tools_memory import SemanticSearchTool
    captured = _patch_search(monkeypatch, hits=[])

    tool = SemanticSearchTool(user_id="u1")
    _run(tool.execute(query="x", kinds=["caption", "junk", "chat"]))

    assert set(captured["source_kinds"]) == {"caption", "chat"}


def test_no_kinds_filter_passes_none(monkeypatch):
    """No kinds filter → None (means "search everything")."""
    from nexus_server.tools_memory import SemanticSearchTool
    captured = _patch_search(monkeypatch, hits=[])

    tool = SemanticSearchTool(user_id="u1")
    _run(tool.execute(query="x"))
    assert captured["source_kinds"] is None


def test_embedding_unavailable_returns_friendly_error(monkeypatch):
    """When EmbeddingUnavailable raises, tool returns guidance to use
    search_past_chats instead."""
    from nexus_server.tools_memory import SemanticSearchTool
    from nexus_server.vector_index import EmbeddingUnavailable

    _patch_search(monkeypatch, raise_with=EmbeddingUnavailable("no API key"))

    tool = SemanticSearchTool(user_id="u1")
    result = _run(tool.execute(query="anything"))

    assert not result.success
    assert "no API key" in (result.error or "")
    # Must tell the agent there's a fallback so it doesn't give up.
    assert "search_past_chats" in (result.error or "")


def test_empty_hits_returns_readable_message(monkeypatch):
    """No matches → human-readable text, not a JSON empty list."""
    from nexus_server.tools_memory import SemanticSearchTool
    _patch_search(monkeypatch, hits=[])

    tool = SemanticSearchTool(user_id="u1")
    result = _run(tool.execute(query="never discussed"))

    assert result.success
    # The output is plain text, not JSON, when nothing matches.
    assert "No semantically similar" in (result.output or "")
    # Should also hint at the lexical fallback.
    assert "search_past_chats" in (result.output or "")


def test_hits_preserve_order_and_distance(monkeypatch):
    """Hits come back in the order vector_index returned them."""
    from nexus_server.tools_memory import SemanticSearchTool

    hits = [
        _FakeHit(1, "caption", "f1", "closest", 0.01),
        _FakeHit(2, "caption", "f2", "middle",  0.20),
        _FakeHit(3, "caption", "f3", "farthest", 0.80),
    ]
    _patch_search(monkeypatch, hits=hits)

    tool = SemanticSearchTool(user_id="u1")
    result = _run(tool.execute(query="x"))
    payload = json.loads(result.output)

    assert [h["source_id"] for h in payload["hits"]] == ["f1", "f2", "f3"]
    assert [h["distance"] for h in payload["hits"]] == [0.01, 0.20, 0.80]


def test_chinese_query_passes_through(monkeypatch):
    """Cross-language search: query is Chinese, ensure it doesn't get
    mangled / dropped between tool and vector_index."""
    from nexus_server.tools_memory import SemanticSearchTool
    captured = _patch_search(monkeypatch, hits=[])

    tool = SemanticSearchTool(user_id="u1")
    _run(tool.execute(query="找一下上次的胸 CT"))

    assert captured["query"] == "找一下上次的胸 CT"


def test_tool_registers_alongside_search_past_chats():
    """register_memory_tools should now register BOTH tools."""
    from nexus_server.tools_memory import register_memory_tools
    from types import SimpleNamespace

    registered = []
    fake_twin = SimpleNamespace(
        register_tool=lambda t: registered.append(t.name),
        _thread_id="",
    )
    register_memory_tools(fake_twin, user_id="u1")
    assert "search_past_chats" in registered
    assert "semantic_search" in registered
