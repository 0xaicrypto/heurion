"""Tests for .docx extraction in distiller.extract_text().

Covers two paths:
  1. python-docx is installed → preferred clean walk
  2. python-docx missing → stdlib zipfile + xml.etree fallback

Both must produce non-empty text from a minimal valid docx. We
synthesise the test file in-memory so the test suite doesn't depend
on any fixture binaries committed to the repo.
"""
from __future__ import annotations

import base64
import io
import sys
import zipfile

import pytest

from nexus_core.distiller import extract_text


# ─────────────────────────────────────────────────────────────────────
# Test fixture: synthesise a minimal valid .docx in-memory
# ─────────────────────────────────────────────────────────────────────


_MIN_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

_MIN_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>"""


def _make_docx(paragraphs: list[str]) -> bytes:
    """Build a minimal valid .docx in-memory from a list of plain
    paragraph strings. Returns the raw zip bytes."""
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body_parts = []
    for p in paragraphs:
        # Escape only the bare minimum; the test strings are ASCII so
        # we don't bother with full XML escaping.
        body_parts.append(
            f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>"
        )
    body = "".join(body_parts)
    document_xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{ns}">'
        f'<w:body>{body}</w:body>'
        f'</w:document>'
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _MIN_CONTENT_TYPES)
        zf.writestr("_rels/.rels", _MIN_RELS)
        zf.writestr("word/document.xml", document_xml)
    return buf.getvalue()


# ─────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────


def test_extract_docx_returns_text_for_valid_docx():
    raw = _make_docx([
        "Hello from the agent.",
        "Second paragraph of structured content.",
    ])
    b64 = base64.b64encode(raw).decode("ascii")
    text, source = extract_text(
        name="memo.docx",
        mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content_text=None,
        content_base64=b64,
    )
    assert source == "docx"
    assert "Hello from the agent" in text
    assert "Second paragraph" in text


def test_extract_docx_picks_up_by_extension_when_mime_wrong():
    """Some browsers / clients upload .docx as application/octet-stream
    or empty mime. We should still recognise it by filename."""
    raw = _make_docx(["Content reachable by extension fallback."])
    b64 = base64.b64encode(raw).decode("ascii")
    text, source = extract_text(
        name="memo.docx",
        mime="application/octet-stream",
        content_text=None,
        content_base64=b64,
    )
    assert source == "docx"
    assert "Content reachable" in text


def test_extract_docx_stdlib_fallback(monkeypatch):
    """Even when python-docx is NOT importable, the stdlib zipfile +
    xml.etree fallback must still produce text. Simulates a minimal
    user install."""
    # Hide python-docx by stuffing None into sys.modules
    monkeypatch.setitem(sys.modules, "docx", None)
    raw = _make_docx(["Fallback path works without python-docx."])
    b64 = base64.b64encode(raw).decode("ascii")
    text, source = extract_text(
        name="report.docx",
        mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content_text=None,
        content_base64=b64,
    )
    assert source == "docx"
    assert "Fallback path works" in text


def test_extract_docx_corrupt_zip_returns_stub():
    """Malformed bytes shouldn't crash — we degrade to a metadata stub."""
    b64 = base64.b64encode(b"not really a zip").decode("ascii")
    text, source = extract_text(
        name="bad.docx",
        mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content_text=None,
        content_base64=b64,
    )
    assert source == "binary-stub"
    assert "bad.docx" in text
