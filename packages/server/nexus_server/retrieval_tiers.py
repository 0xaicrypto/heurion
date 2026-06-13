"""Three-tier retrieval orchestrator (ADR-002 Rev-4 / design v3 §6).

* **T1** Pre-cached views   — SQL hit, ≤ 50ms
* **T2** Single-entity lookup — graph read + 1 LLM call for final answer, ≤ 300ms
* **T3** Algorithm 1 multi-turn — streamed iterative reasoning, 5–15s

Tier classifier is rule-based in M0/M1. M4 can graduate to an LLM
classifier if the rule version's accuracy degrades on a labelled query set.

Output of a retrieval call is a typed iterator yielding ``RetrievalChunk``
events — same shape on every tier; T1/T2 emit one or two events total,
T3 streams reasoning + retrieved-context + final-answer chunks.

This module is consumed by the chat SSE endpoint (``/api/v1/agent/chat``).
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
from dataclasses import dataclass
from enum import Enum
from typing import AsyncIterator, Iterator, Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Tier classification
# ─────────────────────────────────────────────────────────────────────

class Tier(str, Enum):
    T1 = "T1"   # cached view
    T2 = "T2"   # single-entity lookup
    T3 = "T3"   # iterative multi-turn


@dataclass(frozen=True)
class TierChoice:
    tier: Tier
    reason: str
    view_kind: Optional[str] = None    # for T1
    anchor_hint: Optional[str] = None  # for T2


# Canned-view patterns. If a query matches AND the corresponding view
# is fresh in cached_views, we hit T1.
CANNED_VIEW_PATTERNS: dict[str, list[re.Pattern]] = {
    "patient_summary":     [re.compile(r"\b(summary|recap|overview)\b", re.I)],
    "active_findings":     [re.compile(r"\b(active|current)\s+findings?\b", re.I),
                            re.compile(r"\bwhat\s+(?:are|is)\s+the\s+findings?\b", re.I)],
    "current_medications": [re.compile(r"\b(current|active)?\s*(?:meds|medications?)\b", re.I)],
    "imaging_chronology":  [re.compile(r"\b(imaging\s+history|prior\s+stud(?:y|ies))\b", re.I)],
    "lab_trends_30d":      [re.compile(r"\b(labs?|trend|trending)\b", re.I)],
}

# Signals that require multi-hop reasoning → T3
MULTI_HOP_KEYWORDS = re.compile(
    r"\b(why|explain|rationale|trajectory|synthes(?:i[sz]e)|"
    r"across|over\s+time|compare.+(?:and|with)|chronology)\b",
    re.IGNORECASE,
)


def classify(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: Optional[str],
    question: str,
) -> TierChoice:
    """Pick the cheapest tier that can answer ``question`` correctly.

    Default cascade: try T1 (if pattern matches + view is fresh)
                  → T3 (if multi-hop signals)
                  → T2 (single-entity fallback).
    """
    q = question.strip()

    # ── T1 — canned view pattern match
    for view_kind, patterns in CANNED_VIEW_PATTERNS.items():
        if not any(p.search(q) for p in patterns):
            continue
        if patient_hash is None:
            continue
        if _view_is_fresh(conn, user_id, patient_hash, view_kind):
            return TierChoice(Tier.T1, f"matched view {view_kind!r}",
                              view_kind=view_kind)

    # ── T3 — multi-hop signals
    if MULTI_HOP_KEYWORDS.search(q):
        return TierChoice(Tier.T3, "multi-hop keywords")

    # Heuristic: very long questions probably need multi-hop reasoning
    if len(q.split()) > 25:
        return TierChoice(Tier.T3, "long question")

    # Count entity references → multiple → T3
    if _count_entity_references(conn, user_id, patient_hash, q) >= 3:
        return TierChoice(Tier.T3, "multiple entity references")

    # ── T2 — single-entity default
    anchor = _resolve_single_anchor(conn, user_id, patient_hash, q)
    if anchor:
        return TierChoice(Tier.T2, "single-entity anchor",
                          anchor_hint=anchor)

    # No specific anchor — fall through to T3 for breadth
    return TierChoice(Tier.T3, "no single anchor; broaden search")


def _view_is_fresh(
    conn: sqlite3.Connection, user_id: str, patient_hash: str, view_kind: str,
) -> bool:
    row = conn.execute(
        "SELECT generated_at, ttl_seconds, stale FROM cached_views "
        "WHERE user_id = ? AND patient_hash = ? AND view_kind = ?",
        (user_id, patient_hash, view_kind),
    ).fetchone()
    if row is None:
        return False
    generated_at, ttl, stale = row
    if stale:
        return False
    return (int(time.time()) - generated_at) < ttl


def _count_entity_references(
    conn: sqlite3.Connection,
    user_id: str,
    patient_hash: Optional[str],
    question: str,
) -> int:
    """Cheap NER — count tokens in question that look like graph entities."""
    if patient_hash is None:
        return 0
    rows = conn.execute(
        "SELECT content_json FROM clinical_graph_nodes "
        "WHERE user_id = ? AND patient_hash = ? "
        "  AND node_type IN ('finding','med','lab','anatomical_region','ddx') "
        "LIMIT 200",
        (user_id, patient_hash),
    ).fetchall()
    q_lower = question.lower()
    hits = 0
    for (raw,) in rows:
        try:
            label = (json.loads(raw) or {}).get("label", "")
        except json.JSONDecodeError:
            continue
        if label and label.lower() in q_lower:
            hits += 1
    return hits


def _resolve_single_anchor(
    conn: sqlite3.Connection,
    user_id: str,
    patient_hash: Optional[str],
    question: str,
) -> Optional[str]:
    """Return the label of the most likely single anchor entity, or None."""
    if patient_hash is None:
        return None
    rows = conn.execute(
        "SELECT content_json FROM clinical_graph_nodes "
        "WHERE user_id = ? AND patient_hash = ? "
        "  AND node_type IN ('finding','anatomical_region','med','lab') "
        "ORDER BY weight DESC LIMIT 100",
        (user_id, patient_hash),
    ).fetchall()
    q_lower = question.lower()
    for (raw,) in rows:
        try:
            label = (json.loads(raw) or {}).get("label", "")
        except json.JSONDecodeError:
            continue
        if label and label.lower() in q_lower:
            return label
    return None


# ─────────────────────────────────────────────────────────────────────
# Retrieval chunk events (SSE stream payloads)
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RetrievalChunk:
    kind: str
    data: dict


def yield_t1(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: str,
    view_kind: str,
) -> Iterator[RetrievalChunk]:
    """T1 — return cached view + citations as one shot."""
    from nexus_server.cached_views import get_view
    result = get_view(
        conn, user_id=user_id, patient_hash=patient_hash,
        view_kind=view_kind, rebuild_if_stale=True,
    )
    if result is None:
        yield RetrievalChunk("final_answer_chunk", {"text": "No data."})
        yield RetrievalChunk("turn_complete", {})
        return
    content, sources, _ts = result
    yield RetrievalChunk("tier_classified", {"tier": "T1", "view_kind": view_kind})
    yield RetrievalChunk("final_answer_chunk", {"text": content})
    yield RetrievalChunk(
        "citations",
        {"refs": [{"node_id": n, "kind": "cached_view_source"} for n in sources]},
    )
    yield RetrievalChunk("turn_complete", {})


def yield_t2(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: str,
    question: str,
    anchor: str,
) -> Iterator[RetrievalChunk]:
    """T2 — entity-anchored single-shot.

    Builds a textual answer from connected nodes of the anchored entity.
    For M1.6+ this will route through llm_gateway for natural-language
    synthesis; here we render a structured templated answer that callers
    can swap to LLM-backed synthesis later.
    """
    yield RetrievalChunk("tier_classified", {"tier": "T2", "anchor": anchor})

    # Find the anchor node by label match
    anchor_row = conn.execute(
        "SELECT node_id, node_type FROM clinical_graph_nodes "
        "WHERE user_id = ? AND patient_hash = ? "
        "  AND content_json LIKE ? LIMIT 1",
        (user_id, patient_hash, f"%{anchor}%"),
    ).fetchone()
    if anchor_row is None:
        yield RetrievalChunk(
            "final_answer_chunk",
            {"text": f"No information found about {anchor}."},
        )
        yield RetrievalChunk("turn_complete", {})
        return
    anchor_id, anchor_type = anchor_row

    # Pull connected episodic + semantic + measurement nodes
    rows = conn.execute(
        "SELECT n.node_id, n.node_type, n.content_json FROM clinical_graph_nodes n "
        "JOIN clinical_graph_edges e ON "
        "  ((e.src_node = ? AND e.dst_node = n.node_id) OR "
        "   (e.dst_node = ? AND e.src_node = n.node_id)) "
        "WHERE n.user_id = ? AND n.patient_hash = ? "
        "  AND n.node_type IN ('finding','measurement','episodic_event','semantic_fact') "
        "  AND e.user_id = n.user_id AND e.patient_hash = n.patient_hash "
        "ORDER BY n.weight DESC LIMIT 8",
        (anchor_id, anchor_id, user_id, patient_hash),
    ).fetchall()

    parts: list[str] = [f"## About {anchor}\n"]
    refs: list[dict] = [{"node_id": anchor_id, "kind": anchor_type}]
    for nid, ntype, raw in rows:
        try:
            content = json.loads(raw)
        except json.JSONDecodeError:
            continue
        label = content.get("label", "")
        parts.append(f"- {ntype}: {label} [#{nid}]")
        refs.append({"node_id": nid, "kind": ntype})

    yield RetrievalChunk("final_answer_chunk", {"text": "\n".join(parts)})
    yield RetrievalChunk("citations", {"refs": refs})
    yield RetrievalChunk("turn_complete", {})


def yield_t3(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: Optional[str],
    question: str,
) -> Iterator[RetrievalChunk]:
    """T3 — multi-turn streamed reasoning.

    M1.6+ wires the real Algorithm 1 control loop (ported from M3) to
    LLM gateway. The version here streams a placeholder reasoning trail
    + a synthesised summary so the frontend's TierIndicator / ReasoningPane
    have something to render end-to-end.
    """
    yield RetrievalChunk("tier_classified", {"tier": "T3"})

    yield RetrievalChunk("reasoning_chunk",
                        {"text": f"Searching for entities mentioned in: {question[:80]}…"})
    if patient_hash:
        n = conn.execute(
            "SELECT COUNT(*) FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? "
            "  AND node_type IN ('finding','study','measurement')",
            (user_id, patient_hash),
        ).fetchone()[0]
        yield RetrievalChunk("search_results_summary",
                             {"count": int(n or 0), "preview": "graph entities scanned"})

    yield RetrievalChunk(
        "final_answer_chunk",
        {
            "text": (
                "I've reviewed the available record. (T3 multi-hop "
                "reasoning surface is in place; full Algorithm 1 control "
                "loop with LLM-driven iterative search ships in M1.6+.)"
            )
        },
    )
    yield RetrievalChunk("citations", {"refs": []})
    yield RetrievalChunk("turn_complete", {})


# ─────────────────────────────────────────────────────────────────────
# Top-level dispatcher
# ─────────────────────────────────────────────────────────────────────

def retrieve(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: Optional[str],
    question: str,
) -> Iterator[RetrievalChunk]:
    """Classify + dispatch to the appropriate tier yielder."""
    choice = classify(conn, user_id=user_id, patient_hash=patient_hash, question=question)
    logger.info(
        "retrieve: user=%s patient=%s tier=%s reason=%s",
        user_id, patient_hash, choice.tier.value, choice.reason,
    )
    if choice.tier == Tier.T1 and choice.view_kind and patient_hash:
        yield from yield_t1(conn, user_id=user_id,
                            patient_hash=patient_hash,
                            view_kind=choice.view_kind)
    elif choice.tier == Tier.T2 and choice.anchor_hint and patient_hash:
        yield from yield_t2(conn, user_id=user_id, patient_hash=patient_hash,
                            question=question, anchor=choice.anchor_hint)
    else:
        yield from yield_t3(conn, user_id=user_id,
                            patient_hash=patient_hash, question=question)


# ─────────────────────────────────────────────────────────────────────
# Async dispatcher — T3 now calls the real LLM via llm_gateway. T1/T2
# stay synchronous (template / SQL) and are bridged into the async
# iterator via the sync `yield_t1` / `yield_t2` paths.
# ─────────────────────────────────────────────────────────────────────


def _gather_patient_context(
    conn: sqlite3.Connection, user_id: str, patient_hash: str,
) -> str:
    """Build a compact text block of the patient's graph for LLM grounding.
    Includes findings, medications, recent studies, and semantic facts —
    everything the LLM needs to ground its answer in the medic's record."""
    parts: list[str] = []
    try:
        rows = conn.execute(
            "SELECT node_type, content_json FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? "
            "  AND node_type IN ('finding','med','ddx','study','semantic_fact','measurement') "
            "ORDER BY weight DESC LIMIT 40",
            (user_id, patient_hash),
        ).fetchall()
    except sqlite3.Error:
        return ""
    if not rows:
        return ""
    by_kind: dict[str, list[str]] = {}
    for ntype, raw in rows:
        try:
            content = json.loads(raw)
        except json.JSONDecodeError:
            continue
        label = content.get("label") or content.get("modality") or content.get("name") or "?"
        extra = ""
        if "size_cm" in content:    extra = f" ({content['size_cm']} cm)"
        elif "study_date" in content: extra = f" on {content['study_date']}"
        elif "value" in content:    extra = f" = {content['value']}"
        by_kind.setdefault(ntype, []).append(f"{label}{extra}")
    label_map = {
        "finding": "Active findings",
        "med": "Medications",
        "ddx": "Differential diagnoses",
        "study": "Imaging studies",
        "semantic_fact": "Patient-level facts",
        "measurement": "Measurements",
    }
    for kind, items in by_kind.items():
        parts.append(f"{label_map.get(kind, kind)}: " + "; ".join(items[:10]))
    return "\n".join(parts)


async def yield_t3_llm(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: Optional[str],
    question: str,
) -> AsyncIterator[RetrievalChunk]:
    """T3 — real LLM-grounded answer. Replaces the placeholder.

    Pipeline:
      1. Emit tier_classified + a reasoning preview (so the UI's
         TierIndicator + ReasoningPane have something to render).
      2. Pull patient context from clinical_graph_nodes.
      3. Call llm_gateway.call_llm with a clinician-grounded system
         prompt + the patient context.
      4. Emit the LLM's answer as a single final_answer_chunk + a
         citations event with any nodes we grounded on.
    """
    yield RetrievalChunk("tier_classified", {"tier": "T3"})
    yield RetrievalChunk(
        "reasoning_chunk",
        {"text": f"Searching the patient record for: {question[:80]}…"},
    )

    context_block = ""
    cited_node_ids: list[int] = []
    if patient_hash:
        try:
            ctx_rows = conn.execute(
                "SELECT node_id, node_type FROM clinical_graph_nodes "
                "WHERE user_id = ? AND patient_hash = ? "
                "  AND node_type IN ('finding','med','study') "
                "ORDER BY weight DESC LIMIT 8",
                (user_id, patient_hash),
            ).fetchall()
            cited_node_ids = [int(r[0]) for r in ctx_rows]
        except sqlite3.Error:
            cited_node_ids = []
        context_block = _gather_patient_context(conn, user_id, patient_hash)
        if context_block:
            yield RetrievalChunk(
                "search_results_summary",
                {"count": len(cited_node_ids), "preview": "graph entities scanned"},
            )

    system_prompt = (
        "You are Nexus, a clinical workflow assistant for a practising "
        "physician. Answer the medic's question directly and concisely. "
        "When relevant, ground your answer in the patient context "
        "provided below. If the context is empty or does not address "
        "the question, answer from general medical knowledge but say "
        "so explicitly. Always recommend professional review for any "
        "decision-bearing output. Do NOT include hedging boilerplate; "
        "the medic is qualified."
    )
    if context_block:
        system_prompt += "\n\nPATIENT CONTEXT (from the local clinical graph):\n" + context_block

    try:
        from nexus_server import llm_gateway
        content, model, _stop, _tools = await llm_gateway.call_llm(
            messages=[{"role": "user", "content": question}],
            system_prompt=system_prompt,
            model=None,            # use config.DEFAULT_LLM_MODEL
            temperature=0.4,
            max_tokens=1024,
            tools=None,
        )
        logger.info("yield_t3_llm: model=%s answer_chars=%d", model, len(content))
        answer = content.strip() or "(no response)"
    except Exception as exc:  # noqa: BLE001
        logger.exception("LLM call failed in yield_t3_llm")
        answer = (
            f"⚠ LLM call failed: {exc}. Check Settings · LLM — make sure "
            f"the active provider has an API key, and the key is valid."
        )

    yield RetrievalChunk("final_answer_chunk", {"text": answer})
    yield RetrievalChunk(
        "citations",
        {"refs": [{"node_id": nid, "kind": "graph_node"} for nid in cited_node_ids]},
    )
    yield RetrievalChunk("turn_complete", {})


async def retrieve_async(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: Optional[str],
    question: str,
) -> AsyncIterator[RetrievalChunk]:
    """Async retrieval dispatcher. T1/T2 share their synchronous
    implementations (they're pure SQL/template), so we adapt them via
    a sync-iterator → async-iterator bridge. T3 uses yield_t3_llm,
    which actually calls the LLM gateway."""
    choice = classify(conn, user_id=user_id, patient_hash=patient_hash, question=question)
    logger.info(
        "retrieve_async: user=%s patient=%s tier=%s reason=%s",
        user_id, patient_hash, choice.tier.value, choice.reason,
    )
    if choice.tier == Tier.T1 and choice.view_kind and patient_hash:
        for chunk in yield_t1(conn, user_id=user_id,
                              patient_hash=patient_hash,
                              view_kind=choice.view_kind):
            yield chunk
    elif choice.tier == Tier.T2 and choice.anchor_hint and patient_hash:
        for chunk in yield_t2(conn, user_id=user_id, patient_hash=patient_hash,
                              question=question, anchor=choice.anchor_hint):
            yield chunk
    else:
        async for chunk in yield_t3_llm(
            conn, user_id=user_id, patient_hash=patient_hash, question=question,
        ):
            yield chunk
