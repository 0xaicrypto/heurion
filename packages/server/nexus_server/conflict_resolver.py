"""Four-axis clinical conflict resolution (ADR-002 Rev-3).

Two contradictory `finding` / `measurement` / `semantic_fact` nodes about
the same entity → resolve by cascade:

  Axis 1  explicit retraction          (medic sovereignty)
  Axis 2  medic confirmation status    (confirmed > LLM-extracted)
  Axis 3  evidence-strength rank       (pathology > MR > CT > … > chat)
  Axis 4  recency (measurement-only)   (per-kind threshold)

Default when no axis is decisive: ``flag_for_medic`` — both nodes stay
alive, ``memory_conflict`` event surfaces, medic resolves manually.

Per Rev-3 / R11 — never silently override clinical facts.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from typing import Literal, Optional

from nexus_server.event_sourcing import EventKind, Store
from nexus_server.event_sourcing.handlers import (
    _h_conflict_detected,
    _h_conflict_resolved,
)

logger = logging.getLogger(__name__)


Decision = Literal["prefer_a", "prefer_b", "flag_for_medic", "merge"]


# ─────────────────────────────────────────────────────────────────────
# Evidence rank table (Axis 3) — defaults per design v3 §7.2
# ─────────────────────────────────────────────────────────────────────

EVIDENCE_RANK: dict[str, int] = {
    "pathology": 4, "biopsy": 4,
    "MR": 3, "MRI": 3, "PET": 3,
    "CT": 3,
    "US": 2, "ultrasound": 2,
    "XR": 2, "x-ray": 2, "XRAY": 2,
    "clinical_exam": 1, "exam": 1,
    "chat": 0, "chat_hypothesis": 0,
    "manual": 0,
}


# Axis 4 — per-fact-type recency thresholds (seconds)
RECENCY_THRESHOLD_BY_KIND: dict[str, int] = {
    "lesion_size":      90 * 86400,
    "measurement":      90 * 86400,
    "medication_dose":  30 * 86400,
    "lab_value":         7 * 86400,
    "default":          30 * 86400,
}


@dataclass(frozen=True)
class ConflictDecision:
    kind: Decision
    reason: str
    axis_used: str
    auto_resolved: bool


# ─────────────────────────────────────────────────────────────────────
# Loaders
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class NodeWithProvenance:
    node_id: int
    node_type: str
    content: dict
    weight: float
    extracted_at: int
    extraction_model: str
    retracted_at: Optional[int]
    has_medic_confirmation: bool
    source_kind: str
    source_ref: str


def _load_node(
    conn: sqlite3.Connection,
    user_id: str,
    patient_hash: str,
    node_id: int,
) -> Optional[NodeWithProvenance]:
    row = conn.execute(
        "SELECT n.node_id, n.node_type, n.content_json, n.weight, "
        "       p.extracted_at, p.extraction_model, "
        "       p.retracted_at, p.source_kind, p.source_ref "
        "FROM clinical_graph_nodes n "
        "LEFT JOIN node_provenance p "
        "  ON p.user_id = n.user_id AND p.patient_hash = n.patient_hash "
        "   AND p.node_id = n.node_id "
        "WHERE n.user_id = ? AND n.patient_hash = ? AND n.node_id = ? ",
        (user_id, patient_hash, node_id),
    ).fetchone()
    if row is None:
        return None
    # medic confirmation: search for FINDING_ACCEPTED_BY_MEDIC event
    # referencing this node_id
    confirmed_row = conn.execute(
        "SELECT 1 FROM twin_event_log "
        "WHERE user_id = ? AND patient_hash = ? "
        "  AND event_kind = 'finding_accepted_by_medic' "
        "  AND payload_json LIKE ? LIMIT 1",
        (user_id, patient_hash, f'%"node_id": {node_id}%'),
    ).fetchone()
    return NodeWithProvenance(
        node_id=row[0], node_type=row[1],
        content=json.loads(row[2]),
        weight=row[3] or 1.0,
        extracted_at=row[4] or 0,
        extraction_model=row[5] or "",
        retracted_at=row[6],
        has_medic_confirmation=confirmed_row is not None,
        source_kind=row[7] or "",
        source_ref=row[8] or "",
    )


def _evidence_rank(node: NodeWithProvenance) -> int:
    """Rank from source_ref + extraction_model + content_json hints."""
    # Try source_kind first (study/chat/lab/manual)
    if node.source_kind == "lab":
        return 1
    if node.source_kind == "chat":
        return 0
    if node.source_kind == "manual":
        return 0
    # Pathology-flagged content (biopsy/cytology) outranks imaging.
    label = (node.content.get("label") or "").lower()
    if any(k in label for k in ("biopsy", "pathology", "cytology")):
        return EVIDENCE_RANK["pathology"]
    # Try the imaging modality on the linked study (we use a hint
    # field commonly attached by dicom_ingester).
    modality = (node.content.get("modality") or "").upper()
    if modality in EVIDENCE_RANK:
        return EVIDENCE_RANK[modality]
    # Fallback by source_kind=study without modality info → CT-equiv
    if node.source_kind == "study":
        return EVIDENCE_RANK["CT"]
    return 0


def _recency_threshold(node: NodeWithProvenance) -> int:
    if node.node_type == "measurement":
        return RECENCY_THRESHOLD_BY_KIND["measurement"]
    label = (node.content.get("kind") or node.content.get("label") or "").lower()
    if "med" in label or "dose" in label:
        return RECENCY_THRESHOLD_BY_KIND["medication_dose"]
    if "lab" in label or node.source_kind == "lab":
        return RECENCY_THRESHOLD_BY_KIND["lab_value"]
    if "size" in label or node.node_type in {"measurement"}:
        return RECENCY_THRESHOLD_BY_KIND["lesion_size"]
    return RECENCY_THRESHOLD_BY_KIND["default"]


# ─────────────────────────────────────────────────────────────────────
# Core decision function
# ─────────────────────────────────────────────────────────────────────

def resolve_clinical_conflict(
    a: NodeWithProvenance,
    b: NodeWithProvenance,
) -> ConflictDecision:
    """Apply the four-axis cascade.

    Never silently overrides — flags for medic when no axis is decisive
    (per Rev-3 + design v3 §8 / R11)."""
    # Axis 1 — explicit retraction
    if a.retracted_at and not b.retracted_at:
        return ConflictDecision("prefer_b", "A retracted", "retraction", True)
    if b.retracted_at and not a.retracted_at:
        return ConflictDecision("prefer_a", "B retracted", "retraction", True)

    # Axis 2 — medic confirmation
    if a.has_medic_confirmation and not b.has_medic_confirmation:
        return ConflictDecision(
            "prefer_a", "A medic-confirmed", "medic_confirmation", True,
        )
    if b.has_medic_confirmation and not a.has_medic_confirmation:
        return ConflictDecision(
            "prefer_b", "B medic-confirmed", "medic_confirmation", True,
        )

    # Axis 3 — evidence strength
    rank_a = _evidence_rank(a)
    rank_b = _evidence_rank(b)
    if rank_a - rank_b >= 2:
        return ConflictDecision(
            "prefer_a", f"rank {rank_a} >> {rank_b}", "evidence_rank", False,
        )
    if rank_b - rank_a >= 2:
        return ConflictDecision(
            "prefer_b", f"rank {rank_b} >> {rank_a}", "evidence_rank", False,
        )

    # Axis 4 — recency (measurements only)
    if a.node_type == "measurement" and b.node_type == "measurement":
        threshold = _recency_threshold(a)
        delta = abs(a.extracted_at - b.extracted_at)
        if delta > threshold:
            if a.extracted_at > b.extracted_at:
                return ConflictDecision(
                    "prefer_a", f"newer by {delta}s", "recency", False,
                )
            return ConflictDecision(
                "prefer_b", f"newer by {delta}s", "recency", False,
            )

    return ConflictDecision(
        "flag_for_medic",
        "no axis decisive; both nodes preserved",
        "none",
        False,
    )


# ─────────────────────────────────────────────────────────────────────
# Event-sourced wrapper
# ─────────────────────────────────────────────────────────────────────

def detect_and_resolve(
    store: Store,
    conn: sqlite3.Connection,
    *,
    user_id: str,
    patient_hash: str,
    node_a_id: int,
    node_b_id: int,
    detector: str = "rule",
    rule_id: Optional[str] = None,
) -> ConflictDecision:
    """Detect + resolve in one transaction.

    Emits ``conflict_detected`` first; if decision is conclusive, emits
    ``conflict_resolved`` with the chosen axis. Both events flow through
    Store.emit_and_apply so replay sees them.
    """
    a = _load_node(conn, user_id, patient_hash, node_a_id)
    b = _load_node(conn, user_id, patient_hash, node_b_id)
    if a is None or b is None:
        raise ValueError(
            f"missing node(s) for conflict: a={node_a_id} b={node_b_id}"
        )

    detected_idx = store.emit_and_apply(
        kind=EventKind.CONFLICT_DETECTED,
        payload={
            "nodes":    [node_a_id, node_b_id],
            "detector": detector,
            "rule_id":  rule_id,
            "evidence": {
                "a_type": a.node_type, "b_type": b.node_type,
                "a_source": a.source_kind, "b_source": b.source_kind,
            },
        },
        apply_fn=_h_conflict_detected,
        user_id=user_id, patient_hash=patient_hash,
    )

    decision = resolve_clinical_conflict(a, b)

    store.emit_and_apply(
        kind=EventKind.CONFLICT_RESOLVED,
        payload={
            "nodes":         [node_a_id, node_b_id],
            "decision":      decision.kind,
            "axis_used":     decision.axis_used,
            "auto_or_medic": "auto" if decision.auto_resolved else "flagged",
            "reasoning":     decision.reason,
        },
        apply_fn=_h_conflict_resolved,
        user_id=user_id, patient_hash=patient_hash,
        caused_by=detected_idx,
    )

    return decision
