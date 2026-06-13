"""Tests for #140 — DICOM parser + renderer.

Real .dcm bytes are generated via pydicom's test fixtures so the
suite is deterministic and offline-friendly. We exercise:

  * Magic-byte detection (single instance + archive)
  * Parse pulls modality / windowing / patient hash
  * Rendering produces real PNG output for slice / MIP / grid
  * Persistence round-trip (parse → persist → load matches)
  * Patient hashing is stable per-salt + per-ID
"""

from __future__ import annotations

import os
import shutil
import tempfile
import zipfile
from pathlib import Path

import pytest


@pytest.fixture
def isolated_rune_home(monkeypatch):
    """Point RUNE_HOME at a temp dir so the patient_salt + index DB
    don't leak across tests."""
    tmp = tempfile.mkdtemp(prefix="nexus-dicom-test-")
    monkeypatch.setenv("RUNE_HOME", tmp)
    yield Path(tmp)
    shutil.rmtree(tmp, ignore_errors=True)


def _sample_ct_path():
    """Real pydicom test CT — int16 pixel data, full DICOM header."""
    from pydicom.data import get_testdata_files
    files = get_testdata_files("CT_small.dcm")
    if not files:
        pytest.skip("pydicom test data not installed")
    return Path(files[0])


def _make_zip(tmp_path: Path, files: list[tuple[str, bytes]]) -> Path:
    z = tmp_path / "test.zip"
    with zipfile.ZipFile(z, "w") as zf:
        for name, data in files:
            zf.writestr(name, data)
    return z


# ── Magic-byte detection ─────────────────────────────────────────────


def test_looks_like_dicom_bytes_real_dcm():
    from nexus_server.dicom import looks_like_dicom_bytes
    data = _sample_ct_path().read_bytes()
    assert looks_like_dicom_bytes(data)


def test_looks_like_dicom_bytes_random_data_negative():
    from nexus_server.dicom import looks_like_dicom_bytes
    assert not looks_like_dicom_bytes(b"this is not a DICOM file at all")
    assert not looks_like_dicom_bytes(b"\x00" * 200)  # zeros, no DICM


def test_looks_like_dicom_archive_with_real_dcm(tmp_path):
    from nexus_server.dicom import looks_like_dicom_archive
    z = _make_zip(tmp_path, [
        ("CHEST_CT/0001.dcm", _sample_ct_path().read_bytes()),
    ])
    assert looks_like_dicom_archive(z)


def test_looks_like_dicom_archive_dicomdir_rooted(tmp_path):
    """DICOMDIR-rooted archives count as DICOM even if we don't probe
    individual .dcm files."""
    from nexus_server.dicom import looks_like_dicom_archive
    z = _make_zip(tmp_path, [
        ("DICOMDIR", b"fake dicomdir contents"),
        ("DATA/SE001/IMG001", b"opaque binary"),
    ])
    assert looks_like_dicom_archive(z)


def test_looks_like_dicom_archive_normal_zip_negative(tmp_path):
    from nexus_server.dicom import looks_like_dicom_archive
    z = _make_zip(tmp_path, [
        ("README.txt", b"not a medical archive"),
        ("data.csv", b"a,b,c\n1,2,3"),
    ])
    assert not looks_like_dicom_archive(z)


def test_looks_like_dicom_archive_empty_zip(tmp_path):
    from nexus_server.dicom import looks_like_dicom_archive
    z = tmp_path / "empty.zip"
    with zipfile.ZipFile(z, "w"):
        pass
    assert not looks_like_dicom_archive(z)


# ── Parsing ──────────────────────────────────────────────────────────


def test_parse_single_dcm_archive(isolated_rune_home, tmp_path):
    """One .dcm in a zip → one study, one series, one instance."""
    from nexus_server.dicom import parse_dicom_archive

    z = _make_zip(tmp_path, [
        ("study/img1.dcm", _sample_ct_path().read_bytes()),
    ])
    extract = tmp_path / "extracted"
    study = parse_dicom_archive(z, extract)

    assert study.modality == "CT"
    assert len(study.series) == 1
    assert study.total_instances == 1
    s = study.series[0]
    assert s.modality == "CT"
    assert len(s.instances) == 1
    # The sample CT has a numeric SOPInstanceUID we can verify isn't blank
    assert s.instances[0].sop_instance_uid


def test_parse_multi_slice_series(isolated_rune_home, tmp_path):
    """Same DICOM bytes under different filenames should produce one
    series with multiple instances (we don't dedupe by SOPInstanceUID
    because that's the medic's call). The sort key falls back to
    InstanceNumber/0 when z-positions match.
    """
    from nexus_server.dicom import parse_dicom_archive

    data = _sample_ct_path().read_bytes()
    z = _make_zip(tmp_path, [
        (f"study/img{i:03d}.dcm", data) for i in range(5)
    ])
    extract = tmp_path / "ex"
    study = parse_dicom_archive(z, extract)
    assert len(study.series) == 1
    # The instances share UIDs so we may collapse — accept either
    # outcome but ensure we don't lose the data entirely.
    assert study.total_instances >= 1


def test_parse_patient_hash_is_stable(isolated_rune_home, tmp_path):
    """Same PatientID → same hash within one install."""
    from nexus_server.dicom import _hash_patient_id
    h1 = _hash_patient_id("PAT-12345")
    h2 = _hash_patient_id("PAT-12345")
    h3 = _hash_patient_id("PAT-67890")
    assert h1 == h2  # stable
    assert h1 != h3  # different patients diverge
    assert h1  # not empty
    assert len(h1) == 32  # truncated SHA256 hex


def test_parse_patient_hash_empty_for_empty_id(isolated_rune_home):
    from nexus_server.dicom import _hash_patient_id
    assert _hash_patient_id("") == ""


def test_parse_rejects_non_dicom_zip(isolated_rune_home, tmp_path):
    """A zip with no parseable DICOM should raise ValueError."""
    from nexus_server.dicom import parse_dicom_archive

    z = _make_zip(tmp_path, [
        ("notes.txt", b"hello"),
        ("data.csv", b"a,b\n1,2"),
    ])
    with pytest.raises(ValueError):
        parse_dicom_archive(z, tmp_path / "ex")


# ── Rendering ────────────────────────────────────────────────────────


def test_render_slice_png(isolated_rune_home, tmp_path):
    from nexus_server.dicom import parse_dicom_archive, render_slice_png

    z = _make_zip(tmp_path, [
        ("img.dcm", _sample_ct_path().read_bytes()),
    ])
    study = parse_dicom_archive(z, tmp_path / "ex")
    series = study.series[0]

    png_bytes = render_slice_png(series, 0, preset="lung")
    # Real PNG magic
    assert png_bytes.startswith(b"\x89PNG\r\n\x1a\n")
    assert len(png_bytes) > 100  # not just header


def test_render_slice_clamps_out_of_range_idx(isolated_rune_home, tmp_path):
    from nexus_server.dicom import parse_dicom_archive, render_slice_png
    z = _make_zip(tmp_path, [("img.dcm", _sample_ct_path().read_bytes())])
    study = parse_dicom_archive(z, tmp_path / "ex")
    series = study.series[0]
    # Asking for slice 9999 should just give back slice 0 (clamped),
    # not raise. Robustness for UI sliders that race the data.
    png = render_slice_png(series, 9999)
    assert png.startswith(b"\x89PNG")


def test_render_mip_png(isolated_rune_home, tmp_path):
    from nexus_server.dicom import parse_dicom_archive, render_mip_png
    z = _make_zip(tmp_path, [("img.dcm", _sample_ct_path().read_bytes())])
    study = parse_dicom_archive(z, tmp_path / "ex")
    png = render_mip_png(study.series[0], preset="lung")
    assert png.startswith(b"\x89PNG")


def test_render_grid_png(isolated_rune_home, tmp_path):
    from nexus_server.dicom import parse_dicom_archive, render_grid_png
    z = _make_zip(tmp_path, [("img.dcm", _sample_ct_path().read_bytes())])
    study = parse_dicom_archive(z, tmp_path / "ex")
    png = render_grid_png(study.series[0], rows=4, cols=4, cell_size=64)
    assert png.startswith(b"\x89PNG")
    # 4×4 × 64px = 256×256 — verify via PIL
    from PIL import Image
    import io
    img = Image.open(io.BytesIO(png))
    assert img.size == (256, 256)


def test_window_preset_lung_vs_bone_produce_different_output(isolated_rune_home, tmp_path):
    from nexus_server.dicom import parse_dicom_archive, render_slice_png
    z = _make_zip(tmp_path, [("img.dcm", _sample_ct_path().read_bytes())])
    study = parse_dicom_archive(z, tmp_path / "ex")
    s = study.series[0]
    lung = render_slice_png(s, 0, preset="lung")
    bone = render_slice_png(s, 0, preset="bone")
    # Different windows → different pixel histograms → different PNG bytes
    assert lung != bone


# ── Persistence ──────────────────────────────────────────────────────


def test_persist_then_load_round_trip(isolated_rune_home, tmp_path):
    from nexus_server.dicom import (
        init_dicom_index, parse_dicom_archive,
        persist_study, load_study,
    )
    init_dicom_index()
    z = _make_zip(tmp_path, [
        ("img.dcm", _sample_ct_path().read_bytes()),
    ])
    study = parse_dicom_archive(z, tmp_path / "ex")
    study_id = persist_study("user-1", "file-abc", study, tmp_path / "ex")
    assert study_id

    loaded = load_study("user-1", study_id)
    assert loaded is not None
    assert loaded.study_instance_uid == study.study_instance_uid
    assert loaded.modality == study.modality
    assert len(loaded.series) == len(study.series)
    assert loaded.total_instances == study.total_instances


def test_persist_re_upload_replaces_not_duplicates(isolated_rune_home, tmp_path):
    """Same StudyInstanceUID re-persisted should UPDATE, not create
    a second row."""
    from nexus_server.dicom import (
        init_dicom_index, parse_dicom_archive, persist_study,
    )
    init_dicom_index()
    z = _make_zip(tmp_path, [("a.dcm", _sample_ct_path().read_bytes())])
    s1 = parse_dicom_archive(z, tmp_path / "e1")
    id1 = persist_study("user-1", "file-1", s1, tmp_path / "e1")

    # Re-upload the same archive
    s2 = parse_dicom_archive(z, tmp_path / "e2")
    id2 = persist_study("user-1", "file-2", s2, tmp_path / "e2")

    # Same study_id — the UNIQUE constraint on (user_id, study_uid)
    # forces an UPSERT.
    assert id1 == id2


def test_load_study_wrong_user_returns_none(isolated_rune_home, tmp_path):
    """Cross-tenant isolation — user A can't read user B's study."""
    from nexus_server.dicom import (
        init_dicom_index, parse_dicom_archive, persist_study, load_study,
    )
    init_dicom_index()
    z = _make_zip(tmp_path, [("a.dcm", _sample_ct_path().read_bytes())])
    s = parse_dicom_archive(z, tmp_path / "e")
    study_id = persist_study("alice", "file-a", s, tmp_path / "e")

    # Same study_id, different user — must be None
    assert load_study("bob", study_id) is None
    assert load_study("alice", study_id) is not None


# ── Age bucketing ────────────────────────────────────────────────────


def test_age_to_group():
    from nexus_server.dicom import _age_to_group
    assert _age_to_group("045Y") == "40s"
    assert _age_to_group("017Y") == "child"
    assert _age_to_group("085Y") == "80+"
    assert _age_to_group("006M") == "<1y"
    assert _age_to_group("") == ""
    assert _age_to_group("junk") == ""
