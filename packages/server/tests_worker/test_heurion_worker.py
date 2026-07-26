"""Tests for the Execution Plane worker (heurion_worker)."""

from unittest.mock import patch

import pytest

from heurion_worker import consumer, sidecar


@pytest.fixture
def mock_upload():
    def _fake_upload(*, file_obj, file_name, mime_type, tenant_prefix, file_id):
        file_obj.seek(0, 2)
        return {
            "file_id": file_id,
            "file_name": file_name,
            "mime_type": mime_type,
            "size_bytes": file_obj.tell(),
            "storage_key": f"tenants/{tenant_prefix}/{file_id}/{file_name}",
            "download_url": "http://example.com/download",
        }

    with patch("heurion_worker.sidecar.upload_output") as m:
        m.side_effect = _fake_upload
        yield m


def test_generate_docx_from_case_summary_template(mock_upload):
    result = sidecar.generate_docx(
        {
            "template_id": "case_summary",
            "output_name": "ZQ_Case_Summary",
            "data": {
                "patient_initials": "ZQ",
                "age": 58,
                "sex": "M",
                "diagnosis": "NSCLC IIIA",
                "findings_html": "Left upper lobe mass, 3.2 cm.",
                "treatment_plan": "Neoadjuvant therapy.",
                "generated_at": "2026-07-26",
            },
            "tenant": {"workspace_id": "ws_1", "user_id": "u_1"},
        }
    )

    assert result["file_name"] == "ZQ_Case_Summary.docx"
    assert result["mime_type"].endswith("wordprocessingml.document")
    assert result["size_bytes"] > 0
    uploaded_file = mock_upload.call_args.kwargs["file_obj"]
    uploaded_file.seek(0, 2)
    assert uploaded_file.tell() > 0


def test_render_table(mock_upload):
    result = sidecar.render_table(
        {
            "title": "Baseline Characteristics",
            "headers": ["Variable", "Value"],
            "rows": [["Age", "58"], ["Sex", "M"]],
            "output_name": "table_1",
        }
    )

    assert result["file_name"] == "table_1.docx"


def test_render_plot(mock_upload):
    result = sidecar.render_plot(
        {
            "plot_type": "bar",
            "title": "Response Rate",
            "x_label": "Arm",
            "y_label": "%",
            "series": [{"x": ["A", "B"], "y": [30, 55], "label": "ORR"}],
            "output_name": "orr_plot",
        }
    )

    assert result["file_name"] == "orr_plot.png"
    assert result["mime_type"] == "image/png"


def test_dispatch_unknown_job_type():
    with pytest.raises(RuntimeError, match="Unknown sidecar job type"):
        sidecar.dispatch("sidecar.unknown", {})


def test_consumer_handle_sidecar_job(mock_upload):
    record = {
        "job_id": "job_123",
        "type": "sidecar.generate_docx",
        "payload": '{"template_id": "case_summary", "data": {"patient_initials": "AB"}, "tenant": {"workspace_id": "ws_1"}}',
    }
    result = consumer._handle("job_123", record)
    assert result["file_name"] == "case_summary.docx"


def test_consumer_handle_non_sidecar_job():
    record = {"job_id": "job_123", "type": "ping", "payload": "{}"}
    result = consumer._handle("job_123", record)
    assert result["acknowledged"] is True


