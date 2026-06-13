"""Tests for #141 — DICOM upload auto-rewrite in chat path.

When a medic pastes / uploads a raw .dcm file (PACS exports often
have no extension — filename is the SOPInstanceUID), GuessMime
client-side falls back to application/octet-stream and the server
sees the attachment as a generic binary. Without the rewrite
helper, the image branch in llm_gateway never fires, agent gets a
"[binary content omitted]" stub, and replies "I can't see the
content" (the failing screenshot the medic reported).

``_maybe_rewrite_dicom_to_png`` detects DICOM by magic bytes
("DICM" at offset 128) and rewrites the Attachment as a rendered
PNG so the existing image branch handles it normally.
"""

from __future__ import annotations

import base64

import pytest


def _sample_ct_b64() -> str:
    """pydicom's bundled CT test file, base64-encoded — what the
    upload route would feed into the chat request after resolving
    file_id to disk bytes."""
    from pydicom.data import get_testdata_files
    files = get_testdata_files("CT_small.dcm")
    if not files:
        pytest.skip("pydicom test data not installed")
    with open(files[0], "rb") as fh:
        return base64.b64encode(fh.read()).decode("ascii")


# ── Rewrite happy path ───────────────────────────────────────────────


def test_rewrite_single_dcm_to_png():
    """Single .dcm bytes → renders to PNG, mime becomes image/png."""
    from nexus_server.llm_gateway import (
        _maybe_rewrite_dicom_to_png, Attachment,
    )

    att = Attachment(
        # No extension — PACS-style SOPInstanceUID filename
        name="1.2.156.112605.31362038931398.260526",
        mime="application/octet-stream",  # GuessMime default
        size_bytes=514_000,
        content_text=None,
        content_base64=_sample_ct_b64(),
        file_id="file-pacs-1",
    )
    rewritten = _maybe_rewrite_dicom_to_png(att)
    assert rewritten is not att
    assert rewritten.mime == "image/png"
    # Name preserves identity but tagged so downstream UI knows source
    assert "1.2.156" in rewritten.name
    assert ".dicom.png" in rewritten.name
    # file_id preserved so referenced_file_ids on the assistant
    # response still binds correctly
    assert rewritten.file_id == "file-pacs-1"
    # content_base64 is real PNG bytes
    decoded = base64.b64decode(rewritten.content_base64)
    assert decoded.startswith(b"\x89PNG\r\n\x1a\n")


def test_rewrite_preserves_file_id_for_feedback_binding():
    """The rewritten attachment must keep file_id so #128
    referenced_file_ids on assistant_response still works."""
    from nexus_server.llm_gateway import (
        _maybe_rewrite_dicom_to_png, Attachment,
    )
    att = Attachment(
        name="ct.dcm", mime="application/octet-stream",
        size_bytes=1000, content_text=None,
        content_base64=_sample_ct_b64(),
        file_id="file-xyz-789",
    )
    out = _maybe_rewrite_dicom_to_png(att)
    assert out.file_id == "file-xyz-789"


# ── Pass-through cases ───────────────────────────────────────────────


def test_non_dicom_bytes_pass_through():
    """Random bytes should NOT be rewritten — magic-byte check fails."""
    from nexus_server.llm_gateway import (
        _maybe_rewrite_dicom_to_png, Attachment,
    )
    att = Attachment(
        name="notes.pdf", mime="application/pdf",
        size_bytes=200, content_text=None,
        content_base64=base64.b64encode(b"%PDF-1.4 some pdf bytes" * 10).decode(),
        file_id="f1",
    )
    out = _maybe_rewrite_dicom_to_png(att)
    assert out is att  # identity, not rewritten
    assert out.mime == "application/pdf"


def test_no_base64_pass_through():
    """Attachments without bytes (failed file_id resolve) can't be
    detected — pass through unchanged."""
    from nexus_server.llm_gateway import (
        _maybe_rewrite_dicom_to_png, Attachment,
    )
    att = Attachment(
        name="x", mime="application/octet-stream",
        size_bytes=0, content_text=None,
        content_base64=None,
        file_id="missing",
    )
    out = _maybe_rewrite_dicom_to_png(att)
    assert out is att


def test_existing_png_attachment_unchanged():
    """A real PNG upload should not be misdetected as DICOM."""
    from nexus_server.llm_gateway import (
        _maybe_rewrite_dicom_to_png, Attachment,
    )
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00" * 200  # not a complete PNG but enough to pass magic
    )
    att = Attachment(
        name="screenshot.png", mime="image/png",
        size_bytes=len(png_bytes), content_text=None,
        content_base64=base64.b64encode(png_bytes).decode(),
        file_id="png-1",
    )
    out = _maybe_rewrite_dicom_to_png(att)
    # Magic bytes don't match "DICM" at offset 128 — return original
    assert out is att
    assert out.mime == "image/png"


def test_corrupt_dicom_falls_back_to_original():
    """Magic bytes say DICM but pydicom can't parse — should NOT
    crash the chat turn; return original Attachment unchanged so
    the agent at least sees "[binary content omitted]" rather than
    a 500."""
    from nexus_server.llm_gateway import (
        _maybe_rewrite_dicom_to_png, Attachment,
    )
    # 128 zero bytes + "DICM" + garbage afterwards
    fake_dicom = b"\x00" * 128 + b"DICM" + b"this is not real DICOM payload"
    att = Attachment(
        name="bogus.dcm", mime="application/octet-stream",
        size_bytes=len(fake_dicom), content_text=None,
        content_base64=base64.b64encode(fake_dicom).decode(),
        file_id="bogus",
    )
    out = _maybe_rewrite_dicom_to_png(att)
    # Either returned the original (parse failed gracefully) OR
    # somehow rendered — both are acceptable as long as no exception
    # bubbled up. The point is the chat turn survives.
    assert out.file_id == "bogus"
