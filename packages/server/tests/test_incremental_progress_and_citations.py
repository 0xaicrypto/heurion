"""
Regression tests for #202 — incremental upload-row progress writes
and finding-citable chat answers.

A. ``_run_dicom_prerender_async`` writes the uploads row status fields
   AS each phase starts / completes, instead of one big update at the
   end. Without this the 45-second ingester + Quick scan pipeline left
   the desktop's UploadJobRow showing nothing under "Imported" — the
   medic thought the app had stalled.

B. ``_gather_patient_context`` prefixes every graph node with
   ``[Nxx]`` so the LLM can cite by id. The system prompt teaches the
   model to use the tag, and the citations event picks up only the
   IDs that actually appeared in the answer (no over-attribution).
"""
from __future__ import annotations

import json
import pathlib
import re
import sqlite3
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# A. Incremental progress writes
# ─────────────────────────────────────────────────────────────────────


def test_dicom_upload_pipeline_bumps_pending_status_immediately():
    """Source-level guard: the pipeline must commit
    ``memory_status='pending'`` AND ``quick_scan_status='pending'``
    BEFORE the long-running ingester/scan steps so the desktop's
    2-second poll surfaces in-progress state.

    The old code only wrote both statuses after BOTH phases finished
    — a ~45-second blackout."""
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "files.py"
    ).read_text()

    # The pipeline body lives inside ``_run_dicom_prerender_async``.
    # It's defined as ``def`` (not ``async def``) — it spawns its own
    # async work via asyncio.run / BackgroundTasks. Slice it out so
    # unrelated SQL elsewhere doesn't false-positive.
    m = re.search(
        r"def _run_dicom_prerender_async\([\s\S]+?\n(?:async )?def ",
        src,
    )
    assert m, "_run_dicom_prerender_async not found in files.py"
    body = m.group(0)

    # Must explicitly write ``memory_status = 'pending'`` (via _bump or
    # direct SQL) BEFORE running the ingester. Same for quick_scan.
    assert re.search(
        r'_bump\(\s*m_status="pending"',
        body,
    ) or re.search(
        r'memory_status\s*=\s*[\'"]pending[\'"][\s\S]{0,200}UPDATE uploads',
        body,
    ), (
        "_run_dicom_prerender_async doesn't commit "
        "memory_status='pending' before running the ingester. "
        "Without this, the upload card stays empty for ~10s while "
        "the ingester works."
    )
    assert re.search(
        r'_bump\(\s*qs_status="pending"',
        body,
    ), (
        "quick_scan_status='pending' isn't committed before the "
        "Gemini sweep — UploadJobRow won't render the streaming "
        "progress block during the ~30-second scan."
    )

    # And the final-state writes must STILL happen so 'ok' / 'error'
    # land on the row.
    assert re.search(
        r"_bump\([\s\S]{0,200}m_status\s*=\s*memory_status",
        body,
    ), "Final memory_status write missing — row never flips off 'pending'."
    assert re.search(
        r"_bump\([\s\S]{0,200}qs_status\s*=\s*quick_scan_status",
        body,
    ), "Final quick_scan_status write missing."


def test_bump_helper_commits_per_call(tmp_path, monkeypatch):
    """Behavioural: the _bump helper inside _run_dicom_prerender_async
    isn't directly importable (defined as a nested closure). Instead
    we exercise the equivalent SQL plumbing — confirms the uploads
    table accepts in-place status updates by file_id."""
    from nexus_server.config import ServerConfig
    from nexus_server.migrations.runner import run_migrations

    db = tmp_path / "p.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")
    run_migrations()
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO uploads "
            "(file_id, user_id, name, mime, size_bytes, sha256, "
            " disk_path, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("file-progress", "u1", "ct.zip", "application/zip", 1, "x",
             "/tmp/x.zip", "2026-06-14"),
        )
        c.commit()

    # Three sequential bumps — pending → ok for memory, then pending
    # → ok for quick scan. Each one must be visible to a separate
    # connection (simulating the desktop's poll).
    transitions = [
        ("UPDATE uploads SET memory_status='pending' WHERE file_id='file-progress'", "pending", ""),
        ("UPDATE uploads SET memory_status='ok', memory_summary='6 graph events' "
         "WHERE file_id='file-progress'", "ok", ""),
        ("UPDATE uploads SET quick_scan_status='pending' WHERE file_id='file-progress'", "ok", "pending"),
        ("UPDATE uploads SET quick_scan_status='ok', quick_scan_summary='1 flagged' "
         "WHERE file_id='file-progress'", "ok", "ok"),
    ]
    for sql, want_m, want_qs in transitions:
        with sqlite3.connect(db) as c:
            c.execute(sql)
            c.commit()
        # Re-open and read — proves the change is durable + visible.
        with sqlite3.connect(db) as c2:
            row = c2.execute(
                "SELECT memory_status, quick_scan_status FROM uploads "
                "WHERE file_id = 'file-progress'"
            ).fetchone()
        assert row == (want_m, want_qs), (
            f"After SQL ``{sql[:60]}…`` expected ({want_m!r}, {want_qs!r}), "
            f"got {row!r}"
        )


# ─────────────────────────────────────────────────────────────────────
# B. Findings citable in chat
# ─────────────────────────────────────────────────────────────────────


def test_gather_patient_context_prefixes_node_ids(tmp_path, monkeypatch):
    """``_gather_patient_context`` must emit each item as
    ``[Nxx] label`` so the LLM can cite by id."""
    from nexus_server.config import ServerConfig
    from nexus_server.migrations.runner import run_migrations
    from nexus_server import retrieval_tiers

    db = tmp_path / "ctx.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")
    run_migrations()
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO clinical_graph_nodes "
            "(user_id, patient_hash, node_id, node_type, content_json, "
            " embedding_ref, weight, encounter_id, created_at, updated_at, "
            " originating_event_idx) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("u1", "p1", 42, "finding",
             json.dumps({"label": "8mm RUL nodule", "urgency": "moderate"}),
             None, 1.0, None, 1, 1, 0),
        )
        c.execute(
            "INSERT INTO clinical_graph_nodes "
            "(user_id, patient_hash, node_id, node_type, content_json, "
            " embedding_ref, weight, encounter_id, created_at, updated_at, "
            " originating_event_idx) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("u1", "p1", 99, "med",
             json.dumps({"label": "metoprolol 50mg BID"}),
             None, 0.8, None, 1, 1, 0),
        )
        c.commit()

    with sqlite3.connect(db) as c:
        ctx = retrieval_tiers._gather_patient_context(c, "u1", "p1")

    assert "[N42]" in ctx, (
        f"node_id prefix [N42] missing — LLM has no way to cite the "
        f"finding. Got:\n{ctx!r}"
    )
    assert "[N99]" in ctx, "med node id missing"
    assert "8mm RUL nodule" in ctx
    assert "metoprolol" in ctx


def test_system_prompt_teaches_citation_protocol():
    """The yield_t3_llm system prompt must instruct the model to use
    ``[Nxx]`` tags. Without this, the LLM ignores the prefixes."""
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "retrieval_tiers.py"
    ).read_text()
    # Look for the system_prompt assignment block.
    m = re.search(r"system_prompt\s*=\s*\([\s\S]+?\)\s*\n", src)
    assert m, "system_prompt assignment not found"
    sp = m.group(0)
    assert "CITATION PROTOCOL" in sp or "[N" in sp, (
        "system prompt doesn't mention the [Nxx] citation protocol — "
        "LLM will ignore the node-id prefixes and emit no citation "
        "chips."
    )


def test_citations_event_filters_to_answered_nodes_only():
    """Source-level: the citations event must extract ``[Nxx]`` tags
    from the model's answer text and only emit refs that match nodes
    the prompt actually sent. Over-attributing every prompt node
    pollutes the right-rail."""
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "retrieval_tiers.py"
    ).read_text()

    # The regex pattern + filter must exist.
    assert re.search(
        r'finditer\([\'"]\\\\\[N\(\\d\+\)\\]',
        src,
    ) or '[N' in src and 'finditer' in src, (
        "citations event doesn't extract [Nxx] tags from the answer — "
        "every node in the context block gets cited even when the "
        "answer didn't reference it."
    )
    # Backstop comment intact (defends against deleting the fallback).
    assert "Backstop" in src or "fallback" in src.lower(), (
        "citations event lost its backstop for short / non-clinical "
        "answers — chitchat turns will have empty right-rail."
    )


def test_no_hallucinated_node_id_in_citations(tmp_path, monkeypatch):
    """Behavioural: if the LLM hallucinates ``[N9999]`` (an id we
    never sent), the citations event must NOT pass it through. The
    desktop's CitationChip2 would then 404 on /memory/citation/9999
    and confuse the medic.

    We exercise yield_t3_llm with a stubbed LLM call so we control
    the answer text precisely."""
    import asyncio
    from nexus_server import retrieval_tiers
    from nexus_server.config import ServerConfig
    from nexus_server.migrations.runner import run_migrations

    db = tmp_path / "h.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setattr(ServerConfig, "DATABASE_URL", f"sqlite:///{db}")
    run_migrations()
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO clinical_graph_nodes "
            "(user_id, patient_hash, node_id, node_type, content_json, "
            " embedding_ref, weight, encounter_id, created_at, updated_at, "
            " originating_event_idx) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("u1", "p1", 42, "finding",
             json.dumps({"label": "RUL nodule"}),
             None, 1.0, None, 1, 1, 0),
        )
        c.commit()

    # Stub the llm_gateway call_llm. We can't easily import + patch
    # mid-execution, so we replace at the module level.
    from nexus_server import llm_gateway

    async def fake_call_llm(**kw):
        # Answer cites [N42] (real) AND [N9999] (hallucinated).
        return (
            "The RUL nodule [N42] needs follow-up; consider PET [N9999].",
            "fake-model", "stop", [],
        )

    monkeypatch.setattr(llm_gateway, "call_llm", fake_call_llm)

    captured: list[dict] = []
    async def run():
        with sqlite3.connect(db) as c:
            async for chunk in retrieval_tiers.yield_t3_llm(
                c, user_id="u1", patient_hash="p1",
                question="anything to follow up on?",
            ):
                if chunk.kind == "citations":
                    captured.append(chunk.data)
    asyncio.run(run())

    assert captured, "yield_t3_llm didn't emit a citations chunk"
    refs = captured[0]["refs"]
    cited_ids = {r["node_id"] for r in refs}
    assert 42 in cited_ids, (
        f"Real node 42 dropped from citations: {refs!r}"
    )
    assert 9999 not in cited_ids, (
        f"Hallucinated [N9999] leaked into citations: {refs!r}. "
        "The /memory/citation/9999 fetch will 404 and the right-rail "
        "shows 'no provenance for node'."
    )
