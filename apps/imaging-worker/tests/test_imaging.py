import pytest
import numpy as np
from fastapi.testclient import TestClient

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from device import get_optimal_device, get_device_info
from engine import generate_synthetic_ct_volume, MONAIEngine
from recist import calculate_recist_metrics
from renderer import render_key_slice_png
from server import app

def test_device_detection():
    device = get_optimal_device()
    assert device is not None
    info = get_device_info()
    assert "device_type" in info
    assert info["device_type"] in ["mps", "cuda", "cpu"]

def test_synthetic_volume_and_recist():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    assert vol.shape == (32, 64, 64)
    assert gt_mask.shape == (32, 64, 64)
    
    metrics = calculate_recist_metrics(gt_mask, spacing=(2.0, 1.0, 1.0))
    assert metrics["has_lesion"] is True
    assert metrics["total_volume_cm3"] > 0.0
    assert metrics["longest_diameter_mm"] > 0.0
    assert metrics["caliper_longest"] is not None

def test_key_slice_png_rendering():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(16, 64, 64), spacing=(2.0, 1.0, 1.0))
    metrics = calculate_recist_metrics(gt_mask, spacing=(2.0, 1.0, 1.0))
    key_slice = metrics["key_slice_index"]
    
    ct_slice = np.clip(vol[key_slice], 0, 255).astype(np.uint8)
    mask_slice = gt_mask[key_slice]
    
    png_bytes = render_key_slice_png(
        ct_slice_uint8=ct_slice,
        mask_slice_2d=mask_slice,
        recist=metrics,
        modality="CT",
        lesion_name="Test Nodule"
    )
    assert len(png_bytes) > 100
    # PNG signature header: 89 50 4E 47 0D 0A 1A 0A
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"

def test_api_health_and_benchmark():
    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "healthy"
    assert "device" in data
    
    res_bench = client.post("/api/v1/analyze/benchmark", json={
        "model_name": "lung_nodule_segmenter",
        "z_slices": 24,
        "y_dim": 64,
        "x_dim": 64
    })
    assert res_bench.status_code == 200
    bench_data = res_bench.json()
    assert bench_data["status"] == "success"
    assert "recist_metrics" in bench_data
    assert "key_slice_png_base64" in bench_data
    assert bench_data["key_slice_png_base64"].startswith("data:image/png;base64,")

def test_api_models_and_samples():
    client = TestClient(app)
    res_models = client.get("/api/v1/models")
    assert res_models.status_code == 200
    assert len(res_models.json()["models"]) >= 3

    res_samples = client.get("/api/v1/samples")
    assert res_samples.status_code == 200
    samples = res_samples.json()["samples"]
    assert len(samples) >= 1
    sample_id = samples[0]["id"]

    res_sample_ana = client.post("/api/v1/analyze/sample", json={"sample_id": sample_id})
    assert res_sample_ana.status_code == 200
    data = res_sample_ana.json()
    assert data["status"] == "success"
    assert data["recist_metrics"]["longest_diameter_mm"] > 0
    assert data["key_slice_png_base64"].startswith("data:image/png;base64,")

def test_bronchiectasis_and_mucus_analysis():
    client = TestClient(app)
    res = client.post("/api/v1/analyze/bronchiectasis", json={
        "model_name": "bronchiectasis_mucus_analyzer",
        "z_slices": 24,
        "y_dim": 64,
        "x_dim": 64
    })
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["analysis_type"] == "bronchiectasis_and_mucus"
    assert "metrics" in data
    assert data["metrics"]["broncho_arterial_ratio"] > 1.0
    assert data["metrics"]["total_mucus_volume_cm3"] > 0
    assert "印戒征" in str(data["metrics"]["signs_detected"])
    assert data["key_slice_png_base64"].startswith("data:image/png;base64,")
