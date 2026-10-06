import pytest
import numpy as np
from fastapi.testclient import TestClient

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from engine import generate_synthetic_ct_volume, MONAIEngine
from radiomics import (
    compute_shape_features,
    compute_first_order_features,
    compute_glcm_features,
    compute_glrlm_features,
    extract_radiomics_features
)
from server import app


def test_radiomics_shape_features():
    vol, mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    shape_feats = compute_shape_features(mask, spacing=(2.0, 1.0, 1.0))
    
    assert shape_feats["voxel_count"] > 100
    assert shape_feats["volume_cm3"] > 1.0
    assert shape_feats["surface_area_mm2"] > 100.0
    assert 0.0 < shape_feats["sphericity"] <= 1.0
    assert shape_feats["max_3d_diameter_mm"] > 10.0
    assert shape_feats["major_axis_length_mm"] >= shape_feats["minor_axis_length_mm"]
    assert shape_feats["minor_axis_length_mm"] >= shape_feats["least_axis_length_mm"]


def test_radiomics_first_order_statistics():
    vol, mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    fo = compute_first_order_features(vol, mask, spacing=(2.0, 1.0, 1.0))
    
    # In synthetic volume, lesion is ~55 HU
    assert 40.0 <= fo["mean"] <= 70.0
    assert fo["std"] > 0.0
    assert fo["min"] < fo["mean"] < fo["max"]
    assert fo["iqr"] > 0.0
    assert fo["entropy"] > 0.0
    assert 0.0 <= fo["uniformity"] <= 1.0


def test_radiomics_glcm_features():
    vol, mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    glcm = compute_glcm_features(vol, mask, num_bins=16)
    
    assert glcm["contrast"] >= 0.0
    assert glcm["dissimilarity"] >= 0.0
    assert 0.0 <= glcm["homogeneity"] <= 1.0
    assert 0.0 <= glcm["energy_asm"] <= 1.0
    assert glcm["joint_entropy"] > 0.0


def test_radiomics_glrlm_features():
    vol, mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    glrlm = compute_glrlm_features(vol, mask, num_bins=16)
    
    assert 0.0 <= glrlm["short_run_emphasis"] <= 1.0
    assert glrlm["long_run_emphasis"] >= 1.0
    assert glrlm["gray_level_nonuniformity"] > 0.0
    assert glrlm["run_length_nonuniformity"] > 0.0
    assert 0.0 < glrlm["run_percentage"] <= 1.0


def test_empty_mask_handling():
    vol = np.zeros((16, 32, 32), dtype=np.float32)
    mask = np.zeros((16, 32, 32), dtype=np.uint8)
    
    res = extract_radiomics_features(vol, mask, spacing=(1.0, 1.0, 1.0))
    assert res["status"] == "success"
    assert res["lesion_voxel_count"] == 0
    assert res["feature_groups"]["shape_3d"]["volume_cm3"] == 0.0
    assert res["feature_groups"]["first_order"]["mean"] == 0.0


def test_radiomics_api_endpoint():
    client = TestClient(app)
    res = client.post("/api/v1/analyze/radiomics", json={
        "sample_id": "chest_lung_ct",
        "model_name": "lung_nodule_segmenter",
        "num_bins": 16
    })
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert "feature_groups" in data
    assert "features_flat" in data
    assert "markdown_report" in data
    assert data["feature_count"] >= 40
    assert "shape_volume_cm3" in data["features_flat"]
    assert "firstorder_mean" in data["features_flat"]
    assert "glcm_homogeneity" in data["features_flat"]
    assert "glrlm_short_run_emphasis" in data["features_flat"]
