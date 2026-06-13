"""Tests for #136 — auto-embed pipeline.

We verify the routing logic in twin's ``_enqueue_vector_embed``
fire-and-forget helper:

  * ``user_message`` text → source_kind="chat", source_id=f"event-{idx}"
  * ``assistant_response`` text → same shape
  * ``attachment_distilled`` with image/* MIME → source_kind="caption"
  * ``attachment_distilled`` with non-image MIME → source_kind="attachment"
  * source_id prefers file_id when present (cross-session stable),
    falls back to filename, then "anon"

We mock ``upsert_chunks`` so the test runs offline + we can assert
on exact (kind, source_id) tuples submitted.
"""

from __future__ import annotations

import asyncio


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        asyncio.set_event_loop(loop)


def _make_fake_twin(user_id: str = "u-test"):
    """Build the smallest twin-like object that ``_enqueue_vector_embed``
    needs. We use a real twin instance is overkill — the method only
    touches self.config.owner + self._bg_task."""
    from types import SimpleNamespace
    import nexus.twin as twin_mod

    twin = SimpleNamespace()
    twin.config = SimpleNamespace(owner=user_id, agent_id="agent-x")
    twin._bg_tasks = set()
    # Bind the real method to our SimpleNamespace so it uses our
    # config / _bg_tasks state but the actual routing logic.
    twin._bg_task = twin_mod.DigitalTwin._bg_task.__get__(twin)
    twin._enqueue_vector_embed = twin_mod.DigitalTwin._enqueue_vector_embed.__get__(twin)
    return twin


def test_chat_messages_routed_as_chat_kind(monkeypatch):
    """user_message + assistant_response both go to source_kind='chat'."""
    captured: list[tuple] = []

    async def fake_upsert(user_id, source_kind, source_id, text, **kwargs):
        captured.append((user_id, source_kind, source_id, text[:30]))

    import nexus_server.vector_index as vi
    monkeypatch.setattr(vi, "upsert_chunks", fake_upsert)

    async def run():
        twin = _make_fake_twin("u-1")
        twin._enqueue_vector_embed(
            user_id="u-1",
            user_msg_idx=42,
            user_msg_text="show me this CT",
            assistant_msg_idx=43,
            assistant_msg_text="I see a chest CT axial slice...",
            distilled=[],
        )
        # Bg task is fire-and-forget; let the event loop tick.
        await asyncio.sleep(0.05)

    _run(run())

    kinds_ids = [(k, sid) for (_u, k, sid, _t) in captured]
    assert ("chat", "event-42") in kinds_ids
    assert ("chat", "event-43") in kinds_ids
    assert all(uid == "u-1" for (uid, _k, _sid, _t) in captured)


def test_image_distill_routes_to_caption_kind(monkeypatch):
    """attachment_distilled with image/* MIME becomes 'caption' kind."""
    captured: list[tuple] = []

    async def fake_upsert(user_id, source_kind, source_id, text, **kwargs):
        captured.append((source_kind, source_id))

    import nexus_server.vector_index as vi
    monkeypatch.setattr(vi, "upsert_chunks", fake_upsert)

    async def run():
        twin = _make_fake_twin()
        twin._enqueue_vector_embed(
            user_id="u-test",
            user_msg_idx=1,
            user_msg_text="look",
            assistant_msg_idx=2,
            assistant_msg_text="ok",
            distilled=[
                {
                    "name": "ct1.png", "mime": "image/png",
                    "size_bytes": 9999, "summary": "Chest CT axial",
                    "source": "vision-caption",
                    "file_id": "file-aaa",
                },
                {
                    "name": "paper.pdf", "mime": "application/pdf",
                    "size_bytes": 88888, "summary": "A research paper",
                    "source": "pdf",
                    "file_id": "file-bbb",
                },
            ],
        )
        await asyncio.sleep(0.05)

    _run(run())

    kinds = {k for (k, _sid) in captured}
    assert "caption" in kinds
    assert "attachment" in kinds
    assert "chat" in kinds

    # source_id should be file_id, not event-N or filename
    by_kind = {k: sid for (k, sid) in captured if k != "chat"}
    assert by_kind["caption"] == "file-aaa"
    assert by_kind["attachment"] == "file-bbb"


def test_source_id_fallback_to_name_when_no_file_id(monkeypatch):
    """Without file_id, source_id falls back to filename, then 'anon'."""
    captured: list[tuple] = []

    async def fake_upsert(user_id, source_kind, source_id, text, **kwargs):
        captured.append((source_kind, source_id))

    import nexus_server.vector_index as vi
    monkeypatch.setattr(vi, "upsert_chunks", fake_upsert)

    async def run():
        twin = _make_fake_twin()
        twin._enqueue_vector_embed(
            user_id="u-test",
            user_msg_idx=1, user_msg_text="hi",
            assistant_msg_idx=2, assistant_msg_text="hello",
            distilled=[
                # Has name, no file_id
                {
                    "name": "named.txt", "mime": "text/plain",
                    "size_bytes": 10, "summary": "some text",
                    "source": "text",
                },
                # No name, no file_id
                {
                    "mime": "image/png",
                    "size_bytes": 10, "summary": "anon image",
                    "source": "vision-caption",
                },
            ],
        )
        await asyncio.sleep(0.05)

    _run(run())

    attachment_sources = [
        sid for (k, sid) in captured if k == "attachment"
    ]
    caption_sources = [
        sid for (k, sid) in captured if k == "caption"
    ]
    assert attachment_sources == ["named.txt"]
    assert caption_sources == ["anon"]


def test_empty_distilled_skips_no_chunks(monkeypatch):
    """Empty distilled list shouldn't add anything beyond chat msgs."""
    captured: list[tuple] = []

    async def fake_upsert(user_id, source_kind, source_id, text, **kwargs):
        captured.append((source_kind, source_id))

    import nexus_server.vector_index as vi
    monkeypatch.setattr(vi, "upsert_chunks", fake_upsert)

    async def run():
        twin = _make_fake_twin()
        twin._enqueue_vector_embed(
            user_id="u-test",
            user_msg_idx=1, user_msg_text="hi",
            assistant_msg_idx=2, assistant_msg_text="hello",
            distilled=[],
        )
        await asyncio.sleep(0.05)

    _run(run())
    # Exactly 2 chat chunks, nothing else.
    assert len(captured) == 2
    assert all(k == "chat" for (k, _sid) in captured)


def test_summary_with_blank_content_skipped(monkeypatch):
    """A distilled row with empty summary should not get embedded."""
    captured: list[tuple] = []

    async def fake_upsert(user_id, source_kind, source_id, text, **kwargs):
        captured.append((source_kind, source_id))

    import nexus_server.vector_index as vi
    monkeypatch.setattr(vi, "upsert_chunks", fake_upsert)

    async def run():
        twin = _make_fake_twin()
        twin._enqueue_vector_embed(
            user_id="u-test",
            user_msg_idx=1, user_msg_text="hi",
            assistant_msg_idx=2, assistant_msg_text="hello",
            distilled=[
                {
                    "name": "broken.png", "mime": "image/png",
                    "size_bytes": 0, "summary": "",  # empty caption
                    "source": "vision-caption+empty",
                    "file_id": "file-broken",
                },
            ],
        )
        await asyncio.sleep(0.05)

    _run(run())
    # Should NOT have a caption row for the empty one.
    captions = [sid for (k, sid) in captured if k == "caption"]
    assert captions == []


def test_upsert_failure_is_swallowed(monkeypatch):
    """If upsert_chunks raises (e.g. EmbeddingUnavailable), the
    background task swallows so the chat turn still returns."""

    async def broken_upsert(user_id, source_kind, source_id, text, **kwargs):
        from nexus_server.vector_index import EmbeddingUnavailable
        raise EmbeddingUnavailable("no API key in test")

    import nexus_server.vector_index as vi
    monkeypatch.setattr(vi, "upsert_chunks", broken_upsert)

    async def run():
        twin = _make_fake_twin()
        # Should not raise.
        twin._enqueue_vector_embed(
            user_id="u-test",
            user_msg_idx=1, user_msg_text="hi",
            assistant_msg_idx=2, assistant_msg_text="hello",
            distilled=[],
        )
        await asyncio.sleep(0.05)
        # If we reach here, the broken upsert was swallowed.

    _run(run())


def test_twin_chat_signature_accepts_distilled_attachments():
    """Smoke: twin.chat exposes the new kwarg llm_gateway depends on."""
    import inspect
    from nexus.twin import DigitalTwin

    sig = inspect.signature(DigitalTwin.chat)
    assert "distilled_attachments" in sig.parameters
    assert sig.parameters["distilled_attachments"].default is None
