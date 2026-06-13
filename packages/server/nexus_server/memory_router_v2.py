"""HTTP surface for the v3 memory layer (M0 / Rev-8).

Exposes the Layer 1-3 projection tables built on top of ``twin_event_log``
to the frontend. Read endpoints query projections directly for speed;
write endpoints route through ``Store.emit_and_apply`` so Contract B
(event_log = single source of truth) holds.

Mounted at ``/api/v1/memory`` by main.py. All endpoints are auth-gated
(``Depends(get_current_user)``); ``user_id`` is closed over server-side
so the agent cannot pivot to another medic's data even if a malicious
client tampers with paths.

Endpoint groups (see docs/design/nexus-ux-redesign-v2.md §8 for the
complete contract):

* Layer 1 projection reads — patient summary / findings / medications /
  timeline / conflicts.
* Provenance drill-down — citation → full source + key_image.
* Memory mutations — finding edit / retract / conflict resolve.
* Layer 2 practitioner — candidates / active / confirm / reject / pending.
* Audit — event_log subset filtered by patient_hash.

M0 status: read endpoints implemented; mutation endpoints emit events
via ``Store.emit_and_apply`` with no-op apply handlers for kinds that
aren't yet wired (Memory mode edit/retract land in M3, conflict
resolution in M3 — those endpoints return 501 until then).
"""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from nexus_server.auth.routes import get_current_user
from nexus_server.database import get_db_connection
from nexus_server.event_sourcing import (
    EventKind,
    Store,
    init_event_sourcing_schema,
)
from nexus_server.event_sourcing.handlers import (
    _h_practitioner_fact_confirmed,
    _h_practitioner_fact_rejected,
)

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/v1/memory", tags=["memory"])


# ─────────────────────────────────────────────────────────────────────
# Models
# ─────────────────────────────────────────────────────────────────────

class GraphNodeOut(BaseModel):
    node_id: int
    node_type: str
    content: dict
    weight: float
    encounter_id: Optional[str]
    updated_at: int


class ProvenanceOut(BaseModel):
    node_id: int
    source_kind: str
    source_ref: str
    source_locator: dict
    evidence_quote: str
    extraction_model: str
    extraction_prompt_id: str
    confidence: float
    redaction_version: str
    extracted_at: int
    extracted_by_user: str
    superseded_by_node: Optional[int]
    retracted_at: Optional[int]


class PatientProjectionOut(BaseModel):
    patient_hash: str
    findings: list[GraphNodeOut]
    medications: list[GraphNodeOut]
    differentials: list[GraphNodeOut]
    studies: list[GraphNodeOut]
    semantic_facts: list[GraphNodeOut]
    unresolved_conflict_count: int


class PractitionerCandidateOut(BaseModel):
    fact_kind: str
    pattern_key: str
    pattern_value: dict
    observed_count: int
    distinct_patient_count: int
    confidence: float
    first_observed_at: int
    last_reinforced_at: int


class PractitionerActiveOut(BaseModel):
    fact_kind: str
    pattern_key: str
    pattern_value: dict
    confidence: float
    confirmed_at: int


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _row_to_node(row: sqlite3.Row) -> GraphNodeOut:
    return GraphNodeOut(
        node_id=row["node_id"],
        node_type=row["node_type"],
        content=json.loads(row["content_json"]),
        weight=row["weight"],
        encounter_id=row["encounter_id"],
        updated_at=row["updated_at"],
    )


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Defensive: if a deployment hasn't fully initialised the v3 schema
    yet (e.g. an older backend booted before main.py picked up the new
    init call), bring it up now. Idempotent, so a normal boot does
    nothing here."""
    try:
        init_event_sourcing_schema(conn)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "memory_router_v2: schema bring-up failed: %s — endpoints "
            "may return empty until backend restart picks up new init",
            e,
        )


# ─────────────────────────────────────────────────────────────────────
# Layer 1 — patient projection reads
# ─────────────────────────────────────────────────────────────────────

@router.get("/patient/{patient_hash}/projection")
async def get_patient_projection(
    patient_hash: str,
    current_user: str = Depends(get_current_user),
) -> PatientProjectionOut:
    """Full Layer 1 projection for one patient.

    Returns active findings + medications + differentials + studies +
    semantic facts. Used by Memory mode + as a fallback when Tier-1
    cached views aren't available.
    """
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)

        def query_type(node_type: str) -> list[GraphNodeOut]:
            rows = conn.execute(
                "SELECT node_id, node_type, content_json, weight, "
                "       encounter_id, updated_at "
                "FROM clinical_graph_nodes "
                "WHERE user_id = ? AND patient_hash = ? "
                "  AND node_type = ? "
                "ORDER BY updated_at DESC",
                (current_user, patient_hash, node_type),
            ).fetchall()
            return [_row_to_node(r) for r in rows]

        # Active = not retracted in provenance.
        # We do this filter via subquery against node_provenance.
        def active_clinical(node_type: str) -> list[GraphNodeOut]:
            rows = conn.execute(
                "SELECT n.node_id, n.node_type, n.content_json, n.weight, "
                "       n.encounter_id, n.updated_at "
                "FROM clinical_graph_nodes n "
                "LEFT JOIN node_provenance p "
                "  ON p.user_id = n.user_id "
                " AND p.patient_hash = n.patient_hash "
                " AND p.node_id = n.node_id "
                "WHERE n.user_id = ? AND n.patient_hash = ? "
                "  AND n.node_type = ? "
                "  AND (p.retracted_at IS NULL) "
                "ORDER BY n.updated_at DESC",
                (current_user, patient_hash, node_type),
            ).fetchall()
            return [_row_to_node(r) for r in rows]

        findings    = active_clinical("finding")
        medications = query_type("med")
        differentials = query_type("ddx")
        studies     = query_type("study")
        semantics   = active_clinical("semantic_fact")

        # Conflict count = nodes with superseded_by set, where the
        # winning side was a medic-resolved choice and the loser still
        # belongs to this patient. For M0 we just count provenance rows
        # with superseded_by_node not null.
        cur = conn.execute(
            "SELECT COUNT(*) FROM node_provenance "
            "WHERE user_id = ? AND patient_hash = ? "
            "  AND superseded_by_node IS NOT NULL "
            "  AND retracted_at IS NULL",
            (current_user, patient_hash),
        )
        conflict_count = int(cur.fetchone()[0] or 0)

        return PatientProjectionOut(
            patient_hash=patient_hash,
            findings=findings,
            medications=medications,
            differentials=differentials,
            studies=studies,
            semantic_facts=semantics,
            unresolved_conflict_count=conflict_count,
        )


@router.get("/patient/{patient_hash}/findings")
async def list_findings(
    patient_hash: str,
    status: str = Query("active", pattern="^(active|retracted|all)$"),
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)

        filter_clause = ""
        if status == "active":
            filter_clause = "AND (p.retracted_at IS NULL)"
        elif status == "retracted":
            filter_clause = "AND (p.retracted_at IS NOT NULL)"

        rows = conn.execute(
            f"SELECT n.node_id, n.node_type, n.content_json, n.weight, "
            f"       n.encounter_id, n.updated_at "
            f"FROM clinical_graph_nodes n "
            f"LEFT JOIN node_provenance p "
            f"  ON p.user_id = n.user_id AND p.patient_hash = n.patient_hash "
            f"   AND p.node_id = n.node_id "
            f"WHERE n.user_id = ? AND n.patient_hash = ? "
            f"  AND n.node_type IN ('finding', 'measurement') "
            f"  {filter_clause} "
            f"ORDER BY n.updated_at DESC",
            (current_user, patient_hash),
        ).fetchall()
        return {"findings": [_row_to_node(r).model_dump() for r in rows]}


@router.get("/patient/{patient_hash}/medications")
async def list_medications(
    patient_hash: str,
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT node_id, node_type, content_json, weight, encounter_id, updated_at "
            "FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? AND node_type = 'med' "
            "ORDER BY updated_at DESC",
            (current_user, patient_hash),
        ).fetchall()
        return {"medications": [_row_to_node(r).model_dump() for r in rows]}


@router.get("/patient/{patient_hash}/timeline")
async def get_timeline(
    patient_hash: str,
    limit: int = Query(50, ge=1, le=500),
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)
        # Group nodes by encounter_id, latest first.
        rows = conn.execute(
            "SELECT encounter_id, COUNT(*) AS node_count, "
            "       MAX(updated_at) AS last_touched "
            "FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? "
            "  AND encounter_id IS NOT NULL "
            "GROUP BY encounter_id "
            "ORDER BY last_touched DESC LIMIT ?",
            (current_user, patient_hash, limit),
        ).fetchall()
        return {
            "entries": [
                {
                    "encounter_id": r["encounter_id"],
                    "node_count":   r["node_count"],
                    "last_touched": r["last_touched"],
                }
                for r in rows
            ]
        }


# ─────────────────────────────────────────────────────────────────────
# Provenance drill-down
# ─────────────────────────────────────────────────────────────────────

@router.get("/citation/{node_id}")
async def get_citation(
    node_id: int,
    current_user: str = Depends(get_current_user),
) -> ProvenanceOut:
    """The data behind one citation chip.

    Used by the right-rail provenance card and the hover preview.
    """
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)
        row = conn.execute(
            "SELECT * FROM node_provenance "
            "WHERE user_id = ? AND node_id = ? LIMIT 1",
            (current_user, node_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="no provenance for node")
        return ProvenanceOut(
            node_id=row["node_id"],
            source_kind=row["source_kind"],
            source_ref=row["source_ref"],
            source_locator=json.loads(row["source_locator_json"]),
            evidence_quote=row["evidence_quote"],
            extraction_model=row["extraction_model"],
            extraction_prompt_id=row["extraction_prompt_id"],
            confidence=row["confidence"],
            redaction_version=row["redaction_version"],
            extracted_at=row["extracted_at"],
            extracted_by_user=row["extracted_by_user"],
            superseded_by_node=row["superseded_by_node"],
            retracted_at=row["retracted_at"],
        )


# ─────────────────────────────────────────────────────────────────────
# Layer 2 — practitioner memory
# ─────────────────────────────────────────────────────────────────────

@router.get("/practitioner/candidates")
async def list_practitioner_candidates(
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    """Candidates surfaced by the distiller, awaiting medic confirmation."""
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT fact_kind, pattern_key, pattern_value_json, "
            "       observed_count, distinct_patient_count, confidence, "
            "       first_observed_at, last_reinforced_at "
            "FROM practitioner_facts "
            "WHERE user_id = ? "
            "  AND medic_confirmed_at IS NULL "
            "  AND medic_rejected_at IS NULL "
            "ORDER BY last_reinforced_at DESC",
            (current_user,),
        ).fetchall()
        return {
            "candidates": [
                PractitionerCandidateOut(
                    fact_kind=r["fact_kind"],
                    pattern_key=r["pattern_key"],
                    pattern_value=json.loads(r["pattern_value_json"]),
                    observed_count=r["observed_count"],
                    distinct_patient_count=r["distinct_patient_count"],
                    confidence=r["confidence"],
                    first_observed_at=r["first_observed_at"],
                    last_reinforced_at=r["last_reinforced_at"],
                ).model_dump()
                for r in rows
            ]
        }


@router.get("/practitioner/active")
async def list_practitioner_active(
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT fact_kind, pattern_key, pattern_value_json, "
            "       confidence, medic_confirmed_at "
            "FROM practitioner_facts "
            "WHERE user_id = ? "
            "  AND medic_confirmed_at IS NOT NULL "
            "  AND medic_rejected_at IS NULL "
            "ORDER BY medic_confirmed_at DESC",
            (current_user,),
        ).fetchall()
        return {
            "active": [
                PractitionerActiveOut(
                    fact_kind=r["fact_kind"],
                    pattern_key=r["pattern_key"],
                    pattern_value=json.loads(r["pattern_value_json"]),
                    confidence=r["confidence"],
                    confirmed_at=r["medic_confirmed_at"],
                ).model_dump()
                for r in rows
            ]
        }


@router.get("/practitioner/pending_count")
async def practitioner_pending_count(
    current_user: str = Depends(get_current_user),
) -> dict[str, int]:
    """For the avatar badge — single integer."""
    with get_db_connection() as conn:
        _ensure_schema(conn)
        n = conn.execute(
            "SELECT COUNT(*) FROM practitioner_facts "
            "WHERE user_id = ? "
            "  AND medic_confirmed_at IS NULL "
            "  AND medic_rejected_at IS NULL",
            (current_user,),
        ).fetchone()[0]
        return {"count": int(n or 0)}


@router.post("/practitioner/{fact_kind}/{pattern_key:path}/confirm")
async def confirm_practitioner_fact(
    fact_kind: str,
    pattern_key: str,
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    with get_db_connection() as conn:
        _ensure_schema(conn)
        store = Store(conn)
        event_idx = store.emit_and_apply(
            kind=EventKind.PRACTITIONER_FACT_CONFIRMED,
            payload={
                "fact_kind":   fact_kind,
                "pattern_key": pattern_key,
                "by_user":     current_user,
            },
            apply_fn=_h_practitioner_fact_confirmed,
            user_id=current_user,
        )
        return {"ok": True, "event_idx": event_idx}


@router.post("/practitioner/{fact_kind}/{pattern_key:path}/reject")
async def reject_practitioner_fact(
    fact_kind: str,
    pattern_key: str,
    reason: Optional[str] = None,
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    with get_db_connection() as conn:
        _ensure_schema(conn)
        store = Store(conn)
        payload: dict[str, Any] = {
            "fact_kind":   fact_kind,
            "pattern_key": pattern_key,
            "by_user":     current_user,
        }
        if reason:
            payload["reason"] = reason
        event_idx = store.emit_and_apply(
            kind=EventKind.PRACTITIONER_FACT_REJECTED,
            payload=payload,
            apply_fn=_h_practitioner_fact_rejected,
            user_id=current_user,
        )
        return {"ok": True, "event_idx": event_idx}


# ─────────────────────────────────────────────────────────────────────
# Audit — event log slice
# ─────────────────────────────────────────────────────────────────────

@router.get("/audit/{patient_hash}")
async def get_audit_log(
    patient_hash: str,
    limit: int = Query(100, ge=1, le=2000),
    before_event_idx: Optional[int] = None,
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    """Raw event_log subset for this patient. Backs Memory mode's
    audit log viewer and the medico-legal replay debugger."""
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)
        params: list[Any] = [current_user, patient_hash]
        where_clauses = ["user_id = ?", "patient_hash = ?"]
        if before_event_idx is not None:
            where_clauses.append("event_idx < ?")
            params.append(before_event_idx)
        params.append(limit)
        rows = conn.execute(
            f"SELECT event_idx, event_kind, event_kind_version, ts, "
            f"       payload_json, caused_by "
            f"FROM twin_event_log WHERE {' AND '.join(where_clauses)} "
            f"ORDER BY event_idx DESC LIMIT ?",
            params,
        ).fetchall()
        return {
            "events": [
                {
                    "event_idx":          r["event_idx"],
                    "event_kind":         r["event_kind"],
                    "event_kind_version": r["event_kind_version"],
                    "ts":                 r["ts"],
                    "payload":            json.loads(r["payload_json"]),
                    "caused_by":          r["caused_by"],
                }
                for r in rows
            ]
        }


# ─────────────────────────────────────────────────────────────────────
# Health / capability
# ─────────────────────────────────────────────────────────────────────

@router.get("/_status")
async def memory_status(
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    """Capability + projection state — diagnostic + frontend liveness probe."""
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)
        row = conn.execute(
            "SELECT schema_version, last_applied_event_idx, last_applied_ts "
            "FROM projection_state WHERE projection_name = 'all'"
        ).fetchone()
        node_count = conn.execute(
            "SELECT COUNT(*) FROM clinical_graph_nodes WHERE user_id = ?",
            (current_user,),
        ).fetchone()[0]
        return {
            "schema_version":         row["schema_version"] if row else "uninitialised",
            "last_applied_event_idx": row["last_applied_event_idx"] if row else 0,
            "last_applied_ts":        row["last_applied_ts"] if row else 0,
            "user_node_count":        int(node_count or 0),
        }
