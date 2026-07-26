"""MedSci-Sidecar rendering handlers.

Implements the Execution Plane side of the MedSci-Sidecar plugin:
- DOCX generation from Jinja2-style templates (docxtpl)
- PPTX generation from templates (python-pptx)
- Medical table rendering
- Plot rendering (matplotlib / plotly)
- Upload of generated files to object storage
"""

from __future__ import annotations

import io
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any

from heurion_worker.storage import upload_output

logger = logging.getLogger("heurion-worker.sidecar")


def _template_dir() -> Path:
    """Return the directory containing bundled system templates."""
    return Path(__file__).with_name("templates")


def _make_file_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _tenant_prefix(payload: dict[str, Any]) -> str:
    """Extract a tenant/workspace prefix from the job payload.

    Falls back to ``default`` so the object store layout is always valid.
    """
    tenant = payload.get("tenant") or {}
    if isinstance(tenant, str):
        try:
            tenant = json.loads(tenant)
        except Exception:
            tenant = {}
    workspace_id = tenant.get("workspace_id") or tenant.get("id") or "default"
    user_id = tenant.get("user_id") or "anonymous"
    return f"{workspace_id}/{user_id}"


def generate_docx(payload: dict[str, Any]) -> dict:
    """Render a Word document from a template + structured data."""
    from docxtpl import DocxTemplate

    template_id = payload.get("template_id", "case_summary")
    data = payload.get("data", {})
    output_name = payload.get("output_name") or template_id

    template_path = _template_dir() / "docx" / f"{template_id}.docx"
    if not template_path.exists():
        available = [p.stem for p in (_template_dir() / "docx").glob("*.docx")]
        raise RuntimeError(f"Template '{template_id}' not found. Available: {available}")

    tpl = DocxTemplate(str(template_path))
    tpl.render(data)

    file_id = _make_file_id("docx")
    file_name = f"{output_name}.docx"
    buf = io.BytesIO()
    tpl.save(buf)

    return upload_output(
        file_obj=buf,
        file_name=file_name,
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        tenant_prefix=_tenant_prefix(payload),
        file_id=file_id,
    )


def generate_pptx(payload: dict[str, Any]) -> dict:
    """Render a PowerPoint presentation from a template + structured data."""
    from pptx import Presentation

    template_id = payload.get("template_id", "academic_presentation")
    data = payload.get("data", {})
    output_name = payload.get("output_name") or template_id

    template_path = _template_dir() / "pptx" / f"{template_id}.pptx"
    if not template_path.exists():
        available = [p.stem for p in (_template_dir() / "pptx").glob("*.pptx")]
        raise RuntimeError(f"Template '{template_id}' not found. Available: {available}")

    prs = Presentation(str(template_path))

    # Minimal MVP substitution: replace text placeholders of the form {{key}}
    # across all slides. Full table/chart population comes later.
    for slide in prs.slides:
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for paragraph in shape.text_frame.paragraphs:
                for run in paragraph.runs:
                    for key, value in data.items():
                        placeholder = f"{{{{{key}}}}}"
                        if placeholder in run.text:
                            run.text = run.text.replace(placeholder, str(value))

    file_id = _make_file_id("pptx")
    file_name = f"{output_name}.pptx"
    buf = io.BytesIO()
    prs.save(buf)

    return upload_output(
        file_obj=buf,
        file_name=file_name,
        mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        tenant_prefix=_tenant_prefix(payload),
        file_id=file_id,
    )


def render_table(payload: dict[str, Any]) -> dict:
    """Render a medical/Table 1 baseline characteristics table as DOCX."""
    from docx import Document
    from docx.shared import Inches

    title = payload.get("title", "Table 1")
    headers = payload.get("headers", ["Variable", "Value"])
    rows = payload.get("rows", [])
    output_name = payload.get("output_name") or "table_1"

    doc = Document()
    doc.add_heading(title, level=1)
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"

    hdr_cells = table.rows[0].cells
    for i, h in enumerate(headers):
        hdr_cells[i].text = str(h)

    for row in rows:
        cells = table.add_row().cells
        for i, cell in enumerate(row):
            if i < len(cells):
                cells[i].text = str(cell)

    file_id = _make_file_id("table")
    file_name = f"{output_name}.docx"
    buf = io.BytesIO()
    doc.save(buf)

    return upload_output(
        file_obj=buf,
        file_name=file_name,
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        tenant_prefix=_tenant_prefix(payload),
        file_id=file_id,
    )


def render_plot(payload: dict[str, Any]) -> dict:
    """Render a statistical plot (KM curve, bar chart, etc.) as PNG."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plot_type = payload.get("plot_type", "bar")
    title = payload.get("title", "Plot")
    x_label = payload.get("x_label", "X")
    y_label = payload.get("y_label", "Y")
    series = payload.get("series", [{"x": [1, 2, 3], "y": [1, 4, 2], "label": "Series 1"}])

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.set_title(title)
    ax.set_xlabel(x_label)
    ax.set_ylabel(y_label)

    for s in series:
        x = s.get("x", [])
        y = s.get("y", [])
        label = s.get("label", "")
        if plot_type == "scatter":
            ax.scatter(x, y, label=label)
        elif plot_type == "line":
            ax.plot(x, y, label=label)
        else:
            ax.bar(x, y, label=label)

    if len(series) > 1:
        ax.legend()

    file_id = _make_file_id("plot")
    file_name = f"{payload.get('output_name', 'plot')}.png"
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    return upload_output(
        file_obj=buf,
        file_name=file_name,
        mime_type="image/png",
        tenant_prefix=_tenant_prefix(payload),
        file_id=file_id,
    )


HANDLERS = {
    "sidecar.generate_docx": generate_docx,
    "sidecar.generate_pptx": generate_pptx,
    "sidecar.render_table": render_table,
    "sidecar.render_plot": render_plot,
}


def dispatch(job_type: str, payload: dict[str, Any]) -> dict:
    handler = HANDLERS.get(job_type)
    if not handler:
        raise RuntimeError(f"Unknown sidecar job type: {job_type}")
    return handler(payload)
