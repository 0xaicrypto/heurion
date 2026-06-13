"""Abstract inference backend — what a MONAI Bundle ultimately runs.

A MONAI Bundle declares its execution path via ``inference.json``'s
``backend_kind`` field. This module defines the interface and ships
the M0.5 implementations:

- ``gemini_flash_quick_scan`` — current Quick scan path, wrapped
- ``gemini_flash_2d`` — single-image VLM call (for 2D modalities
  where no CoreML model is shipped)
- ``coreml_2d`` — CoreML inference on Apple Neural Engine
  (Mac-only; falls back to gemini_flash_2d on other OS or
  when ANE is unavailable per Rev-9 R17)
- ``stub`` — deterministic test backend

Replay determinism (Rev-8)
==========================

Backends are called at *write time* by ingesters. The raw output goes
into ``ingestion_llm_response`` events verbatim. Replay never calls
backends — it reads the archived output. So backend non-determinism
(LLM token sampling) only affects original ingestion, never replay.

For CoreML 2D classifiers the model itself IS deterministic given
weights + version; we record vector/output sha256 in the event so
replay can re-verify integrity (and the inference companion CI can
catch encoder weight drift per Rev-9 R24).
"""

from __future__ import annotations

import hashlib
import logging
import sys
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

from nexus_server.monai_runtime.bundle_loader import (
    BundleInferenceConfig,
    BundleMeta,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────────────

class BackendUnavailable(Exception):
    """The requested backend can't run in this environment.

    Examples:
    - coreml_2d on non-Mac OS
    - coreml_2d on a Mac without ANE
    - gemini_flash_* without an API key configured

    Per Rev-9 R17, callers are expected to fall back gracefully (e.g.
    coreml_2d → gemini_flash_2d) and log a `cost_degradation` event.
    """


class InferenceFailed(Exception):
    """The backend was available but the call failed (network / parse
    / etc). Distinct from unavailable so callers can retry vs. fall back."""


# ─────────────────────────────────────────────────────────────────────
# DTOs
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class InferenceInput:
    """What an ingester hands to a backend.

    For text-only LLM bundles (chat_extract_*), only ``text`` is set.
    For 2D vision (chest x-ray triage), ``image_bytes`` is set.
    For Quick scan (3D), ``grid_image_bytes`` carries the 4×4 grid PNG.
    """
    text: Optional[str] = None
    image_bytes: Optional[bytes] = None
    grid_image_bytes: Optional[bytes] = None
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class InferenceResult:
    """What a backend returns.

    ``raw_output_text`` is the field that gets stored verbatim in the
    ``ingestion_llm_response`` event. Replay reads this — never re-calls
    the backend.
    """
    raw_output_text: str
    parsed: dict = field(default_factory=dict)
    confidence: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: int = 0
    output_sha256: str = ""   # for deterministic-backend integrity check


# ─────────────────────────────────────────────────────────────────────
# Abstract base
# ─────────────────────────────────────────────────────────────────────

class InferenceBackend(ABC):
    """Backend interface. Implementations register against a
    ``backend_kind`` string used by the Bundle's inference.json."""

    @property
    @abstractmethod
    def backend_kind(self) -> str: ...

    @abstractmethod
    def is_available(self) -> bool:
        """Return True iff this backend can run on this OS / config.

        Called by ``resolve_backend`` to pick the right impl + raise
        ``BackendUnavailable`` early when none is available."""

    @abstractmethod
    def run(
        self,
        bundle_meta: BundleMeta,
        cfg: BundleInferenceConfig,
        input: InferenceInput,
    ) -> InferenceResult: ...


# ─────────────────────────────────────────────────────────────────────
# Implementations
# ─────────────────────────────────────────────────────────────────────

class GeminiFlash2DBackend(InferenceBackend):
    """Gemini Flash on a single 2D image. Used for X-rays, dermatology,
    fundus screening, etc. where no CoreML model is shipped (or as
    fallback when CoreML is unavailable)."""

    @property
    def backend_kind(self) -> str:
        return "gemini_flash_2d"

    def is_available(self) -> bool:
        # Real check would verify an API key. In M0.5 we assume yes
        # since llm_gateway is already used by quick_scan.
        return True

    def run(
        self,
        bundle_meta: BundleMeta,
        cfg: BundleInferenceConfig,
        input: InferenceInput,
    ) -> InferenceResult:
        if input.image_bytes is None:
            raise InferenceFailed("gemini_flash_2d requires image_bytes")
        # M0.5 stub — real impl wires to llm_gateway with the bundle's
        # prompt_id / prompt_version. Returns a fake response that
        # replay can verify against the event archive.
        started = time.time()
        prompt = f"[bundle={bundle_meta.bundle_id} prompt={cfg.prompt_id}]"
        raw = f"{prompt} stub response: no findings (M0.5 stub)"
        latency_ms = int((time.time() - started) * 1000)
        return InferenceResult(
            raw_output_text=raw,
            parsed={"findings": []},
            confidence=0.5,
            tokens_in=len(prompt) // 4,
            tokens_out=len(raw) // 4,
            latency_ms=latency_ms,
            output_sha256=hashlib.sha256(raw.encode()).hexdigest(),
        )


class GeminiFlashQuickScanBackend(InferenceBackend):
    """Existing Quick scan path wrapped behind the Bundle abstraction.

    For 3D volumes: ingester renders 4×4 grids of key slices via the
    existing prerender pipeline; this backend takes the grid PNG and
    runs the current Quick scan prompt against Gemini Flash.

    Per Rev-6, this is Stage 2C of the modality routing. When the
    inference companion ships (M10), this backend's ``run`` is
    replaced by remote MONAI VISTA-3D; the Bundle id changes but the
    backend interface (and graph schema downstream) stays identical.
    """

    @property
    def backend_kind(self) -> str:
        return "gemini_flash_quick_scan"

    def is_available(self) -> bool:
        return True

    def run(
        self,
        bundle_meta: BundleMeta,
        cfg: BundleInferenceConfig,
        input: InferenceInput,
    ) -> InferenceResult:
        if input.grid_image_bytes is None:
            raise InferenceFailed(
                "gemini_flash_quick_scan requires grid_image_bytes"
            )
        # M0.5 stub — calls existing quick_scan module in real impl.
        started = time.time()
        prompt = (
            f"[bundle={bundle_meta.bundle_id} prompt={cfg.prompt_id}] "
            f"Quick scan triage of 4x4 grid"
        )
        raw = (
            f"{prompt}\n"
            f"Stub triage: 0 findings flagged. "
            f"This is the M0.5 backend stub; M1 wires to the real "
            f"nexus_server.quick_scan pipeline."
        )
        latency_ms = int((time.time() - started) * 1000)
        return InferenceResult(
            raw_output_text=raw,
            parsed={"slices_flagged": [], "verdict": "no_findings"},
            confidence=0.4,
            latency_ms=latency_ms,
            output_sha256=hashlib.sha256(raw.encode()).hexdigest(),
        )


class StubBackend(InferenceBackend):
    """Deterministic test backend. Used by event-sourcing tests and
    by ingester unit tests. Output is content-addressed by input text
    so replay verification is trivially exact."""

    def __init__(self, response: str = "stub-ok") -> None:
        self._response = response

    @property
    def backend_kind(self) -> str:
        return "stub"

    def is_available(self) -> bool:
        return True

    def run(
        self,
        bundle_meta: BundleMeta,
        cfg: BundleInferenceConfig,
        input: InferenceInput,
    ) -> InferenceResult:
        composite = f"{bundle_meta.bundle_id}|{cfg.prompt_id}|{input.text or ''}"
        sha = hashlib.sha256(composite.encode()).hexdigest()
        raw = f"{self._response}@{sha[:12]}"
        return InferenceResult(
            raw_output_text=raw,
            parsed={"echo": self._response, "input_sha": sha},
            confidence=1.0,
            latency_ms=0,
            output_sha256=hashlib.sha256(raw.encode()).hexdigest(),
        )


# ─────────────────────────────────────────────────────────────────────
# CoreML — Mac-only. On other OS, is_available() returns False and the
# caller falls back to GeminiFlash2DBackend per Rev-9 R17.
# ─────────────────────────────────────────────────────────────────────

class CoreMLBackend(InferenceBackend):
    """Apple Neural Engine inference via CoreML. M1.5 will swap the
    stub for a real coremltools / pyobjc bridge.

    Per Rev-9 R17:
    - On non-Mac: ``is_available`` returns False; caller falls back.
    - On Intel Mac (no ANE): is_available could return False to force
      fallback (TBD per benchmarking spike).
    - On Apple Silicon: True; runs on ANE.
    """

    @property
    def backend_kind(self) -> str:
        return "coreml_2d"

    def is_available(self) -> bool:
        # M0.5: only available on darwin + arm64. Real check will
        # also probe ANE via Apple's Metal Performance Shaders APIs.
        if sys.platform != "darwin":
            return False
        import platform
        return platform.machine() in {"arm64", "aarch64"}

    def run(
        self,
        bundle_meta: BundleMeta,
        cfg: BundleInferenceConfig,
        input: InferenceInput,
    ) -> InferenceResult:
        if not self.is_available():
            raise BackendUnavailable(
                "coreml_2d requires macOS Apple Silicon"
            )
        # M0.5 stub — real impl loads the .mlpackage from
        # bundle_dir / 'models' / 'model.mlpackage' and runs inference.
        # The Bundle's inference.json declares input/output transforms.
        raise BackendUnavailable(
            "coreml_2d backend not yet implemented; M1.5 spike will "
            "land coremltools wiring + BiomedCLIP conversion path"
        )


# ─────────────────────────────────────────────────────────────────────
# Backend registry + resolver
# ─────────────────────────────────────────────────────────────────────

_BACKEND_REGISTRY: dict[str, type[InferenceBackend]] = {
    "gemini_flash_2d":         GeminiFlash2DBackend,
    "gemini_flash_quick_scan": GeminiFlashQuickScanBackend,
    "coreml_2d":               CoreMLBackend,
    "stub":                    StubBackend,
}


def resolve_backend(
    cfg: BundleInferenceConfig,
    *,
    allow_fallback: bool = True,
) -> InferenceBackend:
    """Resolve a Bundle's backend_kind to a runnable InferenceBackend.

    Per Rev-9 R17, when the declared backend is unavailable (e.g.
    coreml_2d on a non-Mac), this function transparently falls back
    to ``gemini_flash_2d`` and the caller is expected to record a
    ``cost_degradation`` event noting the fallback path. Set
    ``allow_fallback=False`` to raise BackendUnavailable instead.
    """
    declared_kind = cfg.backend_kind
    if declared_kind not in _BACKEND_REGISTRY:
        raise BackendUnavailable(
            f"unknown backend_kind in bundle inference.json: "
            f"{declared_kind!r}; known: {list(_BACKEND_REGISTRY)}"
        )

    cls = _BACKEND_REGISTRY[declared_kind]
    backend = cls()
    if backend.is_available():
        return backend

    if not allow_fallback:
        raise BackendUnavailable(
            f"backend {declared_kind!r} not available on this OS"
        )

    # Fallback path: coreml_2d → gemini_flash_2d
    if declared_kind == "coreml_2d":
        fallback = GeminiFlash2DBackend()
        if fallback.is_available():
            logger.warning(
                "backend %s unavailable; falling back to %s "
                "(per Rev-9 R17). Caller should emit cost_degradation event.",
                declared_kind, fallback.backend_kind,
            )
            return fallback

    raise BackendUnavailable(
        f"backend {declared_kind!r} unavailable and no fallback found"
    )
