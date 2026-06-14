"""
Regression tests: DicomStudy / DicomSeries attribute compatibility.

Two bugs we shipped in the past 24 hours and the user found via the
new error-surfacing UI:

  1. `_run_dicom_ingester_safe` accessed `s.instance_count` on a
     DicomSeries (which has `instances: list` + `slice_count` property,
     no `instance_count` field).
  2. Same function accessed `parsed.extract_dir` on a DicomStudy
     (extract_dir is a SQL column on `dicom_studies`, NOT a field on
     the in-memory dataclass).

These tests pin both attribute names against the actual dataclasses
so future renames of the dataclasses immediately fail the build.

Per ENGINEERING_STANDARDS.md rule 3: "a test that would have failed
BEFORE the fix and passes AFTER."
"""
from __future__ import annotations

import dataclasses
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


def test_dicom_series_has_no_instance_count_field():
    """Bug history: code path used `s.instance_count` — wrong name.
    DicomSeries exposes ``instances`` (list[DicomInstance]) and a
    ``slice_count`` @property. If anyone adds `instance_count` as a
    field later this test will start passing, but the assertion in
    the OTHER direction (use len(s.instances)) is the long-term
    contract. We pin the absence so we notice if it shifts."""
    from nexus_server.dicom import DicomSeries

    field_names = {f.name for f in dataclasses.fields(DicomSeries)}
    assert "instances" in field_names, "DicomSeries lost its instances field"
    assert "instance_count" not in field_names, (
        "DicomSeries now has instance_count as a field — update "
        "_run_dicom_ingester_safe in files.py to use it directly "
        "instead of len(s.instances)."
    )
    # The replacement formula must keep working:
    s = DicomSeries(series_instance_uid="x", instances=[])
    assert len(s.instances) == 0
    # And @property is still there:
    assert s.slice_count == 0


def test_dicom_study_has_no_extract_dir_field():
    """Bug history: `parsed.extract_dir` — wrong place. extract_dir
    is a SQL column on the dicom_studies table, not a dataclass
    field. Code that needs the path must SELECT it, not attribute-
    access it."""
    from nexus_server.dicom import DicomStudy

    field_names = {f.name for f in dataclasses.fields(DicomStudy)}
    assert "study_instance_uid" in field_names
    assert "series" in field_names
    assert "extract_dir" not in field_names, (
        "DicomStudy gained extract_dir as a field — review "
        "files.py::_run_dicom_ingester_safe to use it where we "
        "previously passed empty string."
    )


def test_run_dicom_ingester_safe_does_not_reference_renamed_attrs():
    """Source-level guard: scans files.py for the exact attribute
    typos that bit us. If anyone re-introduces them this test fails
    immediately."""
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "nexus_server" / "files.py").read_text()

    # We strip comments via a simple regex so the source-citing
    # comment in the code itself doesn't trip the check.
    import re
    code_only = re.sub(r"#[^\n]*", "", src)

    for bad in (".instance_count", ".extract_dir"):
        if bad not in code_only:
            continue
        # Allow only known-safe contexts. parsed.extract_dir was the
        # bug; if anyone needs that attribute, they must access it
        # via a SELECT not the dataclass.
        offenders = [
            line.strip() for line in code_only.splitlines()
            if bad in line
        ]
        assert not offenders, (
            f"files.py references {bad} — that attribute does not exist "
            f"on the dataclass. Offending lines:\n  " +
            "\n  ".join(offenders)
        )
