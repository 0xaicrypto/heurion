"""
Tests for the ReportMode PDF export pipeline.

Coverage:

  * `report_pdf.build_report_pdf` — pure builder, no HTTP.
    - Produces a real PDF (starts with %PDF- magic bytes)
    - Output file lives where the caller said it should
    - Locales zh-CN / en-US pick different section labels
    - Empty findings / differentials don't crash; render an "(empty)" line
    - Long bodies don't crash (Platypus auto-paginates)
    - HTML-unsafe characters in user text get escaped (no parser blowup)

  * `report_pdf_router.export_report_pdf` — route function.
    - 200 + path on happy path
    - 422-like rejection on missing patient_hash (Pydantic-level)
    - 500 with actionable detail when archive resolves to a read-only path
    - Forwarded user_id from auth shows up in the log line

  * Source-level guards:
    - main.py wires the router
    - PyInstaller spec lists reportlab.platypus

These tests skip the HTTP layer (no TestClient) and call the route
function directly. That keeps them sandbox-friendly (no network) and
fast (~200 ms each).
"""
from __future__ import annotations

import asyncio
import pathlib
import re
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from nexus_server import report_pdf, report_pdf_router  # noqa: E402
from nexus_server.report_pdf import (  # noqa: E402
    ReportDraftInput, ReportPatientHeader, build_report_pdf,
    default_pdf_name, reports_dir,
)


# ─────────────────────────────────────────────────────────────────────
# Pure builder
# ─────────────────────────────────────────────────────────────────────


def _sample_patient() -> ReportPatientHeader:
    return ReportPatientHeader(
        label="J.D. · #3",
        sex="F",
        age_group="55-64",
        latest_modality="CT",
        latest_study_dt="2024-08-15",
    )


def _sample_draft() -> ReportDraftInput:
    return ReportDraftInput(
        clinical_info  = "Former smoker, follow-up for prior 6mm RUL nodule.",
        impression     = "Stable 8mm RUL nodule. No new findings.",
        recommendation = "Short-interval follow-up CT in 3 months.",
        findings=[
            {"node_id": 42, "label": "8mm RUL nodule", "urgency": "moderate"},
            {"node_id": 43, "label": "GGO, slice 64",  "urgency": "incidental"},
        ],
        differentials=[
            {"node_id": 51, "label": "adenocarcinoma in situ", "urgency": ""},
        ],
    )


def test_build_pdf_produces_valid_pdf_file(tmp_path):
    """End-to-end: feed a typical draft into the builder, assert the
    output file is a real PDF (magic bytes + non-trivial size)."""
    out = tmp_path / "report.pdf"
    size = build_report_pdf(
        patient=_sample_patient(),
        draft=_sample_draft(),
        out_path=out,
        locale="zh-CN",
    )
    assert out.exists(), "PDF was not written to the path the caller passed"
    assert size > 1000, (
        f"PDF is only {size} bytes — typical clinical report is 3-10 KB; "
        "the builder probably rendered an empty story."
    )
    head = out.read_bytes()[:8]
    assert head.startswith(b"%PDF-"), (
        f"output doesn't start with PDF magic bytes: {head!r}. "
        "Either the builder wrote something else or the file is corrupt."
    )


def test_build_pdf_zh_locale_uses_chinese_section_labels(tmp_path):
    """The medic's locale determines section header labels (CLINICAL
    INFORMATION / 临床信息, etc.). Verify by scanning the resulting PDF
    bytes for the expected literal labels.

    Note: reportlab writes text as content streams which are deflated
    inside the PDF — direct grep for the Chinese characters won't hit
    because the stream is compressed. Instead we drive the same private
    label-lookup helper that the builder uses, asserting that zh-CN /
    en-US return different dictionaries.
    """
    zh = report_pdf._labels("zh-CN")
    en = report_pdf._labels("en-US")
    assert zh["clinical_info"] == "临床信息"
    assert en["clinical_info"] == "CLINICAL INFORMATION"
    assert zh["findings"]      == "影像所见"
    assert en["findings"]      == "FINDINGS"
    assert zh != en, "zh-CN and en-US returned the same dictionary"

    # And a smoke build in each locale doesn't error.
    out_zh = tmp_path / "zh.pdf"
    out_en = tmp_path / "en.pdf"
    build_report_pdf(
        patient=_sample_patient(), draft=_sample_draft(),
        out_path=out_zh, locale="zh-CN",
    )
    build_report_pdf(
        patient=_sample_patient(), draft=_sample_draft(),
        out_path=out_en, locale="en-US",
    )
    assert out_zh.read_bytes().startswith(b"%PDF-")
    assert out_en.read_bytes().startswith(b"%PDF-")


def test_build_pdf_empty_findings_and_ddx_does_not_crash(tmp_path):
    """A medic who deselects every finding still gets a PDF — just
    with an "(empty)" placeholder under those sections. We don't want
    reportlab to choke on an empty bullet list."""
    out = tmp_path / "empty.pdf"
    size = build_report_pdf(
        patient=_sample_patient(),
        draft=ReportDraftInput(
            clinical_info  = "Quick follow-up note.",
            impression     = "Unchanged from prior.",
            recommendation = "Annual screening.",
            findings=[], differentials=[],
        ),
        out_path=out,
        locale="zh-CN",
    )
    assert out.exists() and size > 800


def test_build_pdf_html_unsafe_characters_in_user_text_dont_crash(tmp_path):
    """reportlab's Paragraph parses an XML-like subset; literal '<' /
    '>' / '&' in medic-typed text would blow up the parser without
    escaping. The _html_safe helper covers this. Verify it actually
    runs in practice — a medic might paste e.g. "FEV1 < 50% & decline"
    or HTML-tag-shaped text into the impression."""
    out = tmp_path / "unsafe.pdf"
    draft = ReportDraftInput(
        clinical_info  = "FEV1 < 50% & decline observed",
        impression     = "Findings <suggest> obstruction — see <prior>.",
        recommendation = "Spirometry & repeat CT.",
        findings=[
            {"node_id": 1, "label": "Bronchiectasis & mucus plugging", "urgency": ""},
        ],
        differentials=[],
    )
    size = build_report_pdf(
        patient=_sample_patient(), draft=draft,
        out_path=out, locale="zh-CN",
    )
    assert out.exists() and size > 800


def test_build_pdf_long_text_auto_paginates(tmp_path):
    """A medic with a verbose impression / recommendation shouldn't
    cause a "ran off the page" failure. reportlab's SimpleDocTemplate
    auto-paginates Flowables. PDF text streams compress well (~10:1)
    so we don't assert on absolute byte counts — instead we check
    that the long-body PDF is at least 1.5× the short-body PDF and
    parses as a multi-page document (looking for the 2nd /Page
    object marker).
    """
    long_body = "Clinically relevant follow-up note. " * 400  # ~13 KB raw

    out_short = tmp_path / "short.pdf"
    build_report_pdf(
        patient=_sample_patient(), draft=_sample_draft(),
        out_path=out_short, locale="zh-CN",
    )
    short_size = out_short.stat().st_size

    out_long = tmp_path / "long.pdf"
    long_size = build_report_pdf(
        patient=_sample_patient(),
        draft=ReportDraftInput(
            clinical_info  = long_body,
            impression     = long_body,
            recommendation = long_body,
            findings=[], differentials=[],
        ),
        out_path=out_long,
        locale="zh-CN",
    )

    assert long_size > short_size * 1.5, (
        f"long-body PDF ({long_size}) is not meaningfully larger than "
        f"the short-body PDF ({short_size}). Platypus may not be "
        "rendering the long bodies at all — verify _build_story is "
        "actually yielding the Paragraph flowables."
    )

    # Multi-page check: every reportlab page has its own /Type /Page
    # object in the PDF object table. Count occurrences in the raw
    # bytes — even compressed streams keep the cross-reference markers
    # uncompressed.
    long_bytes = out_long.read_bytes()
    page_markers = long_bytes.count(b"/Type /Page\n") + long_bytes.count(b"/Type /Page ")
    assert page_markers >= 2, (
        f"Expected ≥2 pages in the long-body PDF, found "
        f"{page_markers} /Type /Page markers. reportlab pagination "
        "not happening."
    )


def test_default_pdf_name_format():
    """Filename = first 8 hex chars of patient_hash + unix seconds.
    Verifies the convention so other tooling (a future Open-Folder
    listing in the UI, audit log scrubber) can parse the prefix."""
    name = default_pdf_name("deadbeefcafe1234")
    m = re.match(r"^([0-9a-f]{8})-(\d+)\.pdf$", name)
    assert m, f"name {name!r} doesn't match <8hex>-<ts>.pdf convention"
    assert m.group(1) == "deadbeef"


def test_default_pdf_name_with_anon_hash():
    """patient_hash='' (anonymous test patient) still produces a valid
    filename — uses the 'anon' prefix instead of crashing on the slice."""
    name = default_pdf_name("")
    assert name.startswith("anon-")
    assert name.endswith(".pdf")


def test_reports_dir_creates_on_demand(tmp_path):
    """``reports_dir`` should idempotently mkdir."""
    archive = tmp_path / "Archive"
    reps = reports_dir(archive)
    assert reps.is_dir()
    assert reps == archive / "Reports"
    # Second call doesn't error.
    reps2 = reports_dir(archive)
    assert reps2 == reps


# ─────────────────────────────────────────────────────────────────────
# Route function (direct call — no TestClient)
# ─────────────────────────────────────────────────────────────────────


def test_route_happy_path_returns_path_and_size(tmp_path, monkeypatch):
    """Drive the route function directly: build a request, monkeypatch
    NEXUS_ARCHIVE_DIR to a tmp dir, assert the response carries a real
    file path + non-zero byte count."""
    monkeypatch.setenv("NEXUS_ARCHIVE_DIR", str(tmp_path))

    req = report_pdf_router.ReportPdfRequest(
        patient_hash="abcdef1234567890",
        patient_label="J.D. · #3",
        patient_sex="F",
        patient_age_group="55-64",
        latest_modality="CT",
        latest_study_dt="2024-08-15",
        clinical_info="Former smoker, RUL nodule follow-up.",
        impression="Stable 8mm nodule.",
        recommendation="3-month follow-up CT.",
        findings=[
            report_pdf_router.NodeRef(node_id=42, label="8mm RUL nodule",
                                      urgency="moderate"),
        ],
        differentials=[],
        locale="zh-CN",
    )

    resp = asyncio.run(
        report_pdf_router.export_report_pdf(req, user_id="medic-jane"),
    )

    assert resp.patient_hash == req.patient_hash
    assert resp.locale       == "zh-CN"
    assert resp.bytes        > 1000

    out_path = pathlib.Path(resp.path)
    assert out_path.exists()
    assert out_path.read_bytes().startswith(b"%PDF-")
    # Path landed under <archive>/Reports/<hash[:8]>-<ts>.pdf.
    assert "Reports" in out_path.parts
    assert out_path.name.startswith("abcdef12-")


def test_route_rejects_empty_patient_hash():
    """Pydantic min_length=1 should reject. We catch the exception
    type to make sure the validation runs and produces a useful error
    rather than going through to a builder crash."""
    with pytest.raises(Exception):
        # Either Pydantic ValidationError or its subclass — either way
        # the route never gets to do work.
        report_pdf_router.ReportPdfRequest(
            patient_hash="",
            clinical_info="x", impression="y", recommendation="z",
        )


def test_route_500_when_archive_cant_be_resolved(monkeypatch, tmp_path):
    """If `_archive_dir()` raises, the route surfaces a 500 with a
    clear detail string rather than swallowing into a generic
    'Internal Server Error'. We force the failure by stubbing
    `_archive_dir` to raise."""
    from nexus_server import report_pdf_router as r

    def boom():
        raise RuntimeError("no archive disk")

    monkeypatch.setattr(r, "_archive_dir", boom)

    req = r.ReportPdfRequest(
        patient_hash="x" * 16,
        clinical_info="x", impression="y", recommendation="z",
    )
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(r.export_report_pdf(req, user_id="u1"))
    assert exc_info.value.status_code == 500
    detail = str(exc_info.value.detail).lower()
    assert "archive" in detail


def test_route_logs_user_id_on_export(tmp_path, monkeypatch, caplog):
    """The INFO log line on success must include the user_id so audit
    logs can attribute the PDF to a medic."""
    monkeypatch.setenv("NEXUS_ARCHIVE_DIR", str(tmp_path))

    req = report_pdf_router.ReportPdfRequest(
        patient_hash="abcdef1234567890",
        clinical_info="x", impression="y", recommendation="z",
    )
    import logging
    with caplog.at_level(logging.INFO, logger="nexus_server.report_pdf_router"):
        asyncio.run(
            report_pdf_router.export_report_pdf(req, user_id="medic-jane"),
        )

    assert any(
        "medic-jane" in rec.getMessage()
        for rec in caplog.records
    ), (
        "INFO log line on PDF export should name the user_id. "
        f"Records: {[r.getMessage() for r in caplog.records]}"
    )


# ─────────────────────────────────────────────────────────────────────
# Source-level guards
# ─────────────────────────────────────────────────────────────────────


def test_main_py_includes_report_pdf_router():
    """If someone removes the include_router call, the endpoint is
    unreachable but the import still succeeds — a silent regression."""
    src = (
        pathlib.Path(__file__).resolve().parents[1]
        / "nexus_server" / "main.py"
    ).read_text()
    code = "\n".join(l.split("#", 1)[0] for l in src.splitlines())
    assert "from nexus_server import report_pdf_router" in code, (
        "main.py no longer imports report_pdf_router — endpoint will "
        "404 in production."
    )
    assert "_report_pdf_router.router" in code, (
        "report_pdf_router imported but never included on the app."
    )


def test_pyinstaller_spec_lists_reportlab_submodules():
    """PyInstaller can't statically discover reportlab's lazy submodules
    via report_pdf.py's `from reportlab.lib import colors` — the
    submodules load on demand. Without listing them by hand in
    hiddenimports, the bundled sidecar 500s the first time a medic
    clicks Export PDF: "ModuleNotFoundError: reportlab.lib"."""
    src = (
        pathlib.Path(__file__).resolve().parents[1] / "nexus-server.spec"
    ).read_text()
    for mod in (
        "reportlab",
        "reportlab.lib",
        "reportlab.lib.styles",
        "reportlab.platypus",
    ):
        assert f'"{mod}"' in src, (
            f'PyInstaller spec is missing the hidden import "{mod}". '
            "Bundled sidecar will fail at runtime even though `pip install` "
            "succeeded at build time."
        )


def test_pyproject_lists_reportlab():
    """If reportlab isn't in pyproject.toml, `pip install -e .` in CI
    or on a fresh dev box won't pull it — and the route would import-
    fail at sidecar startup."""
    src = (
        pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml"
    ).read_text()
    assert re.search(
        r'^\s*"reportlab[<>=~!]+', src, re.MULTILINE,
    ), "reportlab missing from pyproject.toml dependencies"
