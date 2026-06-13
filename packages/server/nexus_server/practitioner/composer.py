"""Layer 2 composer — renders active practitioner facts into system prompt.

Called by every agent turn. Returns a markdown block listing what
Nexus has learned about this medic, capped at PRACTITIONER_PROMPT_BUDGET_TOKENS.

Per Rev-5 / §6.4 — ordering is recency × confidence × per-kind quota.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)


PRACTITIONER_PROMPT_BUDGET_TOKENS = 800
PER_KIND_QUOTA = {"style": 4, "workflow": 4, "practice": 6, "calibration": 6}

# Patterns that haven't been reinforced in this many seconds drop out
# of prime context (still queryable but not auto-injected).
PRIME_CONTEXT_RECENCY_SECONDS = 180 * 86400  # 180 days


@dataclass(frozen=True)
class _Fact:
    fact_kind: str
    pattern_key: str
    pattern_value: dict
    confidence: float
    last_reinforced_at: int


def _load_active_facts(
    conn: sqlite3.Connection, user_id: str,
) -> list[_Fact]:
    rows = conn.execute(
        "SELECT fact_kind, pattern_key, pattern_value_json, "
        "       confidence, last_reinforced_at "
        "FROM practitioner_facts "
        "WHERE user_id = ? "
        "  AND medic_confirmed_at IS NOT NULL "
        "  AND medic_rejected_at IS NULL "
        "ORDER BY last_reinforced_at DESC",
        (user_id,),
    ).fetchall()
    return [
        _Fact(
            fact_kind=r[0], pattern_key=r[1],
            pattern_value=json.loads(r[2]),
            confidence=float(r[3] or 0),
            last_reinforced_at=int(r[4] or 0),
        )
        for r in rows
    ]


def build_prompt_enrichment(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    budget_tokens: int = PRACTITIONER_PROMPT_BUDGET_TOKENS,
) -> str:
    """Render active facts as markdown for system-prompt injection.

    Token estimation is rough (chars ÷ 4); the caller can pass a tighter
    budget if needed for Tier 1 / Tier 2 paths (per design v3 §6.4).
    """
    facts = _load_active_facts(conn, user_id)
    if not facts:
        return ""

    # Group by kind. Filter out stale (not reinforced in PRIME window).
    now = int(time.time())
    by_kind: dict[str, list[_Fact]] = {}
    for f in facts:
        if now * 1_000_000 - f.last_reinforced_at > PRIME_CONTEXT_RECENCY_SECONDS * 1_000_000:
            # Past prime; skip auto-injection.
            continue
        by_kind.setdefault(f.fact_kind, []).append(f)

    # Per-kind quotas + recency × confidence ordering
    selected: dict[str, list[_Fact]] = {}
    for kind, lst in by_kind.items():
        quota = PER_KIND_QUOTA.get(kind, 4)
        lst.sort(key=lambda f: (f.last_reinforced_at, f.confidence), reverse=True)
        selected[kind] = lst[:quota]

    sections: list[str] = [
        "You are assisting this medic. Their established preferences,",
        "learned from their case history (medic-confirmed; may be",
        "questioned by you if a specific case contradicts):",
        "",
    ]
    char_budget = budget_tokens * 4
    for kind in ("style", "workflow", "practice", "calibration"):
        if kind not in selected:
            continue
        sections.append(kind.upper())
        for f in selected[kind]:
            line = _render_fact_line(f)
            sections.append(f"  • {line}")
        sections.append("")

    sections.append(
        "These are your learned defaults, not rules. Surface them when",
        )
    sections.append(
        "they apply; flag if the current case appears to contradict any.",
    )

    out = "\n".join(sections)
    if len(out) > char_budget:
        out = out[: char_budget - 20] + "\n…(truncated)"
    return out


def _render_fact_line(f: _Fact) -> str:
    """One-line rendering of a single fact."""
    summary = (
        f.pattern_value.get("evidence_sample")
        or f.pattern_value.get("summary")
        or f.pattern_key
    )
    if isinstance(summary, dict):
        summary = json.dumps(summary, ensure_ascii=False)
    return f"{summary}"
