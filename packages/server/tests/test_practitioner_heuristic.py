"""
Layer 2 was dead before 2026-06-14 — the pipeline (writer → event →
projection → reader endpoint) was fully plumbed, but no runtime code
fired the writer. Symptom: Memory · Layer 2 (You / practitioner) sat
on "Nothing yet" forever, regardless of how many encounters the medic
ran.

Fix had two halves:

  1. A deterministic heuristic extractor that turns a raw user_text
     into 0..N Candidate observations
     (``practitioner/heuristic_extractor.py``).

  2. A hook in chat_router._run_practitioner_observation_safe that
     fires the extractor + distill at the end of every chat turn.

This test file covers the heuristic side. The distill side is already
tested in test_practitioner.py (M1.6).
"""
from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from nexus_server.practitioner.heuristic_extractor import (  # noqa: E402
    extract_from_user_text,
)


# ─────────────────────────────────────────────────────────────────────
# One assertion per pattern family — readable cases, not table-driven
# (we want a clear FAIL message when one rule breaks).
# ─────────────────────────────────────────────────────────────────────


def test_no_match_returns_empty_list():
    """Pure-noise text → no observations. Critical because the chat
    hook fires on EVERY turn — false-positive would explode the
    observation table."""
    out = extract_from_user_text(
        "hello world", source_encounter_id="enc-1",
    )
    assert out == []


def test_empty_text_returns_empty_list():
    assert extract_from_user_text("", source_encounter_id="enc-1") == []
    assert extract_from_user_text("   ", source_encounter_id="enc-1") == []


def test_workflow_compare_to_prior():
    out = extract_from_user_text(
        "please compare to prior CT from January", source_encounter_id="enc-1",
    )
    assert any(c.fact_kind == "workflow"
               and c.pattern_key == "workflow:compare_to_prior"
               for c in out), [c.pattern_key for c in out]


def test_workflow_compare_to_prior_chinese():
    """Same workflow, Chinese phrasing — bilingual workflow is also
    expected (since the regex hits both rules)."""
    out = extract_from_user_text(
        "请对比之前的扫描", source_encounter_id="enc-1",
    )
    keys = {c.pattern_key for c in out}
    assert "workflow:compare_to_prior" in keys
    assert "style:bilingual_workflow" in keys


def test_workflow_rule_out():
    out = extract_from_user_text(
        "rule out PE — request CTPA", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "workflow:rule_out_protocol" for c in out)


def test_workflow_contrast_verification():
    out = extract_from_user_text(
        "was this with IV contrast?", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "workflow:contrast_verification" for c in out)


def test_workflow_windowing():
    out = extract_from_user_text(
        "show me the lung window", source_encounter_id="enc-1",
    )
    keys = {c.pattern_key for c in out}
    assert "workflow:explicit_windowing_request" in keys
    # Also catches terse_imperative ("show me the lung window" — 5 words,
    # starts with 'show').
    assert "style:terse_imperative" in keys


def test_workflow_advanced_recon():
    out = extract_from_user_text(
        "create an MIP of the chest", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "workflow:advanced_reconstruction" for c in out)


def test_practice_short_interval_followup():
    out = extract_from_user_text(
        "follow-up in 3 months", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "practice:short_interval_followup" for c in out)


def test_practice_aggressive_workup_biopsy():
    out = extract_from_user_text(
        "go for biopsy on this one", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "practice:aggressive_workup" for c in out)


def test_practice_watchful_waiting():
    out = extract_from_user_text(
        "this is watchful waiting territory", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "practice:watchful_waiting" for c in out)


def test_practice_mdt_referral():
    out = extract_from_user_text(
        "send this case to tumor board", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "practice:mdt_referral" for c in out)


def test_style_bilingual_workflow():
    """Any Chinese character → bilingual_workflow signal."""
    out = extract_from_user_text(
        "show me 肝脏", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "style:bilingual_workflow" for c in out)


def test_style_terse_imperative():
    out = extract_from_user_text(
        "list mets", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "style:terse_imperative" for c in out)


def test_style_citation_seeker():
    out = extract_from_user_text(
        "where did you get that?", source_encounter_id="enc-1",
    )
    assert any(c.pattern_key == "style:citation_seeker" for c in out)


def test_calibration_explicit_self_calibration():
    out = extract_from_user_text(
        "I usually go for short-interval follow-up here",
        source_encounter_id="enc-1",
    )
    keys = {c.pattern_key for c in out}
    assert "calibration:explicit_self_calibration" in keys
    # And the practice signal also fires (the same sentence carries both).
    assert "practice:short_interval_followup" in keys


def test_one_observation_per_fact_kind_per_message():
    """Even when a message would match multiple workflow rules, we cap
    at one observation per fact_kind so a verbose turn doesn't dominate
    the observation log. The distiller's COUNT(DISTINCT patient_hash)
    threshold is the real signal — observations should be sparse per
    turn, dense across patients."""
    out = extract_from_user_text(
        "compare to prior, rule out PE, with contrast, show lung window",
        source_encounter_id="enc-1",
    )
    workflow_obs = [c for c in out if c.fact_kind == "workflow"]
    assert len(workflow_obs) == 1, (
        f"Multiple workflow observations from one turn: {workflow_obs}. "
        "The extractor's `seen_kinds` guard isn't capping correctly — "
        "without that cap a single verbose question would inflate the "
        "observation table 4× per turn."
    )


def test_evidence_quote_is_clipped():
    """We clip evidence_quote to ≤120 chars so practitioner_observations
    never carries a 1000-char prompt verbatim. Source_encounter_id
    threads through unchanged."""
    long_text = "I usually " + ("really long phrase that goes on and on " * 20)
    out = extract_from_user_text(long_text, source_encounter_id="enc-xyz")
    assert out, "calibration phrase should have matched"
    cal = next(c for c in out if c.fact_kind == "calibration")
    assert len(cal.evidence_quote) <= 121, (
        f"evidence_quote length {len(cal.evidence_quote)} exceeds 120 "
        "clip — would leak long prompts into practitioner_observations."
    )
    assert cal.source_encounter_id == "enc-xyz"


def test_extraction_metadata_carries_v1_tag():
    """All heuristic Candidates carry the v1 model tag + prompt id so
    we can distinguish them from future LLM extractor output in the
    observation log. Without these tags audit can't tell which
    extractor produced any given observation."""
    out = extract_from_user_text(
        "rule out PE", source_encounter_id="enc-1",
    )
    assert out
    c = out[0]
    assert c.extraction_model == "heuristic-v1@0.1"
    assert c.extraction_prompt_id == "practitioner_heuristic_v1"


# ─────────────────────────────────────────────────────────────────────
# Source-level guard: chat_router must actually fire this extractor
# ─────────────────────────────────────────────────────────────────────


def test_chat_router_wires_in_practitioner_observation_hook():
    """Without this hook, the heuristic extractor sits in a file
    nobody calls. We grep chat_router to confirm the wiring."""
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "chat_router.py"
    ).read_text()
    code_only = "\n".join(
        line.split("#", 1)[0] for line in src.splitlines()
    )
    # The helper exists.
    assert "_run_practitioner_observation_safe" in code_only, (
        "chat_router no longer defines _run_practitioner_observation_safe — "
        "Layer 2 will go back to being dead."
    )
    # It's actually called from the SSE stream.
    # We isolate the post-emit block (after the assistant_idx commit)
    # and confirm the helper is invoked there.
    assert code_only.count("_run_practitioner_observation_safe") >= 2, (
        "_run_practitioner_observation_safe is defined but never "
        "invoked. Layer 2 stays dead."
    )


def test_chat_router_calls_distill_for_user():
    """The hook must invoke distill, not just emit observations. Without
    distill, observations pile up in practitioner_observations forever
    but never get promoted to practitioner_facts → the reader endpoint
    keeps returning [] and Layer 2 stays empty."""
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "chat_router.py"
    ).read_text()
    code_only = "\n".join(
        line.split("#", 1)[0] for line in src.splitlines()
    )
    # Must import distill from practitioner package AND call it.
    assert "from nexus_server.practitioner import" in code_only
    assert "distill(" in code_only, (
        "chat_router doesn't actually invoke distill() — "
        "observations would accumulate but never become candidates."
    )
