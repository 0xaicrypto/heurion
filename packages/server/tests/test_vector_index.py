"""Smoke tests for the vector index (#135).

We mock the embedding client because (a) the sandbox doesn't have
outbound network to Gemini, (b) we want deterministic results to assert
on. The mock returns vectors that are unit vectors aligned with the
text's hash — same text always gets the same vector, different texts
get different vectors, and we can construct "close" pairs by design.

Real Gemini integration is covered by manual checks at deploy time.
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import os
import shutil
import tempfile
from dataclasses import dataclass

import pytest


@dataclass
class _FakeEmbResult:
    text: str
    embedding: list[float]
    model: str = "fake-test-model"


class _FakeEmbeddingClient:
    """Deterministic per-text vectors built from a hash.

    The vector is 768d unit-length, where each component is derived
    from the SHA-256 of the input text. This gives us:

    * Same text → same vector (re-embed is idempotent)
    * Different text → different vector (search can distinguish)
    * We can construct controlled "similar" pairs by hashing
      semantically-related strings together.

    The vector is intentionally NOT a real semantic embedding — but
    the storage / retrieval pipeline only cares that it's a stable
    768-float blob, which is exactly what this gives us.
    """

    def __init__(self):
        self.call_count = 0
        self.batch_sizes: list[int] = []

    async def embed_batch(self, texts):
        from nexus_server.vector_index import EMBEDDING_DIM
        self.call_count += 1
        self.batch_sizes.append(len(texts))
        out = []
        for t in texts:
            h = hashlib.sha256(t.encode("utf-8")).digest()
            # Expand 32 bytes → 768 floats by tiling + scaling.
            raw = []
            for i in range(EMBEDDING_DIM):
                b = h[i % len(h)]
                raw.append((b - 128) / 128.0)  # roughly [-1, 1]
            # Normalise to unit length so cosine distances are sane.
            norm = math.sqrt(sum(x * x for x in raw)) or 1.0
            vec = [x / norm for x in raw]
            out.append(_FakeEmbResult(text=t, embedding=vec))
        return out


@pytest.fixture
def isolated_index(monkeypatch):
    """Point vector_index at a fresh temp DB for each test.

    Without this, parallel tests would step on each other since the
    module uses a single multi-tenant DB by design.
    """
    tmp = tempfile.mkdtemp(prefix="nexus-vec-test-")
    monkeypatch.setenv("RUNE_HOME", tmp)

    # Force a fresh import path so the module picks up the new
    # RUNE_HOME on _index_db_path() resolution (it reads the env
    # var every call, so no reload needed — but we clear the
    # singleton client just in case).
    import nexus_server.vector_index as vi
    vi._default_client = None
    vi.init_vector_index()
    yield vi
    shutil.rmtree(tmp, ignore_errors=True)


def test_chunk_text_short_returns_single():
    from nexus_server.vector_index import chunk_text
    chunks = chunk_text("Short text.")
    assert chunks == ["Short text."]


def test_chunk_text_empty_returns_empty():
    from nexus_server.vector_index import chunk_text
    assert chunk_text("") == []
    assert chunk_text("   ") == []
    assert chunk_text(None or "") == []


def test_chunk_text_long_splits_at_paragraphs():
    from nexus_server.vector_index import chunk_text
    text = "Para A. " * 200 + "\n\n" + "Para B. " * 200
    chunks = chunk_text(text, char_budget=1500)
    assert len(chunks) >= 2
    assert all(len(c) <= 1500 for c in chunks)


def test_chunk_text_caps_at_max_chunks():
    """Pathologically long text shouldn't generate hundreds of chunks."""
    from nexus_server.vector_index import chunk_text, MAX_CHUNKS_PER_SOURCE
    text = "\n\n".join([f"Paragraph {i}. " * 500 for i in range(50)])
    chunks = chunk_text(text)
    assert len(chunks) <= MAX_CHUNKS_PER_SOURCE


def test_upsert_then_search_roundtrip(isolated_index):
    """Write a few chunks, search by similar text, get back the closest."""
    vi = isolated_index
    fake = _FakeEmbeddingClient()

    async def run():
        # Write 3 chunks under different sources
        await vi.upsert_chunks(
            user_id="u1",
            source_kind="chat",
            source_id="msg-100",
            text="The patient has a nodule in the right upper lung.",
            embedding_client=fake,
        )
        await vi.upsert_chunks(
            user_id="u1",
            source_kind="caption",
            source_id="img-200",
            text="Chest CT showing right upper lobe lesion, 8mm.",
            embedding_client=fake,
        )
        await vi.upsert_chunks(
            user_id="u1",
            source_kind="chat",
            source_id="msg-300",
            text="Tomorrow's lunch is sushi at 12pm.",
            embedding_client=fake,
        )

        # Search for the most similar to the FIRST chunk's text. Since
        # the fake embedder gives identical vectors for identical text,
        # the exact-match chunk should be hit #1 (distance 0).
        hits = await vi.search_chunks(
            user_id="u1",
            query="The patient has a nodule in the right upper lung.",
            k=3,
            embedding_client=fake,
        )
        return hits

    hits = asyncio.run(run())
    assert len(hits) >= 1
    assert hits[0].source_id == "msg-100"
    assert hits[0].distance < 1e-5  # exact match
    # Sorted by distance ascending
    assert all(hits[i].distance <= hits[i + 1].distance for i in range(len(hits) - 1))


def test_user_isolation(isolated_index):
    """Chunks written under u1 must not surface in u2's searches."""
    vi = isolated_index
    fake = _FakeEmbeddingClient()

    async def run():
        await vi.upsert_chunks(
            user_id="u1", source_kind="chat", source_id="m1",
            text="alpha bravo charlie", embedding_client=fake,
        )
        await vi.upsert_chunks(
            user_id="u2", source_kind="chat", source_id="m2",
            text="delta echo foxtrot", embedding_client=fake,
        )
        hits_u1 = await vi.search_chunks(
            user_id="u1", query="alpha bravo charlie", k=5,
            embedding_client=fake,
        )
        hits_u2 = await vi.search_chunks(
            user_id="u2", query="alpha bravo charlie", k=5,
            embedding_client=fake,
        )
        return hits_u1, hits_u2

    h1, h2 = asyncio.run(run())
    assert {h.source_id for h in h1} == {"m1"}
    assert {h.source_id for h in h2} == {"m2"}


def test_source_kind_filter(isolated_index):
    """source_kinds= filter scopes the k-NN."""
    vi = isolated_index
    fake = _FakeEmbeddingClient()

    async def run():
        await vi.upsert_chunks(
            user_id="u1", source_kind="chat", source_id="c1",
            text="medical CT lung", embedding_client=fake,
        )
        await vi.upsert_chunks(
            user_id="u1", source_kind="caption", source_id="cap1",
            text="medical CT lung", embedding_client=fake,
        )
        # Same text under both kinds: with no filter we get both,
        # with kind filter we get only one.
        unfiltered = await vi.search_chunks(
            user_id="u1", query="medical CT lung", k=5,
            embedding_client=fake,
        )
        only_caption = await vi.search_chunks(
            user_id="u1", query="medical CT lung", k=5,
            source_kinds=["caption"], embedding_client=fake,
        )
        return unfiltered, only_caption

    unf, capt = asyncio.run(run())
    assert {h.source_kind for h in unf} == {"chat", "caption"}
    assert {h.source_kind for h in capt} == {"caption"}


def test_upsert_replaces_prior_chunks(isolated_index):
    """Re-distilling under the same key replaces, not appends."""
    vi = isolated_index
    fake = _FakeEmbeddingClient()

    async def run():
        await vi.upsert_chunks(
            user_id="u1", source_kind="caption", source_id="img-1",
            text="version 1 text", embedding_client=fake,
        )
        await vi.upsert_chunks(
            user_id="u1", source_kind="caption", source_id="img-1",
            text="version 2 completely different content here", embedding_client=fake,
        )
        # Search for v1's text — should NOT find img-1 because we
        # replaced. (Fake embedder hashes the text, so v1 vector ≠
        # v2 vector; img-1's stored vector is now v2's vector.)
        hits = await vi.search_chunks(
            user_id="u1", query="version 1 text", k=5,
            embedding_client=fake,
        )
        # Find which chunks belong to img-1: should be exactly 1
        # (the v2 chunk), and its distance should be > 0 because
        # the query text differs.
        img1_chunks = [h for h in hits if h.source_id == "img-1"]
        return img1_chunks

    img1 = asyncio.run(run())
    assert len(img1) == 1
    assert "version 2" in img1[0].text_chunk


def test_delete_chunks_for_source(isolated_index):
    """delete_chunks_for_source wipes both metadata and vec0 rows."""
    vi = isolated_index
    fake = _FakeEmbeddingClient()

    async def run_setup():
        await vi.upsert_chunks(
            user_id="u1", source_kind="upload", source_id="file-x",
            text="some uploaded content", embedding_client=fake,
        )
    asyncio.run(run_setup())

    s_before = vi.stats(user_id="u1")
    assert s_before["total"] >= 1

    removed = vi.delete_chunks_for_source("u1", "upload", "file-x")
    assert removed >= 1

    s_after = vi.stats(user_id="u1")
    assert s_after.get("by_kind", {}).get("upload", 0) == 0


def test_stats_returns_kind_breakdown(isolated_index):
    """stats() helper for diagnostics."""
    vi = isolated_index
    fake = _FakeEmbeddingClient()

    async def run():
        await vi.upsert_chunks(
            user_id="u1", source_kind="chat", source_id="m1",
            text="a", embedding_client=fake,
        )
        await vi.upsert_chunks(
            user_id="u1", source_kind="caption", source_id="c1",
            text="b", embedding_client=fake,
        )
        await vi.upsert_chunks(
            user_id="u1", source_kind="caption", source_id="c2",
            text="c", embedding_client=fake,
        )
    asyncio.run(run())
    s = vi.stats(user_id="u1")
    assert s["by_kind"]["chat"] == 1
    assert s["by_kind"]["caption"] == 2
    assert s["total"] == 3


def test_embedding_unavailable_when_no_api_key(isolated_index, monkeypatch):
    """The real embedding client raises if GEMINI_API_KEY is missing.

    Important: callers (upsert / search) propagate this so the higher
    layer can fall back to lexical search. We don't want a silent
    no-op that hides "embeddings stopped working" for weeks.
    """
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    from nexus_server.vector_index import (
        GeminiEmbeddingClient, EmbeddingUnavailable,
    )

    # Force a brand-new client so it picks up the lack-of-key state.
    client = GeminiEmbeddingClient(api_key="")

    async def run():
        with pytest.raises(EmbeddingUnavailable):
            await client.embed_batch(["test"])

    asyncio.run(run())


def test_empty_query_returns_empty(isolated_index):
    """Empty / whitespace query short-circuits — no embed call."""
    vi = isolated_index
    fake = _FakeEmbeddingClient()

    async def run():
        return await vi.search_chunks(
            user_id="u1", query="", k=5, embedding_client=fake,
        )

    hits = asyncio.run(run())
    assert hits == []
    assert fake.call_count == 0  # didn't even try to embed


def test_packing_round_trip():
    """The vector pack format matches sqlite-vec's expectations."""
    from nexus_server.vector_index import _pack_vector, EMBEDDING_DIM
    vec = [0.1] * EMBEDDING_DIM
    packed = _pack_vector(vec)
    assert len(packed) == EMBEDDING_DIM * 4  # float32 = 4 bytes
    # First float: 0.1 → bytes via struct
    import struct
    unpacked = struct.unpack(f"{EMBEDDING_DIM}f", packed)
    assert all(abs(u - 0.1) < 1e-6 for u in unpacked)
