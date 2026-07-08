"""
Tests for the T4 web-grounded retrieval tier.

Coverage:

  PHI scrubber
    - MRN / SSN / 9+ digit-run patterns redacted
    - DOB-shaped dates redacted
    - "J.D. has..." → patient-identifier redacted; "FEV1" / "ACR" kept
    - Internal [Nxx]/[Wxx] tags removed (they have no meaning to
      external search providers)
    - Empty / whitespace-only input → ""
    - Multi-pattern message gets all hits redacted

  Domain allow-list
    - DEFAULT_CLINICAL_DOMAINS used when env unset
    - NEXUS_WEB_ALLOWED_DOMAINS overrides
    - Literal "NONE" disables allow-list (opt-out)

  Tavily provider (mocked)
    - Happy path: 200 + valid JSON → list[WebResult]
    - Each result gets a 1-based w_id
    - Snippets clipped to 600 chars (prompt-budget guard)
    - 4xx / 5xx response → ([], error_msg)
    - Network failure → ([], error_msg)

  Intent classifier
    - Guideline keywords → True
    - Patient-anchored override → False even with guideline words
    - Plain clinical chitchat → False

  is_configured() probe
    - True when TAVILY_API_KEY set
    - False when missing / placeholder
    - REPLACE_WITH_ sentinel rejected

  Source-level guards
    - retrieval_tiers.Tier has T4
    - retrieve_async routes Tier.T4 through yield_t4_web
    - settings_router.ALLOWED_KEYS includes TAVILY_API_KEY
"""
from __future__ import annotations

import asyncio
import pathlib
import sys
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from nexus_server import web_search  # noqa: E402


# ─────────────────────────────────────────────────────────────────────
# PHI scrubber
# ─────────────────────────────────────────────────────────────────────


def test_scrub_redacts_mrn_variants():
    """MRN-12345 / MRN12345 / MRN: 12345 — all forms."""
    cases = [
        "patient MRN-12345 follow-up",
        "MRN12345 has...",
        "MRN: 67890 next visit",
    ]
    for raw in cases:
        out = web_search.scrub_phi(raw)
        assert "MRN" not in out or "[REDACTED]" in out, (
            f"MRN not scrubbed: {raw!r} → {out!r}"
        )
        # The digit run should be gone.
        assert "12345" not in out and "67890" not in out


def test_scrub_redacts_ssn():
    out = web_search.scrub_phi("SSN is 123-45-6789 in the chart")
    assert "[REDACTED]" in out
    assert "123-45-6789" not in out


def test_scrub_redacts_long_digit_runs():
    """9+ digits in a row (NPI / record IDs) gets redacted."""
    out = web_search.scrub_phi("record 1234567890 had findings")
    assert "1234567890" not in out
    assert "[REDACTED]" in out


def test_scrub_keeps_short_numerals():
    """Don't false-positive on common clinical numerals (FEV1 50%,
    8mm nodule, age 65). These are short digit runs."""
    out = web_search.scrub_phi(
        "65-year-old former smoker with 8mm RUL nodule FEV1 50%"
    )
    # Numbers under 9 digits should survive.
    assert "65" in out
    assert "8mm" in out
    assert "50" in out


def test_scrub_redacts_dob_dates():
    """1924-08-15, 8/15/1924, 1924/08/15 — all variants."""
    for raw in (
        "DOB: 1924-08-15",
        "DOB: 08/15/1924",
        "born 2024-08-15",
    ):
        out = web_search.scrub_phi(raw)
        assert "[REDACTED-DATE]" in out, f"DOB not scrubbed: {raw!r}"
        # Original year must be gone.
        assert "1924" not in out
        assert "2024" not in out


def test_scrub_redacts_initials_in_clinical_phrasing():
    """'J.D. has...' / 'Z.S. presented...' — narrow pattern targeting
    initials immediately followed by a clinical verb. Avoid eating
    acronyms like 'ACR' or 'NCCN'."""
    out = web_search.scrub_phi("J.D. has a 8mm RUL nodule")
    assert "J.D." not in out
    assert "[REDACTED-PATIENT]" in out

    out = web_search.scrub_phi("Z.S. presented with chest pain")
    assert "Z.S." not in out


def test_scrub_keeps_clinical_acronyms():
    """ACR / NCCN / FEV1 are NOT initials — narrow pattern leaves them
    alone. Critical: scrubbing too aggressively would defeat the point
    of clinical search."""
    raw = "NCCN guidelines for ACR follow-up FEV1 monitoring"
    out = web_search.scrub_phi(raw)
    assert "NCCN" in out
    assert "ACR" in out
    assert "FEV1" in out


def test_scrub_removes_internal_citation_tags():
    """[Nxx] and [Wxx] are internal app conventions, not real search
    tokens. Leaving them in pollutes the search index hit rate."""
    out = web_search.scrub_phi(
        "compare [N42] nodule to NCCN guidelines [W7]"
    )
    assert "[N42]" not in out
    assert "[W7]" not in out
    # NCCN must survive.
    assert "NCCN" in out


def test_scrub_handles_empty_input():
    assert web_search.scrub_phi("") == ""
    assert web_search.scrub_phi("   ") == ""


def test_scrub_collapses_whitespace_after_redaction():
    """After removing tokens, leftover double spaces / leading spaces
    get collapsed. This keeps the query clean for Tavily."""
    out = web_search.scrub_phi("MRN-12345  is  patient with nodule")
    assert "  " not in out, f"double spaces in: {out!r}"


# ─────────────────────────────────────────────────────────────────────
# Domain allow-list
# ─────────────────────────────────────────────────────────────────────


def _clear_web_env(monkeypatch):
    for k in (
        "TAVILY_API_KEY", "NEXUS_WEB_ALLOWED_DOMAINS",
    ):
        monkeypatch.delenv(k, raising=False)


def test_default_domains_used_when_env_unset(monkeypatch):
    _clear_web_env(monkeypatch)
    domains = web_search._live_allowed_domains()
    assert "nccn.org" in domains
    assert "uptodate.com" in domains
    assert "ncbi.nlm.nih.gov" in domains
    # And it's a real list (not the constant; defensive copy).
    assert domains is not web_search.DEFAULT_CLINICAL_DOMAINS


def test_env_override_replaces_defaults(monkeypatch):
    _clear_web_env(monkeypatch)
    monkeypatch.setenv(
        "NEXUS_WEB_ALLOWED_DOMAINS",
        "example-hosp.org, my.cancer.center, NCCN.ORG",
    )
    domains = web_search._live_allowed_domains()
    assert domains == ["example-hosp.org", "my.cancer.center", "nccn.org"]


def test_env_none_disables_allowlist(monkeypatch):
    """The literal "NONE" opts out of the allow-list. Searches will hit
    Tavily without include_domains filtering — the medic must
    consciously opt into this."""
    _clear_web_env(monkeypatch)
    monkeypatch.setenv("NEXUS_WEB_ALLOWED_DOMAINS", "NONE")
    assert web_search._live_allowed_domains() == []


# ─────────────────────────────────────────────────────────────────────
# is_configured probe
# ─────────────────────────────────────────────────────────────────────


def test_is_configured_false_without_key(monkeypatch):
    _clear_web_env(monkeypatch)
    assert web_search.is_configured() is False


def test_is_configured_true_with_key(monkeypatch):
    _clear_web_env(monkeypatch)
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-real-1234567890")
    assert web_search.is_configured() is True


def test_is_configured_rejects_placeholder(monkeypatch):
    """REPLACE_WITH_ sentinel from the bundled .env template is treated
    as 'not configured' so we don't POST garbage to Tavily."""
    _clear_web_env(monkeypatch)
    monkeypatch.setenv("TAVILY_API_KEY", "REPLACE_WITH_TAVILY_KEY")
    assert web_search.is_configured() is False


# ─────────────────────────────────────────────────────────────────────
# Tavily provider (mocked httpx)
# ─────────────────────────────────────────────────────────────────────


class _FakeResponse:
    def __init__(self, status_code, json_body=None, text=""):
        self.status_code = status_code
        self._json = json_body
        self.text = text

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class _FakeClient:
    def __init__(self, response):
        self._response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, json=None):
        return self._response


def _patch_httpx(response):
    """Returns a context manager that patches httpx.AsyncClient to
    return ``response`` to .post()."""
    import httpx
    return patch.object(httpx, "AsyncClient", lambda *a, **k: _FakeClient(response))


def test_post_tavily_happy_path():
    resp = _FakeResponse(200, json_body={
        "results": [
            {
                "url": "https://www.nccn.org/guidelines/lung-cancer",
                "title": "NCCN Lung Cancer Guidelines",
                "content": "Short-interval follow-up for...",
                "score": 0.92,
            },
            {
                "url": "https://radiopaedia.org/nodule",
                "title": "Pulmonary nodule",
                "content": "A pulmonary nodule is a small spot...",
                "score": 0.85,
            },
        ],
    })
    with _patch_httpx(resp):
        results, err = asyncio.run(web_search._post_tavily(
            "NCCN pulmonary nodule follow-up", "fake-key",
        ))
    assert err is None
    assert len(results) == 2
    # 1-based w_id ordinal.
    assert results[0].w_id == 1
    assert results[1].w_id == 2
    # domain extracted from URL.
    assert results[0].domain == "www.nccn.org"
    # title + snippet present.
    assert "NCCN" in results[0].title
    assert "follow-up" in results[0].snippet
    # score preserved.
    assert results[0].score == 0.92


def test_post_tavily_snippet_clipped_to_600():
    """Snippets longer than 600 chars get trimmed so the prompt budget
    doesn't blow up on a verbose source."""
    long_snippet = "A" * 2000
    resp = _FakeResponse(200, json_body={
        "results": [{
            "url": "https://nccn.org/x", "title": "x",
            "content": long_snippet,
        }],
    })
    with _patch_httpx(resp):
        results, err = asyncio.run(
            web_search._post_tavily("q", "fake-key"),
        )
    assert err is None
    assert len(results[0].snippet) == 600


def test_post_tavily_4xx_returns_error_not_results():
    resp = _FakeResponse(401, json_body={"error": "bad key"})
    with _patch_httpx(resp):
        results, err = asyncio.run(
            web_search._post_tavily("q", "fake-key"),
        )
    assert results == []
    assert err is not None
    assert "401" in err or "bad key" in err.lower()


def test_post_tavily_network_error_returns_msg():
    """A ConnectError should not propagate — we want T4 to degrade
    gracefully, not crash the chat turn."""
    import httpx

    class _FakeBoom:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, *a, **k):
            raise httpx.ConnectError("connection refused")

    with patch.object(httpx, "AsyncClient", lambda *a, **k: _FakeBoom()):
        results, err = asyncio.run(
            web_search._post_tavily("q", "fake-key"),
        )
    assert results == []
    assert err is not None
    assert "tavily" in err.lower()


def test_search_clinical_unconfigured_returns_clear_error(monkeypatch):
    _clear_web_env(monkeypatch)
    resp = asyncio.run(web_search.search_clinical("any question"))
    assert resp.results == []
    assert resp.error is not None
    assert "TAVILY_API_KEY" in resp.error


def test_search_clinical_scrubs_query_before_tavily(monkeypatch):
    """Verify the loopback never sends a PHI-laden query to the
    external provider. This is the load-bearing privacy guarantee."""
    _clear_web_env(monkeypatch)
    monkeypatch.setenv("TAVILY_API_KEY", "fake-key-xyz")

    captured: dict = {}

    async def fake_post(query, api_key, **kwargs):
        captured["query"] = query
        captured["api_key"] = api_key
        captured["domains"] = kwargs.get("include_domains")
        return ([], None)

    monkeypatch.setattr(web_search, "_post_tavily", fake_post)

    asyncio.run(web_search.search_clinical(
        "MRN-12345 patient with 1924-08-15 DOB and 8mm nodule per NCCN"
    ))
    sent = captured["query"]
    # All PHI markers scrubbed.
    assert "MRN-12345" not in sent
    assert "1924-08-15" not in sent
    # Clinical content survives — NCCN, nodule, 8mm.
    assert "NCCN" in sent
    assert "8mm" in sent or "8" in sent


# ─────────────────────────────────────────────────────────────────────
# Intent classifier
# ─────────────────────────────────────────────────────────────────────


def test_intent_guideline_keyword_matches():
    cases = [
        "What does NCCN say about pulmonary nodule follow-up?",
        "Is there literature on this approach?",
        "What does ESMO recommend?",
        "Latest 2024 trial on adenocarcinoma",
        "指南建议如何随访？",
    ]
    for q in cases:
        assert web_search.looks_like_web_question(q) is True, (
            f"Should have matched as web intent: {q!r}"
        )


def test_intent_patient_anchored_override():
    """'this patient' / 这个病人 dominates — keeps us on T3 even when
    guideline tokens are present. T3 has the patient context; T4
    would force a pointless web search round-trip."""
    cases = [
        "does this patient fit NCCN criteria?",
        "is this patient's nodule consistent with literature on GGOs?",
        "这个病人是否符合指南？",
    ]
    for q in cases:
        assert web_search.looks_like_web_question(q) is False, (
            f"Should have stayed on T3 (patient-anchored): {q!r}"
        )


def test_intent_plain_clinical_does_not_match():
    cases = [
        "summarise the CT",
        "show me the lung window",
        "what is the size of the nodule?",
    ]
    for q in cases:
        assert web_search.looks_like_web_question(q) is False, (
            f"False positive on plain clinical Q: {q!r}"
        )


# ─────────────────────────────────────────────────────────────────────
# Source-level guards
# ─────────────────────────────────────────────────────────────────────


def test_tier_enum_has_t4():
    """The Tier enum must include T4 or retrieval_tiers' classify
    can't dispatch to the new path."""
    from nexus_server.retrieval_tiers import Tier
    assert Tier.T4.value == "T4"


def test_classify_routes_to_t4_for_web_intent(monkeypatch):
    """End-to-end on the classifier: with TAVILY_API_KEY set + a
    web-intent question, classify() returns Tier.T4. Without the key,
    it falls back to T3."""
    import sqlite3
    from nexus_server.retrieval_tiers import classify, Tier

    monkeypatch.setenv("TAVILY_API_KEY", "fake-key")

    conn = sqlite3.connect(":memory:")
    # No patient_hash, no cached_views — we just need the classifier
    # to make it past the T1 guard and hit the web-intent branch.
    choice = classify(
        conn, user_id="u1", patient_hash=None,
        question="What does NCCN say about 8mm pulmonary nodule follow-up?",
    )
    assert choice.tier == Tier.T4, (
        f"Expected T4 for guideline question, got {choice.tier}: "
        f"{choice.reason}"
    )


def test_classify_skips_t4_without_tavily_key(monkeypatch):
    """No key → T4 unavailable → classifier silently falls through to
    T1/T3 instead of routing to a broken tier."""
    import sqlite3
    from nexus_server.retrieval_tiers import classify, Tier

    # Make sure no key is present.
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    conn = sqlite3.connect(":memory:")
    choice = classify(
        conn, user_id="u1", patient_hash=None,
        question="What does NCCN say about 8mm pulmonary nodule follow-up?",
    )
    assert choice.tier != Tier.T4


def test_retrieve_async_dispatches_t4(monkeypatch):
    """When classify returns T4, retrieve_async runs yield_t4_web —
    not yield_t3_llm. We patch yield_t4_web with a stub that just
    emits a sentinel chunk so we can verify the dispatcher path."""
    import sqlite3
    import nexus_server.retrieval_tiers as rt

    monkeypatch.setenv("TAVILY_API_KEY", "fake-key")

    async def fake_yield_t4(conn, *, user_id, patient_hash, question):
        yield rt.RetrievalChunk("tier_classified", {"tier": "T4-sentinel"})

    monkeypatch.setattr(rt, "yield_t4_web", fake_yield_t4)

    async def fake_yield_t3(*args, **kwargs):
        pytest.fail("Should have hit T4, not T3")
        yield  # pragma: no cover

    monkeypatch.setattr(rt, "yield_t3_llm", fake_yield_t3)

    async def collect():
        conn = sqlite3.connect(":memory:")
        out = []
        async for c in rt.retrieve_async(
            conn, user_id="u1", patient_hash=None,
            question="What does NCCN recommend?",
        ):
            out.append(c)
        return out

    chunks = asyncio.run(collect())
    assert chunks
    assert chunks[0].kind == "tier_classified"
    assert chunks[0].data.get("tier") == "T4-sentinel"


def test_settings_router_allows_tavily_key():
    from nexus_server.settings_router import ALLOWED_KEYS
    assert "TAVILY_API_KEY" in ALLOWED_KEYS, (
        "TAVILY_API_KEY not in ALLOWED_KEYS — Settings · LLM PUT would "
        "reject the medic's attempt to save it."
    )
    assert "NEXUS_WEB_ALLOWED_DOMAINS" in ALLOWED_KEYS
