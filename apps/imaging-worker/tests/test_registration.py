import pytest
import numpy as np
from fastapi.testclient import TestClient

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from registration import (
    generate_synthetic_pet_ct_pair,
    compute_normalized_cross_correlation,
    run_3d_deformable_registration,
    compute_pet_metrics_and_fusion,
    delineate_radiotherapy_targets
)
from server import app


def test_synthetic_pet_ct_pair():
    ct, pet, meta = generate_synthetic_pet_ct_pair(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    assert ct.shape == (24, 48, 48)
    assert pet.shape == (24, 48, 48)
    assert np.min(ct) <= -800.0  # Lung / air
    assert np.max(ct) >= 200.0   # Bone
    assert np.max(pet) >= 10.0   # Peak tumor SUV


def test_deformable_registration_ncc_improvement():
    ct, _, _ = generate_synthetic_pet_ct_pair(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    # Create displaced moving volume
    moving = np.roll(ct, shift=(1, 2, -1), axis=(0, 1, 2))
    
    res = run_3d_deformable_registration(
        fixed_vol=ct,
        moving_vol=moving,
        spacing=(2.0, 1.0, 1.0),
        iterations=8,
        smoothing_sigma=1.0
    )
    assert res["status"] == "success"
    assert res["final_ncc"] >= res["initial_ncc"]
    assert res["mse_reduction_percent"] >= 0.0
    assert res["max_displacement_mm"] > 0.0
    assert "Deformable B-Spline" in res["summary_markdown"]


def test_pet_metrics_and_fusion():
    ct, pet, _ = generate_synthetic_pet_ct_pair(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    res = compute_pet_metrics_and_fusion(
        ct_volume=ct,
        pet_volume=pet,
        spacing=(2.0, 1.0, 1.0),
        suv_threshold=2.5
    )
    assert res["status"] == "success"
    assert res["suv_max"] >= 10.0
    assert res["suv_mean"] >= 2.5
    assert res["mtv_cm3"] > 0.1
    assert res["tlg_g"] > 0.1
    assert len(res["fusion_png_base64"]) > 500
    assert res["fusion_png_base64"].startswith("data:image/png;base64,")


def test_delineate_radiotherapy_targets_hierarchy():
    ct, pet, _ = generate_synthetic_pet_ct_pair(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    metabolic_mask = pet >= 2.5
    res = delineate_radiotherapy_targets(
        ct_volume=ct,
        metabolic_or_lesion_mask=metabolic_mask,
        spacing=(2.0, 1.0, 1.0),
        ctv_margin_mm=4.0,
        ptv_margin_mm=3.0
    )
    assert res["status"] == "success"
    # Volumetric hierarchy: GTV < CTV < PTV
    assert 0 < res["gtv_volume_cm3"] <= res["ctv_volume_cm3"]
    assert res["ctv_volume_cm3"] <= res["ptv_volume_cm3"]
    assert "dicom_rt_roi_metadata" in res
    assert "GTV" in res["dicom_rt_roi_metadata"]
    assert "CTV" in res["dicom_rt_roi_metadata"]
    assert "PTV" in res["dicom_rt_roi_metadata"]
    assert res["rtstruct_png_size_bytes"] > 500


def test_registration_endpoints_api():
    client = TestClient(app)

    # 1. Deformable registration
    resp_def = client.post("/api/v1/registration/deformable", json={"iterations": 5})
    assert resp_def.status_code == 200
    assert resp_def.json()["status"] == "success"
    assert resp_def.json()["final_ncc"] >= resp_def.json()["initial_ncc"]

    # 2. PET-CT Fusion
    resp_fuse = client.post("/api/v1/registration/pet-ct-fusion", json={"suv_threshold": 2.5})
    assert resp_fuse.status_code == 200
    data_fuse = resp_fuse.json()
    assert data_fuse["suv_max"] > 5.0
    assert data_fuse["fusion_png_base64"].startswith("data:image/png;base64,")

    # 3. RT-STRUCT Delineation
    resp_rt = client.post("/api/v1/rtstruct/delineate", json={"ctv_margin_mm": 5.0, "ptv_margin_mm": 3.0})
    assert resp_rt.status_code == 200
    data_rt = resp_rt.json()
    assert data_rt["gtv_volume_cm3"] <= data_rt["ctv_volume_cm3"] <= data_rt["ptv_volume_cm3"]
    assert data_rt["rtstruct_png_base64"].startswith("data:image/png;base64,")
