import io
import os
import uuid
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from ..storage import upload_output


def _make_file_id() -> str:
    return f"plot_{uuid.uuid4().hex[:16]}"


def render_plot(payload: dict[str, Any]) -> dict:
    """Render a statistical plot (KM curve, bar chart, etc.) as PNG."""
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

    file_id = _make_file_id()
    file_name = f"{payload.get('output_name', 'plot')}.png"
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    tenant_prefix = os.environ.get("TENANT_PREFIX", "default/anonymous")
    return upload_output(
        file_obj=buf,
        file_name=file_name,
        mime_type="image/png",
        tenant_prefix=tenant_prefix,
        file_id=file_id,
    )
