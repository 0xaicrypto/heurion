"""Tests for the Phase C-1 memory / cross-session chat search tools."""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import tempfile
import time
from pathlib import Path

import pytest


@pytest.fixture
def fake_event_log(monkeypatch, tmp_path):
    """Build a fake twin DB at the path twin_event_log expects, seed
    some chat events across two sessions, and return the user_id."""
    user_id = "alice-xyz"

    # twin_event_log builds db_path from user_id via _twin_base_dir()
    # which honours NEXUS_TWIN_BASE_DIR or falls back. Set it.
    monkeypatch.setenv("NEXUS_TWIN_BASE_DIR", str(tmp_path))

    from nexus_server import twin_event_log
    db_path = twin_event_log._db_path(user_id)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
          idx        INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          content    TEXT,
          timestamp  REAL,
          metadata   TEXT,
          session_id TEXT
        )
        """
    )

    # Seed: 3 messages in session-A (about "BSC anchor"), 2 in session-B
    # (about "DPM projection"), 1 in default session (about "BSC anchor")
    rows = [
        ("user_message",       "Let's design the BSC anchor for state_root.", 1.0, "{}", "sess-A"),
        ("assistant_response", "Sure — the BSC anchor will hold a 32-byte state_root each cycle.", 2.0, "{}", "sess-A"),
        ("user_message",       "How does the DPM projection function work?", 3.0, "{}", "sess-B"),
        ("assistant_response", "It folds the EventLog into in-memory state via a deterministic reduce.", 4.0, "{}", "sess-B"),
        ("user_message",       "Refresh on BSC anchor — what does it cost?", 5.0, "{}", ""),
        # Noise / non-chat events must NOT appear in search
        ("chain_activity",     "Anchored stateRoot on BSC anchor for tokenId=42", 6.0, "{}", "sess-A"),
        ("user_message",       "current session message", 7.0, "{}", "sess-CURRENT"),
    ]
    conn.executemany(
        "INSERT INTO events (event_type, content, timestamp, metadata, session_id) VALUES (?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    conn.close()

    return user_id


# ─────────────────────────────────────────────────────────────────────
# search_messages — direct DB layer
# ─────────────────────────────────────────────────────────────────────


def test_search_messages_matches_substring(fake_event_log):
    from nexus_server import twin_event_log
    hits = twin_event_log.search_messages(fake_event_log, "BSC anchor", limit=10)
    contents = [h["snippet"] for h in hits]
    assert any("BSC anchor" in s for s in contents)
    # Expect 3 hits — 2 in sess-A + 1 in default session — but NOT the
    # chain_activity event.
    assert len(hits) == 3
    assert all(h["role"] in ("user", "assistant") for h in hits)


def test_search_messages_case_insensitive(fake_event_log):
    from nexus_server import twin_event_log
    hits = twin_event_log.search_messages(fake_event_log, "bsc ANCHOR", limit=5)
    assert len(hits) == 3


def test_search_messages_empty_query_returns_empty(fake_event_log):
    from nexus_server import twin_event_log
    assert twin_event_log.search_messages(fake_event_log, "", limit=5) == []
    assert twin_event_log.search_messages(fake_event_log, "   ", limit=5) == []


def test_search_messages_excludes_session(fake_event_log):
    from nexus_server import twin_event_log
    # Excluding sess-CURRENT shouldn't affect "BSC anchor" hits.
    hits = twin_event_log.search_messages(
        fake_event_log, "BSC anchor", limit=10,
        exclude_session_id="sess-CURRENT",
    )
    assert len(hits) == 3
    # Now exclude sess-A — should drop to just the default-session hit.
    hits = twin_event_log.search_messages(
        fake_event_log, "BSC anchor", limit=10,
        exclude_session_id="sess-A",
    )
    assert len(hits) == 1
    assert hits[0]["session_id"] == ""


def test_search_messages_returns_sync_id(fake_event_log):
    from nexus_server import twin_event_log
    hits = twin_event_log.search_messages(fake_event_log, "DPM projection", limit=5)
    assert len(hits) == 1
    h = hits[0]
    assert isinstance(h["sync_id"], int) and h["sync_id"] > 0
    assert h["session_id"] == "sess-B"


def test_search_messages_skips_non_chat_events(fake_event_log):
    from nexus_server import twin_event_log
    # chain_activity row contains "Anchored stateRoot" — but we should
    # NOT see it because event_type is not user_message/assistant_*.
    hits = twin_event_log.search_messages(fake_event_log, "Anchored stateRoot", limit=5)
    assert hits == []


# ─────────────────────────────────────────────────────────────────────
# SearchPastChatsTool — function-calling layer
# ─────────────────────────────────────────────────────────────────────


def test_search_past_chats_tool_returns_structured_json(fake_event_log):
    """Memory Fix C: the tool now returns {chat_hits, file_hits}
    wrapping the per-surface arrays."""
    from nexus_server.tools_memory import SearchPastChatsTool
    tool = SearchPastChatsTool(
        user_id=fake_event_log, session_id_getter=lambda: "sess-CURRENT",
    )
    result = asyncio.run(tool.execute(query="BSC anchor"))
    assert result.success
    payload = json.loads(result.output)
    assert isinstance(payload, dict)
    assert set(payload.keys()) == {"chat_hits", "file_hits"}
    assert len(payload["chat_hits"]) == 3
    # Each chat hit must carry the wire shape the desktop renderer needs
    for h in payload["chat_hits"]:
        assert set(h.keys()) >= {"sync_id", "session_id", "role", "snippet", "timestamp"}
    # No files uploaded in this fixture — file_hits is empty
    assert payload["file_hits"] == []


def test_search_past_chats_excludes_current_session_by_default(fake_event_log):
    from nexus_server.tools_memory import SearchPastChatsTool
    tool = SearchPastChatsTool(
        user_id=fake_event_log, session_id_getter=lambda: "sess-CURRENT",
    )
    # The current session has a message containing "current" — should NOT
    # be in results by default.
    result = asyncio.run(tool.execute(query="current session"))
    assert "No past messages matched" in result.output


def test_search_past_chats_includes_current_when_flagged(fake_event_log):
    from nexus_server.tools_memory import SearchPastChatsTool
    tool = SearchPastChatsTool(
        user_id=fake_event_log, session_id_getter=lambda: "sess-CURRENT",
    )
    result = asyncio.run(tool.execute(
        query="current session", include_current_session=True,
    ))
    payload = json.loads(result.output)
    chat_hits = payload["chat_hits"]
    assert len(chat_hits) == 1
    assert chat_hits[0]["session_id"] == "sess-CURRENT"


def test_search_past_chats_empty_query_errors(fake_event_log):
    from nexus_server.tools_memory import SearchPastChatsTool
    tool = SearchPastChatsTool(
        user_id=fake_event_log, session_id_getter=lambda: "",
    )
    result = asyncio.run(tool.execute(query="   "))
    assert not result.success
    assert "query" in result.error.lower()


def test_search_past_chats_no_hits_returns_friendly_message(fake_event_log):
    from nexus_server.tools_memory import SearchPastChatsTool
    tool = SearchPastChatsTool(
        user_id=fake_event_log, session_id_getter=lambda: "",
    )
    result = asyncio.run(tool.execute(query="nonexistent topic xyz"))
    assert result.success
    assert "No past messages matched" in result.output


def test_search_past_chats_clamps_limit(fake_event_log):
    """Even if the LLM asks for 1000 results, we cap at 20 so a
    misbehaving call can't dump the whole event log into context."""
    from nexus_server.tools_memory import SearchPastChatsTool
    tool = SearchPastChatsTool(
        user_id=fake_event_log, session_id_getter=lambda: "",
    )
    # Insert a bunch of hits with the same word
    from nexus_server import twin_event_log
    db_path = twin_event_log._db_path(fake_event_log)
    conn = sqlite3.connect(db_path)
    for i in range(50):
        conn.execute(
            "INSERT INTO events (event_type, content, timestamp, metadata, session_id) "
            "VALUES (?, ?, ?, ?, ?)",
            ("user_message", f"floodword {i}", 100.0 + i, "{}", f"s-{i}"),
        )
    conn.commit()
    conn.close()
    result = asyncio.run(tool.execute(query="floodword", limit=1000))
    payload = json.loads(result.output)
    assert len(payload["chat_hits"]) == 20


# ─────────────────────────────────────────────────────────────────────
# Memory Fix C: uploaded files appear in search results
# ─────────────────────────────────────────────────────────────────────


def test_search_past_chats_includes_uploaded_file_hits(
    fake_event_log, monkeypatch, tmp_path,
):
    """When the user has uploaded a file whose extracted_text matches
    the query, search_past_chats should surface it under file_hits."""
    # Initialise the uploads table on the same DB the chat handler uses
    monkeypatch.setenv("NEXUS_DB_PATH", str(tmp_path / "memory_fix_c.db"))
    from nexus_server import database as db_mod
    if hasattr(db_mod, "_initialized"):
        db_mod._initialized = False
    db_mod.init_db()

    from nexus_server import files as _files
    _files._ensure_uploads_table()

    # Seed a fake upload with extracted_text containing our query
    from nexus_server.database import get_db_connection
    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO uploads (file_id, user_id, name, mime, size_bytes,
                                 disk_path, created_at, sha256, gnfd_path,
                                 extracted_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "abc123", fake_event_log, "paper.pdf",
                "application/pdf", 12345, "/tmp/paper.pdf",
                "2026-05-15T10:00:00Z", "deadbeef", "",
                "This paper analyses agentic commerce on BNB Chain and "
                "the role of DPM in stateless agent migration.",
            ),
        )
        conn.commit()

    from nexus_server.tools_memory import SearchPastChatsTool
    tool = SearchPastChatsTool(
        user_id=fake_event_log, session_id_getter=lambda: "",
    )
    result = asyncio.run(tool.execute(query="agentic commerce"))
    assert result.success
    payload = json.loads(result.output)
    assert len(payload["file_hits"]) == 1
    fh = payload["file_hits"][0]
    assert fh["file_name"] == "paper.pdf"
    assert "agentic commerce" in fh["snippet"].lower()
