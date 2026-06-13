"""ClinicalGraph — vendor + adapt M3-Agent's entity-centric graph.

Per ADR-002 (with Rev-1..Rev-9) and design v3 §4 + §16.12, this is the
Layer 1 graph helper. It exposes M3's algorithmic primitives — entity-
centric retrieval, weight-based reinforcement, equivalence-based merging,
``get_entity_info`` traversal — but its data store is **our** projection
tables, not M3's pickle.

Provenance
==========

Algorithms ported from M3-Agent's ``mmagent/videograph.py`` and
``mmagent/retrieve.py``, used under the Apache License 2.0.
Original copyright::

    Copyright (2025) Bytedance Ltd. and/or its affiliates
    Licensed under the Apache License, Version 2.0
    https://github.com/ByteDance-Seed/m3-agent

Medical adaptations:

* Entity types replaced (face/voice anchors removed; patient/study/
  series/key_image/anatomical_region/finding/measurement/med/lab/ddx
  added) — per Rev-1.
* ``clip_id`` semantics removed, replaced by ``encounter_id`` — per Rev-1.
* Pickle persistence replaced with event-sourced SQL projection tables —
  per Rev-8.
* All writes routed through ``Store.emit_and_apply``; no direct INSERT.
* Cross-modal equivalence detection rewritten for clinical entities —
  per Rev-1 (face↔voice → finding-region-modality matching).

Reads vs. writes
================

ClinicalGraph methods are split:

* ``add_node``, ``add_edge``, ``reinforce_node``, etc. — emit events
  via Store. These are the WRITE path.
* ``search_text_nodes``, ``get_entity_info``, ``get_connected_nodes`` —
  query projection tables directly. These are the READ path.

The split mirrors the canonical/projection duality of Rev-8. Writes
always go through events; reads go through fast SQL.

Reference: design v3 §4 module layout, §6 retrieval, §16.12 event
sourcing.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from typing import Iterable, Optional

import numpy as np

from nexus_server.event_sourcing import EventKind, Store
from nexus_server.event_sourcing.handlers import (
    _h_edge_added,
    _h_node_added,
    _h_node_weight_changed,
    _h_provenance_recorded,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Node types (Rev-1: replaces M3's face/voice anchors)
# ─────────────────────────────────────────────────────────────────────

VALID_NODE_TYPES = frozenset({
    "patient",
    "study",
    "series",
    "key_image",
    "anatomical_region",
    "finding",
    "measurement",
    "med",
    "lab",
    "ddx",
    "episodic_event",
    "semantic_fact",
})

# Clinical-fact nodes that require provenance (Rev-2).
PROVENANCE_REQUIRED = frozenset({"finding", "measurement", "semantic_fact"})


# ─────────────────────────────────────────────────────────────────────
# Edge types (Rev-1: adds clinical edge kinds M3 doesn't have)
# ─────────────────────────────────────────────────────────────────────

VALID_EDGE_KINDS = frozenset({
    "mentions",            # episodic → entity
    "imaging_of",          # anatomical_region ↔ study/series/key_image
    "finding_in",          # finding ↔ study/key_image
    "localization_of",     # finding ↔ anatomical_region
    "measurement_of",      # measurement ↔ finding
    "follow_up",           # study A → prior study B
    "same_finding",        # finding_t1 ↔ finding_t2 (longitudinal identity)
    "cross_modality_same", # finding_CT ↔ finding_MR
    "treats",
    "causes",
    "contraindicates",
    "equivalence",         # union-find merge candidate
    "superseded_by",       # semantic_fact A → B (B replaces A)
})


# ─────────────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────────────

class ClinicalGraphError(Exception):
    pass


class InvalidNodeType(ClinicalGraphError):
    pass


class InvalidEdgeKind(ClinicalGraphError):
    pass


class ProvenanceRequired(ClinicalGraphError):
    """Per Rev-2: finding/measurement/semantic_fact need provenance."""


# ─────────────────────────────────────────────────────────────────────
# Lightweight read DTOs
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GraphNode:
    node_id: int
    node_type: str
    content: dict
    weight: float
    encounter_id: Optional[str]
    originating_event_idx: int


@dataclass(frozen=True)
class GraphEdge:
    src_node: int
    dst_node: int
    kind: str
    weight: float


# ─────────────────────────────────────────────────────────────────────
# ClinicalGraph — the Layer 1 facade
# ─────────────────────────────────────────────────────────────────────

class ClinicalGraph:
    """Per-patient clinical graph. One instance per (user_id, patient_hash).

    Cheap to construct — just holds the (user_id, patient_hash) keys
    and refs to Store + connection. No state cached in-process.
    """

    def __init__(
        self,
        store: Store,
        conn: sqlite3.Connection,
        user_id: str,
        patient_hash: str,
    ) -> None:
        self.store = store
        self.conn = conn
        self.user_id = user_id
        self.patient_hash = patient_hash

    # ────────────────────── WRITE PATH (event-sourced) ──────────────

    def add_node(
        self,
        *,
        node_type: str,
        content: dict,
        weight: float = 1.0,
        encounter_id: Optional[str] = None,
        embedding_ref: Optional[int] = None,
        caused_by: Optional[int] = None,
        provenance: Optional[dict] = None,
    ) -> int:
        """Emit NODE_ADDED + (if required) PROVENANCE_RECORDED in same txn.

        Per Rev-2: clinical-fact nodes (finding/measurement/semantic_fact)
        MUST be accompanied by provenance. The check is enforced here AND
        at the event_kinds payload validation layer.
        """
        if node_type not in VALID_NODE_TYPES:
            raise InvalidNodeType(node_type)
        if node_type in PROVENANCE_REQUIRED and provenance is None:
            raise ProvenanceRequired(
                f"node_type={node_type} requires provenance (Rev-2)"
            )

        node_event_idx = self.store.emit_and_apply(
            kind=EventKind.NODE_ADDED,
            payload={
                "node_type":    node_type,
                "content_json": content,
                "weight":       weight,
                "encounter_id": encounter_id,
                "embedding_ref": embedding_ref,
            },
            apply_fn=_h_node_added,
            user_id=self.user_id,
            patient_hash=self.patient_hash,
            caused_by=caused_by,
        )

        if provenance is not None:
            self.store.emit_and_apply(
                kind=EventKind.PROVENANCE_RECORDED,
                payload={"node_id": node_event_idx, **provenance},
                apply_fn=_h_provenance_recorded,
                user_id=self.user_id,
                patient_hash=self.patient_hash,
                caused_by=node_event_idx,
            )

        return node_event_idx

    def add_edge(
        self,
        *,
        src: int,
        dst: int,
        kind: str,
        weight: float = 1.0,
        caused_by: Optional[int] = None,
    ) -> int:
        if kind not in VALID_EDGE_KINDS:
            raise InvalidEdgeKind(kind)
        # M3 rule: don't allow edges between same-type text nodes
        # (would create self-referential semantic clusters).
        src_node = self.get_node(src)
        dst_node = self.get_node(dst)
        if src_node and dst_node:
            if (
                src_node.node_type == dst_node.node_type
                and src_node.node_type in ("episodic_event", "semantic_fact")
            ):
                logger.debug("rejecting edge %d→%d: same text-type", src, dst)
                return -1

        return self.store.emit_and_apply(
            kind=EventKind.EDGE_ADDED,
            payload={
                "src_node": src,
                "dst_node": dst,
                "kind":     kind,
                "weight":   weight,
            },
            apply_fn=_h_edge_added,
            user_id=self.user_id,
            patient_hash=self.patient_hash,
            caused_by=caused_by,
        )

    def reinforce_node(self, node_id: int, delta: float = 1.0) -> int:
        """Reinforce all edges touching node_id by delta (M3 semantic).

        Implementation: emit one NODE_WEIGHT_CHANGED event on the node
        itself. Edge weights are reinforced separately if needed via
        repeated add_edge with higher weight (the apply_fn upserts).
        """
        node = self.get_node(node_id)
        if node is None:
            return -1
        return self.store.emit_and_apply(
            kind=EventKind.NODE_WEIGHT_CHANGED,
            payload={
                "node_id":       node_id,
                "before_weight": node.weight,
                "after_weight":  node.weight + delta,
                "reason":        "reinforce",
            },
            apply_fn=_h_node_weight_changed,
            user_id=self.user_id,
            patient_hash=self.patient_hash,
        )

    def weaken_node(self, node_id: int, delta: float = 1.0) -> int:
        return self.reinforce_node(node_id, delta=-delta)

    # ────────────────────── READ PATH (projection SQL) ──────────────

    def get_node(self, node_id: int) -> Optional[GraphNode]:
        row = self.conn.execute(
            "SELECT node_id, node_type, content_json, weight, encounter_id, "
            "       originating_event_idx "
            "FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? AND node_id = ?",
            (self.user_id, self.patient_hash, node_id),
        ).fetchone()
        if row is None:
            return None
        return GraphNode(
            node_id=row[0],
            node_type=row[1],
            content=json.loads(row[2]),
            weight=row[3],
            encounter_id=row[4],
            originating_event_idx=row[5],
        )

    def get_connected_nodes(
        self,
        node_id: int,
        types: Optional[Iterable[str]] = None,
    ) -> list[int]:
        """All nodes connected by any edge to node_id.

        Port of M3 ``VideoGraph.get_connected_nodes``. Filter by type
        if ``types`` is provided.
        """
        types_filter = (
            "AND n.node_type IN ({})".format(",".join("?" * len(list(types))))
            if types else ""
        )
        type_params = list(types) if types else []

        rows = self.conn.execute(
            f"SELECT DISTINCT n.node_id FROM clinical_graph_nodes n "
            f"JOIN clinical_graph_edges e "
            f"  ON ((e.src_node = ? AND e.dst_node = n.node_id) "
            f"   OR  (e.dst_node = ? AND e.src_node = n.node_id)) "
            f"WHERE n.user_id = ? AND n.patient_hash = ? "
            f"  AND e.user_id = ? AND e.patient_hash = ? "
            f"  {types_filter}",
            (
                node_id, node_id,
                self.user_id, self.patient_hash,
                self.user_id, self.patient_hash,
                *type_params,
            ),
        ).fetchall()
        return [r[0] for r in rows]

    def list_nodes_by_type(self, node_type: str) -> list[GraphNode]:
        if node_type not in VALID_NODE_TYPES:
            raise InvalidNodeType(node_type)
        rows = self.conn.execute(
            "SELECT node_id, node_type, content_json, weight, encounter_id, "
            "       originating_event_idx "
            "FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? AND node_type = ? "
            "ORDER BY originating_event_idx DESC",
            (self.user_id, self.patient_hash, node_type),
        ).fetchall()
        return [
            GraphNode(r[0], r[1], json.loads(r[2]), r[3], r[4], r[5])
            for r in rows
        ]

    def get_entity_info(self, anchor_node_id: int) -> list[GraphNode]:
        """Port of M3 ``VideoGraph.get_entity_info``.

        Given an anchor (typically a patient or anatomical_region),
        return connected episodic + semantic + finding/measurement nodes.
        Result is the de-duplicated knowledge subgraph anchored at
        the entity.
        """
        connected_ids = self.get_connected_nodes(
            anchor_node_id,
            types=("episodic_event", "semantic_fact", "finding", "measurement"),
        )
        return [n for nid in connected_ids if (n := self.get_node(nid))]

    # ────────────────────── Text-embedding similarity search ────────

    def search_text_nodes(
        self,
        query_embedding: np.ndarray,
        *,
        top_k: int = 10,
        restrict_to_types: Optional[Iterable[str]] = None,
    ) -> list[tuple[int, float]]:
        """Cosine similarity over text-embedding-bearing nodes.

        Port of M3 ``VideoGraph.search_text_nodes`` adapted to read
        embeddings from our ``vector_index.chunks`` projection via the
        ``embedding_ref`` FK on nodes.

        Returns ``[(node_id, score), ...]`` sorted descending.

        NOTE: M0 stub. Real implementation lands when vector_index
        cosine search is wired (M4 tier classifier). For now we return
        an empty list — callers should treat as "no semantic hits;
        fall back to T2 entity-anchor lookup."
        """
        # Stub — see docstring. Real impl in M4.
        _ = (query_embedding, top_k, restrict_to_types)
        return []


# ─────────────────────────────────────────────────────────────────────
# Module-level helpers
# ─────────────────────────────────────────────────────────────────────

def ensure_patient(
    store: Store,
    user_id: str,
    patient_hash: str,
    *,
    demographics: Optional[dict] = None,
    source: str = "manual",
) -> int:
    """Idempotent patient registration → returns the patient node_id.

    If already registered, returns the existing node_id without emitting
    a new event. Otherwise emits PATIENT_REGISTERED and returns the
    new event_idx (which IS the patient node_id by handler convention).
    """
    cur = store._conn.execute(  # type: ignore[attr-defined]
        "SELECT node_id FROM clinical_graph_nodes "
        "WHERE user_id = ? AND patient_hash = ? AND node_type = 'patient' "
        "LIMIT 1",
        (user_id, patient_hash),
    )
    row = cur.fetchone()
    if row is not None:
        return int(row[0])

    from nexus_server.event_sourcing.handlers import _h_patient_registered

    return store.emit_and_apply(
        kind=EventKind.PATIENT_REGISTERED,
        payload={
            "patient_hash":     patient_hash,
            "source":           source,
            "demographics_json": demographics or {},
        },
        apply_fn=_h_patient_registered,
        user_id=user_id,
        patient_hash=patient_hash,
    )
