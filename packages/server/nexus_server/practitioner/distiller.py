"""Layer 2 distiller — promote observations to candidate facts.

Walks ``practitioner_observations`` per user; aggregates by
``(fact_kind, pattern_key)``; promotes to ``practitioner_facts`` only
when ``distinct_patient_count >= N_THRESHOLDS[fact_kind]``.

Per Rev-5: never silently activate a promoted candidate — the row lands
with ``medic_confirmed_at = NULL``, surfaces in the "Nexus has learned"
panel, and only becomes agent-visible after explicit medic confirmation.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass

from nexus_server.event_sourcing import EventKind, Store
from nexus_server.event_sourcing.handlers import (
    _h_practitioner_candidate_surfaced,
)

logger = logging.getLogger(__name__)


# Per-kind N-of-distinct-patients thresholds. Calibration is strictest
# because it actively suppresses agent suggestions. Per Rev-5 / §6.2.
N_THRESHOLDS: dict[str, int] = {
    "style":       3,
    "workflow":    5,
    "practice":    5,
    "calibration": 8,
}


@dataclass(frozen=True)
class DistillerResult:
    candidates_surfaced: int
    candidates_reinforced: int


def distill(
    store: Store,
    conn: sqlite3.Connection,
    *,
    user_id: str,
) -> DistillerResult:
    """Run one distillation pass for one user.

    Walks observations, computes ``(distinct_patient_count, total_count)``
    per ``(fact_kind, pattern_key)``, emits ``practitioner_candidate_surfaced``
    for groups that cross threshold and aren't already
    confirmed/rejected.
    """
    # Aggregate observations
    rows = conn.execute(
        "SELECT fact_kind, pattern_key, COUNT(*) AS total, "
        "       COUNT(DISTINCT patient_hash) AS distinct_count "
        "FROM practitioner_observations "
        "WHERE user_id = ? "
        "GROUP BY fact_kind, pattern_key",
        (user_id,),
    ).fetchall()

    surfaced = 0
    reinforced = 0
    for fact_kind, pattern_key, total, distinct_count in rows:
        threshold = N_THRESHOLDS.get(fact_kind, 5)
        if distinct_count < threshold:
            continue

        # Check current fact state (confirmed / rejected / new candidate)
        existing = conn.execute(
            "SELECT medic_confirmed_at, medic_rejected_at, distinct_patient_count "
            "FROM practitioner_facts "
            "WHERE user_id = ? AND fact_kind = ? AND pattern_key = ?",
            (user_id, fact_kind, pattern_key),
        ).fetchone()
        if existing and existing[1] is not None:
            # Already rejected — never re-surface (per Rev-5 medic_rejected
            # is permanent for the pattern_key).
            continue

        confidence = min(1.0, distinct_count / (threshold * 2))

        # Sample a pattern_value from one observation — real implementation
        # would aggregate values; M1.6 stub picks the first observation's
        # evidence_quote as a placeholder pattern_value.
        sample = conn.execute(
            "SELECT evidence_quote FROM practitioner_observations "
            "WHERE user_id = ? AND fact_kind = ? AND pattern_key = ? "
            "ORDER BY observed_at DESC LIMIT 1",
            (user_id, fact_kind, pattern_key),
        ).fetchone()
        pattern_value = {"evidence_sample": sample[0] if sample else ""}

        store.emit_and_apply(
            kind=EventKind.PRACTITIONER_CANDIDATE_SURFACED,
            payload={
                "fact_kind":      fact_kind,
                "pattern_key":    pattern_key,
                "distinct_count": int(distinct_count),
                "confidence":     confidence,
                "observed_count": int(total),
                "pattern_value":  pattern_value,
                "extraction_model":     "stub-practitioner@0.1",
                "extraction_prompt_id": "practitioner_signals_v1",
            },
            apply_fn=_h_practitioner_candidate_surfaced,
            user_id=user_id,
        )

        if existing is None:
            surfaced += 1
        else:
            reinforced += 1

    logger.info(
        "distill: user=%s surfaced=%d reinforced=%d",
        user_id, surfaced, reinforced,
    )
    return DistillerResult(
        candidates_surfaced=surfaced,
        candidates_reinforced=reinforced,
    )
