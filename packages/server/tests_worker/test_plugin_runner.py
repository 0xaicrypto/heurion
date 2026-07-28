"""Tests for the plugin-based runner with local fallback."""

import os

import pytest

from heurion_worker import plugin_runner


def _force_local(monkeypatch):
    monkeypatch.setattr(plugin_runner, "RUNNER_BACKEND", "local")


def test_run_docx_local_fallback(tmp_path, monkeypatch):
    _force_local(monkeypatch)
    output_dir = tmp_path / "outputs"
    monkeypatch.setenv("PLUGIN_LOCAL_OUTPUT_DIR", str(output_dir))
    monkeypatch.setenv("PLUGIN_LOCAL_URL_PREFIX", "http://test.local/plugin-outputs")

    result = plugin_runner.run(
        "sidecar.heurion/docx.generate_docx",
        {
            "template_id": "case_summary",
            "output_name": "Local_Test",
            "data": {"patient_name": "Local Patient", "diagnosis": "X", "summary": "Y"},
        },
        tenant={"workspace_id": "ws_test", "user_id": "u_test"},
    )

    assert result["file_name"] == "Local_Test.docx"
    assert result["mime_type"].endswith("wordprocessingml.document")
    assert result["size_bytes"] > 0
    assert os.path.exists(result["storage_key"])
    assert result["download_url"].startswith("http://test.local/plugin-outputs")


def test_old_job_type_alias_mapping():
    resolved = plugin_runner._resolve_job_type("sidecar.generate_docx")
    assert resolved == "sidecar.heurion/docx.generate_docx"

    parsed = plugin_runner._parse_job_type("sidecar.generate_docx")
    assert parsed == ("heurion/docx", "generate_docx")


def test_manifests_match_official_catalog():
    import json
    from pathlib import Path

    official_path = Path(__file__).parent.parent.parent.parent / "packages" / "server-ts" / "data" / "official-plugins.json"
    assert official_path.exists(), "official-plugins.json not found"
    with official_path.open("r", encoding="utf-8") as f:
        official = json.load(f)

    official_ids = {m["plugin"]["id"] for m in official}
    runner_ids = set(plugin_runner.MANIFESTS.keys())

    assert official_ids == runner_ids, f"manifest mismatch: {official_ids ^ runner_ids}"
    for manifest in official:
        pid = manifest["plugin"]["id"]
        assert plugin_runner.MANIFESTS[pid]["plugin"]["name"] == manifest["plugin"]["name"]
