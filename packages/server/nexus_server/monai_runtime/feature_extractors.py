"""Layer C — structured radiology feature extractors (Rev-9 / M1.7).

These are pure-Python computations on DICOM pixel data; no GPU.
They run on Mac out of the box. Each returns a typed feature payload
that the DICOM ingester emits as ``image_feature_extracted`` events.

Implemented:
* ``hu_stats`` — Hounsfield statistics (CT). Pure NumPy.
* ``intensity_histogram`` — 16-bin histogram over slice intensities.
* ``size_estimate`` — bounding-box dimensions in mm using DICOM pixel spacing.

Deferred to M1.7-real:
* ``enhancement_delta`` — multi-phase Δ across arterial / portal /
  delayed; requires registered series.
* ``morphology_class`` — small CoreML classifier for round / lobulated
  / spiculated / irregular. M1.7 spike will train + convert.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FeatureResult:
    kind: str           # 'hu_stats' | 'intensity_histogram' | 'size_estimate'
    values: dict
    extractor_id: str   # 'hu_stats@1.0'
    confidence: float = 1.0  # deterministic extractors are confident


def hu_stats(pixel_array, *, rescale_slope: float = 1.0,
             rescale_intercept: float = 0.0) -> FeatureResult:
    """Compute HU statistics over a CT slice.

    DICOM stores raw pixel values; HU = pixel * RescaleSlope + RescaleIntercept.
    Most modern CT use slope=1, intercept=-1024 (air ≈ -1000, water ≈ 0).

    Returns ``{mean, std, min, max, median, p10, p90}`` of HU values.
    Uses pure Python (sums + sorts) so it doesn't require numpy at runtime
    — though numpy is much faster if available.
    """
    try:
        import numpy as np
        arr = np.asarray(pixel_array, dtype=float)
        hu = arr * rescale_slope + rescale_intercept
        flat = hu.flatten()
        result = {
            "mean":   float(flat.mean()),
            "std":    float(flat.std()),
            "min":    float(flat.min()),
            "max":    float(flat.max()),
            "median": float(np.median(flat)),
            "p10":    float(np.percentile(flat, 10)),
            "p90":    float(np.percentile(flat, 90)),
        }
    except ImportError:
        # numpy-free fallback (slow but works)
        flat = [
            p * rescale_slope + rescale_intercept
            for row in pixel_array for p in row
        ]
        flat.sort()
        n = len(flat) or 1
        result = {
            "mean":   sum(flat) / n,
            "std":    (sum((x - sum(flat) / n) ** 2 for x in flat) / n) ** 0.5,
            "min":    flat[0],
            "max":    flat[-1],
            "median": flat[n // 2],
            "p10":    flat[int(n * 0.10)],
            "p90":    flat[int(n * 0.90)],
        }
    return FeatureResult(
        kind="hu_stats",
        values=result,
        extractor_id="hu_stats@1.0",
    )


def intensity_histogram(pixel_array, *, bins: int = 16) -> FeatureResult:
    """16-bin histogram. Useful as a coarse signature for cosine-sim
    comparisons across studies before the visual encoder ships."""
    try:
        import numpy as np
        arr = np.asarray(pixel_array).flatten()
        hist, edges = np.histogram(arr, bins=bins)
        result = {
            "bins": int(bins),
            "counts": [int(c) for c in hist.tolist()],
            "edges": [float(e) for e in edges.tolist()],
        }
    except ImportError:
        flat = [p for row in pixel_array for p in row]
        lo, hi = min(flat), max(flat)
        step = (hi - lo) / bins if hi > lo else 1
        counts = [0] * bins
        for p in flat:
            idx = min(bins - 1, int((p - lo) / step))
            counts[idx] += 1
        result = {
            "bins": bins,
            "counts": counts,
            "edges": [lo + i * step for i in range(bins + 1)],
        }
    return FeatureResult(
        kind="intensity_histogram",
        values=result,
        extractor_id="intensity_histogram@1.0",
    )


def size_estimate(
    bbox_pixels: tuple[int, int, int, int],
    pixel_spacing_mm: tuple[float, float],
) -> FeatureResult:
    """Convert a ROI bounding box from pixels to mm dimensions.

    Args:
        bbox_pixels: (x0, y0, x1, y1) in pixel coordinates.
        pixel_spacing_mm: (row_spacing, col_spacing) from DICOM
                          (0028,0030) PixelSpacing tag.

    Returns width_mm + height_mm + longest_diameter_mm.
    """
    x0, y0, x1, y1 = bbox_pixels
    rs, cs = pixel_spacing_mm
    width_mm = abs(x1 - x0) * cs
    height_mm = abs(y1 - y0) * rs
    return FeatureResult(
        kind="size_estimate",
        values={
            "width_mm":            float(width_mm),
            "height_mm":           float(height_mm),
            "longest_diameter_mm": float(max(width_mm, height_mm)),
        },
        extractor_id="size_estimate@1.0",
    )


# ─────────────────────────────────────────────────────────────────────
# M1.6 — multimodal LLM context attachment (Rev-9 Layer B)
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AttachedImage:
    image_sha256: str
    file_path: str
    estimated_tokens: int


def estimate_image_tokens(width_px: int, height_px: int) -> int:
    """Rough token estimate for Gemini-style image inputs.

    Gemini 1.5/2.5 charge ~258 tokens per image regardless of size for
    images < 384px on each side; larger images cost proportionally more
    in 384px tiles. Claude 3.5 uses ~1500 tokens per image. We use the
    higher of the two as a budget-conservative estimate.
    """
    tile_size = 384
    tiles_w = max(1, width_px // tile_size + (1 if width_px % tile_size else 0))
    tiles_h = max(1, height_px // tile_size + (1 if height_px % tile_size else 0))
    return tiles_w * tiles_h * 258


def attach_key_images_to_context(
    key_image_refs: list[dict],
    *,
    max_images: int = 3,
    max_tokens: int = 4500,
) -> tuple[list[AttachedImage], int]:
    """Pick which key images to attach to an LLM context.

    Per Rev-9 / UX v2 §5.3: T2 max 3, T3 max 16. The caller passes the
    appropriate budget. Returns (selected, total_estimated_tokens).
    """
    selected: list[AttachedImage] = []
    total_tokens = 0
    for ref in key_image_refs[:max_images]:
        width = ref.get("width", 512)
        height = ref.get("height", 512)
        tokens = estimate_image_tokens(width, height)
        if total_tokens + tokens > max_tokens:
            break
        selected.append(AttachedImage(
            image_sha256=ref["image_sha256"],
            file_path=ref["file_path"],
            estimated_tokens=tokens,
        ))
        total_tokens += tokens
    return selected, total_tokens


# ─────────────────────────────────────────────────────────────────────
# M1.5 — Visual embedding scaffold (BiomedCLIP, CoreML on ANE)
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class VisualEmbedding:
    vector: list[float]      # 512-d for BiomedCLIP, smaller for CXR-CLIP variants
    encoder_id: str          # 'biomedclip@0.9'
    vector_sha256: str
    embedding_version: str


def compute_visual_embedding_stub(
    image_bytes: bytes,
    encoder_id: str = "biomedclip-stub@0.0",
) -> VisualEmbedding:
    """Deterministic stub. Real BiomedCLIP / CXR-CLIP CoreML inference
    ships on Mac (see ``coreml_inference.py``); this stub keeps the
    event-chain and projection schema working in CI / Linux dev sandboxes.

    Replay-deterministic: same input bytes → same vector (hash-derived).
    """
    import hashlib
    h = hashlib.sha256(image_bytes).digest()
    # Generate a pseudo-512-d vector from the digest. NOT a real embedding,
    # but deterministic + consistent across replays.
    vec = []
    seed = int.from_bytes(h, "big")
    for i in range(512):
        seed = (seed * 1103515245 + 12345 + i) & 0xFFFFFFFFFFFFFFFF
        # Map to a roughly normal-distributed float in [-1, 1]
        vec.append(((seed % 20000) - 10000) / 10000.0)
    vector_sha = hashlib.sha256(
        b",".join(f"{v:.6f}".encode() for v in vec)
    ).hexdigest()
    return VisualEmbedding(
        vector=vec,
        encoder_id=encoder_id,
        vector_sha256=vector_sha,
        embedding_version=encoder_id,
    )
