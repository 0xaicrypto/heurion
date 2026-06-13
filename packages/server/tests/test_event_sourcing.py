"""Golden replay test — the load-bearing CI gate for ADR-002 Rev-8.

This test enforces Contract B: every projection table is rebuildable
byte-identical from twin_event_log by replay alone. If a code path
mutates a projection without going through Store.emit_and_apply, the
golden replay roundtrip will diverge and this test fails.

Per task #195, this test is the hard gate on M0 readiness. A red run
here means event sourcing is broken and we are not ready to ship.

Run::

    pytest packages/server/tests/test_event_sourcing.py -v

How it works
------------

1. Open a fresh in-memory SQLite, init schema, build a Store.
2. Emit a representative mix of events covering every event kind
   (chat, ingestion, graph mutations, Layer 2, etc).
3. Snapshot the projection state.
4. Drop all projection tables, replay event_log from idx 0.
5. Compare rebuilt projections deep-equal against the snapshot.
6. Repeat the comparison for incremental replay (drop only some
   projections, replay from a checkpoint).
"""

from __future__ import annotations

import json
import sqlite3
import sys
import pathlib

# Allow running from repo root with `pytest packages/server/...`
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest

from nexus_server.event_sourcing import (
    EventKind,
    Store,
    init_event_sourcing_schema,
    replay,
)
from nexus_server.event_sourcing.event_kinds import (
    EVENT_REGISTRY,
    current_version,
    validate_payload,
)
from nexus_server.event_sourcing.replay import (
    REPLAY_HANDLERS,
    full_rebuild,
    verify_handler_coverage,
)
from nexus_server.event_sourcing.schema import (
    PROJECTION_TABLES,
    drop_projections,
)
from nexus_server.event_sourcing.handlers import (
    _h_node_added,
    _h_edge_added,
    _h_provenance_recorded,
    _h_patient_registered,
    _h_practitioner_observation_emitted,
    _h_user_message,
    _h_assistant_response,
)


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def fresh_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    init_event_sourcing_schema(conn)
    return conn


@pytest.fixture
def store(fresh_db: sqlite3.Connection) -> Store:
    return Store(fresh_db)


# ─────────────────────────────────────────────────────────────────────
# Coverage tests — every event kind in the registry has a handler.
# This is Rev-8 R23 mitigation enforcement.
# ─────────────────────────────────────────────────────────────────────

class TestRegistryCoverage:
    def test_every_event_kind_has_handler(self):
        """R23 mitigation: replay refuses silent skips for unknown events.

        Every (kind, version) registered in EVENT_REGISTRY must have a
        handler in REPLAY_HANDLERS. Adding an event kind without its
        handler is a hard build failure (this test).
        """
        missing = verify_handler_coverage()
        assert not missing, (
            f"event registry has {len(missing)} entries without a replay handler: "
            f"{missing}. Add handlers to nexus_server.event_sourcing.handlers and "
            f"register them via register_handler()."
        )

    def test_handler_registry_not_empty(self):
        """At least the ~50 v3 event kinds should be registered."""
        assert len(REPLAY_HANDLERS) >= 50, (
            f"only {len(REPLAY_HANDLERS)} handlers registered; expected ≥ 50 "
            f"per v3 §16.12.2 taxonomy"
        )

    def test_registry_matches_handlers_one_to_one(self):
        """No orphan handlers (handler exists for kind that isn't registered)."""
        orphans = set(REPLAY_HANDLERS) - set(EVENT_REGISTRY)
        assert not orphans, (
            f"replay handlers registered for unknown event kinds: {orphans}. "
            f"Either register them in event_kinds.EVENT_REGISTRY or remove "
            f"the handler."
        )


# ─────────────────────────────────────────────────────────────────────
# Validation tests
# ─────────────────────────────────────────────────────────────────────

class TestValidation:
    def test_missing_required_field_rejected(self):
        from nexus_server.event_sourcing.event_kinds import EventValidationError
        with pytest.raises(EventValidationError, match="missing required"):
            validate_payload(
                EventKind.NODE_ADDED, "1.0",
                {"content_json": {}},  # missing 'node_type'
                patient_hash="abc",
            )

    def test_patient_scoped_requires_patient_hash(self):
        from nexus_server.event_sourcing.event_kinds import EventValidationError
        with pytest.raises(EventValidationError, match="patient-scoped"):
            validate_payload(
                EventKind.NODE_ADDED, "1.0",
                {"node_type": "finding", "content_json": {}},
                patient_hash=None,
            )

    def test_unknown_kind_version_rejected(self):
        from nexus_server.event_sourcing.event_kinds import EventValidationError
        with pytest.raises(EventValidationError, match="unknown event"):
            validate_payload(
                EventKind.NODE_ADDED, "99.0",  # bad version
                {"node_type": "x", "content_json": {}},
                patient_hash="abc",
            )


# ─────────────────────────────────────────────────────────────────────
# Privacy invariant tests
# ─────────────────────────────────────────────────────────────────────

class TestPrivacyInvariants:
    def test_layer2_rejects_patient_hash_in_pattern(self, store):
        from nexus_server.event_sourcing.store import PrivacyInvariantViolation

        # 32+ hex char value should trip the hash detector.
        with pytest.raises(PrivacyInvariantViolation, match="patient_hash"):
            store.emit_and_apply(
                kind=EventKind.PRACTITIONER_CANDIDATE_SURFACED,
                payload={
                    "fact_kind": "practice",
                    "pattern_key": "test/key",
                    "distinct_count": 5,
                    "confidence": 0.9,
                    "pattern_value_json": {
                        "leaked_hash": "a" * 64,  # looks like a patient_hash
                    },
                },
                apply_fn=lambda c, e: None,
                user_id="dr_test",
            )

    def test_layer2_rejects_iso_date_in_pattern(self, store):
        from nexus_server.event_sourcing.store import PrivacyInvariantViolation
        with pytest.raises(PrivacyInvariantViolation, match="ISO date"):
            store.emit_and_apply(
                kind=EventKind.PRACTITIONER_FACT_CONFIRMED,
                payload={
                    "fact_kind": "practice",
                    "pattern_key": "test/key",
                    "by_user": "dr_test",
                    "pattern_value_json": {
                        "encounter_on": "2026-04-12",  # specific date
                    },
                },
                apply_fn=lambda c, e: None,
                user_id="dr_test",
            )


# ─────────────────────────────────────────────────────────────────────
# Store basic operation
# ─────────────────────────────────────────────────────────────────────

class TestStoreBasics:
    def test_emit_and_apply_returns_monotonic_idx(self, store, fresh_db):
        idx1 = store.emit_and_apply(
            kind=EventKind.PATIENT_REGISTERED,
            payload={"patient_hash": "h1", "source": "manual"},
            apply_fn=_h_patient_registered,
            user_id="dr_test",
            patient_hash="h1",
        )
        idx2 = store.emit_and_apply(
            kind=EventKind.PATIENT_REGISTERED,
            payload={"patient_hash": "h2", "source": "manual"},
            apply_fn=_h_patient_registered,
            user_id="dr_test",
            patient_hash="h2",
        )
        assert idx2 > idx1

    def test_event_appears_in_log(self, store):
        idx = store.emit_and_apply(
            kind=EventKind.PATIENT_REGISTERED,
            payload={"patient_hash": "h1", "source": "manual"},
            apply_fn=_h_patient_registered,
            user_id="dr_test",
            patient_hash="h1",
        )
        event = store.read_event(idx)
        assert event is not None
        assert event["event_kind"] == "patient_registered"
        assert event["payload"]["patient_hash"] == "h1"

    def test_apply_projection_writes_atomically(self, store, fresh_db):
        store.emit_and_apply(
            kind=EventKind.PATIENT_REGISTERED,
            payload={"patient_hash": "h1", "source": "manual"},
            apply_fn=_h_patient_registered,
            user_id="dr_test",
            patient_hash="h1",
        )
        row = fresh_db.execute(
            "SELECT user_id, patient_hash, node_type FROM clinical_graph_nodes"
        ).fetchone()
        assert row == ("dr_test", "h1", "patient")

    def test_failed_apply_rolls_back_event(self, store, fresh_db):
        """If apply_fn throws, the event should NOT be in the log."""

        def bad_apply(cur, event):
            raise RuntimeError("oops")

        with pytest.raises(RuntimeError, match="oops"):
            store.emit_and_apply(
                kind=EventKind.PATIENT_REGISTERED,
                payload={"patient_hash": "h_rb", "source": "manual"},
                apply_fn=bad_apply,
                user_id="dr_test",
                patient_hash="h_rb",
            )
        count = fresh_db.execute(
            "SELECT COUNT(*) FROM twin_event_log WHERE patient_hash = ?",
            ("h_rb",),
        ).fetchone()[0]
        assert count == 0  # atomic rollback


# ─────────────────────────────────────────────────────────────────────
# Golden replay — the headline test
# ─────────────────────────────────────────────────────────────────────

class TestGoldenReplay:
    """Drop projections + replay → identical state. Contract B verifier."""

    def _emit_representative_workload(self, store: Store) -> None:
        """Emit a varied event mix covering common Layer 1 + 2 + 3 paths."""
        # Two patients registered
        for pid in ("p_alpha", "p_beta"):
            store.emit_and_apply(
                kind=EventKind.PATIENT_REGISTERED,
                payload={
                    "patient_hash": pid,
                    "source": "manual",
                    "demographics_json": {"sex": "F", "age_group": "50-59"},
                },
                apply_fn=_h_patient_registered,
                user_id="dr_chen",
                patient_hash=pid,
            )

        # Chat for p_alpha
        chat_idx = store.emit_and_apply(
            kind=EventKind.USER_MESSAGE,
            payload={"text": "how's the renal mass?", "session_id": "s1"},
            apply_fn=_h_user_message,
            user_id="dr_chen",
            patient_hash="p_alpha",
        )
        store.emit_and_apply(
            kind=EventKind.ASSISTANT_RESPONSE,
            payload={
                "text": "Stable, no growth in the past 3 months.",
                "model": "claude-haiku-4-5", "prompt_id": "main_chat",
                "prompt_version": "1.0",
            },
            apply_fn=_h_assistant_response,
            user_id="dr_chen",
            patient_hash="p_alpha",
            caused_by=chat_idx,
        )

        # A finding node for p_alpha
        finding_idx = store.emit_and_apply(
            kind=EventKind.NODE_ADDED,
            payload={
                "node_type": "finding",
                "content_json": {
                    "label": "left renal mass", "size_cm": 2.4,
                    "presence": True,
                },
                "weight": 1.0,
                "encounter_id": "study_001",
            },
            apply_fn=_h_node_added,
            user_id="dr_chen",
            patient_hash="p_alpha",
        )
        # Provenance for that finding
        store.emit_and_apply(
            kind=EventKind.PROVENANCE_RECORDED,
            payload={
                "node_id": finding_idx,
                "source_kind": "study",
                "source_ref": "1.2.840.xxxx.0001",
                "source_locator_json": {"slice_no": 142},
                "evidence_quote": "左肾上极 2.4cm 类圆形低密度灶",
                "extracted_by_user": "dr_chen",
                "extracted_at": 1749517200,
                "extraction_model": "gemini-2.5-flash",
                "extraction_prompt_id": "imaging_v3",
                "confidence": 0.87,
                "redaction_version": "phi-v2",
            },
            apply_fn=_h_provenance_recorded,
            user_id="dr_chen",
            patient_hash="p_alpha",
            caused_by=finding_idx,
        )
        # Edge: patient → finding
        store.emit_and_apply(
            kind=EventKind.EDGE_ADDED,
            payload={"src_node": 1, "dst_node": finding_idx,
                     "kind": "mentions", "weight": 1.0},
            apply_fn=_h_edge_added,
            user_id="dr_chen",
            patient_hash="p_alpha",
        )

        # Layer 2 observation (PHI-safe pattern)
        store.emit_and_apply(
            kind=EventKind.PRACTITIONER_OBSERVATION_EMITTED,
            payload={
                "fact_kind": "practice",
                "pattern_key": "decision/renal_mass/lt_3cm/birads4/next_step",
                "evidence_quote": "MR with contrast remains the recommended next step.",
                "source_encounter_id": "session_s1",
            },
            apply_fn=_h_practitioner_observation_emitted,
            user_id="dr_chen",
            patient_hash="p_alpha",
        )

    def _capture_projection_state(
        self, conn: sqlite3.Connection,
    ) -> dict[str, list[tuple]]:
        """Return all rows in every projection table, as a dict for compare."""
        snapshot = {}
        for table in PROJECTION_TABLES:
            try:
                rows = conn.execute(
                    f"SELECT * FROM {table} ORDER BY 1, 2, 3"
                ).fetchall()
                snapshot[table] = rows
            except sqlite3.OperationalError:
                # Table doesn't exist — empty
                snapshot[table] = []
        return snapshot

    def test_drop_replay_roundtrip_byte_identical(
        self, store: Store, fresh_db: sqlite3.Connection,
    ) -> None:
        """The headline test: state after replay == state before drop."""
        self._emit_representative_workload(store)
        original = self._capture_projection_state(fresh_db)

        # Sanity: workload produced non-empty projections
        assert any(rows for rows in original.values()), (
            "test workload produced empty projections; test broken"
        )

        # Drop all projections, replay from idx 0
        full_rebuild(fresh_db)

        rebuilt = self._capture_projection_state(fresh_db)

        for table in PROJECTION_TABLES:
            assert rebuilt[table] == original[table], (
                f"projection '{table}' diverged after replay.\n"
                f"  before: {original[table]}\n"
                f"  after:  {rebuilt[table]}\n"
                f"Contract B (event_log = single source of truth) is broken. "
                f"Some code path mutated this projection without going "
                f"through Store.emit_and_apply()."
            )

    def test_incremental_replay_from_checkpoint(
        self, store: Store, fresh_db: sqlite3.Connection,
    ) -> None:
        """Replay starting at a non-zero event_idx catches up correctly."""
        # Emit half
        for pid in ("p_inc1", "p_inc2"):
            store.emit_and_apply(
                kind=EventKind.PATIENT_REGISTERED,
                payload={"patient_hash": pid, "source": "manual"},
                apply_fn=_h_patient_registered,
                user_id="dr_chen",
                patient_hash=pid,
            )
        checkpoint = fresh_db.execute(
            "SELECT MAX(event_idx) FROM twin_event_log"
        ).fetchone()[0]

        # Emit the rest
        for pid in ("p_inc3", "p_inc4"):
            store.emit_and_apply(
                kind=EventKind.PATIENT_REGISTERED,
                payload={"patient_hash": pid, "source": "manual"},
                apply_fn=_h_patient_registered,
                user_id="dr_chen",
                patient_hash=pid,
            )

        # Drop projections, replay only from checkpoint+1
        drop_projections(fresh_db)
        init_event_sourcing_schema(fresh_db)
        replay(fresh_db, from_event_idx=checkpoint + 1)

        # Only the post-checkpoint patients should appear
        rows = fresh_db.execute(
            "SELECT json_extract(content_json, '$.patient_hash') FROM clinical_graph_nodes "
            "WHERE node_type = 'patient' ORDER BY 1"
        ).fetchall()
        appearing = {r[0] for r in rows}
        assert appearing == {"p_inc3", "p_inc4"}, (
            f"incremental replay should only restore post-checkpoint state; "
            f"found {appearing}"
        )

    def test_unknown_kind_halts_replay(self, fresh_db):
        """R23 mitigation: replay must NOT silently skip unknown kinds."""
        # Manually insert an event whose kind has no handler.
        # We use a kind that IS in EventKind enum but tamper to a version
        # that isn't registered. Bypass the Store to insert a bad row.
        fresh_db.execute(
            "INSERT INTO twin_event_log "
            "(event_kind, event_kind_version, user_id, ts, payload_json) "
            "VALUES (?, ?, ?, ?, ?)",
            ("user_message", "999.0", "dr_test", 1, "{}"),
        )
        fresh_db.commit()

        from nexus_server.event_sourcing.replay import UnknownEventKindError
        with pytest.raises(UnknownEventKindError):
            replay(fresh_db, from_event_idx=0)


# ─────────────────────────────────────────────────────────────────────
# Schema sanity
# ─────────────────────────────────────────────────────────────────────

class TestSchema:
    def test_init_is_idempotent(self, fresh_db):
        """Calling init twice does not error and does not duplicate state."""
        init_event_sourcing_schema(fresh_db)
        init_event_sourcing_schema(fresh_db)
        row = fresh_db.execute(
            "SELECT COUNT(*) FROM projection_state WHERE projection_name = 'all'"
        ).fetchone()
        assert row[0] == 1

    def test_all_projection_tables_exist(self, fresh_db):
        for table in PROJECTION_TABLES:
            cur = fresh_db.execute(
                f"SELECT name FROM sqlite_master "
                f"WHERE type='table' AND name=?",
                (table,),
            )
            assert cur.fetchone() is not None, f"projection table {table} missing"

    def test_event_log_table_exists(self, fresh_db):
        cur = fresh_db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='twin_event_log'"
        )
        assert cur.fetchone() is not None
