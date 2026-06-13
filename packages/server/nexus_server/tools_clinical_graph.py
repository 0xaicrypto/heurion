"""Agent tools that expose the ClinicalGraph to the LLM.

Per design v3 §6.6 / §7.2 (and Rev-1), this module registers:

* ``search_node`` — entity-anchored retrieval (find a specific entity
  + its connected facts). Used at Tier 2 single-shot retrieval.
* ``search_encounter`` — encounter-anchored retrieval (find studies /
  chat sessions / lab postings relevant to the query). Used at Tier 3
  multi-turn retrieval.

These complement ``SearchPastChatsTool`` (existing FTS path in
``tools_memory.py``) which stays for keyword lookups.

M0 status
=========

* Both tools are wired to read from the projection tables
  (clinical_graph_nodes, clinical_graph_edges).
* Visual embedding search and multimodal context attachment are
  Rev-9 / M1.5+ work and are NOT included here.
* Compare-studies + cross-modality tools land in M2.

Privacy
=======

* Tools close over ``user_id`` server-side. The LLM cannot pivot to
  another user's graph by passing a different user_id — the parameter
  isn't on the tool's input schema.
* Patient hash is required on every call; passing ``patient_hash``
  the user doesn't own returns an empty result rather than leaking.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any, Callable, Optional

from nexus_core.tools.base import BaseTool, ToolResult

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# search_node — entity-anchored lookup
# ─────────────────────────────────────────────────────────────────────

class SearchNodeTool(BaseTool):
    """Find clinical entities (patients, findings, meds, labs) and
    their connected facts. Use when the question is entity-centric:
    'What did we conclude about the left renal mass?',
    'List all meds the patient is on.'
    """

    def __init__(
        self,
        user_id: str,
        conn_factory: Callable[[], sqlite3.Connection],
    ) -> None:
        self._user_id = user_id
        self._conn_factory = conn_factory

    @property
    def name(self) -> str:
        return "search_node"

    @property
    def description(self) -> str:
        return (
            "Find a clinical entity and its connected facts on a specific "
            "patient. Entity types: patient, study, finding, measurement, "
            "med, lab, ddx, anatomical_region. Returns the matching nodes "
            "with their content plus directly connected episodic and "
            "semantic facts. Use when the question is entity-centric "
            "(e.g. 'what's the status of the left renal mass') rather "
            "than time-based or summary-style."
        )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "patient_hash": {
                    "type": "string",
                    "description": "PHI-safe patient hash to search within.",
                },
                "query": {
                    "type": "string",
                    "description": "Free-text query — substring matched "
                                   "against node content. (Embedding-based "
                                   "search arrives in M4.)",
                },
                "entity_type": {
                    "type": "string",
                    "description": "Optional filter on node_type.",
                    "enum": [
                        "patient", "study", "series", "key_image",
                        "anatomical_region", "finding", "measurement",
                        "med", "lab", "ddx", "episodic_event",
                        "semantic_fact",
                    ],
                },
                "top_k": {
                    "type": "integer",
                    "description": "Max nodes to return (default 8).",
                    "default": 8,
                },
            },
            "required": ["patient_hash", "query"],
        }

    async def execute(self, **kwargs: Any) -> ToolResult:
        patient_hash: str = kwargs["patient_hash"]
        query: str = kwargs["query"]
        entity_type: Optional[str] = kwargs.get("entity_type")
        top_k: int = int(kwargs.get("top_k", 8))

        conn = self._conn_factory()
        try:
            return _execute_search_node(
                conn=conn,
                user_id=self._user_id,
                patient_hash=patient_hash,
                query=query,
                entity_type=entity_type,
                top_k=top_k,
            )
        finally:
            conn.close()


def _execute_search_node(
    *,
    conn: sqlite3.Connection,
    user_id: str,
    patient_hash: str,
    query: str,
    entity_type: Optional[str],
    top_k: int,
) -> ToolResult:
    # Defensive: never leak across users (privacy invariant).
    where = ["user_id = ?", "patient_hash = ?"]
    params: list[Any] = [user_id, patient_hash]

    if entity_type:
        where.append("node_type = ?")
        params.append(entity_type)

    # M0 substring search over content_json. Embedding cosine in M4.
    if query.strip():
        where.append("content_json LIKE ?")
        params.append(f"%{query.strip()}%")

    rows = conn.execute(
        f"SELECT node_id, node_type, content_json, weight "
        f"FROM clinical_graph_nodes "
        f"WHERE {' AND '.join(where)} "
        f"ORDER BY weight DESC, node_id DESC LIMIT ?",
        (*params, top_k),
    ).fetchall()

    if not rows:
        return ToolResult(success=True, output="No matching entities.")

    hits = []
    for node_id, node_type, content_json, weight in rows:
        # For each hit, also fetch directly connected episodic/semantic facts.
        connected = conn.execute(
            "SELECT n.node_id, n.node_type, n.content_json "
            "FROM clinical_graph_nodes n "
            "JOIN clinical_graph_edges e "
            "  ON ((e.src_node = ? AND e.dst_node = n.node_id) "
            "   OR (e.dst_node = ? AND e.src_node = n.node_id)) "
            "WHERE n.user_id = ? AND n.patient_hash = ? "
            "  AND e.user_id = ? AND e.patient_hash = ? "
            "  AND n.node_type IN ('episodic_event', 'semantic_fact', "
            "                       'measurement') "
            "ORDER BY n.weight DESC LIMIT 5",
            (node_id, node_id, user_id, patient_hash, user_id, patient_hash),
        ).fetchall()

        hits.append({
            "node_id":   node_id,
            "node_type": node_type,
            "weight":    weight,
            "content":   json.loads(content_json),
            "connected": [
                {
                    "node_id":   cid,
                    "node_type": ctype,
                    "content":   json.loads(ccontent),
                }
                for (cid, ctype, ccontent) in connected
            ],
        })

    return ToolResult(
        success=True,
        output=json.dumps({"hits": hits}, ensure_ascii=False, indent=2),
    )


# ─────────────────────────────────────────────────────────────────────
# search_encounter — encounter-anchored lookup
# ─────────────────────────────────────────────────────────────────────

class SearchEncounterTool(BaseTool):
    """Find encounters (studies, chat sessions, lab postings) relevant
    to the query. Use when the question is temporal / structural:
    'When did we first see the lesion?',
    'What changed between the two MRIs?'.
    """

    def __init__(
        self,
        user_id: str,
        conn_factory: Callable[[], sqlite3.Connection],
    ) -> None:
        self._user_id = user_id
        self._conn_factory = conn_factory

    @property
    def name(self) -> str:
        return "search_encounter"

    @property
    def description(self) -> str:
        return (
            "Find encounters (studies, chat sessions, lab postings) for "
            "a patient. Use for temporal or summary queries — 'when did "
            "we last see the lesion', 'what changed between the two MRIs'. "
            "Returns encounters with their type, date, and a brief content "
            "summary."
        )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "patient_hash": {"type": "string"},
                "query": {
                    "type": "string",
                    "description": "Free-text query against encounter content.",
                },
                "before_date": {
                    "type": "string",
                    "description": "Optional ISO date upper bound.",
                },
                "top_k": {
                    "type": "integer",
                    "default": 8,
                },
            },
            "required": ["patient_hash", "query"],
        }

    async def execute(self, **kwargs: Any) -> ToolResult:
        patient_hash: str = kwargs["patient_hash"]
        query: str = kwargs["query"]
        top_k: int = int(kwargs.get("top_k", 8))

        conn = self._conn_factory()
        try:
            return _execute_search_encounter(
                conn=conn,
                user_id=self._user_id,
                patient_hash=patient_hash,
                query=query,
                top_k=top_k,
            )
        finally:
            conn.close()


def _execute_search_encounter(
    *,
    conn: sqlite3.Connection,
    user_id: str,
    patient_hash: str,
    query: str,
    top_k: int,
) -> ToolResult:
    # An encounter is identified by the encounter_id column on graph nodes.
    # Group nodes by encounter_id and summarise.
    rows = conn.execute(
        "SELECT encounter_id, "
        "       COUNT(*) AS node_count, "
        "       MAX(updated_at) AS last_touched "
        "FROM clinical_graph_nodes "
        "WHERE user_id = ? AND patient_hash = ? "
        "  AND encounter_id IS NOT NULL "
        "  AND (? = '' OR content_json LIKE ?) "
        "GROUP BY encounter_id "
        "ORDER BY last_touched DESC LIMIT ?",
        (user_id, patient_hash, query.strip(), f"%{query.strip()}%", top_k),
    ).fetchall()

    if not rows:
        return ToolResult(success=True, output="No matching encounters.")

    encounters = []
    for encounter_id, node_count, last_touched in rows:
        # Show a small sample of nodes from this encounter.
        sample = conn.execute(
            "SELECT node_type, content_json FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? AND encounter_id = ? "
            "ORDER BY weight DESC LIMIT 5",
            (user_id, patient_hash, encounter_id),
        ).fetchall()

        encounters.append({
            "encounter_id": encounter_id,
            "node_count":   node_count,
            "last_touched": last_touched,
            "sample":       [
                {"node_type": t, "content": json.loads(c)}
                for (t, c) in sample
            ],
        })

    return ToolResult(
        success=True,
        output=json.dumps(
            {"encounters": encounters}, ensure_ascii=False, indent=2,
        ),
    )


# ─────────────────────────────────────────────────────────────────────
# Registration helper
# ─────────────────────────────────────────────────────────────────────

def register_clinical_graph_tools(
    twin,
    user_id: str,
    conn_factory: Callable[[], sqlite3.Connection],
) -> None:
    """Register both tools on a twin's tool registry.

    Mirrors the pattern of ``tools_memory.register_memory_tools``.
    Feature-flag-gated by caller (``memory.use_graph``); off by default
    until M5 cutover per task #195.
    """
    twin.tools.register(SearchNodeTool(user_id, conn_factory))
    twin.tools.register(SearchEncounterTool(user_id, conn_factory))
    logger.info(
        "registered ClinicalGraph tools (search_node, search_encounter) "
        "for user=%s", user_id,
    )
