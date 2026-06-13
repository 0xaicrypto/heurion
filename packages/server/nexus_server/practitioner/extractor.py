"""Layer 2 extractor — turn one encounter into candidate observations.

M1.6 status: stub backend. M8 swaps in real LLM extraction call
(prompt `practitioner_signals_v1`).
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Callable

from nexus_server.event_sourcing import EventKind, Store
from nexus_server.event_sourcing.handlers import (
    _h_practitioner_observation_emitted,
)


@dataclass(frozen=True)
class Candidate:
    """One extracted practitioner signal from an encounter."""
    fact_kind: str            # 'style' | 'workflow' | 'practice' | 'calibration'
    pattern_key: str          # canonical structured slug
    evidence_quote: str       # verbatim from source
    source_encounter_id: str
    extraction_model: str = "stub-practitioner@0.1"
    extraction_prompt_id: str = "practitioner_signals_v1"


Extractor = Callable[[sqlite3.Connection, str, str, str], list[Candidate]]


def stub_practitioner_extractor(
    conn: sqlite3.Connection,
    user_id: str,
    patient_hash: str,
    source_encounter_id: str,
) -> list[Candidate]:
    """Deterministic stub — returns no candidates by default.
    Tests + smoke runs override with fixture data."""
    return []


def extract_from_encounter(
    store: Store,
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: str,
    source_encounter_id: str,
    extractor: Extractor = stub_practitioner_extractor,
) -> list[int]:
    """Run the extractor and emit one event per candidate.

    Returns the event_idx list of emitted PRACTITIONER_OBSERVATION_EMITTED
    events.
    """
    candidates = extractor(conn, user_id, patient_hash, source_encounter_id)
    event_idxs: list[int] = []
    for cand in candidates:
        idx = store.emit_and_apply(
            kind=EventKind.PRACTITIONER_OBSERVATION_EMITTED,
            payload={
                "fact_kind":            cand.fact_kind,
                "pattern_key":          cand.pattern_key,
                "evidence_quote":       cand.evidence_quote,
                "source_encounter_id":  cand.source_encounter_id,
                "extraction_model":     cand.extraction_model,
                "extraction_prompt_id": cand.extraction_prompt_id,
            },
            apply_fn=_h_practitioner_observation_emitted,
            user_id=user_id, patient_hash=patient_hash,
        )
        event_idxs.append(idx)
    return event_idxs
