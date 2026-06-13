"""
Integration test for the real-LLM T3 chat path.

Earlier the T3 branch in retrieval_tiers.yield_t3 returned a hardcoded
"(T3 multi-hop reasoning … ships in M1.6+.)" placeholder regardless of
the question — that's what the user saw three times in a row in chat.

This test pins the new behaviour:

  * retrieve_async dispatches T3 questions to yield_t3_llm
  * yield_t3_llm builds a system prompt that includes patient context
  * yield_t3_llm calls llm_gateway.call_llm
  * the returned content is emitted as final_answer_chunk
  * if call_llm raises, the failure is surfaced as a final_answer_chunk
    (NOT swallowed silently — the user must know LLM is broken)
"""
from __future__ import annotations

import asyncio
import pathlib
import sqlite3
import sys
from contextlib import asynccontextmanager

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from nexus_server import retrieval_tiers


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def conn(tmp_path):
    db = tmp_path / "graph.db"
    c = sqlite3.connect(db)
    c.executescript(
        """
        CREATE TABLE clinical_graph_nodes (
            node_id INTEGER PRIMARY KEY,
            user_id TEXT NOT NULL,
            patient_hash TEXT NOT NULL,
            node_type TEXT NOT NULL,
            content_json TEXT NOT NULL,
            weight REAL DEFAULT 1.0
        );
        CREATE TABLE clinical_graph_edges (
            src_node INTEGER, dst_node INTEGER,
            user_id TEXT, patient_hash TEXT,
            edge_type TEXT
        );
        """
    )
    c.executemany(
        "INSERT INTO clinical_graph_nodes(node_id, user_id, patient_hash, node_type, content_json, weight) "
        "VALUES (?,?,?,?,?,?)",
        [
            (1, "u1", "p1", "finding",
             '{"label":"left renal mass","size_cm":3.2}', 0.9),
            (2, "u1", "p1", "med",
             '{"label":"amlodipine 5 mg"}', 0.7),
            (3, "u1", "p1", "study",
             '{"label":"CT abdomen","study_date":"2026-05-12"}', 0.8),
        ],
    )
    c.commit()
    yield c
    c.close()


async def _drain(it):
    out = []
    async for chunk in it:
        out.append((chunk.kind, dict(chunk.data)))
    return out


# ─────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────


def test_gather_patient_context_includes_all_node_kinds(conn):
    block = retrieval_tiers._gather_patient_context(conn, "u1", "p1")
    assert "left renal mass" in block
    assert "amlodipine" in block
    assert "CT abdomen" in block
    # Headings come from the kind→label map.
    assert "Active findings" in block
    assert "Medications" in block
    assert "Imaging studies" in block


def test_yield_t3_calls_real_llm(conn, monkeypatch):
    """Critical pin: yield_t3_llm must invoke call_llm — NOT return the
    old hardcoded placeholder."""
    calls: list[dict] = []

    async def fake_call_llm(*, messages, system_prompt, model, temperature, max_tokens, tools):
        calls.append({
            "messages": messages,
            "system_prompt": system_prompt,
            "model": model,
            "temperature": temperature,
            "max_tokens": max_tokens,
        })
        return ("Renal masses >3 cm warrant urology referral.", "gemini-2.5-flash", "stop", [])

    from nexus_server import llm_gateway
    monkeypatch.setattr(llm_gateway, "call_llm", fake_call_llm)

    chunks = asyncio.run(_drain(retrieval_tiers.yield_t3_llm(
        conn, user_id="u1", patient_hash="p1",
        question="What should I do with this renal mass?",
    )))
    kinds = [c[0] for c in chunks]
    # Frame contract
    assert kinds[0] == "tier_classified"
    assert "final_answer_chunk" in kinds
    assert "turn_complete" in kinds[-1:]

    # call_llm WAS invoked, exactly once.
    assert len(calls) == 1
    # System prompt was built and contains patient context.
    sp = calls[0]["system_prompt"]
    assert "left renal mass" in sp
    assert "PATIENT CONTEXT" in sp
    # User question reached the LLM.
    assert calls[0]["messages"] == [
        {"role": "user", "content": "What should I do with this renal mass?"},
    ]

    # The final answer is the LLM's content, NOT the placeholder.
    answer_chunks = [d["text"] for k, d in chunks if k == "final_answer_chunk"]
    assert any("urology referral" in t for t in answer_chunks)
    # Defensive: the old placeholder must NOT appear anywhere.
    full = "\n".join(answer_chunks)
    assert "ships in M1.6+" not in full
    assert "T3 multi-hop reasoning surface is in place" not in full


def test_yield_t3_surfaces_llm_failure_to_user(conn, monkeypatch):
    """If call_llm raises (no API key, network down, etc.), the user
    must see WHY in the chat — not a silent placeholder."""
    async def boom(**_kw):
        raise RuntimeError("GEMINI_API_KEY not configured")

    from nexus_server import llm_gateway
    monkeypatch.setattr(llm_gateway, "call_llm", boom)

    chunks = asyncio.run(_drain(retrieval_tiers.yield_t3_llm(
        conn, user_id="u1", patient_hash="p1",
        question="anything",
    )))
    ans = "\n".join(d["text"] for k, d in chunks if k == "final_answer_chunk")
    assert "LLM call failed" in ans
    assert "GEMINI_API_KEY" in ans
    assert "Settings · LLM" in ans   # tells user where to fix it


def test_retrieve_async_dispatches_t3_to_llm(conn, monkeypatch):
    """The top-level retrieve_async must route T3 questions through
    the LLM path (not the old sync yield_t3 that emitted a placeholder)."""
    called = {"n": 0}

    async def fake_call_llm(**kwargs):
        called["n"] += 1
        return ("Generic answer", "gemini-2.5-flash", "stop", [])

    from nexus_server import llm_gateway
    monkeypatch.setattr(llm_gateway, "call_llm", fake_call_llm)

    # A question with "compare" → multi-hop → T3 classifier.
    chunks = asyncio.run(_drain(retrieval_tiers.retrieve_async(
        conn, user_id="u1", patient_hash="p1",
        question="Compare this CT to the previous one and tell me what changed.",
    )))
    assert called["n"] == 1
    kinds = [c[0] for c in chunks]
    assert kinds[0] == ("tier_classified")
    assert chunks[0][1]["tier"] == "T3"
    assert any(
        "Generic answer" in d.get("text", "")
        for k, d in chunks if k == "final_answer_chunk"
    )
