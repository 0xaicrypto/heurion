"""HTTP surface for the v3 memory layer (M0 / Rev-8).

Exposes the Layer 1-3 projection tables built on top of ``twin_event_log``
to the frontend. Read endpoints query projections directly for speed;
write endpoints route through ``Store.emit_and_apply`` so Contract B
(event_log = single source of truth) holds.

Mounted at ``/api/v1/memory`` by main.py. All endpoints are auth-gated
(``Depends(get_current_user)``); ``user_id`` is closed over server-side
so the agent cannot pivot to another medic's data even if a malicious
client tampers with paths.

Endpoint groups (see docs/design/nexus-architecture.md §8 for the
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
import time
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

@router.get("/patient/{patient_hash}/ingest_debug")
async def patient_ingest_debug(
    patient_hash: str,
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    """Diagnostic: for THIS (user, patient), how many ingestion attempts
    fired, how many entities did the LLM emit, how many landed in the
    graph, and what were the most recent skip reasons.

    The medic can paste the output (curl from the server console or
    a small "Debug · ingestion" button) when the 病人 tab's 当前发现
    stays empty — it answers the exact question "did chat_ingester
    even run, or did it run and silently drop everything?" without
    needing to grep server logs.
    """
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)

        def count(sql: str, params: tuple) -> int:
            try:
                row = conn.execute(sql, params).fetchone()
                return int(row[0]) if row else 0
            except sqlite3.Error:
                return 0

        # Count INGESTION_* events scoped to (user, patient)
        n_started = count(
            "SELECT COUNT(*) FROM twin_event_log "
            "WHERE user_id = ? AND patient_hash = ? "
            "  AND event_kind = 'ingestion_started'",
            (current_user, patient_hash),
        )
        n_completed = count(
            "SELECT COUNT(*) FROM twin_event_log "
            "WHERE user_id = ? AND patient_hash = ? "
            "  AND event_kind = 'ingestion_completed'",
            (current_user, patient_hash),
        )
        n_node_added = count(
            "SELECT COUNT(*) FROM twin_event_log "
            "WHERE user_id = ? AND patient_hash = ? "
            "  AND event_kind = 'node_added'",
            (current_user, patient_hash),
        )
        n_graph_nodes = count(
            "SELECT COUNT(*) FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ?",
            (current_user, patient_hash),
        )
        # Latest INGESTION_LLM_RESPONSE — read the raw LLM output so
        # the medic can SEE what the extractor returned (vs guessing).
        latest_llm: dict[str, Any] = {}
        try:
            row = conn.execute(
                "SELECT payload_json, ts FROM twin_event_log "
                "WHERE user_id = ? AND patient_hash = ? "
                "  AND event_kind = 'ingestion_llm_response' "
                "ORDER BY event_idx DESC LIMIT 1",
                (current_user, patient_hash),
            ).fetchone()
            if row:
                import json as _json
                payload = _json.loads(row[0])
                raw = payload.get("raw_output_text", "")
                latest_llm = {
                    "model":          payload.get("model"),
                    "prompt_id":      payload.get("prompt_id"),
                    "latency_ms":     payload.get("latency_ms"),
                    "ts":             row[1],
                    "raw_output_head": raw[:400],   # cap so the response stays small
                    "raw_output_chars": len(raw),
                }
        except sqlite3.Error:
            pass
        # Latest INGESTION_COMPLETED — has the skipped quote list now.
        latest_completed: dict[str, Any] = {}
        try:
            row = conn.execute(
                "SELECT payload_json, ts FROM twin_event_log "
                "WHERE user_id = ? AND patient_hash = ? "
                "  AND event_kind = 'ingestion_completed' "
                "ORDER BY event_idx DESC LIMIT 1",
                (current_user, patient_hash),
            ).fetchone()
            if row:
                import json as _json
                p = _json.loads(row[0])
                latest_completed = {
                    "emitted_node_count": p.get("emitted_node_count"),
                    "errors":             p.get("errors") or [],
                    # F55 — drops dict + raw_count surfaced from the
                    # extractor for precise diagnosis ("which step
                    # killed which entity").
                    "drops":              p.get("drops") or {},
                    "raw_count":          p.get("raw_count") or 0,
                    "ts":                 row[1],
                }
        except sqlite3.Error:
            pass
        return {
            "user_id":              current_user,
            "patient_hash":         patient_hash,
            "ingestion_started":    n_started,
            "ingestion_completed":  n_completed,
            "node_added_events":    n_node_added,
            "clinical_graph_nodes": n_graph_nodes,
            "latest_llm_response":  latest_llm,
            "latest_completed":     latest_completed,
            # Plain-English summary the UI can render directly.
            "diagnosis": _diagnose_ingest_state(
                n_started, n_completed, n_node_added, n_graph_nodes,
                latest_llm, latest_completed,
            ),
        }


def _diagnose_ingest_state(
    n_started: int, n_completed: int, n_node_added: int,
    n_graph_nodes: int, latest_llm: dict, latest_completed: dict,
) -> str:
    """Plain-English summary of what the ingestion pipeline did. Read
    in priority order so the most actionable diagnosis surfaces first.

    Sub-cases for ``ingestion_completed > 0 AND node_added == 0``:
      (A) extractor LLM call raised an exception — raw_output_text
          starts with "(extractor error: ...)". Most common cause:
          API key invalid for ``gemini-2.5-flash`` (the model the
          extractor pins; main chat might use a different model and
          succeed even when extractor fails).
      (B) LLM returned prose / refusal instead of JSON — raw output
          has no JSON structure. Usually a safety filter, or Gemini
          decided to "comply with the medical advice rule" rather
          than the JSON-only instruction.
      (C) LLM returned valid JSON but empty list — extractor judged
          this turn as "nothing clinical to extract" (often happens
          on short user messages like "重试", "你好").
      (D) LLM returned entities but ALL got dropped at verbatim
          check — extractor paraphrased every evidence_quote and
          fuzzy_rescue couldn't recover. Now that F7 logs the
          skipped quotes in INGESTION_COMPLETED.errors we can see
          them directly.
    """
    if n_started == 0:
        return ("chat_ingester 从未对这位病人触发过 — 检查聊天时 "
                "patient_hash 是否传给了 /api/v1/agent/chat,以及主聊天 "
                "调用是否在 SSE 流末尾正常 turn_complete。")
    if n_started > 0 and n_completed == 0:
        return ("chat_ingester 启动后从未完成 — 多半在 LLM 调用阶段抛 "
                "异常 (API key 无效 / quota / 网络)。看 server 日志中 "
                "包含 'chat_ingester failed' 的 WARNING 行。")
    if n_completed > 0 and n_node_added == 0:
        raw_head = (latest_llm.get("raw_output_head") or "").strip()
        # Case (A) — extractor LLM call raised. We stamped the
        # raw_output_text as "(extractor error: ...)" in llm_extractor.py.
        if raw_head.startswith("(extractor error:"):
            return (
                "★ extractor LLM 调用抛出异常 — 主聊天能跑,但抽取这一 "
                "步失败。最常见原因:GEMINI_API_KEY 对 gemini-2.5-flash "
                "无权限 (extractor 把模型硬编码在那里,而主聊天可能用 "
                "了另一个模型);或者 quota 已耗。完整错误见 raw_output_head: "
                + raw_head[:300]
            )

        # F55 — Read the persisted drops dict from INGESTION_COMPLETED.
        # The extractor now writes a structured per-reason count
        # (no_label / no_evidence / not_verbatim / not_dict /
        # bad_node_type / fuzzy_rescued) so we can render the exact
        # breakdown instead of guessing.
        drops_dict = latest_completed.get("drops") or {}
        raw_count = int(latest_completed.get("raw_count") or 0)

        # F55 fix — strip ```json fence before JSON-shape detection so
        # the diagnosis below doesn't fall through to "raw_output 为空"
        # when the LLM wrapped the response in markdown fences.
        head_naked = raw_head
        if head_naked.startswith("```"):
            head_naked = head_naked.lstrip("`")
            if head_naked.lower().startswith("json"):
                head_naked = head_naked[4:]
            head_naked = head_naked.lstrip()

        # Case (D) — entities found but all dropped. Use the precise
        # drops dict if available (post-F55 ingest); fall back to the
        # legacy "errors" list for older event payloads.
        skipped_quotes = latest_completed.get("errors") or []
        if raw_count > 0 or drops_dict or skipped_quotes:
            # Build human breakdown.
            reasons = []
            for key, label in [
                ("not_verbatim",  "verbatim 校验失败(quote 不在 source)"),
                ("no_evidence",   "缺 evidence_quote"),
                ("no_label",      "缺 label"),
                ("bad_node_type", "node_type 不在白名单"),
                ("not_dict",      "结构不是 dict"),
            ]:
                v = int(drops_dict.get(key) or 0)
                if v > 0:
                    reasons.append(f"{label} × {v}")
            rescued = int(drops_dict.get("fuzzy_rescued") or 0)
            if reasons:
                msg = (
                    f"LLM 返回 {raw_count} 条实体,全部被验证步骤过滤: "
                    + "; ".join(reasons)
                )
                if rescued:
                    msg += f" (其中 {rescued} 条 fuzzy_rescue 救回但仍未落地)"
                if skipped_quotes:
                    msg += f" — 示例被丢 quote: {skipped_quotes[:2]}"
                return msg

        # Case (C) — JSON returned with empty/missing entities.
        if head_naked.startswith("{") and '"entities"' in head_naked:
            return (
                "LLM 返回了合法 JSON 但 entities 字段为空 — 这次对话被 "
                "判定为没有临床实体可提取。如果你刚才发的是 SOAP 但仍 "
                "为空,把 raw_output_head 贴给我;否则可能是消息太短/非 "
                "临床内容。"
            )
        # Case (B) — non-JSON response.
        if raw_head and "{" not in raw_head:
            return (
                "LLM 调用成功但返回不是 JSON — extractor 提示词没有被 "
                "理解 (safety filter / refusal / 用错模型)。raw output "
                "开头: " + raw_head[:200]
            )
        return (
            "INGESTION_COMPLETED 已发出但没有 NODE_ADDED — "
            "raw_output_head: " + raw_head[:200]
        )
    if n_node_added > 0 and n_graph_nodes == 0:
        return ("NODE_ADDED 事件已发出但 clinical_graph_nodes 没有行 — "
                "handler 投影失败,或者 user_id/patient_hash 列对不上 "
                "(rare,通常意味着 DB 迁移问题)。")
    return f"链路正常:已写入 {n_graph_nodes} 个图节点,共 {n_started} 次摄取。"


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

    Two-tier resolution:

      1. If ``node_provenance`` has a row for ``node_id`` (the canonical
         path — required for finding / measurement / semantic_fact
         nodes per Rev-2), return it verbatim.

      2. Otherwise, fall back to a SYNTHESIZED provenance derived from
         ``clinical_graph_nodes`` itself: source_kind = the node_type,
         source_ref = the originating_event_idx, evidence_quote = a
         best-effort short string from the node's ``content_json``.

         This covers nodes that don't strictly require provenance
         (study, patient, key_image, encounter…) but that the right-
         rail still tries to render when the user clicks a citation
         chip. Returning 404 here was strictly correct per the
         contract but produced a red "Failed to load" message in the
         Memory UI even for healthy DICOM imports — every study node
         clicked through this 404.

         The synthesized row is clearly marked (extracted_by_user =
         "system:synthesized") so downstream consumers can tell it
         apart from real LLM/ingester-stamped provenance.

      3. Only after BOTH fail do we 404 — true "no such node".
    """
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)

        # ── Tier 1: real provenance row.
        row = conn.execute(
            "SELECT * FROM node_provenance "
            "WHERE user_id = ? AND node_id = ? LIMIT 1",
            (current_user, node_id),
        ).fetchone()
        if row is not None:
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

        # ── Tier 2: synthesise from the node row itself.
        node_row = conn.execute(
            "SELECT node_id, node_type, content_json, "
            "       originating_event_idx, created_at "
            "FROM clinical_graph_nodes "
            "WHERE user_id = ? AND node_id = ? LIMIT 1",
            (current_user, node_id),
        ).fetchone()
        if node_row is not None:
            try:
                content = json.loads(node_row["content_json"] or "{}")
            except json.JSONDecodeError:
                content = {}
            # Build a one-line evidence quote from the node payload —
            # prefer obvious user-facing fields (study_uid, body_part,
            # name, label) in priority order; fall back to the dict
            # repr capped at 240 chars so the UI doesn't show MB of
            # JSON.
            evidence_parts = []
            for k in ("label", "name", "study_uid", "modality",
                      "body_part", "summary", "text"):
                v = content.get(k)
                if v:
                    evidence_parts.append(f"{k}={v}")
            evidence = (
                " · ".join(evidence_parts)
                if evidence_parts
                else (json.dumps(content, sort_keys=True)[:240])
            )
            return ProvenanceOut(
                node_id=node_row["node_id"],
                source_kind=node_row["node_type"] or "node",
                source_ref=str(node_row["originating_event_idx"] or node_row["node_id"]),
                source_locator={
                    "kind":           "event_log",
                    "event_idx":      node_row["originating_event_idx"],
                    "node_type":      node_row["node_type"],
                    "content_keys":   sorted(content.keys()),
                },
                evidence_quote=evidence,
                extraction_model="(synthesized)",
                extraction_prompt_id="(synthesized)",
                confidence=1.0,
                redaction_version="0",
                extracted_at=int(node_row["created_at"] or 0),
                extracted_by_user="system:synthesized",
                superseded_by_node=None,
                retracted_at=None,
            )

        # ── Tier 3: node truly doesn't exist.
        raise HTTPException(
            status_code=404,
            detail="no such node",
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


# ─────────────────────────────────────────────────────────────────────
# Layer 2b — Session takeaways (LLM-distilled qualitative insights)
# ─────────────────────────────────────────────────────────────────────

@router.get("/takeaways")
async def list_takeaways(
    scope_kind: Optional[str] = Query(None, description="patient|research|cross_research|other"),
    scope_ref: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    """List the medic's session takeaways. Optionally filter by scope.

    Drives the "Nexus 学到 N 条" panel on each chat surface. Returns
    rows sorted newest-first. Rejected (medic_rejected_at NOT NULL)
    are excluded — they were explicitly removed from the prompt path,
    so the medic doesn't want to see them again either.
    """
    with get_db_connection() as conn:
        conn.row_factory = sqlite3.Row
        _ensure_schema(conn)
        sql = (
            "SELECT id, scope_kind, scope_ref, session_id, text, tag, "
            "       confidence, distilled_at, medic_acked_at "
            "FROM chat_takeaways "
            "WHERE user_id = ? AND medic_rejected_at IS NULL"
        )
        params: list = [current_user]
        if scope_kind:
            sql += " AND scope_kind = ?"
            params.append(scope_kind)
        if scope_ref:
            sql += " AND scope_ref = ?"
            params.append(scope_ref)
        sql += " ORDER BY distilled_at DESC LIMIT ?"
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        return {
            "takeaways": [dict(r) for r in rows],
            "count": len(rows),
        }


@router.post("/takeaways/{takeaway_id}/ack")
async def ack_takeaway(
    takeaway_id: int,
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    """Stamp ``medic_acked_at`` so the UI can dim "new" insights."""
    now = int(time.time())
    with get_db_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "UPDATE chat_takeaways SET medic_acked_at = ? "
            "WHERE user_id = ? AND id = ? "
            "  AND medic_rejected_at IS NULL",
            (now, current_user, takeaway_id),
        )
        conn.commit()
        return {"ok": True, "id": takeaway_id, "acked_at": now}


@router.post("/takeaways/{takeaway_id}/reject")
async def reject_takeaway(
    takeaway_id: int,
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    """Stamp ``medic_rejected_at`` so this insight stops being injected
    into future system prompts. We KEEP the row (audit) but the
    fetch_prior_insights filter drops it."""
    now = int(time.time())
    with get_db_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "UPDATE chat_takeaways SET medic_rejected_at = ? "
            "WHERE user_id = ? AND id = ?",
            (now, current_user, takeaway_id),
        )
        conn.commit()
        return {"ok": True, "id": takeaway_id, "rejected_at": now}


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
