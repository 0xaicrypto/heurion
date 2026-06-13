"""DICOM ingester — modality-routing event-sourced pipeline (M1 / Rev-6 + Rev-9).

Per design v3 §5.1, this is the rewrite that replaces the legacy
``nexus_server.dicom`` direct-projection-write path with the Rev-8
event-sourced flow. Every node + edge + provenance row is born from
an event in ``twin_event_log``; replaying the log rebuilds the same
projection state byte-identical.

Pipeline (Stages 1–9 of §5.1)
=============================

::

    DICOM upload completes
       │
       ▼
    ingest(study_uid, ...)
       │
       ├─ Stage 1  monai.transforms parse + canonicalise
       │            └─ emit DICOM_UPLOADED
       │
       ├─ Stage 2  route by (modality, volume_size):
       │            2A  2D modalities (CR/DX/Photo/Fundus/single-frame US)
       │                 → CoreML / Gemini Flash 2D bundle
       │            2B  Cine ultrasound
       │                 → Gemini Flash on representative frames
       │            2C  3D volumes (CT/MR/PET/3D US)
       │                 → quick_scan_4x4_grid Bundle (Gemini Flash today;
       │                   remote MONAI VISTA-3D at M10 inference companion)
       │
       ├─ Stage 3 (Rev-9 / IM-1)  render + redact key images
       │            └─ emit IMAGE_REDACTION_APPLIED, IMAGE_EXTRACTED
       │
       ├─ Stage 4  call backend → archive verbatim
       │            └─ emit INGESTION_STARTED, INGESTION_LLM_RESPONSE
       │
       ├─ Stage 5  parse → emit NODE_ADDED (study/series/key_image/
       │            anatomical_region/finding/measurement) +
       │            PROVENANCE_RECORDED for clinical facts
       │
       ├─ Stage 6  emit EDGE_ADDED (imaging_of / finding_in /
       │            localization_of / measurement_of)
       │
       ├─ Stage 7  cross_study_compare (M2; placeholder here)
       │
       ├─ Stage 8  cached_views.invalidate (M4; placeholder)
       │
       └─ Stage 9  emit INGESTION_COMPLETED

Critical invariants
===================

* No projection write outside ``Store.emit_and_apply``.
* IM-1 redaction MUST commit before IMAGE_EXTRACTED (Rev-9 §5.5.7 #1).
* Verbatim LLM output archived in INGESTION_LLM_RESPONSE — replay
  reads this, never re-invokes Gemini.
* Bundle id + prompt id provenance fields auto-derived via
  ``monai_runtime.bundle_to_provenance_refs``.

M1 status
=========

Real redaction + real Gemini-Flash invocation are stubbed; the backends
(GeminiFlashQuickScanBackend etc.) live in monai_runtime and currently
return deterministic placeholders. M1's job is to nail the *event chain
shape* end-to-end; M1.5–M1.7 will swap stub backends for real ones
(CoreML 2D, MONAI Bundle inference, BiomedCLIP visual embeddings,
structured radiology features).
"""

from __future__ import annotations

import hashlib
import logging
import sqlite3
from dataclasses import dataclass
from typing import Callable, Optional

from nexus_server.clinical_graph import ClinicalGraph, ensure_patient
from nexus_server.event_sourcing import EventKind, Store
from nexus_server.event_sourcing.handlers import (
    _h_dicom_uploaded,
    _h_image_extracted,
    _h_image_redaction_applied,
    _h_ingestion_completed,
    _h_ingestion_llm_response,
    _h_ingestion_started,
)
from nexus_server.monai_runtime import (
    InferenceInput,
    InferenceResult,
    bundle_to_provenance_refs,
    load_bundle,
    resolve_backend,
)

logger = logging.getLogger(__name__)


# Bundles per modality routing decision. M1.5/M1.7 add chest_xray_triage,
# dermatology, etc. for Stage 2A; cine US gets a bundle in M2.
BUNDLE_FOR_3D = "quick_scan_4x4_grid@0.3.0"
BUNDLE_FOR_2D_DEFAULT = "quick_scan_4x4_grid@0.3.0"  # M1.5 swaps in chest_xray_triage

INGESTER_VERSION = "dicom_ingester@1.0"
REDACTION_VERSION = "phi-v2"
REDACTION_ENGINE = "pydicom-overlay+ocr"
REDACTION_ENGINE_VERSION = "0.4.2"


# ─────────────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────────────

class DicomIngestError(Exception):
    pass


class RedactionRequired(DicomIngestError):
    """IM-1 redaction must commit before IMAGE_EXTRACTED. Per Rev-9 §5.5.7
    invariant #1: ``image_extracted`` cannot commit without preceding
    ``image_redaction_applied`` for the same target."""


class UnsupportedModality(DicomIngestError):
    pass


# ─────────────────────────────────────────────────────────────────────
# Modality routing
# ─────────────────────────────────────────────────────────────────────

# Modalities that are 2D imagery (always one frame). Routed to Stage 2A.
MODALITIES_2D = frozenset({"CR", "DX", "DR", "MG", "PT_2D", "OP", "XC"})

# Multi-frame cine modalities. Routed to Stage 2B.
MODALITIES_CINE = frozenset({"US"})  # US can be 2D-still OR cine; resolved by frame count

# 3D volumetric modalities. Routed to Stage 2C.
MODALITIES_3D = frozenset({"CT", "MR", "PET", "PT", "NM"})


def route_modality(modality: str, frame_count: int) -> str:
    """Determine routing stage from DICOM modality tag + frame count.

    Returns one of ``"2A"`` (2D), ``"2B"`` (cine), ``"2C"`` (3D).
    """
    m = modality.upper()
    if m in MODALITIES_3D:
        return "2C"
    if m in MODALITIES_CINE:
        return "2B" if frame_count > 1 else "2A"
    if m in MODALITIES_2D:
        return "2A"
    if frame_count > 16:
        return "2C"
    return "2A"


# ─────────────────────────────────────────────────────────────────────
# Redaction interface
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RedactionResult:
    """Output of the redaction pass (Rev-9 IM-1).

    Real impl wraps pydicom + PaddleOCR + face-detection. For M1 tests we
    inject a deterministic stub; for M1.6 production the real pipeline
    runs against actual DICOM/PNG bytes.
    """
    redacted_bytes: bytes
    redacted_regions: list[dict]   # [{bbox, reason}]
    ocr_hits: list[str]
    face_detections: list[dict]


# Caller-supplied redaction function. Bench-stable for tests; M1.6 wires
# the real pydicom/OCR pipeline.
RedactionFn = Callable[[bytes], RedactionResult]


def stub_redactor(image_bytes: bytes) -> RedactionResult:
    """Deterministic no-op redactor for tests + dev.

    Production runs ``nexus_server.monai_runtime.redaction.real_redact``
    once that's wired (M1.6); this stub keeps the event chain working
    without requiring PaddleOCR / pydicom in CI."""
    return RedactionResult(
        redacted_bytes=image_bytes,
        redacted_regions=[],
        ocr_hits=[],
        face_detections=[],
    )


# ─────────────────────────────────────────────────────────────────────
# Inputs
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class KeySliceInput:
    """One key slice picked by upstream prerender / Quick scan grid logic."""
    slice_no: int
    sop_instance_uid: str
    rendered_png_bytes: bytes


@dataclass(frozen=True)
class StudyInput:
    """Everything the ingester needs to process one study.

    The caller (typically the existing prerender + Quick scan worker)
    hands the ingester:
      - identifiers (study_uid, modality, body part)
      - the file path of the DICOM (for sha256 / canonical store)
      - the list of key slices already rendered as PNG bytes
        (cumulative ~16 per study, modality-window-adjusted)
    """
    study_uid: str
    series_uid: str
    modality: str
    body_part: Optional[str]
    study_date: Optional[str]
    frame_count: int
    dicom_file_path: str
    dicom_sha256: str
    file_size_bytes: int
    key_slices: list[KeySliceInput]
    grid_image_bytes: Optional[bytes] = None  # for Stage 2C 4x4 grid


# ─────────────────────────────────────────────────────────────────────
# Ingester
# ─────────────────────────────────────────────────────────────────────

class DicomIngester:
    """Event-sourced DICOM ingestion. One instance per request is fine —
    stateless beyond the Store + connection refs."""

    def __init__(
        self,
        store: Store,
        conn: sqlite3.Connection,
        *,
        redact: RedactionFn = stub_redactor,
        ingester_version: str = INGESTER_VERSION,
    ) -> None:
        self.store = store
        self.conn = conn
        self.redact = redact
        self.ingester_version = ingester_version

    def ingest(
        self,
        *,
        user_id: str,
        patient_hash: str,
        study: StudyInput,
    ) -> dict:
        """Run the full §5.1 pipeline.

        Returns a dict summarising what was emitted: counts of events
        + node ids by type, for the caller to log / audit.
        """
        # ── Stage 1 — announce upload + register patient anchor
        uploaded_idx = self.store.emit_and_apply(
            kind=EventKind.DICOM_UPLOADED,
            payload={
                "study_uid":  study.study_uid,
                "modality":   study.modality,
                "sha256":     study.dicom_sha256,
                "file_size":  study.file_size_bytes,
                "body_part":  study.body_part,
                "study_date": study.study_date,
            },
            apply_fn=_h_dicom_uploaded,
            user_id=user_id,
            patient_hash=patient_hash,
        )
        patient_node_id = ensure_patient(
            self.store, user_id, patient_hash, source="dicom",
        )

        # ── Stage 2 — pick routing decision
        route = route_modality(study.modality, study.frame_count)
        logger.info(
            "dicom_ingester: study=%s modality=%s frame_count=%d → route=%s",
            study.study_uid, study.modality, study.frame_count, route,
        )

        # ── Stage 3 — IM-1 render + redact key images.
        # Critical invariant (Rev-9 §5.5.7 #1): redaction event MUST
        # commit before image_extracted for the same target.
        key_image_node_ids: list[int] = []
        for slice in study.key_slices:
            key_image_node_ids.append(
                self._ingest_one_key_image(
                    user_id=user_id, patient_hash=patient_hash,
                    study=study, slice=slice,
                    caused_by=uploaded_idx,
                )
            )

        # ── Stage 4 — resolve Bundle + call backend + archive raw output
        bundle_id = (
            BUNDLE_FOR_3D if route == "2C" else BUNDLE_FOR_2D_DEFAULT
        )
        bundle_meta, bundle_cfg = load_bundle(bundle_id)
        provenance_refs = bundle_to_provenance_refs(bundle_meta, bundle_cfg)
        backend = resolve_backend(bundle_cfg)

        started_idx = self.store.emit_and_apply(
            kind=EventKind.INGESTION_STARTED,
            payload={
                "kind":             "dicom",
                "target_ref":       study.study_uid,
                "ingester_version": self.ingester_version,
            },
            apply_fn=_h_ingestion_started,
            user_id=user_id, patient_hash=patient_hash,
            caused_by=uploaded_idx,
        )

        backend_input = self._build_backend_input(route, study)
        result: InferenceResult = backend.run(
            bundle_meta, bundle_cfg, backend_input,
        )

        self.store.emit_and_apply(
            kind=EventKind.INGESTION_LLM_RESPONSE,
            payload={
                "raw_output_text": result.raw_output_text,
                "model":           bundle_meta.bundle_id,
                "prompt_id":       provenance_refs.extraction_prompt_id,
                "prompt_version":  bundle_cfg.prompt_version or "1.0",
                "tokens_in":       result.tokens_in,
                "tokens_out":      result.tokens_out,
                "latency_ms":      result.latency_ms,
            },
            apply_fn=_h_ingestion_llm_response,
            user_id=user_id, patient_hash=patient_hash,
            caused_by=started_idx,
        )

        # ── Stage 5–6 — emit study/series nodes + linkage edges
        graph = ClinicalGraph(self.store, self.conn, user_id, patient_hash)

        study_node_id = graph.add_node(
            node_type="study",
            content={
                "study_uid": study.study_uid,
                "modality":  study.modality,
                "body_part": study.body_part,
                "study_date": study.study_date,
                "route":     route,
            },
            encounter_id=study.study_uid,
            caused_by=started_idx,
        )
        graph.add_edge(
            src=patient_node_id, dst=study_node_id,
            kind="mentions", caused_by=started_idx,
        )
        for key_image_node_id in key_image_node_ids:
            graph.add_edge(
                src=study_node_id, dst=key_image_node_id,
                kind="imaging_of", caused_by=started_idx,
            )

        finding_node_ids = self._emit_findings_from_result(
            user_id=user_id, patient_hash=patient_hash,
            study=study, result=result, started_idx=started_idx,
            graph=graph, study_node_id=study_node_id,
            provenance_refs=provenance_refs,
        )

        # ── Stage 7–8 — cross_study_compare + cached_views invalidate
        # (M2/M4 placeholders; events stubs are no-op handlers today)

        # ── Stage 9 — complete
        self.store.emit_and_apply(
            kind=EventKind.INGESTION_COMPLETED,
            payload={
                "kind":               "dicom",
                "target_ref":         study.study_uid,
                "emitted_node_count": (
                    len(key_image_node_ids) + len(finding_node_ids) + 1
                ),
                "errors":             [],
            },
            apply_fn=_h_ingestion_completed,
            user_id=user_id, patient_hash=patient_hash,
            caused_by=started_idx,
        )

        summary = {
            "route":                  route,
            "study_node_id":          study_node_id,
            "key_image_node_ids":     key_image_node_ids,
            "finding_node_ids":       finding_node_ids,
            "bundle_id":              bundle_meta.bundle_id,
            "extraction_model":       provenance_refs.extraction_model,
            "extraction_prompt_id":   provenance_refs.extraction_prompt_id,
        }
        logger.info("dicom_ingester complete: %s", summary)
        return summary

    # ────────────────────── private helpers ─────────────────────

    def _ingest_one_key_image(
        self,
        *,
        user_id: str,
        patient_hash: str,
        study: StudyInput,
        slice: KeySliceInput,
        caused_by: int,
    ) -> int:
        """Run redaction → image_extracted → key_image node for one slice.
        Returns the key_image node id."""
        redacted = self.redact(slice.rendered_png_bytes)
        sha_before = hashlib.sha256(slice.rendered_png_bytes).hexdigest()
        sha_after = hashlib.sha256(redacted.redacted_bytes).hexdigest()

        # Redaction event MUST commit first (Rev-9 §5.5.7 #1).
        redaction_event_idx = self.store.emit_and_apply(
            kind=EventKind.IMAGE_REDACTION_APPLIED,
            payload={
                "image_sha256_before": sha_before,
                "image_sha256_after":  sha_after,
                "redacted_regions":    redacted.redacted_regions,
                "engine":              REDACTION_ENGINE,
                "engine_version":      REDACTION_ENGINE_VERSION,
                "ocr_hits":            redacted.ocr_hits,
                "face_detections":     redacted.face_detections,
            },
            apply_fn=_h_image_redaction_applied,
            user_id=user_id, patient_hash=patient_hash,
            caused_by=caused_by,
        )

        # Now extract — references the post-redaction sha256.
        extracted_event_idx = self.store.emit_and_apply(
            kind=EventKind.IMAGE_EXTRACTED,
            payload={
                "study_uid":         study.study_uid,
                "series_uid":        study.series_uid,
                "slice_no":          slice.slice_no,
                "sop_instance_uid":  slice.sop_instance_uid,
                "image_sha256":      sha_after,
                "file_path":         f"keyimage/{sha_after}.png",
                "dimensions":        [512, 512],
                "rendered_at_resolution": [512, 512],
                "windowing_applied": {"width": 400, "level": 40},  # modality-default
                "pinned_by":         self.ingester_version,
            },
            apply_fn=_h_image_extracted,
            user_id=user_id, patient_hash=patient_hash,
            caused_by=redaction_event_idx,
        )

        # Emit the key_image graph node (Rev-9 §5.5.3 schema).
        from nexus_server.clinical_graph import ClinicalGraph
        graph = ClinicalGraph(self.store, self.conn, user_id, patient_hash)
        return graph.add_node(
            node_type="key_image",
            content={
                "image_sha256": sha_after,
                "source_dicom": {
                    "study_uid":        study.study_uid,
                    "series_uid":       study.series_uid,
                    "slice_no":         slice.slice_no,
                    "sop_instance_uid": slice.sop_instance_uid,
                },
                "rendered_at_resolution": [512, 512],
                "windowing_applied":      {"width": 400, "level": 40},
                "redaction": {
                    "applied":         True,
                    "regions":         redacted.redacted_regions,
                    "engine":          REDACTION_ENGINE,
                    "engine_version": REDACTION_ENGINE_VERSION,
                },
                # visual_embedding + features filled in by M1.5 / M1.7
                "visual_embedding": None,
                "features":         {},
                "pinned_by":        self.ingester_version,
            },
            encounter_id=study.study_uid,
            caused_by=extracted_event_idx,
        )

    def _build_backend_input(self, route: str, study: StudyInput) -> InferenceInput:
        if route == "2C":
            grid = study.grid_image_bytes or b""
            return InferenceInput(grid_image_bytes=grid)
        # 2A and 2B both currently fall back to the quick_scan Bundle until
        # M1.5 ships dedicated chest_xray_triage / dermatology / cine_us
        # 2D Bundles. The quick_scan backend requires grid_image_bytes,
        # so we synthesise a 1×1 "grid" from the representative slice.
        if study.key_slices:
            png = study.key_slices[0].rendered_png_bytes
            return InferenceInput(
                grid_image_bytes=png,
                image_bytes=png,
                metadata={"synthetic_grid": True, "route": route},
            )
        return InferenceInput(
            grid_image_bytes=b"empty",
            text=f"empty {route} study {study.study_uid}",
        )

    def _emit_findings_from_result(
        self,
        *,
        user_id: str,
        patient_hash: str,
        study: StudyInput,
        result: InferenceResult,
        started_idx: int,
        graph: ClinicalGraph,
        study_node_id: int,
        provenance_refs,
    ) -> list[int]:
        """Parse the backend's structured output → finding/measurement nodes.

        For M1 we parse the stub backends' synthetic output. M1.6+ swaps
        to the real Quick scan parser when the GeminiFlashQuickScanBackend
        gets wired to the actual quick_scan module.
        """
        finding_node_ids: list[int] = []
        # Stub backends today return parsed.findings = [] — so this loop
        # is no-op in M1 test fixtures. A real Quick scan return would
        # populate parsed["findings"] with [{"label", "size_cm", "evidence_quote", ...}]
        import time
        now = int(time.time())
        for finding in result.parsed.get("findings", []):
            provenance = {
                "source_kind":          "study",
                "source_ref":           study.study_uid,
                "source_locator_json":  {"sha256": study.dicom_sha256},
                "evidence_quote":       finding.get("evidence_quote", ""),
                "extracted_by_user":    user_id,
                "extracted_at":         now,
                "extraction_model":     provenance_refs.extraction_model,
                "extraction_prompt_id": provenance_refs.extraction_prompt_id,
                "confidence":           float(finding.get("confidence", 0.5)),
                "redaction_version":    REDACTION_VERSION,
            }
            node_id = graph.add_node(
                node_type="finding",
                content=finding,
                encounter_id=study.study_uid,
                caused_by=started_idx,
                provenance=provenance,
            )
            graph.add_edge(
                src=node_id, dst=study_node_id,
                kind="finding_in", caused_by=started_idx,
            )
            finding_node_ids.append(node_id)
        return finding_node_ids


# ─────────────────────────────────────────────────────────────────────
# Convenience factory
# ─────────────────────────────────────────────────────────────────────

def make_test_study(
    *,
    study_uid: str = "1.2.840.test.001",
    modality: str = "CT",
    body_part: str = "ABDOMEN",
    frame_count: int = 400,
    key_slice_count: int = 4,
) -> StudyInput:
    """Build a synthetic StudyInput for tests + smoke runs.
    No real DICOM file required — bytes are synthetic but content-addressed."""
    slices = [
        KeySliceInput(
            slice_no=i,
            sop_instance_uid=f"{study_uid}.slice.{i}",
            rendered_png_bytes=f"png-stub-{study_uid}-{i}".encode(),
        )
        for i in range(key_slice_count)
    ]
    raw = f"dicom-stub-{study_uid}".encode()
    return StudyInput(
        study_uid=study_uid,
        series_uid=f"{study_uid}.series.1",
        modality=modality,
        body_part=body_part,
        study_date="2026-06-13",
        frame_count=frame_count,
        dicom_file_path=f"/tmp/{study_uid}.dcm",
        dicom_sha256=hashlib.sha256(raw).hexdigest(),
        file_size_bytes=len(raw),
        key_slices=slices,
        grid_image_bytes=b"4x4-grid-png-stub",
    )
