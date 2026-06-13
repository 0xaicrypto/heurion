"""MONAI runtime tests — Bundle loader + Provenance adapter + backends.

Per ADR-002 Rev-6 / Rev-9 R16, this is the CI gate that catches
Bundle ↔ Provenance schema drift. Every shipped Bundle is loaded
and asserted against the expected Provenance adapter output.
"""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest

from nexus_server.monai_runtime import (
    BUNDLE_ROOT,
    ACCEPTABLE_LICENSES,
    BackendUnavailable,
    BundleLicenseError,
    BundleLoadError,
    GeminiFlash2DBackend,
    GeminiFlashQuickScanBackend,
    InferenceInput,
    StubBackend,
    bundle_to_provenance_refs,
    list_bundles,
    load_bundle,
    resolve_backend,
)


# ─────────────────────────────────────────────────────────────────────
# Shipped Bundle: quick_scan_4x4_grid
# ─────────────────────────────────────────────────────────────────────

class TestQuickScanBundle:
    """The first shipped Bundle. Validates Rev-6 end-to-end."""

    def test_metadata_loads(self):
        meta, _ = load_bundle("quick_scan_4x4_grid@0.3.0")
        assert meta.name == "quick_scan_4x4_grid"
        assert meta.version == "0.3.0"
        assert meta.license in ACCEPTABLE_LICENSES
        assert "CT" in meta.modalities
        assert "MR" in meta.modalities

    def test_inference_config_loads(self):
        _, cfg = load_bundle("quick_scan_4x4_grid@0.3.0")
        assert cfg.backend_kind == "gemini_flash_quick_scan"
        assert cfg.prompt_id == "quick_scan_triage_v3"
        assert cfg.prompt_version == "3.0.0"
        # Safety policy: immutable disclaimer must be set
        assert cfg.postprocessing.get("disclaimer_immutable") is True

    def test_provenance_refs_produced(self):
        """Rev-6 R16 contract — Bundle metadata → Provenance fields.

        This is the single function whose stability the rest of the
        codebase depends on. Drift here surfaces in this test.
        """
        meta, cfg = load_bundle("quick_scan_4x4_grid@0.3.0")
        refs = bundle_to_provenance_refs(meta, cfg)
        assert refs.extraction_model == (
            "monai-bundle://quick_scan_4x4_grid@0.3.0"
        )
        assert refs.extraction_prompt_id == "quick_scan_triage_v3@3.0.0"

    def test_resolves_to_quickscan_backend(self):
        _, cfg = load_bundle("quick_scan_4x4_grid@0.3.0")
        backend = resolve_backend(cfg)
        assert isinstance(backend, GeminiFlashQuickScanBackend)

    def test_bundle_dir_sha_stable_across_loads(self):
        """Sha256 over the Bundle's content must be deterministic.
        Same Bundle on disk → same hash on every load. Audit relies on it."""
        meta1, _ = load_bundle("quick_scan_4x4_grid@0.3.0")
        meta2, _ = load_bundle("quick_scan_4x4_grid@0.3.0")
        assert meta1.bundle_sha256 == meta2.bundle_sha256
        assert len(meta1.bundle_sha256) == 64  # hex sha256


# ─────────────────────────────────────────────────────────────────────
# Bundle loader error cases
# ─────────────────────────────────────────────────────────────────────

class TestBundleLoaderErrors:
    def test_missing_bundle_id_format(self):
        with pytest.raises(BundleLoadError, match="<name>@<version>"):
            load_bundle("not-a-version-id")

    def test_unknown_bundle(self):
        with pytest.raises(BundleLoadError, match="bundle dir not found"):
            load_bundle("nonexistent@1.0.0")

    def test_version_mismatch(self, tmp_path):
        # Construct a malformed Bundle with name@version not matching metadata.
        bundle_root = tmp_path
        b = bundle_root / "fake"
        (b / "configs").mkdir(parents=True)
        (b / "configs" / "metadata.json").write_text(json.dumps({
            "name": "fake", "version": "1.0.0",
            "license": "Apache-2.0", "format_version": "1.0",
        }))
        (b / "configs" / "inference.json").write_text(json.dumps({
            "backend_kind": "stub"
        }))
        with pytest.raises(BundleLoadError, match="does not match"):
            load_bundle("fake@2.0.0", root=bundle_root)

    def test_unacceptable_license_rejected(self, tmp_path):
        bundle_root = tmp_path
        b = bundle_root / "evil"
        (b / "configs").mkdir(parents=True)
        (b / "configs" / "metadata.json").write_text(json.dumps({
            "name": "evil", "version": "1.0.0",
            "license": "PROPRIETARY", "format_version": "1.0",
        }))
        (b / "configs" / "inference.json").write_text(json.dumps({
            "backend_kind": "stub"
        }))
        with pytest.raises(BundleLicenseError, match="PROPRIETARY"):
            load_bundle("evil@1.0.0", root=bundle_root)


# ─────────────────────────────────────────────────────────────────────
# list_bundles enumeration
# ─────────────────────────────────────────────────────────────────────

class TestListBundles:
    def test_list_finds_quick_scan(self):
        all_bundles = list_bundles()
        names = {m.name for m in all_bundles}
        assert "quick_scan_4x4_grid" in names


# ─────────────────────────────────────────────────────────────────────
# Inference backends
# ─────────────────────────────────────────────────────────────────────

class TestInferenceBackends:
    def test_stub_deterministic(self):
        meta, cfg = load_bundle("quick_scan_4x4_grid@0.3.0")
        backend = StubBackend(response="ok")
        r1 = backend.run(meta, cfg, InferenceInput(text="hello"))
        r2 = backend.run(meta, cfg, InferenceInput(text="hello"))
        assert r1.raw_output_text == r2.raw_output_text
        assert r1.output_sha256 == r2.output_sha256

    def test_quickscan_backend_requires_grid(self):
        from nexus_server.monai_runtime import InferenceFailed
        meta, cfg = load_bundle("quick_scan_4x4_grid@0.3.0")
        backend = GeminiFlashQuickScanBackend()
        with pytest.raises(InferenceFailed, match="grid_image_bytes"):
            backend.run(meta, cfg, InferenceInput(text="no grid here"))

    def test_quickscan_backend_runs_stub(self):
        meta, cfg = load_bundle("quick_scan_4x4_grid@0.3.0")
        backend = GeminiFlashQuickScanBackend()
        result = backend.run(meta, cfg, InferenceInput(grid_image_bytes=b"png"))
        assert result.raw_output_text  # non-empty stub
        assert result.output_sha256
        assert "no_findings" in result.parsed.get("verdict", "")


# ─────────────────────────────────────────────────────────────────────
# Backend resolution + fallback (Rev-9 R17)
# ─────────────────────────────────────────────────────────────────────

class TestResolveBackend:
    def test_resolve_known(self):
        meta, cfg = load_bundle("quick_scan_4x4_grid@0.3.0")
        backend = resolve_backend(cfg)
        assert isinstance(backend, GeminiFlashQuickScanBackend)

    def test_unknown_backend_kind_raises(self, tmp_path):
        bundle_root = tmp_path
        b = bundle_root / "weird"
        (b / "configs").mkdir(parents=True)
        (b / "configs" / "metadata.json").write_text(json.dumps({
            "name": "weird", "version": "1.0.0",
            "license": "MIT", "format_version": "1.0",
        }))
        (b / "configs" / "inference.json").write_text(json.dumps({
            "backend_kind": "alien_backend_42"
        }))
        _, cfg = load_bundle("weird@1.0.0", root=bundle_root)
        with pytest.raises(BackendUnavailable, match="unknown backend_kind"):
            resolve_backend(cfg)

    def test_coreml_falls_back_on_non_mac(self, tmp_path, monkeypatch):
        # On Linux CI, CoreML is unavailable. Resolution should fall
        # back to gemini_flash_2d per Rev-9 R17.
        bundle_root = tmp_path
        b = bundle_root / "cxr"
        (b / "configs").mkdir(parents=True)
        (b / "configs" / "metadata.json").write_text(json.dumps({
            "name": "cxr", "version": "1.0.0",
            "license": "MIT", "format_version": "1.0",
        }))
        (b / "configs" / "inference.json").write_text(json.dumps({
            "backend_kind": "coreml_2d",
            "prompt_id": "cxr_triage",
        }))
        _, cfg = load_bundle("cxr@1.0.0", root=bundle_root)

        import sys
        # Force non-mac for this test (CI usually runs Linux anyway).
        monkeypatch.setattr(sys, "platform", "linux")

        backend = resolve_backend(cfg, allow_fallback=True)
        assert isinstance(backend, GeminiFlash2DBackend)

    def test_coreml_strict_mode_raises(self, tmp_path, monkeypatch):
        bundle_root = tmp_path
        b = bundle_root / "cxr2"
        (b / "configs").mkdir(parents=True)
        (b / "configs" / "metadata.json").write_text(json.dumps({
            "name": "cxr2", "version": "1.0.0",
            "license": "MIT", "format_version": "1.0",
        }))
        (b / "configs" / "inference.json").write_text(json.dumps({
            "backend_kind": "coreml_2d",
        }))
        _, cfg = load_bundle("cxr2@1.0.0", root=bundle_root)
        monkeypatch.setattr(sys, "platform", "linux")
        with pytest.raises(BackendUnavailable, match="not available"):
            resolve_backend(cfg, allow_fallback=False)
