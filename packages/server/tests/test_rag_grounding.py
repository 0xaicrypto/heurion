"""Tests for #138 — RAG memory grounding context block.

The block runs once per chat turn, before twin.chat — it pulls
the top-k semantically related chunks from the user's history and
formats them so the LLM sees them as background context. We verify:

  * Empty query → empty block (no embed call wasted)
  * Image captions append to the query (cross-modal recall)
  * Embedding backend down → empty block (silent fallback)
  * Hits get deduped by (kind, source_id) — long sources don't flood
  * Hit text trimmed to ~240 chars
  * Output contains [CONTEXT — RELATED PRIOR INTERACTIONS] header
"""

from __future__ import annotations

import asyncio
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
    created_at_ms: int = 0


def _patch_search(monkeypatch, hits=None, raise_with=None):
    captured: dict = {}

    async def fake_search(user_id, query, *, k=10, source_kinds=None, embedding_client=None):
        captured["user_id"] = user_id
        captured["query"] = query
        captured["k"] = k
        if raise_with is not None:
            raise raise_with
        return hits or []

    import nexus_server.vector_index as vi
    monkeypatch.setattr(vi, "search_chunks", fake_search)
    return captured


def test_empty_query_returns_empty_block(monkeypatch):
    from nexus_server.llm_gateway import _build_related_context_block
    captured = _patch_search(monkeypatch, hits=[])

    block = _run(_build_related_context_block(
        user_id="u1", bare_text="", image_captions=[],
    ))
    assert block == ""
    # Should not have even tried to search.
    assert "query" not in captured


def test_image_captions_append_to_query(monkeypatch):
    """When captions are present, they're concatenated to bare_text."""
    from nexus_server.llm_gateway import _build_related_context_block
    captured = _patch_search(monkeypatch, hits=[])

    _run(_build_related_context_block(
        user_id="u1",
        bare_text="看一下",
        image_captions=[
            "kind: medical_imaging\ndomain: chest CT axial\nsummary: 5mm 高密度影",
        ],
    ))
    assert "看一下" in captured["query"]
    assert "chest CT" in captured["query"]


def test_embedding_unavailable_returns_empty_silently(monkeypatch):
    from nexus_server.llm_gateway import _build_related_context_block
    from nexus_server.vector_index import EmbeddingUnavailable

    _patch_search(monkeypatch, raise_with=EmbeddingUnavailable("offline"))

    block = _run(_build_related_context_block(
        user_id="u1", bare_text="anything", image_captions=None,
    ))
    assert block == ""


def test_hits_deduped_by_kind_and_source(monkeypatch):
    """Multiple chunks from same source produce one line, not N."""
    from nexus_server.llm_gateway import _build_related_context_block

    hits = [
        _FakeHit(1, "caption", "file-aaa", "chunk 1 of CT", 0.05),
        _FakeHit(2, "caption", "file-aaa", "chunk 2 of CT", 0.10),
        _FakeHit(3, "chat", "event-42", "we discussed CT", 0.20),
    ]
    _patch_search(monkeypatch, hits=hits)

    block = _run(_build_related_context_block(
        user_id="u1", bare_text="CT", image_captions=None,
    ))

    assert "file-aaa" in block
    assert "event-42" in block
    # Only ONE line per (kind, source_id) — count occurrences of
    # the source_id appearing in a hit line.
    assert block.count("[caption:file-aaa") == 1


def test_long_text_trimmed(monkeypatch):
    """Each hit's text gets trimmed to ~240 chars + ellipsis."""
    from nexus_server.llm_gateway import _build_related_context_block

    long_text = "x" * 1000
    hits = [_FakeHit(1, "chat", "event-1", long_text, 0.1)]
    _patch_search(monkeypatch, hits=hits)

    block = _run(_build_related_context_block(
        user_id="u1", bare_text="hi", image_captions=None,
    ))
    # Single bullet line should be < 350 chars (240 text + prefix + suffix).
    bullet_line = next(
        (line for line in block.splitlines() if "event-1" in line), ""
    )
    assert len(bullet_line) < 350
    assert "…" in bullet_line


def test_no_hits_returns_empty(monkeypatch):
    """search returns empty list → block is empty (don't emit a
    'no matches' header, just stay quiet)."""
    from nexus_server.llm_gateway import _build_related_context_block
    _patch_search(monkeypatch, hits=[])

    block = _run(_build_related_context_block(
        user_id="u1", bare_text="searchable", image_captions=None,
    ))
    assert block == ""


def test_block_header_and_format(monkeypatch):
    """Successful retrieval emits a recognisable [CONTEXT — ...] header
    and per-hit bullets with (kind:source_id, sim=...) prefix."""
    from nexus_server.llm_gateway import _build_related_context_block

    hits = [
        _FakeHit(1, "caption", "file-a", "Chest CT, RUL nodule", 0.12),
        _FakeHit(2, "chat", "event-7", "We saw a similar finding", 0.30),
    ]
    _patch_search(monkeypatch, hits=hits)

    block = _run(_build_related_context_block(
        user_id="u1", bare_text="新片来了", image_captions=None,
    ))

    assert "[CONTEXT — RELATED PRIOR INTERACTIONS]" in block
    assert "background memory" in block
    assert "caption:file-a" in block
    assert "chat:event-7" in block
    # Similarity score = 1 - distance, formatted .2f
    assert "sim=0.88" in block  # 1 - 0.12 = 0.88
    assert "sim=0.70" in block  # 1 - 0.30 = 0.70


def test_user_id_scopes_search(monkeypatch):
    """The block must pass user_id through, never search globally."""
    from nexus_server.llm_gateway import _build_related_context_block
    captured = _patch_search(monkeypatch, hits=[])

    _run(_build_related_context_block(
        user_id="medic-jin", bare_text="x", image_captions=None,
    ))
    assert captured["user_id"] == "medic-jin"


def test_k_limited_to_5(monkeypatch):
    """Should only ask for top-5; don't flood the context window."""
    from nexus_server.llm_gateway import _build_related_context_block
    captured = _patch_search(monkeypatch, hits=[])

    _run(_build_related_context_block(
        user_id="u1", bare_text="x", image_captions=None,
    ))
    assert captured["k"] == 5
