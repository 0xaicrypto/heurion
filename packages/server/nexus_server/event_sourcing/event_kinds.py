"""Typed event registry.

Every kind of state-changing operation in the memory layer has a typed
entry here. New event kinds are added by appending to ``EVENT_REGISTRY``;
existing kinds may grow new versions but never have their old versions
removed (per Rev-8 / R23 mitigation).

Each registration specifies:
- ``kind`` — canonical name (snake_case)
- ``version`` — semver string, e.g. "1.0"
- ``required_fields`` — payload keys that must be present
- ``patient_scoped`` — whether ``patient_hash`` must be set on the event row

The CI test ``test_event_registry_coverage`` asserts every registered
``(kind, version)`` has a corresponding replay handler in
``handlers.REPLAY_HANDLERS``.

Reference: design doc v3 §16.12.2.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class EventKind(str, Enum):
    """All event kinds. Adding here requires:
    1. A registration in EVENT_REGISTRY below
    2. A handler in handlers.REPLAY_HANDLERS
    3. CI test passes
    """

    # ─ Chat (Layer 1 chat-event substrate) ─────────────────────────
    USER_MESSAGE                       = "user_message"
    ASSISTANT_RESPONSE                 = "assistant_response"
    TOOL_CALL                          = "tool_call"
    AGENT_SUGGESTION                   = "agent_suggestion"
    SUGGESTION_RESOLVED                = "suggestion_resolved"

    # ─ Ingestion (event-sourced data import) ───────────────────────
    DICOM_UPLOADED                     = "dicom_uploaded"
    INGESTION_STARTED                  = "ingestion_started"
    INGESTION_LLM_RESPONSE             = "ingestion_llm_response"
    INGESTION_COMPLETED                = "ingestion_completed"

    # ─ Layer 1 graph mutations ─────────────────────────────────────
    NODE_ADDED                         = "node_added"
    NODE_UPDATED                       = "node_updated"
    NODE_WEIGHT_CHANGED                = "node_weight_changed"
    NODE_RETRACTED                     = "node_retracted"
    EDGE_ADDED                         = "edge_added"
    EDGE_UPDATED                       = "edge_updated"
    EDGE_REMOVED                       = "edge_removed"
    PROVENANCE_RECORDED                = "provenance_recorded"

    # ─ Layer 1 derived decisions ───────────────────────────────────
    ANATOMICAL_REGION_NORMALIZED       = "anatomical_region_normalized"
    EQUIVALENCE_MERGED                 = "equivalence_merged"
    CONFLICT_DETECTED                  = "conflict_detected"
    CONFLICT_RESOLVED                  = "conflict_resolved"
    CROSS_STUDY_COMPARE_RUN            = "cross_study_compare_run"

    # ─ Layer 2 practitioner memory ─────────────────────────────────
    PRACTITIONER_OBSERVATION_EMITTED   = "practitioner_observation_emitted"
    PRACTITIONER_CANDIDATE_SURFACED    = "practitioner_candidate_surfaced"
    PRACTITIONER_FACT_CONFIRMED        = "practitioner_fact_confirmed"
    PRACTITIONER_FACT_REJECTED         = "practitioner_fact_rejected"

    # ─ Layer 3 reference knowledge ─────────────────────────────────
    REFERENCE_VERSION_INGESTED         = "reference_version_ingested"

    # ─ Meta-layer (agent self-evolution) ───────────────────────────
    PROMPT_VERSION_CHANGED             = "prompt_version_changed"
    CONFIG_CHANGED                     = "config_changed"
    SKILL_REGISTERED                   = "skill_registered"

    # ─ Embeddings ──────────────────────────────────────────────────
    EMBEDDING_MODEL_CHANGED            = "embedding_model_changed"
    CHUNK_EMBEDDED                     = "chunk_embedded"
    CHUNK_RE_EMBEDDED                  = "chunk_re_embedded"

    # ─ Medic UI actions (persistent state) ─────────────────────────
    PATIENT_REGISTERED                 = "patient_registered"
    PATIENT_PINNED                     = "patient_pinned"
    PATIENT_UNPINNED                   = "patient_unpinned"
    FINDING_ACCEPTED_BY_MEDIC          = "finding_accepted_by_medic"
    FINDING_EDITED_BY_MEDIC            = "finding_edited_by_medic"
    IMPRESSION_EDITED                  = "impression_edited"
    MEDIC_CORRECTION                   = "medic_correction"

    # ─ Persistence operations ──────────────────────────────────────
    SNAPSHOT_TAKEN                     = "snapshot_taken"
    BACKUP_COMPLETED                   = "backup_completed"
    RESTORE_PERFORMED                  = "restore_performed"
    EXPORT_BUNDLE_CREATED              = "export_bundle_created"
    IMPORT_BUNDLE_STARTED              = "import_bundle_started"
    IMPORT_BUNDLE_COMPLETED            = "import_bundle_completed"

    # ─ Schema ──────────────────────────────────────────────────────
    SCHEMA_MIGRATION_APPLIED           = "schema_migration_applied"

    # ─ Imaging (Rev-9) ─────────────────────────────────────────────
    IMAGE_REDACTION_APPLIED            = "image_redaction_applied"
    IMAGE_EXTRACTED                    = "image_extracted"
    IMAGE_EMBEDDING_COMPUTED           = "image_embedding_computed"
    IMAGE_FEATURE_EXTRACTED            = "image_feature_extracted"
    IMAGE_ATTACHED_TO_CONTEXT          = "image_attached_to_context"
    REDACTION_POLICY_CHANGED           = "redaction_policy_changed"


@dataclass(frozen=True)
class EventSpec:
    """Schema metadata for one (kind, version) pair."""
    kind: EventKind
    version: str
    required_fields: tuple[str, ...] = ()
    optional_fields: tuple[str, ...] = ()
    patient_scoped: bool = False
    description: str = ""


# ─────────────────────────────────────────────────────────────────────
# The registry. New kinds append here. Old (kind, version) tuples are
# never removed. Adding a new version of an existing kind is a separate
# entry; replay handlers must exist for every entry in this table.
# ─────────────────────────────────────────────────────────────────────

EVENT_REGISTRY: dict[tuple[EventKind, str], EventSpec] = {}


def _r(spec: EventSpec) -> None:
    """Register an event spec. Refuses duplicates."""
    key = (spec.kind, spec.version)
    if key in EVENT_REGISTRY:
        raise ValueError(f"event spec already registered: {key}")
    EVENT_REGISTRY[key] = spec


# Chat
_r(EventSpec(EventKind.USER_MESSAGE, "1.0",
   required_fields=("text", "session_id"),
   description="Raw user-typed message; canonical text record."))
_r(EventSpec(EventKind.ASSISTANT_RESPONSE, "1.0",
   required_fields=("text", "model", "prompt_id", "prompt_version"),
   optional_fields=("retrieved_context_refs", "citations",
                    "image_attachments_sha256"),
   description="Verbatim assistant reply; non-deterministic source archived."))
_r(EventSpec(EventKind.TOOL_CALL, "1.0",
   required_fields=("tool_name", "args_json", "response_json"),
   optional_fields=("latency_ms", "error"),
   description="Tool invocation by the agent."))
_r(EventSpec(EventKind.AGENT_SUGGESTION, "1.0",
   required_fields=("text", "kind"),
   optional_fields=("context_event_idx",),
   description="Agent's suggestion to the medic; tracked for calibration."))
_r(EventSpec(EventKind.SUGGESTION_RESOLVED, "1.0",
   required_fields=("suggestion_event_idx", "outcome"),
   optional_fields=("response",),
   description="Medic's response to a suggestion (accepted|overridden|ignored)."))

# Ingestion
_r(EventSpec(EventKind.DICOM_UPLOADED, "1.0",
   required_fields=("study_uid", "modality", "sha256", "file_size"),
   optional_fields=("body_part", "study_date"),
   patient_scoped=True,
   description="A DICOM file was uploaded; canonical file ref by SHA-256."))
_r(EventSpec(EventKind.INGESTION_STARTED, "1.0",
   required_fields=("kind", "target_ref", "ingester_version"),
   patient_scoped=True,
   description="An ingester run begins; marks the start of a derivation chain."))
_r(EventSpec(EventKind.INGESTION_LLM_RESPONSE, "1.0",
   required_fields=("raw_output_text", "model", "prompt_id", "prompt_version"),
   optional_fields=("tokens_in", "tokens_out", "latency_ms"),
   patient_scoped=True,
   description="VERBATIM LLM output — the load-bearing replay artifact."))
_r(EventSpec(EventKind.INGESTION_COMPLETED, "1.0",
   required_fields=("kind", "target_ref"),
   optional_fields=("emitted_node_count", "errors"),
   patient_scoped=True,
   description="Ingester run finished; summary metadata."))

# Graph mutations
_r(EventSpec(EventKind.NODE_ADDED, "1.0",
   required_fields=("node_type", "content_json"),
   optional_fields=("embedding_ref", "weight", "encounter_id",
                    "originating_event_idx"),
   patient_scoped=True,
   description="A new graph node materialised in a projection."))
_r(EventSpec(EventKind.NODE_UPDATED, "1.0",
   required_fields=("node_id", "before_state_json", "after_state_json"),
   patient_scoped=True))
_r(EventSpec(EventKind.NODE_WEIGHT_CHANGED, "1.0",
   required_fields=("node_id", "before_weight", "after_weight", "reason"),
   patient_scoped=True))
_r(EventSpec(EventKind.NODE_RETRACTED, "1.0",
   required_fields=("node_id", "retracted_by_user", "reason"),
   patient_scoped=True))
_r(EventSpec(EventKind.EDGE_ADDED, "1.0",
   required_fields=("src_node", "dst_node", "kind"),
   optional_fields=("weight",),
   patient_scoped=True))
_r(EventSpec(EventKind.EDGE_UPDATED, "1.0",
   required_fields=("src_node", "dst_node", "kind",
                    "before_weight", "after_weight"),
   patient_scoped=True))
_r(EventSpec(EventKind.EDGE_REMOVED, "1.0",
   required_fields=("src_node", "dst_node", "kind", "reason"),
   patient_scoped=True))
_r(EventSpec(EventKind.PROVENANCE_RECORDED, "1.0",
   required_fields=("node_id", "source_kind", "source_ref", "source_locator_json",
                    "evidence_quote", "extracted_by_user", "extracted_at",
                    "extraction_model", "extraction_prompt_id", "confidence",
                    "redaction_version"),
   patient_scoped=True,
   description="Mandatory provenance row for any clinical-fact node."))

# Layer 1 derived
_r(EventSpec(EventKind.ANATOMICAL_REGION_NORMALIZED, "1.0",
   required_fields=("raw_label", "canonical_label", "was_new"),
   optional_fields=("radlex_id", "snomed_id"),
   patient_scoped=True))
_r(EventSpec(EventKind.EQUIVALENCE_MERGED, "1.0",
   required_fields=("merger", "nodes_unioned"),
   optional_fields=("character_id_assigned",),
   patient_scoped=True))
_r(EventSpec(EventKind.CONFLICT_DETECTED, "1.0",
   required_fields=("nodes", "detector"),
   optional_fields=("rule_id", "evidence"),
   patient_scoped=True))
_r(EventSpec(EventKind.CONFLICT_RESOLVED, "1.0",
   required_fields=("nodes", "decision", "axis_used", "auto_or_medic"),
   optional_fields=("reasoning",),
   patient_scoped=True))
_r(EventSpec(EventKind.CROSS_STUDY_COMPARE_RUN, "1.0",
   required_fields=("new_study", "priors_considered"),
   optional_fields=("matches_found", "follow_up_edges_emitted",
                    "same_finding_edges_emitted"),
   patient_scoped=True))

# Layer 2
_r(EventSpec(EventKind.PRACTITIONER_OBSERVATION_EMITTED, "1.0",
   required_fields=("fact_kind", "pattern_key", "evidence_quote",
                    "source_encounter_id"),
   patient_scoped=True,  # observations carry patient_hash for medic audit
   description="One raw observation feeding the Layer 2 distiller."))
_r(EventSpec(EventKind.PRACTITIONER_CANDIDATE_SURFACED, "1.0",
   required_fields=("fact_kind", "pattern_key", "distinct_count", "confidence")))
_r(EventSpec(EventKind.PRACTITIONER_FACT_CONFIRMED, "1.0",
   required_fields=("fact_kind", "pattern_key", "by_user")))
_r(EventSpec(EventKind.PRACTITIONER_FACT_REJECTED, "1.0",
   required_fields=("fact_kind", "pattern_key", "by_user"),
   optional_fields=("reason",)))

# Layer 3
_r(EventSpec(EventKind.REFERENCE_VERSION_INGESTED, "1.0",
   required_fields=("kind", "key", "version", "source_url", "content_sha256")))

# Meta-layer
_r(EventSpec(EventKind.PROMPT_VERSION_CHANGED, "1.0",
   required_fields=("prompt_id", "old_version", "new_version", "content_sha256"),
   optional_fields=("change_summary",)))
_r(EventSpec(EventKind.CONFIG_CHANGED, "1.0",
   required_fields=("config_id", "before_json", "after_json")))
_r(EventSpec(EventKind.SKILL_REGISTERED, "1.0",
   required_fields=("skill_id", "version")))

# Embeddings
_r(EventSpec(EventKind.EMBEDDING_MODEL_CHANGED, "1.0",
   required_fields=("old_model", "new_model")))
_r(EventSpec(EventKind.CHUNK_EMBEDDED, "1.0",
   required_fields=("chunk_id", "source_text_sha256", "model_version",
                    "vector_sha256")))
_r(EventSpec(EventKind.CHUNK_RE_EMBEDDED, "1.0",
   required_fields=("chunk_id", "old_model_version", "new_model_version")))

# Medic UI
_r(EventSpec(EventKind.PATIENT_REGISTERED, "1.0",
   required_fields=("patient_hash", "source"),
   optional_fields=("demographics_json",),
   patient_scoped=True))
_r(EventSpec(EventKind.PATIENT_PINNED, "1.0",
   required_fields=("patient_hash",), patient_scoped=True))
_r(EventSpec(EventKind.PATIENT_UNPINNED, "1.0",
   required_fields=("patient_hash",), patient_scoped=True))
_r(EventSpec(EventKind.FINDING_ACCEPTED_BY_MEDIC, "1.0",
   required_fields=("node_id", "by_user"), patient_scoped=True))
_r(EventSpec(EventKind.FINDING_EDITED_BY_MEDIC, "1.0",
   required_fields=("node_id", "before_state", "after_state", "by_user"),
   patient_scoped=True))
_r(EventSpec(EventKind.IMPRESSION_EDITED, "1.0",
   required_fields=("study_uid", "before_text", "after_text", "by_user"),
   patient_scoped=True))
_r(EventSpec(EventKind.MEDIC_CORRECTION, "1.0",
   required_fields=("source_node_id", "correction_text", "action_taken"),
   patient_scoped=True))

# Persistence
_r(EventSpec(EventKind.SNAPSHOT_TAKEN, "1.0",
   required_fields=("tier", "location", "sha256", "db_size_bytes")))
_r(EventSpec(EventKind.BACKUP_COMPLETED, "1.0",
   required_fields=("location", "archive_sha256")))
_r(EventSpec(EventKind.RESTORE_PERFORMED, "1.0",
   required_fields=("snapshot_ref", "restored_at_event_idx", "restore_kind")))
_r(EventSpec(EventKind.EXPORT_BUNDLE_CREATED, "1.0",
   required_fields=("destination", "included_event_count", "includes_phi")))
_r(EventSpec(EventKind.IMPORT_BUNDLE_STARTED, "1.0",
   required_fields=("source_ref", "schema_version")))
_r(EventSpec(EventKind.IMPORT_BUNDLE_COMPLETED, "1.0",
   required_fields=("events_imported", "conflicts_resolved")))

# Schema
_r(EventSpec(EventKind.SCHEMA_MIGRATION_APPLIED, "1.0",
   required_fields=("migration_id", "version_before", "version_after")))

# Imaging (Rev-9)
_r(EventSpec(EventKind.IMAGE_REDACTION_APPLIED, "1.0",
   required_fields=("image_sha256_before", "image_sha256_after",
                    "redacted_regions", "engine", "engine_version"),
   optional_fields=("ocr_hits", "face_detections"),
   patient_scoped=True,
   description="Mandatory before image_extracted commits. PHI overlay strip."))
_r(EventSpec(EventKind.IMAGE_EXTRACTED, "1.0",
   required_fields=("study_uid", "series_uid", "slice_no",
                    "sop_instance_uid", "image_sha256", "file_path",
                    "dimensions", "rendered_at_resolution",
                    "windowing_applied", "pinned_by"),
   patient_scoped=True))
_r(EventSpec(EventKind.IMAGE_EMBEDDING_COMPUTED, "1.0",
   required_fields=("image_sha256", "encoder_bundle_id", "encoder_version",
                    "embedding_version", "vector_sha256"),
   optional_fields=("latency_ms",),
   patient_scoped=True))
_r(EventSpec(EventKind.IMAGE_FEATURE_EXTRACTED, "1.0",
   required_fields=("image_sha256", "feature_kind", "values_json",
                    "extractor_bundle_id", "extractor_version"),
   patient_scoped=True))
_r(EventSpec(EventKind.IMAGE_ATTACHED_TO_CONTEXT, "1.0",
   required_fields=("parent_event_idx", "image_sha256s_included"),
   optional_fields=("total_image_tokens_estimate",),
   patient_scoped=True,
   description="Audit: which images informed a specific agent response."))
_r(EventSpec(EventKind.REDACTION_POLICY_CHANGED, "1.0",
   required_fields=("modality", "old_policy_version", "new_policy_version"),
   optional_fields=("summary",)))


# ─────────────────────────────────────────────────────────────────────
# Payload validation
# ─────────────────────────────────────────────────────────────────────

class EventValidationError(ValueError):
    """Raised when a payload fails to validate against its spec."""
    pass


def validate_payload(
    kind: EventKind,
    version: str,
    payload: dict[str, Any],
    *,
    patient_hash: str | None = None,
) -> None:
    """Validate that a payload conforms to its registered spec.

    Raises ``EventValidationError`` on:
    - Unknown (kind, version) pair
    - Missing required field
    - patient_scoped event without patient_hash supplied
    """
    spec = EVENT_REGISTRY.get((kind, version))
    if spec is None:
        raise EventValidationError(
            f"unknown event (kind={kind}, version={version}); "
            f"register in EVENT_REGISTRY first"
        )

    missing = [f for f in spec.required_fields if f not in payload]
    if missing:
        raise EventValidationError(
            f"event {kind}@{version} missing required fields: {missing}"
        )

    if spec.patient_scoped and patient_hash is None:
        raise EventValidationError(
            f"event {kind}@{version} is patient-scoped but no patient_hash given"
        )


def current_version(kind: EventKind) -> str:
    """Return the highest registered version for a kind.
    Used by Store.emit_and_apply when caller doesn't specify a version.
    """
    versions = [v for (k, v) in EVENT_REGISTRY if k == kind]
    if not versions:
        raise EventValidationError(f"no versions registered for {kind}")
    # Simple lex sort works for "1.0" / "1.1" / "2.0" — promote to packaging.Version if needed.
    return sorted(versions, reverse=True)[0]
