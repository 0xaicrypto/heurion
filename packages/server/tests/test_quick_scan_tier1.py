"""
Regression tests for Quick scan Tier-1 improvements (#196).

What changed:
  ① ``dicom.render_grid_png`` now accepts ``slice_start, slice_end`` —
     so quick_scan can produce DENSE per-range grids instead of one
     uniform whole-series overview. This fixes the silent TypeError
     fallback that had quick_scan triaging a 500-slice CT from a
     single 16-thumbnail image.

  ② Per-cell resolution bumped from 256 → 384 px (1024² → 1536² total
     PNG). 5 mm findings now render at ~5 px diameter instead of ~3 px.

  ③ Chest / lung / whole-body CT studies render 3 window presets
     (lung / mediastinum / bone) instead of one — each preset gets
     its own Phase-1 pass with a window-aware prompt.

  ④ The ``except TypeError: ... break`` fallback in
     ``_render_batched_grids`` is GONE. Its presence used to mask the
     signature mismatch and silently degrade scans. The test guards
     against it being re-added.

Guarded behaviours:
  - render_grid_png samples WITHIN the given slice range, not the full series.
  - Chest body parts → 3 presets; other body parts → 1.
  - GridFinding carries the window through to the metadata dict.
  - Phase-1 prompt includes the window hint.
  - Cell size bumped.
  - Broken fallback removed.
"""
from __future__ import annotations

import pathlib
import re
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


# ─────────────────────────────────────────────────────────────────────
# ① render_grid_png signature + sampling behaviour
# ─────────────────────────────────────────────────────────────────────


def _fake_series(n: int):
    """Build a tiny DicomSeries with n synthetic instances we can use
    without pydicom — the test patches pydicom.dcmread so we never
    actually decode anything."""
    from pathlib import Path as _Path
    from nexus_server.dicom import DicomSeries, DicomInstance
    insts = [
        DicomInstance(
            sop_instance_uid=f"sop-{i}",
            instance_number=i,
            file_path=_Path(f"/dev/null/inst-{i}.dcm"),
            z_position=float(i),
        )
        for i in range(n)
    ]
    s = DicomSeries(
        series_instance_uid="series-1",
        series_number=1,
        modality="CT",
        body_part="CHEST",
        series_description="thin slice",
        instances=insts,
    )
    return s


def test_render_grid_png_accepts_slice_start_end(monkeypatch):
    """Calling render_grid_png(..., slice_start=, slice_end=) must NOT
    raise TypeError. This is the silent-fallback bug #196 fixed."""
    import inspect
    from nexus_server.dicom import render_grid_png
    sig = inspect.signature(render_grid_png)
    params = sig.parameters
    assert "slice_start" in params, (
        "render_grid_png must accept slice_start so quick_scan can "
        "render dense per-range grids. Without it the batched scan "
        "silently degrades to a single whole-series overview."
    )
    assert "slice_end" in params, "missing slice_end keyword arg"


def test_render_grid_png_samples_within_range_only(monkeypatch):
    """Behavioural: with slice_start=10, slice_end=25 on a 500-slice
    series, render_grid_png must only touch instance indices in [10, 25].

    Catches a regression where the new args get accepted but ignored
    (e.g. someone removes the range-clamping logic).
    """
    series = _fake_series(500)

    touched_indices: list[int] = []

    fake_arr = MagicMock()
    fake_arr.astype.return_value = fake_arr
    fake_arr.__mul__.return_value = fake_arr
    fake_arr.__add__.return_value = fake_arr

    def fake_dcmread(path):
        # Pull index out of '/dev/null/inst-NNN.dcm'
        m = re.search(r"inst-(\d+)\.dcm", str(path))
        if m:
            touched_indices.append(int(m.group(1)))
        ds = MagicMock()
        ds.pixel_array = fake_arr
        ds.RescaleSlope = 1
        ds.RescaleIntercept = 0
        ds.WindowCenter = 40
        ds.WindowWidth = 400
        return ds

    import pydicom
    monkeypatch.setattr(pydicom, "dcmread", fake_dcmread)
    # _window_to_uint8 calls numpy ops on the array; stub it to return
    # a deterministic 1×1 grayscale buffer so the PIL pipeline accepts it.
    import numpy as np
    monkeypatch.setattr(
        "nexus_server.dicom._window_to_uint8",
        lambda arr, wl, ww, **kw: np.zeros((1, 1), dtype=np.uint8),
    )
    # Skip the slow HU array reshape.
    monkeypatch.setattr(
        "nexus_server.dicom._hu_array",
        lambda ds: fake_arr,
    )

    from nexus_server.dicom import render_grid_png
    png = render_grid_png(
        series, rows=4, cols=4, cell_size=16,
        slice_start=10, slice_end=25,
    )
    assert isinstance(png, bytes) and len(png) > 0

    # Every touched index must be inside [10, 25] inclusive.
    out_of_range = [i for i in touched_indices if i < 10 or i > 25]
    assert not out_of_range, (
        f"render_grid_png sampled outside [10, 25]: {sorted(set(out_of_range))}"
    )
    # And at least one in-range index was actually read.
    assert touched_indices, "render_grid_png didn't read any instances"


# ─────────────────────────────────────────────────────────────────────
# ② cell_size bump
# ─────────────────────────────────────────────────────────────────────


def test_quick_scan_cell_size_constant_bumped():
    """Quick scan's per-cell render must be at least 384 px so 5 mm
    findings render at ~5 px diameter. The previous default of 256 had
    them at ~3 px — below the vision model's medical noise floor."""
    from nexus_server import quick_scan
    assert quick_scan.QUICK_SCAN_CELL_SIZE >= 384, (
        f"QUICK_SCAN_CELL_SIZE shrunk to {quick_scan.QUICK_SCAN_CELL_SIZE}; "
        "sub-cm findings won't be detectable. Keep at 384 or higher."
    )
    # And the 4×4 layout × this cell must still fit Gemini's 3072 cap.
    assert quick_scan.QUICK_SCAN_CELL_SIZE * 4 <= 3072, (
        "Cell size × 4 exceeds Gemini's 3072 px per-image cap."
    )


# ─────────────────────────────────────────────────────────────────────
# ③ Multi-window presets for chest CT
# ─────────────────────────────────────────────────────────────────────


def test_chest_ct_uses_three_window_presets():
    """A CT chest study must trigger lung / mediastinum / bone passes."""
    from nexus_server.quick_scan import _presets_for_body_part
    presets = _presets_for_body_part("CHEST", "CT")
    assert set(presets) == {"lung", "mediastinum", "bone"}, presets


def test_whole_body_ct_uses_three_window_presets():
    """PET-CT whole-body studies often have body_part = "WHOLEBODY" —
    these should also get the 3-window chest scan since the lung +
    bone tissue classes still matter."""
    from nexus_server.quick_scan import _presets_for_body_part
    presets = _presets_for_body_part("WHOLEBODY", "CT")
    assert set(presets) == {"lung", "mediastinum", "bone"}


def test_non_chest_ct_uses_single_default_window():
    """Head / abdomen / pelvis stay single-pass. Adding 3× cost for
    body parts where lung/bone presets don't help would just waste
    Gemini calls."""
    from nexus_server.quick_scan import _presets_for_body_part
    for bp in ("HEAD", "BRAIN", "ABDOMEN", "PELVIS", "KNEE", ""):
        presets = _presets_for_body_part(bp, "CT")
        assert presets == ("default",), f"{bp} should be single-window, got {presets}"


def test_non_ct_modality_always_single_window():
    """PET / MR / X-ray don't benefit from CT-specific lung/bone presets."""
    from nexus_server.quick_scan import _presets_for_body_part
    for modality in ("PT", "MR", "DX", "CR", "NM", ""):
        for bp in ("CHEST", "WHOLEBODY", "HEAD"):
            presets = _presets_for_body_part(bp, modality)
            assert presets == ("default",), (
                f"modality={modality} body_part={bp} should be "
                f"single-window, got {presets}"
            )


def test_phase1_prompt_carries_window_hint():
    """Source-level guard: the Phase-1 prompt template must reference
    the window so Gemini knows what tissue class it's grading. Without
    it the model would treat every grid as 'random axial CT' and
    confuse e.g. lung opacity with mediastinal fat."""
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "nexus_server" / "quick_scan.py").read_text()
    # The prompt-building function must format the window hint into
    # the prompt body.
    assert "Rendering window:" in src, (
        "Phase-1 prompt no longer includes the rendering-window hint. "
        "Gemini will grade every grid as 'generic CT' — multi-window "
        "scanning loses its point."
    )
    # And the hint table must exist with the three CT presets.
    for preset in ("lung", "mediastinum", "bone"):
        assert f'"{preset}":' in src, (
            f"PRESET_PROMPT_HINTS lost the {preset!r} entry."
        )


def test_grid_finding_carries_window_field():
    """GridFinding must expose ``window`` so the report can group
    findings by tissue class. Without this the chat report can't
    distinguish a lung-window finding from a bone-window finding —
    both would show up as 'finding at slice 80'."""
    from nexus_server.quick_scan import GridFinding, _finding_to_dict
    g = GridFinding(
        slice_start=10, slice_end=25,
        verdict="suspicious", finding="rib fracture", urgency="moderate",
        window="bone",
    )
    d = _finding_to_dict(g)
    assert d.get("window") == "bone", (
        "_finding_to_dict dropped the window field — chat report will "
        "lose tissue-class grouping."
    )


# ─────────────────────────────────────────────────────────────────────
# ④ Broken fallback removed
# ─────────────────────────────────────────────────────────────────────


def test_render_batched_grids_no_typeerror_fallback():
    """Regression: the ``except TypeError: ... break`` fallback in
    ``_render_batched_grids`` was masking the signature-mismatch bug —
    every quick_scan silently fell back to one whole-series grid.
    The fallback MUST stay gone now that render_grid_png accepts the
    range params."""
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "nexus_server" / "quick_scan.py").read_text()

    # Locate the helper body so we don't false-positive on comments
    # elsewhere in the module.
    m = re.search(
        r"async def _render_batched_grids\(.*?\n"
        r"(?P<body>.*?)\n(?:async def |def )",
        src, re.DOTALL,
    )
    assert m, "could not locate _render_batched_grids in quick_scan.py"
    body = m.group("body")

    # Strip comments and docstrings so the bug-history note doesn't
    # trip the check.
    code_only = re.sub(r'"""[\s\S]*?"""', "", body)
    code_only = "\n".join(
        line.split("#", 1)[0] for line in code_only.splitlines()
    )

    assert "except TypeError" not in code_only, (
        "Regression — the broken TypeError fallback is back in "
        "_render_batched_grids. That fallback masks render_grid_png "
        "signature drift and silently degrades scans to a single grid. "
        "If render_grid_png's signature changes, fail loud instead."
    )


def test_run_async_iterates_over_presets():
    """Source-level guard: _run_quick_scan_async must loop over the
    list of presets and accumulate (start, end, preset, png) tuples.
    Without this loop, the multi-window scan collapses to one window."""
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "nexus_server" / "quick_scan.py").read_text()
    # The presets-iteration block must be present.
    assert re.search(
        r"for preset in presets:\s*\n[^}]*_render_batched_grids",
        src, re.DOTALL,
    ), (
        "_run_quick_scan_async no longer iterates over presets — "
        "multi-window Phase-1 scan is broken."
    )
    # And the result list must carry the preset as the 3rd tuple element.
    assert "(s, e, preset, png)" in src or "(start, end, preset, png)" in src, (
        "Grid accumulator dropped the preset element — Phase-1 can't "
        "tell which window each grid came from."
    )
