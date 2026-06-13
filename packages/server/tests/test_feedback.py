"""Tests for #130 — Expert Feedback Loop.

We exercise the feedback module's helpers directly + the FastAPI
endpoint via TestClient. Real event_log writes are stubbed so the
test runs offline and deterministically.

Surface under test:

  * POST /api/v1/feedback validates body (kind enum, correction_text
    required for "correct", skill_name path-traversal guard)
  * 404 when assistant_event_idx doesn't exist
  * 400 when the indexed event isn't an assistant_response
  * Appends JSONL row to .nexus/skills/<skill>/feedback.jsonl
  * Multiple feedbacks under same skill accumulate (count grows)
  * GET /api/v1/feedback/stats returns per-skill counts
  * referenced_file_ids come from event metadata, not request body
    (prevents client lying about what they're correcting)
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


# ── Stub helpers ──────────────────────────────────────────────────────


def _patch_event_lookup(monkeypatch, content, meta, sid, event_type="assistant_response"):
    """Replace _read_assistant_event so we can return any event shape."""
    from nexus_server import feedback as fb_mod

    def fake_read(user_id, event_idx):
        if event_type != "assistant_response":
            return None, None, None  # signals "wrong type"
        return content, meta, sid

    monkeypatch.setattr(fb_mod, "_read_assistant_event", fake_read)


def _patch_skills_dir(monkeypatch, tmp_path):
    """Redirect .nexus/skills writes into a tmp_path."""
    from nexus_server import feedback as fb_mod
    monkeypatch.setattr(fb_mod, "_skills_dir", lambda: tmp_path / ".nexus" / "skills")
    return tmp_path / ".nexus" / "skills"


# ── _append_feedback direct tests ─────────────────────────────────────


def test_append_feedback_writes_jsonl_row(tmp_path, monkeypatch):
    skills = _patch_skills_dir(monkeypatch, tmp_path)
    from nexus_server.feedback import _append_feedback

    path = _append_feedback(
        skill_name="chest-ct-reader",
        kind="correct",
        expert_text="实际是钙化点，HU > 400",
        tag="钙化_vs_结节",
        assistant_event_idx=42,
        agent_output="右上肺 8mm 结节",
        referenced_file_ids=["file-abc"],
        session_id="session-x",
    )
    assert path.exists()
    assert path == skills / "chest-ct-reader" / "feedback.jsonl"

    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    assert len(rows) == 1
    r = rows[0]
    assert r["skill_name"] == "chest-ct-reader"
    assert r["kind"] == "correct"
    assert r["feedback"]["expert_text"] == "实际是钙化点，HU > 400"
    assert r["feedback"]["tag"] == "钙化_vs_结节"
    assert r["context"]["assistant_event_idx"] == 42
    assert r["context"]["agent_output"] == "右上肺 8mm 结节"
    assert r["context"]["referenced_file_ids"] == ["file-abc"]
    assert r["context"]["session_id"] == "session-x"
    # ts is iso8601 utc
    assert r["ts"].endswith("+00:00")


def test_append_feedback_creates_skill_folder_on_demand(tmp_path, monkeypatch):
    _patch_skills_dir(monkeypatch, tmp_path)
    from nexus_server.feedback import _append_feedback

    # Skill folder doesn't pre-exist (this is the "main-agent" case).
    path = _append_feedback(
        skill_name="main-agent",
        kind="accept",
        expert_text=None,
        tag=None,
        assistant_event_idx=1,
        agent_output="hi",
        referenced_file_ids=[],
        session_id=None,
    )
    assert path.exists()
    assert path.parent.is_dir()


def test_multiple_appends_grow_count(tmp_path, monkeypatch):
    _patch_skills_dir(monkeypatch, tmp_path)
    from nexus_server.feedback import _append_feedback, _count_lines

    for i in range(3):
        p = _append_feedback(
            skill_name="chest-ct-reader",
            kind="correct",
            expert_text=f"correction {i}",
            tag=None,
            assistant_event_idx=i,
            agent_output="...",
            referenced_file_ids=[],
            session_id=None,
        )
    assert _count_lines(p) == 3


# ── API endpoint tests ────────────────────────────────────────────────


@pytest.fixture
def client(tmp_path, monkeypatch):
    """FastAPI TestClient with auth + skills dir stubbed."""
    from fastapi.testclient import TestClient
    from nexus_server import feedback as fb_mod
    from nexus_server.auth import get_current_user

    # Skills go to tmp
    monkeypatch.setattr(
        fb_mod, "_skills_dir",
        lambda: tmp_path / ".nexus" / "skills",
    )

    # Build a minimal FastAPI app — we don't pull in the whole main:create_app()
    # because that brings DB / chain / Stripe deps. Just mount the feedback
    # router and stub the auth dep.
    from fastapi import FastAPI
    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: "u-test"
    app.include_router(fb_mod.router)

    yield TestClient(app)


def test_accept_kind_writes_row(client, monkeypatch):
    """Happy path: ✓ Accept → no correction_text required."""
    _patch_event_lookup(
        monkeypatch,
        content="The chest CT shows a nodule",
        meta={"referenced_file_ids": ["file-1"]},
        sid="sess-1",
    )
    r = client.post("/api/v1/feedback", json={
        "assistant_event_idx": 42,
        "kind": "accept",
        "skill_name": "chest-ct-reader",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["skill_name"] == "chest-ct-reader"
    assert body["feedback_count"] == 1


def test_correct_requires_correction_text(client, monkeypatch):
    _patch_event_lookup(
        monkeypatch, content="response", meta={}, sid=None,
    )
    r = client.post("/api/v1/feedback", json={
        "assistant_event_idx": 1, "kind": "correct",
    })
    assert r.status_code == 400
    assert "correction_text" in r.json()["detail"]


def test_correct_kind_persists_correction(client, monkeypatch, tmp_path):
    _patch_event_lookup(
        monkeypatch,
        content="右上肺结节 8mm",
        meta={"referenced_file_ids": ["file-ct-1"]},
        sid="sess-correct",
    )
    r = client.post("/api/v1/feedback", json={
        "assistant_event_idx": 47,
        "kind": "correct",
        "correction_text": "实际是钙化点，HU > 400",
        "skill_name": "chest-ct-reader",
        "tag": "钙化_vs_结节",
    })
    assert r.status_code == 200, r.text

    # Verify the file on disk
    feedback_file = (
        tmp_path / ".nexus" / "skills" / "chest-ct-reader" / "feedback.jsonl"
    )
    assert feedback_file.exists()
    rows = [json.loads(l) for l in feedback_file.read_text().splitlines() if l]
    assert len(rows) == 1
    assert rows[0]["feedback"]["expert_text"] == "实际是钙化点，HU > 400"
    assert rows[0]["context"]["referenced_file_ids"] == ["file-ct-1"]


def test_unknown_kind_rejected(client, monkeypatch):
    _patch_event_lookup(monkeypatch, content="x", meta={}, sid=None)
    r = client.post("/api/v1/feedback", json={
        "assistant_event_idx": 1, "kind": "🤔",
    })
    assert r.status_code == 400
    assert "kind" in r.json()["detail"]


def test_event_not_found_404(client, monkeypatch):
    # event_lookup returns None,None,None — simulates a missing row
    from nexus_server import feedback as fb_mod
    monkeypatch.setattr(
        fb_mod, "_read_assistant_event",
        lambda u, i: (None, None, None),
    )
    r = client.post("/api/v1/feedback", json={
        "assistant_event_idx": 999_999, "kind": "accept",
    })
    assert r.status_code == 404


def test_path_traversal_in_skill_name_blocked(client, monkeypatch):
    _patch_event_lookup(monkeypatch, content="x", meta={}, sid=None)
    # All these should be 400'd
    for bad in ["../etc", "skill/with/slash", ".sneak", "..foo"]:
        r = client.post("/api/v1/feedback", json={
            "assistant_event_idx": 1, "kind": "accept",
            "skill_name": bad,
        })
        # ".." or "/" or leading "." should all be rejected
        if "/" in bad or "\\" in bad or bad.startswith("."):
            assert r.status_code == 400, f"bad name {bad!r} should be rejected"


def test_referenced_file_ids_pulled_from_event_not_request(client, monkeypatch, tmp_path):
    """Client cannot fake which files they're correcting — the
    referenced_file_ids written to disk come from the event log
    metadata, not from the request body."""
    _patch_event_lookup(
        monkeypatch,
        content="reply",
        meta={"referenced_file_ids": ["real-file-1"]},
        sid="s",
    )
    # Client doesn't even send referenced_file_ids; we still write
    # the real one from the event.
    r = client.post("/api/v1/feedback", json={
        "assistant_event_idx": 1, "kind": "accept",
    })
    assert r.status_code == 200

    fb_file = (
        tmp_path / ".nexus" / "skills" / "main-agent" / "feedback.jsonl"
    )
    rows = [json.loads(l) for l in fb_file.read_text().splitlines() if l]
    assert rows[0]["context"]["referenced_file_ids"] == ["real-file-1"]


def test_default_skill_name_when_omitted(client, monkeypatch, tmp_path):
    _patch_event_lookup(monkeypatch, content="x", meta={}, sid=None)
    r = client.post("/api/v1/feedback", json={
        "assistant_event_idx": 1, "kind": "accept",
    })
    assert r.status_code == 200
    assert r.json()["skill_name"] == "main-agent"
    assert (tmp_path / ".nexus" / "skills" / "main-agent" / "feedback.jsonl").exists()


def test_stats_endpoint_aggregates_per_skill(client, monkeypatch, tmp_path):
    _patch_event_lookup(monkeypatch, content="x", meta={}, sid=None)

    # Drop 2 feedbacks for chest-ct, 1 for head-ct
    for _ in range(2):
        client.post("/api/v1/feedback", json={
            "assistant_event_idx": 1, "kind": "accept",
            "skill_name": "chest-ct-reader",
        })
    client.post("/api/v1/feedback", json={
        "assistant_event_idx": 1, "kind": "accept",
        "skill_name": "head-ct-reader",
    })

    r = client.get("/api/v1/feedback/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["counts_by_skill"]["chest-ct-reader"] == 2
    assert body["counts_by_skill"]["head-ct-reader"] == 1
    assert body["total"] == 3
