"""Tests for #131 — vision-grounded skill evolution extensions.

Three pieces under test:

1. ``TaskExample`` gains ``images`` and ``expert_correction`` fields
   without breaking existing default construction.

2. ``score_skill_on_examples`` passes ``images`` to both the rollout
   message AND the judge message (so vision-capable models see the
   actual visual content), and routes ``expert_correction`` into the
   judge prompt.

3. ``build_examples_from_feedback`` reads .nexus/skills/<name>/feedback.jsonl
   produced by #130 endpoint and constructs TaskExamples — both
   "correct" rows (with expert_correction set) and "accept" rows
   (with expected_output_summary set).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        asyncio.set_event_loop(loop)


# ── TaskExample shape ─────────────────────────────────────────────────


def test_task_example_default_construction_back_compat():
    from nexus_server.skill_evolution import TaskExample

    # Old call sites that only pass `input` should still work.
    ex = TaskExample(input="hello")
    assert ex.input == "hello"
    assert ex.images == []
    assert ex.expert_correction == ""
    assert ex.rubric == ""


def test_task_example_with_vision_fields():
    from nexus_server.skill_evolution import TaskExample
    ex = TaskExample(
        input="describe this CT",
        images=[{"mime": "image/png", "data_b64": "AAAA"}],
        expert_correction="实际是钙化点，HU > 400",
        rubric="medical accuracy",
    )
    assert len(ex.images) == 1
    assert ex.images[0]["mime"] == "image/png"
    assert ex.expert_correction == "实际是钙化点，HU > 400"


# ── score_skill_on_examples vision routing ────────────────────────────


def test_score_propagates_images_to_rollout_and_judge():
    """Both the skill rollout and the judge LLM call must receive
    the image bytes via the ``images`` field on the user message."""
    from nexus_server.skill_evolution import (
        TaskExample, score_skill_on_examples,
    )

    captured_rollout = []
    captured_judge = []

    async def fake_llm(messages, system_prompt, model, **kwargs):
        # Heuristic: rollout uses the SKILL.md body as system_prompt;
        # judge uses JUDGE_PROMPT. Tell them apart by what the system
        # prompt starts with.
        if (system_prompt or "").startswith("You are a strict but fair grader"):
            captured_judge.append(messages[0])
            return '{"score": 80, "issues": []}'
        captured_rollout.append(messages[0])
        return "agent answer about the CT"

    ex = TaskExample(
        input="What's in this CT?",
        images=[{"mime": "image/png", "data_b64": "PNGfaker"}],
        rubric="accuracy",
    )
    mean, details = _run(score_skill_on_examples(
        skill_body="You are a chest CT reader.",
        examples=[ex],
        llm_caller=fake_llm,
    ))

    # Image on rollout
    assert len(captured_rollout) == 1
    assert "images" in captured_rollout[0]
    assert captured_rollout[0]["images"][0]["mime"] == "image/png"

    # Image on judge too
    assert len(captured_judge) == 1
    assert "images" in captured_judge[0]
    assert captured_judge[0]["images"][0]["mime"] == "image/png"

    assert mean == 80.0


def test_expert_correction_goes_into_judge_prompt():
    """When expert_correction is set, the judge user message must
    include the ground-truth text as 'EXPERT CORRECTION'."""
    from nexus_server.skill_evolution import (
        TaskExample, score_skill_on_examples,
    )

    captured_judge_text = []

    async def fake_llm(messages, system_prompt, model, **kwargs):
        if (system_prompt or "").startswith("You are a strict"):
            captured_judge_text.append(messages[0]["content"])
            return '{"score": 50, "issues": ["did not apply correction"]}'
        return "agent output that ignored the correction"

    ex = TaskExample(
        input="Analyse this image",
        expert_correction="实际是钙化点，HU > 400, 无需 PET-CT",
    )
    _run(score_skill_on_examples(
        skill_body="reader skill", examples=[ex], llm_caller=fake_llm,
    ))
    assert len(captured_judge_text) == 1
    assert "EXPERT CORRECTION" in captured_judge_text[0]
    assert "钙化点" in captured_judge_text[0]


def test_rollout_without_images_omits_field():
    """Text-only examples must NOT inject an images key (the SDK
    would otherwise see an empty list — harmless but noisy)."""
    from nexus_server.skill_evolution import (
        TaskExample, score_skill_on_examples,
    )

    captured = []

    async def fake_llm(messages, system_prompt, model, **kwargs):
        captured.append(messages[0])
        if (system_prompt or "").startswith("You are a strict"):
            return '{"score": 100, "issues": []}'
        return "ok"

    ex = TaskExample(input="text-only example", rubric="x")
    _run(score_skill_on_examples(
        skill_body="s", examples=[ex], llm_caller=fake_llm,
    ))
    rollout = captured[0]
    assert "images" not in rollout


# ── build_examples_from_feedback ──────────────────────────────────────


def _make_feedback_file(tmp_path, rows):
    p = tmp_path / "feedback.jsonl"
    with p.open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    return p


def test_build_examples_from_feedback_correct_rows(tmp_path):
    from nexus_server.skill_evolution import build_examples_from_feedback

    p = _make_feedback_file(tmp_path, [
        {
            "ts": "2026-06-07T14:00:00+00:00",
            "skill_name": "chest-ct-reader",
            "kind": "correct",
            "context": {
                "assistant_event_idx": 47,
                "agent_output": "右上肺 8mm 结节",
                "referenced_file_ids": [],
                "session_id": "s1",
            },
            "feedback": {
                "kind": "correct",
                "expert_text": "实际是钙化点，HU > 400",
                "tag": "钙化_vs_结节",
            },
        },
    ])
    examples = build_examples_from_feedback(p)
    assert len(examples) == 1
    ex = examples[0]
    assert ex.expert_correction == "实际是钙化点，HU > 400"
    assert ex.images == []  # no file_ids → no images hydrated
    assert "expert correction" in ex.rubric.lower()


def test_build_examples_from_feedback_accept_rows_capture_output(tmp_path):
    from nexus_server.skill_evolution import build_examples_from_feedback

    p = _make_feedback_file(tmp_path, [
        {
            "ts": "2026-06-07T14:00:00+00:00",
            "skill_name": "chest-ct-reader",
            "kind": "accept",
            "context": {
                "assistant_event_idx": 50,
                "agent_output": "Excellent reading — lung CT shows X Y Z.",
                "referenced_file_ids": [],
                "session_id": "s2",
            },
            "feedback": {"kind": "accept", "expert_text": "", "tag": ""},
        },
    ])
    examples = build_examples_from_feedback(p)
    assert len(examples) == 1
    ex = examples[0]
    assert ex.expert_correction == ""  # not a correction
    assert "Excellent reading" in ex.expected_output_summary
    assert "previously accepted" in ex.rubric.lower()


def test_build_examples_from_feedback_newest_first_and_capped(tmp_path):
    """Newest rows come first; cap at max_examples."""
    from nexus_server.skill_evolution import build_examples_from_feedback

    rows = []
    for i in range(30):
        rows.append({
            "ts": f"2026-06-07T14:{i:02d}:00+00:00",
            "skill_name": "x",
            "kind": "correct",
            "context": {
                "assistant_event_idx": i,
                "agent_output": f"output {i}",
                "referenced_file_ids": [],
                "session_id": "s",
            },
            "feedback": {
                "kind": "correct",
                "expert_text": f"correction {i}",
                "tag": "",
            },
        })
    p = _make_feedback_file(tmp_path, rows)
    examples = build_examples_from_feedback(p, max_examples=10)
    assert len(examples) == 10
    # Newest 10: rows 29..20. The first one in the result should be
    # the LATEST feedback (idx 29).
    assert "correction 29" in examples[0].expert_correction
    assert "correction 20" in examples[9].expert_correction


def test_build_examples_handles_missing_file(tmp_path):
    """Non-existent path → empty list, no exception."""
    from nexus_server.skill_evolution import build_examples_from_feedback
    examples = build_examples_from_feedback(tmp_path / "no.jsonl")
    assert examples == []


def test_build_examples_skips_corrupt_lines(tmp_path):
    """Malformed JSON lines are ignored, not fatal."""
    from nexus_server.skill_evolution import build_examples_from_feedback
    p = tmp_path / "feedback.jsonl"
    p.write_text(
        '{"valid": "row 1", "kind": "correct", "feedback":{"expert_text":"a"}, "context":{}}\n'
        '{this is not json}\n'
        '{"valid": "row 2", "kind": "correct", "feedback":{"expert_text":"b"}, "context":{}}\n',
        encoding="utf-8",
    )
    examples = build_examples_from_feedback(p)
    # 2 valid rows survived
    assert len(examples) == 2
    texts = {e.expert_correction for e in examples}
    assert texts == {"a", "b"}


def test_build_examples_input_mentions_attachment_when_present(tmp_path):
    """When referenced_file_ids exist, the synthetic input prompts the
    agent to analyse the attached image (since we can't reconstruct
    the original user_message text)."""
    from nexus_server.skill_evolution import build_examples_from_feedback

    p = _make_feedback_file(tmp_path, [
        {
            "kind": "correct",
            "context": {
                "agent_output": "...",
                "referenced_file_ids": ["file-ct-1"],
            },
            "feedback": {"kind": "correct", "expert_text": "x"},
        },
        {
            "kind": "correct",
            "context": {"agent_output": "...", "referenced_file_ids": []},
            "feedback": {"kind": "correct", "expert_text": "y"},
        },
    ])
    examples = build_examples_from_feedback(p)
    inputs = {e.input for e in examples}
    # With attachment → "attached image" prompt
    assert any("attached image" in i for i in inputs)
    # Without attachment → "user query" prompt
    assert any("user query" in i for i in inputs)
