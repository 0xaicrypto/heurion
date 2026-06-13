"""ChatIngester end-to-end test.

Verifies the first real event-sourcing client:
- Emit-event-then-apply chain produces correct projection state.
- Verbatim-quote verification rejects hallucinated quotes.
- A drop_projections + replay roundtrip rebuilds the same state.
"""

from __future__ import annotations

import json
import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest

from nexus_server.event_sourcing import EventKind, Store, init_event_sourcing_schema
from nexus_server.event_sourcing.handlers import (
    _h_assistant_response, _h_user_message,
)
from nexus_server.event_sourcing.replay import full_rebuild
from nexus_server.event_sourcing.schema import PROJECTION_TABLES
from nexus_server.memorization import (
    ChatIngester,
    QuoteVerificationError,
    StructuredEntity,
)
from nexus_server.memorization.chat_ingester import make_stub_extractor


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    init_event_sourcing_schema(c)
    return c


@pytest.fixture
def store(conn: sqlite3.Connection) -> Store:
    return Store(conn)


def _seed_chat_encounter(
    store: Store,
    user_id: str,
    patient_hash: str,
    session_id: str,
    user_text: str,
    assistant_text: str,
) -> int:
    """Helper: drop a chat turn into event_log so the ingester has source.
    Returns the assistant_response event_idx."""
    store.emit_and_apply(
        kind=EventKind.USER_MESSAGE,
        payload={"text": user_text, "session_id": session_id},
        apply_fn=_h_user_message,
        user_id=user_id, patient_hash=patient_hash,
    )
    return store.emit_and_apply(
        kind=EventKind.ASSISTANT_RESPONSE,
        payload={
            "text": assistant_text, "session_id": session_id,
            "model": "claude-haiku-4-5",
            "prompt_id": "main_chat", "prompt_version": "1.0",
        },
        apply_fn=_h_assistant_response,
        user_id=user_id, patient_hash=patient_hash,
    )


# ─────────────────────────────────────────────────────────────────────
# Happy path
# ─────────────────────────────────────────────────────────────────────

class TestIngestEncounter:
    def test_emits_full_chain_and_writes_projections(self, store, conn):
        user_id = "dr_chen"
        patient_hash = "7a3f_test"
        session_id = "sess-001"

        # Seed chat — quote must exist VERBATIM in this text:
        assistant_text = (
            "The left renal mass measures 2.4 cm on today's CT, "
            "stable from the prior study 4 months ago."
        )
        resp_idx = _seed_chat_encounter(
            store, user_id, patient_hash, session_id,
            user_text="how's the renal mass?",
            assistant_text=assistant_text,
        )

        # Extractor returns one finding citing verbatim text.
        finding = StructuredEntity(
            node_type="finding",
            content={"label": "left renal mass", "size_cm": 2.4},
            evidence_quote="The left renal mass measures 2.4 cm on today's CT",
            confidence=0.92,
        )
        ingester = ChatIngester(
            store=store, conn=conn,
            extractor=make_stub_extractor([finding]),
        )

        node_ids = ingester.ingest_encounter(
            user_id=user_id,
            patient_hash=patient_hash,
            encounter_id=session_id,
            source_event_idx=resp_idx,
        )

        assert len(node_ids) == 1

        # Verify projection state
        rows = conn.execute(
            "SELECT node_type, content_json FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? ORDER BY node_id",
            (user_id, patient_hash),
        ).fetchall()
        # Expect: patient node + finding node
        types = [r[0] for r in rows]
        assert "patient" in types
        assert "finding" in types

        # Verify provenance was written
        prov_row = conn.execute(
            "SELECT evidence_quote, extraction_model FROM node_provenance "
            "WHERE user_id = ? AND patient_hash = ? LIMIT 1",
            (user_id, patient_hash),
        ).fetchone()
        assert prov_row is not None
        assert "left renal mass measures 2.4 cm" in prov_row[0]

        # Verify edge was created: patient → finding
        edge_count = conn.execute(
            "SELECT COUNT(*) FROM clinical_graph_edges "
            "WHERE user_id = ? AND patient_hash = ? AND kind = 'mentions'",
            (user_id, patient_hash),
        ).fetchone()[0]
        assert edge_count >= 1

    def test_emits_archival_chain_in_event_log(self, store, conn):
        user_id = "dr_test"
        patient_hash = "p_chain"
        resp_idx = _seed_chat_encounter(
            store, user_id, patient_hash, "sess-x",
            user_text="check this",
            assistant_text="No abnormal findings on the latest film.",
        )

        finding = StructuredEntity(
            node_type="finding",
            content={"label": "no abnormal findings", "presence": False},
            evidence_quote="No abnormal findings on the latest film",
        )
        ingester = ChatIngester(
            store=store, conn=conn,
            extractor=make_stub_extractor([finding]),
        )
        ingester.ingest_encounter(
            user_id=user_id, patient_hash=patient_hash,
            encounter_id="sess-x", source_event_idx=resp_idx,
        )

        kinds = [
            r[0] for r in conn.execute(
                "SELECT event_kind FROM twin_event_log "
                "WHERE user_id = ? ORDER BY event_idx", (user_id,)
            ).fetchall()
        ]
        # Expect, in order: user_message, assistant_response, patient_registered,
        # ingestion_started, ingestion_llm_response, node_added, provenance_recorded,
        # edge_added, ingestion_completed.
        assert kinds[0] == "user_message"
        assert kinds[1] == "assistant_response"
        assert "ingestion_started" in kinds
        assert "ingestion_llm_response" in kinds
        assert "node_added" in kinds
        assert "provenance_recorded" in kinds
        assert "ingestion_completed" in kinds
        # ingestion_completed must come AFTER all node_added events
        last_node_added = max(i for i, k in enumerate(kinds) if k == "node_added")
        ingestion_completed_pos = kinds.index("ingestion_completed")
        assert ingestion_completed_pos > last_node_added


# ─────────────────────────────────────────────────────────────────────
# Quote verification — Rev-2 hallucination defense
# ─────────────────────────────────────────────────────────────────────

class TestQuoteVerification:
    def test_paraphrased_quote_rejected(self, store, conn):
        user_id = "dr_test"
        patient_hash = "p_quote"
        resp_idx = _seed_chat_encounter(
            store, user_id, patient_hash, "sess-q1",
            user_text="?",
            assistant_text="The left renal mass is stable.",
        )

        bad = StructuredEntity(
            node_type="finding",
            content={"label": "renal mass"},
            # This is a paraphrase, not verbatim. Must be rejected.
            evidence_quote="The left kidney mass is unchanged.",
        )
        ingester = ChatIngester(
            store=store, conn=conn,
            extractor=make_stub_extractor([bad]),
        )
        with pytest.raises(QuoteVerificationError, match="not found verbatim"):
            ingester.ingest_encounter(
                user_id=user_id, patient_hash=patient_hash,
                encounter_id="sess-q1", source_event_idx=resp_idx,
            )

    def test_quote_failure_does_not_leave_partial_state(self, store, conn):
        """If quote verification fails mid-batch, no node should be in the
        projection — the failure aborts before any clinical-fact emission.
        (The patient_registered + ingestion_started + ingestion_llm_response
        events DO commit; that's correct — they're not clinical facts and
        replay produces the same partial chain.)"""
        user_id = "dr_test"
        patient_hash = "p_partial"
        resp_idx = _seed_chat_encounter(
            store, user_id, patient_hash, "sess-p",
            user_text="?",
            assistant_text="Mass is 2.4 cm.",
        )

        ingester = ChatIngester(
            store=store, conn=conn,
            extractor=make_stub_extractor([
                StructuredEntity(
                    node_type="finding",
                    content={"label": "mass"},
                    evidence_quote="Mass is 2.4 cm",  # OK
                ),
                StructuredEntity(
                    node_type="finding",
                    content={"label": "ghost"},
                    # Hallucinated — not in source
                    evidence_quote="There is also a 1cm lesion in the spleen.",
                ),
            ]),
        )
        with pytest.raises(QuoteVerificationError):
            ingester.ingest_encounter(
                user_id=user_id, patient_hash=patient_hash,
                encounter_id="sess-p", source_event_idx=resp_idx,
            )

        # No finding node should have been written.
        finding_count = conn.execute(
            "SELECT COUNT(*) FROM clinical_graph_nodes "
            "WHERE user_id = ? AND patient_hash = ? AND node_type = 'finding'",
            (user_id, patient_hash),
        ).fetchone()[0]
        assert finding_count == 0


# ─────────────────────────────────────────────────────────────────────
# Replay roundtrip — Contract B for chat_ingester
# ─────────────────────────────────────────────────────────────────────

class TestReplayRoundtrip:
    def test_drop_projections_replay_rebuilds_chat_state(self, store, conn):
        user_id = "dr_replay"
        patient_hash = "p_rb"
        resp_idx = _seed_chat_encounter(
            store, user_id, patient_hash, "sess-rb",
            user_text="any changes?",
            assistant_text=(
                "Mild progression: lesion grew from 2.1 to 2.4 cm. "
                "Recommend MR follow-up."
            ),
        )

        entities = [
            StructuredEntity(
                node_type="finding",
                content={"label": "lesion", "size_cm": 2.4, "delta_cm": 0.3},
                evidence_quote="lesion grew from 2.1 to 2.4 cm",
            ),
            StructuredEntity(
                node_type="ddx",
                content={"diagnosis": "RCC", "leading": True},
                evidence_quote="Recommend MR follow-up",
            ),
        ]
        ingester = ChatIngester(
            store=store, conn=conn,
            extractor=make_stub_extractor(entities),
        )
        # ddx isn't in the "provenance required" set so no provenance attached.
        # finding IS in the set so the helper builds provenance for it.
        # But add_node only attaches provenance for finding/measurement/semantic_fact;
        # ddx → no provenance, ingester logic handles correctly.
        emitted = ingester.ingest_encounter(
            user_id=user_id, patient_hash=patient_hash,
            encounter_id="sess-rb", source_event_idx=resp_idx,
        )
        assert len(emitted) == 2

        # Snapshot every projection table
        before = {
            t: conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2, 3").fetchall()
            for t in PROJECTION_TABLES
        }

        # Full rebuild — drop projections, replay event_log
        full_rebuild(conn)

        after = {
            t: conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2, 3").fetchall()
            for t in PROJECTION_TABLES
        }

        for table in PROJECTION_TABLES:
            assert before[table] == after[table], (
                f"projection {table} diverged after replay; "
                f"ChatIngester broke Contract B"
            )
