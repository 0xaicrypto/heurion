"""SQLite DDL for the event-sourcing foundation.

Two flavours of schema:

* CANONICAL_SCHEMA_DDL — the ``event_log`` table itself + ``projection_state``.
  These are the load-bearing canonical store. Migrations on these tables
  are strictly additive (new columns w/ defaults) per Rev-8 invariants.

* PROJECTION_SCHEMA_DDL — every read-side projection table. All Layer
  1-3 storage. Per Rev-8 these are derived: drop them, replay event_log,
  rebuild. Safe to redefine on schema upgrade without migration.

Per the design contract (v3 §16.12 / ADR Rev-8 / Rev-9), the M0 ship
declares ALL v3 tables in one shot — Layer 1 graph, Layer 2 practitioner,
Layer 3 reference, key_image content_json Rev-9 placeholder fields, even
the cached_views table. This eliminates schema migration as a category
of risk for the remainder of v3 phases.
"""

from __future__ import annotations

import logging
import sqlite3

logger = logging.getLogger(__name__)


# Bumped on any change to CANONICAL_SCHEMA_DDL. Migrations file in a
# follow-up phase will read this from a row in the schema_version table.
SCHEMA_VERSION = "3.1"


# ─────────────────────────────────────────────────────────────────────
# Canonical store — event_log + projection_state.
# Append-only. Never altered by application code.
# ─────────────────────────────────────────────────────────────────────

CANONICAL_SCHEMA_DDL = """
-- ════════════════════════════════════════════════════════════════════
-- twin_event_log — THE canonical store. Single source of truth per
-- ADR-002 Rev-8. Every mutation in Layer 1-4 is an event here.
-- Append-only. No UPDATE or DELETE from application code (CI-enforced).
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS twin_event_log (
    event_idx          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_kind         TEXT    NOT NULL,
    event_kind_version TEXT    NOT NULL,
    user_id            TEXT    NOT NULL,
    patient_hash       TEXT,
    ts                 INTEGER NOT NULL,    -- unix microseconds, monotonic per user
    payload_json       TEXT    NOT NULL,
    caused_by          INTEGER REFERENCES twin_event_log(event_idx)
);

CREATE INDEX IF NOT EXISTS idx_event_log_user_ts
    ON twin_event_log(user_id, ts);

CREATE INDEX IF NOT EXISTS idx_event_log_patient_ts
    ON twin_event_log(patient_hash, ts)
    WHERE patient_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_log_kind
    ON twin_event_log(event_kind, ts);

CREATE INDEX IF NOT EXISTS idx_event_log_caused_by
    ON twin_event_log(caused_by);


-- ════════════════════════════════════════════════════════════════════
-- projection_state — checkpoints for incremental replay. Per Rev-8.
-- One row per logical projection ('all' covers everything; finer-grained
-- per-table rows added when a single projection needs to lag).
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS projection_state (
    projection_name        TEXT    PRIMARY KEY,
    schema_version         TEXT    NOT NULL,
    last_applied_event_idx INTEGER NOT NULL DEFAULT 0,
    last_applied_ts        INTEGER NOT NULL DEFAULT 0,
    is_rebuilding          INTEGER NOT NULL DEFAULT 0,
    rebuilt_at             INTEGER
);


-- ════════════════════════════════════════════════════════════════════
-- schema_version — single-row table tracking active canonical version.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS event_log_schema_version (
    version    TEXT    PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
"""


# ─────────────────────────────────────────────────────────────────────
# Projection tables — all derivable from event_log. Per Rev-8 these
# can be dropped and rebuilt without data loss. M0 ships ALL v3 tables
# so no migration is required through M9.
# ─────────────────────────────────────────────────────────────────────

PROJECTION_SCHEMA_DDL = """
-- ════════════════════════════════════════════════════════════════════
-- Layer 1 — ClinicalGraph (per-patient, PHI-bearing)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS clinical_graph_nodes (
    user_id       TEXT    NOT NULL,
    patient_hash  TEXT    NOT NULL,
    node_id       INTEGER NOT NULL,
    node_type     TEXT    NOT NULL,
    -- content_json schema is type-dependent. For node_type='key_image'
    -- (Rev-9) it carries: image_sha256, source_dicom, rendered_at_resolution,
    -- windowing_applied, redaction {applied, regions, engine, engine_version},
    -- visual_embedding {encoder_bundle_id, encoder_version, embedding_version,
    -- vector_sha256}, features {hu_stats, enhancement_delta, morphology, ...},
    -- pinned_by. All fields optional / nullable in M0; populated incrementally
    -- by M1 (image_sha256 + redaction), M1.5 (visual_embedding), M1.7 (features).
    content_json  TEXT    NOT NULL,
    embedding_ref INTEGER,
    weight        REAL    NOT NULL DEFAULT 1.0,
    encounter_id  TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    originating_event_idx INTEGER NOT NULL
        REFERENCES twin_event_log(event_idx),
    PRIMARY KEY (user_id, patient_hash, node_id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_patient
    ON clinical_graph_nodes(user_id, patient_hash);

CREATE INDEX IF NOT EXISTS idx_nodes_type
    ON clinical_graph_nodes(user_id, patient_hash, node_type);

CREATE INDEX IF NOT EXISTS idx_nodes_encounter
    ON clinical_graph_nodes(user_id, patient_hash, encounter_id);


CREATE TABLE IF NOT EXISTS clinical_graph_edges (
    user_id       TEXT    NOT NULL,
    patient_hash  TEXT    NOT NULL,
    src_node      INTEGER NOT NULL,
    dst_node      INTEGER NOT NULL,
    kind          TEXT    NOT NULL,
    weight        REAL    NOT NULL DEFAULT 1.0,
    created_at    INTEGER NOT NULL,
    originating_event_idx INTEGER NOT NULL
        REFERENCES twin_event_log(event_idx),
    PRIMARY KEY (user_id, patient_hash, src_node, dst_node, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_src
    ON clinical_graph_edges(user_id, patient_hash, src_node);

CREATE INDEX IF NOT EXISTS idx_edges_dst
    ON clinical_graph_edges(user_id, patient_hash, dst_node);

CREATE INDEX IF NOT EXISTS idx_edges_kind
    ON clinical_graph_edges(user_id, patient_hash, kind);


-- Mandatory provenance for every semantic_fact / finding / measurement.
-- Per Rev-2: evidence_quote must be a verbatim substring of the source.
CREATE TABLE IF NOT EXISTS node_provenance (
    user_id               TEXT    NOT NULL,
    patient_hash          TEXT    NOT NULL,
    node_id               INTEGER NOT NULL,
    source_kind           TEXT    NOT NULL,
    source_ref            TEXT    NOT NULL,
    source_locator_json   TEXT    NOT NULL,
    evidence_quote        TEXT    NOT NULL,
    extracted_by_user     TEXT    NOT NULL,
    extracted_at          INTEGER NOT NULL,
    extraction_model      TEXT    NOT NULL,
    extraction_prompt_id  TEXT    NOT NULL,
    confidence            REAL    NOT NULL,
    redaction_version     TEXT    NOT NULL,
    superseded_by_node    INTEGER,
    retracted_at          INTEGER,
    retracted_by_user     TEXT,
    retracted_reason      TEXT,
    PRIMARY KEY (user_id, patient_hash, node_id)
);

CREATE INDEX IF NOT EXISTS idx_prov_source
    ON node_provenance(source_kind, source_ref);

CREATE INDEX IF NOT EXISTS idx_prov_model
    ON node_provenance(extraction_model, extraction_prompt_id);

CREATE INDEX IF NOT EXISTS idx_prov_user
    ON node_provenance(extracted_by_user, extracted_at);


-- Tier 1 cached view materialisations.
CREATE TABLE IF NOT EXISTS cached_views (
    user_id        TEXT    NOT NULL,
    patient_hash   TEXT    NOT NULL,
    view_kind      TEXT    NOT NULL,
    content_md     TEXT    NOT NULL,
    sources_json   TEXT    NOT NULL,
    generated_at   INTEGER NOT NULL,
    stale          INTEGER NOT NULL DEFAULT 0,
    ttl_seconds    INTEGER NOT NULL DEFAULT 86400,
    PRIMARY KEY (user_id, patient_hash, view_kind)
);

CREATE INDEX IF NOT EXISTS idx_views_stale
    ON cached_views(user_id, patient_hash, stale);


-- ════════════════════════════════════════════════════════════════════
-- Layer 2 — Practitioner Memory (per-medic, PHI-stripped, cross-patient)
-- ════════════════════════════════════════════════════════════════════
-- Only confirmed-active facts surface to the agent composer. Privacy
-- invariants enforced by Store: pattern_value_json scanned for hex hash
-- + date patterns at write time; rejected if found.
CREATE TABLE IF NOT EXISTS practitioner_facts (
    user_id                TEXT    NOT NULL,
    fact_kind              TEXT    NOT NULL,
    pattern_key            TEXT    NOT NULL,
    pattern_value_json     TEXT    NOT NULL,
    observed_count         INTEGER NOT NULL,
    distinct_patient_count INTEGER NOT NULL,
    confidence             REAL    NOT NULL,
    first_observed_at      INTEGER NOT NULL,
    last_reinforced_at     INTEGER NOT NULL,
    medic_confirmed_at     INTEGER,
    medic_rejected_at      INTEGER,
    extraction_model       TEXT    NOT NULL,
    extraction_prompt_id   TEXT    NOT NULL,
    PRIMARY KEY (user_id, fact_kind, pattern_key)
);

CREATE INDEX IF NOT EXISTS idx_pf_user_kind
    ON practitioner_facts(user_id, fact_kind);

CREATE INDEX IF NOT EXISTS idx_pf_active
    ON practitioner_facts(user_id)
    WHERE medic_confirmed_at IS NOT NULL AND medic_rejected_at IS NULL;


-- Per-user observation stream. Carries patient_hash for medic audit
-- ("show me which cases led you to think this about me?"). Never
-- aggregated across users.
CREATE TABLE IF NOT EXISTS practitioner_observations (
    user_id                TEXT    NOT NULL,
    patient_hash           TEXT    NOT NULL,
    fact_kind              TEXT    NOT NULL,
    pattern_key            TEXT    NOT NULL,
    observed_at            INTEGER NOT NULL,
    source_encounter_id    TEXT    NOT NULL,
    evidence_quote         TEXT    NOT NULL,
    extraction_model       TEXT    NOT NULL,
    extraction_prompt_id   TEXT    NOT NULL,
    PRIMARY KEY (user_id, patient_hash, fact_kind, pattern_key, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_po_distill
    ON practitioner_observations(user_id, fact_kind, pattern_key);

CREATE INDEX IF NOT EXISTS idx_po_patient
    ON practitioner_observations(user_id, patient_hash);


-- ════════════════════════════════════════════════════════════════════
-- Layer 3 — Reference knowledge (universal, version-pinned, public)
-- Populated by offline loaders from RadLex / RxNorm / ACR-AC etc.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS reference_knowledge (
    kind         TEXT    NOT NULL,
    key          TEXT    NOT NULL,
    content_json TEXT    NOT NULL,
    source       TEXT    NOT NULL,
    version      TEXT    NOT NULL,
    ingested_at  INTEGER NOT NULL,
    PRIMARY KEY (kind, key, version)
);

CREATE INDEX IF NOT EXISTS idx_ref_kind_key
    ON reference_knowledge(kind, key);
"""


# ─────────────────────────────────────────────────────────────────────
# Names of all projection tables — used by replay's drop-all-projections
# path and by the golden replay test.
# ─────────────────────────────────────────────────────────────────────

PROJECTION_TABLES: tuple[str, ...] = (
    "clinical_graph_nodes",
    "clinical_graph_edges",
    "node_provenance",
    "cached_views",
    "practitioner_facts",
    "practitioner_observations",
    "reference_knowledge",
)


def init_event_sourcing_schema(conn: sqlite3.Connection) -> None:
    """Apply both canonical + projection DDL to the connection.

    Idempotent. Safe to call on every server boot. Sets WAL mode and
    enables FK enforcement (required by replay's FK to twin_event_log).
    """
    cur = conn.cursor()

    # SQLite-level config — per Rev-7 §16.3 Tier 0 + Rev-8 transaction
    # guarantees, we need WAL + foreign keys on.
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")

    # Apply DDL. Use executescript to handle multi-statement DDL.
    cur.executescript(CANONICAL_SCHEMA_DDL)
    cur.executescript(PROJECTION_SCHEMA_DDL)

    # Bootstrap default projection_state row if absent.
    cur.execute(
        "INSERT OR IGNORE INTO projection_state "
        "(projection_name, schema_version) VALUES ('all', ?)",
        (SCHEMA_VERSION,),
    )

    # Record current schema version row.
    import time
    cur.execute(
        "INSERT OR IGNORE INTO event_log_schema_version "
        "(version, applied_at) VALUES (?, ?)",
        (SCHEMA_VERSION, int(time.time())),
    )

    conn.commit()
    logger.info(
        "event-sourcing schema initialised; version=%s tables=%d",
        SCHEMA_VERSION, len(PROJECTION_TABLES) + 3,  # +event_log,+projection_state,+schema_version
    )


def drop_projections(conn: sqlite3.Connection) -> None:
    """Drop every projection table — leave canonical store intact.

    Used by replay's full-rebuild path and by the golden replay test.
    The canonical store (twin_event_log + projection_state) is never
    touched by this function.
    """
    cur = conn.cursor()
    for table in PROJECTION_TABLES:
        cur.execute(f"DROP TABLE IF EXISTS {table}")
    cur.execute("UPDATE projection_state SET last_applied_event_idx=0")
    conn.commit()
    logger.warning("dropped %d projection tables", len(PROJECTION_TABLES))
