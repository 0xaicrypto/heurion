import io
import os
import uuid
from pathlib import Path
from typing import Any

from docxtpl import DocxTemplate

from ..storage import upload_output


def _make_file_id() -> str:
    return f"docx_{uuid.uuid4().hex[:16]}"


def _template_dir() -> Path:
    return Path(os.environ.get("PLUGIN_TEMPLATE_DIR", "/templates/docx"))


def generate_docx(payload: dict[str, Any]) -> dict:
    """Render a Word document from a template + structured data."""
    template_id = payload.get("template_id", "case_summary")
    data = payload.get("data", {})
    output_name = payload.get("output_name") or template_id

    template_path = _template_dir() / f"{template_id}.docx"
    if not template_path.exists():
        available = [p.stem for p in _template_dir().glob("*.docx")]
        raise RuntimeError(f"Template '{template_id}' not found. Available: {available}")

    tpl = DocxTemplate(str(template_path))
    tpl.render(data)

    file_id = _make_file_id()
    file_name = f"{output_name}.docx"
    buf = io.BytesIO()
    tpl.save(buf)

    tenant_prefix = os.environ.get("TENANT_PREFIX", "default/anonymous")
    return upload_output(
        file_obj=buf,
        file_name=file_name,
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        tenant_prefix=tenant_prefix,
        file_id=file_id,
    )
