"""MONAI Bundle loader + Provenance adapter.

The thin adapter that closes Rev-6 / R16 (MONAI Bundle metadata schema
drift vs. our typed ``node_provenance`` schema). Compatibility test in
CI loads every shipped Bundle and asserts the adapter produces the
expected Provenance row shape.

MONAI Bundle directory layout
=============================

::

    <bundle_root>/
    └── <bundle_id>/                       e.g. quick_scan_4x4_grid
        ├── configs/
        │   ├── metadata.json              required — name, version, license, …
        │   └── inference.json             required — backend + runtime config
        ├── models/                        optional — model weights (M1.5+)
        │   └── model.pt | model.mlpackage
        ├── docs/                          optional — markdown notes
        └── LICENSE                        required for non-Apache bundles

Bundle ID convention
====================

A Bundle is identified by ``"<name>@<version>"``, e.g.
``"quick_scan_4x4_grid@0.3.0"``. This string is what lands in
``node_provenance.extraction_model``. The bundle_loader resolves it
to a directory under ``BUNDLE_ROOT``.

Per Rev-6, the Bundle id + the ``prompt_id`` from inference.json are the
two strings that uniquely identify the (model, prompt, version) tuple
behind any extracted node. Five years from now, looking at a provenance
row plus the bundle_root archive snapshot, an auditor can reproduce
exactly which model/prompt produced the extraction.
"""

from __future__ import annotations

import hashlib
import json
import logging
import pathlib
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# Root of shipped Bundle artifacts. Resolved relative to this module so
# the runtime can find bundles regardless of where the server is invoked.
BUNDLE_ROOT = pathlib.Path(__file__).parent / "bundles"


# Acceptable Bundle licenses. Strict allowlist — adding a license requires
# explicit review of redistribution terms (Rev-6 / open question §14.9).
ACCEPTABLE_LICENSES = frozenset({
    "Apache-2.0",
    "MIT",
    "BSD-3-Clause",
    "BSD-2-Clause",
    # NVIDIA Source Code License is NOT in this allowlist — explicit per-Bundle
    # review required before shipping.
})


# ─────────────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────────────

class BundleLoadError(Exception):
    """Bundle directory missing, malformed, or required fields absent."""


class BundleLicenseError(BundleLoadError):
    """Bundle has a license not in ACCEPTABLE_LICENSES.

    Refuse to load such bundles by default; add to the allowlist only
    after explicit license review. CI lint scans the bundles directory
    and flags any bundle with an unreviewed license.
    """


# ─────────────────────────────────────────────────────────────────────
# Typed bundle records
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class BundleMeta:
    """Parsed from ``configs/metadata.json``.

    Field names follow MONAI Bundle spec where they exist; new fields
    (backend_kind, prompt_id) are our extensions for the Provenance
    adapter.
    """
    bundle_id: str                  # canonical "<name>@<version>"
    name: str
    version: str
    format_version: str             # MONAI bundle format version
    monai_version: Optional[str]
    description: str
    license: str
    authors: tuple[str, ...]
    modalities: tuple[str, ...]     # which DICOM modalities this Bundle covers
    inputs: dict                    # MONAI ``network_data_format.inputs``
    outputs: dict                   # MONAI ``network_data_format.outputs``
    bundle_dir: pathlib.Path
    bundle_sha256: str = ""         # computed at load time


@dataclass(frozen=True)
class BundleInferenceConfig:
    """Parsed from ``configs/inference.json``.

    The ``backend_kind`` is OUR extension — points at one of the
    inference_backend implementations. Standard MONAI bundles
    typically declare a ``network_def`` PyTorch class; we extend this
    with backend dispatch so a Bundle can wrap any model (PyTorch,
    Gemini API call, CoreML, etc.) under the same packaging.
    """
    backend_kind: str               # "gemini_flash_quick_scan" | "coreml_2d" | …
    prompt_id: Optional[str]        # for LLM-backed bundles
    prompt_version: Optional[str]
    network_def: Optional[dict]     # MONAI ``network_def`` — PyTorch-backed bundles only
    preprocessing: dict
    postprocessing: dict
    extra: dict = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────
# Loading
# ─────────────────────────────────────────────────────────────────────

def load_bundle(
    bundle_id: str,
    *,
    root: pathlib.Path = BUNDLE_ROOT,
    strict_license: bool = True,
) -> tuple[BundleMeta, BundleInferenceConfig]:
    """Load a Bundle by its canonical id (``"<name>@<version>"``).

    Returns ``(BundleMeta, BundleInferenceConfig)``.

    Raises:
        BundleLoadError: directory missing or required fields absent.
        BundleLicenseError: license not in ACCEPTABLE_LICENSES (when
            ``strict_license=True``).
    """
    name, version = _parse_bundle_id(bundle_id)
    bundle_dir = root / name
    if not bundle_dir.is_dir():
        raise BundleLoadError(f"bundle dir not found: {bundle_dir}")

    meta_path = bundle_dir / "configs" / "metadata.json"
    inference_path = bundle_dir / "configs" / "inference.json"
    if not meta_path.exists():
        raise BundleLoadError(f"missing metadata.json: {meta_path}")
    if not inference_path.exists():
        raise BundleLoadError(f"missing inference.json: {inference_path}")

    meta_raw = json.loads(meta_path.read_text(encoding="utf-8"))
    inference_raw = json.loads(inference_path.read_text(encoding="utf-8"))

    # Version check.
    if meta_raw.get("version") != version:
        raise BundleLoadError(
            f"bundle id version ({version}) does not match "
            f"metadata.json version ({meta_raw.get('version')!r})"
        )

    license_str = meta_raw.get("license", "UNKNOWN")
    if strict_license and license_str not in ACCEPTABLE_LICENSES:
        raise BundleLicenseError(
            f"bundle {bundle_id} has license {license_str!r}; "
            f"not in ACCEPTABLE_LICENSES. Add via explicit license review."
        )

    bundle_sha256 = _hash_bundle_dir(bundle_dir)

    meta = BundleMeta(
        bundle_id=bundle_id,
        name=meta_raw["name"],
        version=meta_raw["version"],
        format_version=meta_raw.get("format_version", "0.1.0"),
        monai_version=meta_raw.get("monai_version"),
        description=meta_raw.get("description", ""),
        license=license_str,
        authors=tuple(meta_raw.get("authors", [])),
        modalities=tuple(meta_raw.get("modalities", [])),
        inputs=meta_raw.get("network_data_format", {}).get("inputs", {}),
        outputs=meta_raw.get("network_data_format", {}).get("outputs", {}),
        bundle_dir=bundle_dir,
        bundle_sha256=bundle_sha256,
    )
    cfg = BundleInferenceConfig(
        backend_kind=inference_raw.get("backend_kind", "unknown"),
        prompt_id=inference_raw.get("prompt_id"),
        prompt_version=inference_raw.get("prompt_version"),
        network_def=inference_raw.get("network_def"),
        preprocessing=inference_raw.get("preprocessing", {}),
        postprocessing=inference_raw.get("postprocessing", {}),
        extra={k: v for k, v in inference_raw.items()
               if k not in {"backend_kind", "prompt_id", "prompt_version",
                            "network_def", "preprocessing", "postprocessing"}},
    )

    logger.info(
        "loaded bundle id=%s license=%s backend=%s sha256=%s",
        bundle_id, license_str, cfg.backend_kind, bundle_sha256[:12],
    )
    return meta, cfg


def list_bundles(root: pathlib.Path = BUNDLE_ROOT) -> list[BundleMeta]:
    """Enumerate every well-formed Bundle in ``root``.

    Bundles that fail to load are logged and skipped — useful for CI
    where we don't want one bad Bundle to mask others.
    """
    out: list[BundleMeta] = []
    if not root.is_dir():
        return out
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        meta_path = child / "configs" / "metadata.json"
        if not meta_path.exists():
            continue
        try:
            raw = json.loads(meta_path.read_text(encoding="utf-8"))
            version = raw["version"]
            name = raw["name"]
            bundle_id = f"{name}@{version}"
            meta, _ = load_bundle(bundle_id, root=root, strict_license=False)
            out.append(meta)
        except Exception as exc:
            logger.warning("skipping malformed bundle dir %s: %s", child, exc)
    return out


# ─────────────────────────────────────────────────────────────────────
# Provenance adapter — the load-bearing Rev-6 R16 mitigation
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ProvenanceRefs:
    """The subset of node_provenance fields a Bundle determines.

    Returned by ``bundle_to_provenance_refs``. The ingester combines
    this with per-extraction fields (evidence_quote, confidence, etc)
    to build the full Provenance row.
    """
    extraction_model: str       # e.g. "monai-bundle://quick_scan_4x4_grid@0.3.0"
    extraction_prompt_id: str   # e.g. "quick_scan_triage_v3"


def bundle_to_provenance_refs(
    meta: BundleMeta,
    cfg: BundleInferenceConfig,
) -> ProvenanceRefs:
    """Map a loaded Bundle to the Provenance fields that identify it.

    Stable convention:
    * ``extraction_model = "monai-bundle://<name>@<version>"`` — schema
      indicator prefix makes Bundle-backed extractions visually
      distinguishable from raw model calls in provenance audits.
    * ``extraction_prompt_id`` falls back to a synthetic id when the
      bundle isn't LLM-prompt-backed (e.g. CoreML classifiers carry
      a ``prompt_id`` of the form ``"coreml-postproc/<name>"``).

    Per Rev-6, this single function is the contract. Drift in MONAI
    Bundle spec is absorbed here — the rest of the codebase sees only
    our typed Provenance schema.
    """
    extraction_model = f"monai-bundle://{meta.bundle_id}"
    if cfg.prompt_id:
        extraction_prompt_id = cfg.prompt_id
        if cfg.prompt_version:
            extraction_prompt_id = f"{cfg.prompt_id}@{cfg.prompt_version}"
    else:
        extraction_prompt_id = f"{cfg.backend_kind}-postproc/{meta.name}"
    return ProvenanceRefs(
        extraction_model=extraction_model,
        extraction_prompt_id=extraction_prompt_id,
    )


# ─────────────────────────────────────────────────────────────────────
# Hashing helpers
# ─────────────────────────────────────────────────────────────────────

def _hash_bundle_dir(bundle_dir: pathlib.Path) -> str:
    """SHA-256 over the Bundle's deterministic content (configs + models).

    Used for audit: the hash recorded at load time can be re-computed
    later to verify the Bundle on disk hasn't been tampered with.
    """
    h = hashlib.sha256()
    # Walk in sorted order for determinism.
    for path in sorted(bundle_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(bundle_dir).as_posix()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(path.read_bytes())
    return h.hexdigest()


def _parse_bundle_id(bundle_id: str) -> tuple[str, str]:
    if "@" not in bundle_id:
        raise BundleLoadError(
            f"bundle_id must be '<name>@<version>'; got {bundle_id!r}"
        )
    name, _, version = bundle_id.partition("@")
    if not name or not version:
        raise BundleLoadError(f"empty name or version in bundle_id {bundle_id!r}")
    return name, version
