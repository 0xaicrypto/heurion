"""Plugin tool handlers."""

from .docx import generate_docx
from .pptx import generate_pptx
from .table import render_table
from .plot import render_plot
from .pdf import convert_to_pdf

HANDLERS = {
    "generate_docx": generate_docx,
    "generate_pptx": generate_pptx,
    "render_table": render_table,
    "render_plot": render_plot,
    "convert_to_pdf": convert_to_pdf,
}
