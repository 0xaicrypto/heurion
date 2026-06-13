"""ChatIngester — Layer 1 graph derivation from chat events.

Per task #195 / design v3 §5.2, this is the first event-sourcing client
in M0. It validates the emit-event-then-apply pattern end-to-end:

1. Reads a chat encounter (user_message + assistant_response events
   already in twin_event_log).
2. Calls an extractor (an LLM, or in M0 tests, a stub) to produce a
   list of structured clinical entities.
3. For each entity:
   a. Verifies ``evidence_quote`` is a verbatim substring of the chat
      source (Rev-2 hallucination defense). Reject if not.
   b. Emits an INGESTION_STARTED → INGESTION_LLM_RESPONSE →
      NODE_ADDED (+ PROVENANCE_RECORDED for clinical facts) chain
      via ``Store.emit_and_apply_many()``.

Verbatim quote verification
===========================

Per ADR-002 Rev-2, the LLM extractor is contractually required to
quote the source text verbatim — never paraphrase the evidence. We
verify this at write time by substring-matching ``evidence_quote``
against the concatenated source text. Mismatch raises
``QuoteVerificationError`` and the whole ingestion run aborts (no
partial graph state).

This single check closes the LLM-hallucination hole identified as
v2 R3 / v3 R13.

LLM client
==========

M0 supplies a pluggable ``extractor`` callable. The real implementation
calls our LLM gateway with prompt ``chat_extract_clinical_entities_v1``
(stored in meta-layer). Tests inject a deterministic stub for replay
verification.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass, field
from typing import Callable, Optional

from nexus_server.event_sourcing import EventKind, Store
from nexus_server.event_sourcing.handlers import (
    _h_ingestion_completed,
    _h_ingestion_llm_response,
    _h_ingestion_started,
)
from nexus_server.clinical_graph import (
    ClinicalGraph,
    ProvenanceRequired,
    ensure_patient,
)

logger = logging.getLogger(__name__)


# Default model + prompt identifiers; meta-layer pins the actual content.
DEFAULT_EXTRACTION_MODEL = "stub-extractor@0.1"
DEFAULT_EXTRACTION_PROMPT = "chat_extract_clinical_entities_v1"
DEFAULT_INGESTER_VERSION = "chat_ingester@1.0"
DEFAULT_REDACTION_VERSION = "phi-v2"


# ─────────────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────────────

class IngestionError(Exception):
    pass


class QuoteVerificationError(IngestionError):
    """Raised when an evidence_quote isn't a verbatim substring of source.

    Per Rev-2 / R13 mitigation: LLM extractors MUST quote text
    verbatim. Paraphrased quotes are a hallucination signal and abort
    the whole ingestion run (no partial state).
    """


# ─────────────────────────────────────────────────────────────────────
# Extractor output shape
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class StructuredEntity:
    """One extracted clinical entity from a chat encounter.

    The extractor (LLM or stub) is contractually required to:
    - Set ``node_type`` to a value in clinical_graph.VALID_NODE_TYPES
    - Quote ``evidence_quote`` verbatim from the chat source
    - Set ``confidence`` between 0 and 1
    """
    node_type: str
    content: dict
    evidence_quote: str
    confidence: float = 0.8
    encounter_id: Optional[str] = None
    extracted_anatomical_region: Optional[str] = None


@dataclass
class ExtractionResult:
    """What the extractor returns from one chat-encounter pass."""
    raw_llm_output: str
    entities: list[StructuredEntity] = field(default_factory=list)
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: int = 0


# Extractor signature: input is the concatenated chat-source text;
# output is an ExtractionResult.
Extractor = Callable[[str], ExtractionResult]


# ─────────────────────────────────────────────────────────────────────
# ChatIngester
# ─────────────────────────────────────────────────────────────────────

class ChatIngester:
    """Stateless service. Construct once per request; cheap to make."""

    def __init__(
        self,
        store: Store,
        conn: sqlite3.Connection,
        extractor: Extractor,
        *,
        ingester_version: str = DEFAULT_INGESTER_VERSION,
        extraction_model: str = DEFAULT_EXTRACTION_MODEL,
        extraction_prompt_id: str = DEFAULT_EXTRACTION_PROMPT,
        redaction_version: str = DEFAULT_REDACTION_VERSION,
    ) -> None:
        self.store = store
        self.conn = conn
        self.extractor = extractor
        self.ingester_version = ingester_version
        self.extraction_model = extraction_model
        self.extraction_prompt_id = extraction_prompt_id
        self.redaction_version = redaction_version

    # ────────────────────── Public API ──────────────────────────────

    def ingest_encounter(
        self,
        *,
        user_id: str,
        patient_hash: str,
        encounter_id: str,
        source_event_idx: int,
    ) -> list[int]:
        """Run one ingestion pass over a chat encounter.

        Args:
            user_id: medic owning the chat.
            patient_hash: PHI-safe patient ref.
            encounter_id: typically the chat session id; used as
                          ``encounter_id`` on emitted nodes.
            source_event_idx: the event_idx that triggered ingestion
                              (the assistant_response that the medic
                              wants the agent to remember).

        Returns:
            The list of NODE_ADDED event_idxs created (which double
            as the graph node_ids per the handler convention).

        Raises:
            QuoteVerificationError: extractor produced an evidence_quote
                that isn't a verbatim substring of the source text.
        """
        # 1. Pull the source text from the canonical event_log.
        source_text = self._concat_source_text(
            user_id=user_id, encounter_id=encounter_id
        )
        if not source_text:
            logger.warning(
                "ingest_encounter: no source text for user=%s encounter=%s",
                user_id, encounter_id,
            )
            return []

        # 2. Ensure patient node exists (idempotent).
        patient_node_id = ensure_patient(
            self.store, user_id, patient_hash, source="chat",
        )

        # 3. Mark ingestion started.
        started_idx = self.store.emit_and_apply(
            kind=EventKind.INGESTION_STARTED,
            payload={
                "kind":              "chat",
                "target_ref":        encounter_id,
                "ingester_version":  self.ingester_version,
            },
            apply_fn=_h_ingestion_started,
            user_id=user_id,
            patient_hash=patient_hash,
            caused_by=source_event_idx,
        )

        # 4. Run extractor + ARCHIVE raw output before deriving anything.
        result = self.extractor(source_text)
        self.store.emit_and_apply(
            kind=EventKind.INGESTION_LLM_RESPONSE,
            payload={
                "raw_output_text": result.raw_llm_output,
                "model":           self.extraction_model,
                "prompt_id":       self.extraction_prompt_id,
                "prompt_version":  "1.0",
                "tokens_in":       result.tokens_in,
                "tokens_out":      result.tokens_out,
                "latency_ms":      result.latency_ms,
            },
            apply_fn=_h_ingestion_llm_response,
            user_id=user_id,
            patient_hash=patient_hash,
            caused_by=started_idx,
        )

        # 5. Verify every entity's evidence_quote is verbatim.
        #    Per Rev-2: reject the entire run on any mismatch.
        for entity in result.entities:
            if entity.evidence_quote not in source_text:
                raise QuoteVerificationError(
                    f"entity evidence_quote not found verbatim in source: "
                    f"node_type={entity.node_type!r} "
                    f"quote={entity.evidence_quote[:80]!r}"
                )

        # 6. Emit each entity as NODE_ADDED + (clinical-fact) PROVENANCE.
        graph = ClinicalGraph(self.store, self.conn, user_id, patient_hash)
        import time
        now = int(time.time())
        emitted_node_ids: list[int] = []
        for entity in result.entities:
            provenance = self._build_provenance(
                user_id=user_id,
                source_ref=encounter_id,
                source_event_idx=source_event_idx,
                entity=entity,
                extracted_at=now,
            )
            try:
                node_id = graph.add_node(
                    node_type=entity.node_type,
                    content=entity.content,
                    encounter_id=encounter_id or entity.encounter_id,
                    caused_by=started_idx,
                    provenance=(provenance if entity.node_type in
                                ("finding", "measurement", "semantic_fact")
                                else None),
                )
            except ProvenanceRequired:
                # Shouldn't fire — we passed provenance for clinical
                # facts. Re-raise for visibility.
                raise
            emitted_node_ids.append(node_id)

            # Link to patient anchor.
            graph.add_edge(
                src=patient_node_id, dst=node_id,
                kind="mentions", caused_by=started_idx,
            )

        # 7. Complete.
        self.store.emit_and_apply(
            kind=EventKind.INGESTION_COMPLETED,
            payload={
                "kind":               "chat",
                "target_ref":         encounter_id,
                "emitted_node_count": len(emitted_node_ids),
                "errors":             [],
            },
            apply_fn=_h_ingestion_completed,
            user_id=user_id,
            patient_hash=patient_hash,
            caused_by=started_idx,
        )

        logger.info(
            "chat_ingester: user=%s patient=%s encounter=%s emitted=%d",
            user_id, patient_hash, encounter_id, len(emitted_node_ids),
        )
        return emitted_node_ids

    # ────────────────────── Private ─────────────────────────────────

    def _concat_source_text(
        self, *, user_id: str, encounter_id: str,
    ) -> str:
        """Pull user_message + assistant_response payloads for this
        encounter and concatenate. The result is what evidence_quote
        substring checks against."""
        # M0: session_id is in user_message payload. We match on
        # encounter_id appearing in either payload.session_id OR
        # patient_hash-of-the-event. Simple substring scan.
        rows = self.conn.execute(
            "SELECT event_kind, payload_json FROM twin_event_log "
            "WHERE user_id = ? "
            "  AND event_kind IN ('user_message', 'assistant_response') "
            "  AND payload_json LIKE ? "
            "ORDER BY event_idx ASC",
            (user_id, f"%{encounter_id}%"),
        ).fetchall()

        parts: list[str] = []
        for kind, payload_json in rows:
            try:
                p = json.loads(payload_json)
            except json.JSONDecodeError:
                continue
            text = p.get("text", "")
            if text:
                parts.append(text)
        return "\n".join(parts)

    def _build_provenance(
        self,
        *,
        user_id: str,
        source_ref: str,
        source_event_idx: int,
        entity: StructuredEntity,
        extracted_at: int,
    ) -> dict:
        return {
            "source_kind":          "chat",
            "source_ref":           source_ref,
            "source_locator_json":  {"event_idx": source_event_idx},
            "evidence_quote":       entity.evidence_quote,
            "extracted_by_user":    user_id,
            "extracted_at":         extracted_at,
            "extraction_model":     self.extraction_model,
            "extraction_prompt_id": self.extraction_prompt_id,
            "confidence":           entity.confidence,
            "redaction_version":    self.redaction_version,
        }


# ─────────────────────────────────────────────────────────────────────
# A simple deterministic extractor used by tests and M0 smoke-runs.
# Real extractor lives in nexus_server/llm/extractors/chat_v1.py (TBD).
# ─────────────────────────────────────────────────────────────────────

def make_stub_extractor(
    entities: list[StructuredEntity],
    *,
    raw_output: str = "",
) -> Extractor:
    """Return an Extractor that emits a fixed list of entities.

    Useful for tests + deterministic replay verification. The
    ``raw_output`` field is stored verbatim in INGESTION_LLM_RESPONSE
    so replay reads identical archived output regardless of LLM
    non-determinism.
    """
    def _extract(source_text: str) -> ExtractionResult:
        return ExtractionResult(
            raw_llm_output=raw_output or json.dumps(
                [{"node_type": e.node_type, "evidence_quote": e.evidence_quote}
                 for e in entities],
                ensure_ascii=False,
            ),
            entities=list(entities),
            tokens_in=len(source_text) // 4,
            tokens_out=len(raw_output) // 4 if raw_output else 0,
            latency_ms=1,
        )
    return _extract
