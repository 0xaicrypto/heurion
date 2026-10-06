import pytest
import numpy as np
from fastapi.testclient import TestClient

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from engine import generate_synthetic_ct_volume, MONAIEngine
from interactive import interactive_segment_3d
from server import app


def test_interactive_segment_positive_click():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    res = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[{'z': 16, 'y': 36, 'x': 44, 'is_positive': True}]
    )
    assert res["status"] == "success"
    assert res["voxel_count"] > 100
    assert res["volume_cm3"] > 0.1
    assert res["key_slice_index"] == 16
    assert 40.0 <= res["target_hu"] <= 70.0


def test_interactive_segment_negative_repulsion():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    res_pos_only = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[{'z': 16, 'y': 36, 'x': 44, 'is_positive': True}]
    )
    
    # Add negative click right next to positive region
    res_with_neg = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[
            {'z': 16, 'y': 36, 'x': 44, 'is_positive': True},
            {'z': 16, 'y': 44, 'x': 44, 'is_positive': False}
        ]
    )
    assert res_with_neg["status"] == "success"
    assert res_with_neg["voxel_count"] < res_pos_only["voxel_count"]


def test_interactive_segment_bbox_constraint():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    res = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[{'z': 16, 'y': 36, 'x': 44, 'is_positive': True}],
        bbox={'z_min': 14, 'z_max': 18, 'y_min': 30, 'y_max': 42, 'x_min': 38, 'x_max': 50}
    )
    mask = res["mask"]
    # Check that mask does not leak outside bounding box
    assert np.all(mask[:14, :, :] == 0)
    assert np.all(mask[19:, :, :] == 0)


def test_interactive_segment_api_endpoint():
    client = TestClient(app)
    res = client.post("/api/v1/analyze/interactive-segment", json={
        "sample_id": "chest_lung_ct",
        "points": [
            {"z": 115, "y": 256, "x": 256, "is_positive": True}
        ],
        "window_preset": "lung",
        "plane": "axial"
    })
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["model_name"] == "vista3d_interactive_segmenter"
    assert "slice_png_base64" in data
    assert data["slice_png_base64"].startswith("data:image/png;base64,")
    assert "recist_metrics" in data
    assert data["positive_prompts_count"] == 1
    assert data["negative_prompts_count"] == 0
    assert "MONAI VISTA-3D" in data["summary_markdown"]


def test_models_list_contains_advanced_architectures():
    client = TestClient(app)
    res = client.get("/api/v1/models")
    assert res.status_code == 200
    model_ids = [m["id"] for m in res.json()["models"]]
    assert "vista3d_interactive_segmenter" in model_ids
    assert "whole_body_ct_segmenter" in model_ids
