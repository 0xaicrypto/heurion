# quick_scan_4x4_grid Bundle (0.3.0)

Nexus Quick scan wrapped as a MONAI Bundle. Apache-2.0.

## Purpose

Wrap the existing Gemini-Flash Quick scan pipeline (`nexus_server/quick_scan.py`)
behind the MONAI Bundle interface so it has the same provenance
footprint as every other extraction in Nexus memory. Per ADR-002 Rev-6.

## Bundle id

`quick_scan_4x4_grid@0.3.0`

This is the string that lands in `node_provenance.extraction_model`
as `monai-bundle://quick_scan_4x4_grid@0.3.0` (the `monai-bundle://`
schema indicator is prepended by `bundle_loader.bundle_to_provenance_refs`).

## Backend

`gemini_flash_quick_scan` — see `nexus_server/monai_runtime/inference_backend.py`.
On M0.5 the backend is a stub; M1 wires it to the real Quick scan
pipeline in `nexus_server/quick_scan.py`.

## Swap-in path

Per Rev-6, when the inference companion ships (M10):

* Bundle `quick_scan_4x4_grid@0.3.0` becomes `vista3d_local_companion@1.0.0`
* Backend changes from `gemini_flash_quick_scan` to `remote_monai_vista3d`
* `node_provenance.extraction_model` switches to
  `monai-bundle://vista3d_local_companion@1.0.0`
* Graph schema and downstream consumers do not change

This is the load-bearing reason the Bundle abstraction exists: the
swap doesn't require any consumer-side code changes.

## Files

* `configs/metadata.json` — Bundle metadata + intended-use + limitations
* `configs/inference.json` — backend kind + prompt id + pre/post-processing
* (no `models/` directory — this Bundle wraps an external API call, not
  a model file)

## Tests

`tests/test_monai_runtime.py::TestQuickScanBundle` loads this Bundle
and asserts:

* metadata.json parses to a valid `BundleMeta`
* inference.json parses to a valid `BundleInferenceConfig`
* `bundle_to_provenance_refs` produces the expected extraction_model
  + extraction_prompt_id strings
* the resolved `InferenceBackend` is `GeminiFlashQuickScanBackend`
