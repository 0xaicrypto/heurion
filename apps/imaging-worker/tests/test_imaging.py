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


def test_subsolid_metrics_calculations():
    from recist import calculate_subsolid_metrics, calculate_volume_doubling_time
    # 1. Pure GGO: HU values around -450 HU (< -150 HU)
    vol_ggo = np.full((16, 32, 32), -800.0, dtype=np.float32)
    mask_ggo = np.zeros((16, 32, 32), dtype=np.uint8)
    mask_ggo[8, 12:20, 12:20] = 1
    vol_ggo[mask_ggo == 1] = -450.0

    res_ggo = calculate_subsolid_metrics(vol_ggo, mask_ggo, spacing=(1.0, 1.0, 1.0))
    assert res_ggo["nodule_type"] == "pure_ggo"
    assert res_ggo["solid_core_diameter_mm"] == 0.0
    assert res_ggo["consolidation_tumor_ratio"] == 0.0
    assert res_ggo["lung_rads"]["category"] == "2"

    # 2. Part-solid / subsolid: outer rim -450 HU, central core +40 HU (> -150 HU)
    vol_part = np.full((16, 32, 32), -800.0, dtype=np.float32)
    mask_part = np.zeros((16, 32, 32), dtype=np.uint8)
    mask_part[8, 10:22, 10:22] = 1 # 12x12 total nodule
    vol_part[mask_part == 1] = -450.0
    # Center 6x6 core is solid
    mask_solid = np.zeros((16, 32, 32), dtype=bool)
    mask_solid[8, 13:19, 13:19] = True
    vol_part[mask_solid] = 40.0

    res_part = calculate_subsolid_metrics(vol_part, mask_part, spacing=(1.0, 1.0, 1.0))
    assert res_part["nodule_type"] == "part_solid"
    assert res_part["solid_core_diameter_mm"] > 0.0
    assert 0.0 < res_part["consolidation_tumor_ratio"] < 0.8
    assert res_part["lung_rads"]["category"] in ["3", "4A", "4B"]

    # 3. Schwartz Volume Doubling Time (VDT)
    # Rapid growth: doubling in 180 days (<400)
    vdt_rapid = calculate_volume_doubling_time(baseline_vol_cm3=1.0, followup_vol_cm3=2.0, days_interval=180.0)
    assert vdt_rapid["vdt_days"] == 180.0
    assert vdt_rapid["category"] == "rapid_growth"
    assert vdt_rapid["clinical_alert"] is True

    # Indolent growth: doubling in 800 days (>600)
    vdt_slow = calculate_volume_doubling_time(baseline_vol_cm3=1.0, followup_vol_cm3=2.0, days_interval=800.0)
    assert vdt_slow["vdt_days"] == 800.0
    assert vdt_slow["category"] == "indolent_growth"
    assert vdt_slow["clinical_alert"] is False

    # Regressed / stable
    vdt_regr = calculate_volume_doubling_time(baseline_vol_cm3=2.0, followup_vol_cm3=1.0, days_interval=100.0)
    assert vdt_regr["category"] == "regressed"
    assert vdt_regr["vdt_days"] is None


def test_vdt_endpoint():
    client = TestClient(app)
    res = client.post("/api/v1/recist/volume-doubling-time", json={
        "baseline_volume_cm3": 1.2,
        "followup_volume_cm3": 2.4,
        "days_interval": 120.0
    })
    assert res.status_code == 200
    data = res.json()
    assert data["vdt_days"] == 120.0
    assert data["clinical_alert"] is True
    assert data["category"] == "rapid_growth"


def test_quality_control_and_pathology_risk():
    from recist import calculate_subsolid_metrics
    vol = np.full((16, 32, 32), -800.0, dtype=np.float32)
    mask = np.zeros((16, 32, 32), dtype=np.uint8)
    mask[8, 12:20, 12:20] = 1
    vol[mask == 1] = -450.0  # pure GGO

    # Case A: Thin-slice (1.0 mm)
    res_thin = calculate_subsolid_metrics(vol, mask, spacing=(1.0, 0.8, 0.8))
    assert res_thin["quality_control"]["is_thin_slice"] is True
    assert res_thin["quality_control"]["tier"] == "optimal"
    assert res_thin["quality_control"]["warning"] is None
    assert res_thin["pathology_risk"]["risk_level"] == "low"
    assert "AAH" in res_thin["pathology_risk"]["tendency"]

    # Case B: Thick-slice (5.0 mm) -> triggers warning
    res_thick = calculate_subsolid_metrics(vol, mask, spacing=(5.0, 0.8, 0.8))
    assert res_thick["quality_control"]["is_thin_slice"] is False
    assert res_thick["quality_control"]["tier"] == "thick_slice_warning"
    assert "HRCT" in res_thick["quality_control"]["warning"]


def test_emphysema_metrics_and_endpoint():
    from recist import calculate_emphysema_metrics
    # Synthesize volume with bilateral lungs and emphysema area
    vol = np.full((24, 64, 64), -1000.0, dtype=np.float32)
    # Lung body
    vol[:, 10:54, 10:54] = -750.0
    # Emphysema region (HU <= -950)
    vol[:, 20:30, 20:30] = -970.0

    em = calculate_emphysema_metrics(vol, spacing=(1.5, 0.8, 0.8))
    assert em["total_lung_volume_liters"] > 0
    assert em["emphysema_volume_liters"] > 0
    assert em["laa_percent"] > 0
    assert "GOLD" in em["gold_stage"]

    # Test API endpoint
    client = TestClient(app)
    res = client.post("/api/v1/recist/emphysema", json={
        "sample_id": "chest_lung_ct",
        "emphysema_hu_threshold": -950.0
    })
    assert res.status_code == 200
    data = res.json()
    assert "laa_percent" in data
    assert "gold_stage" in data
    assert "total_lung_volume_liters" in data


def test_cascaded_anatomical_masking():
    from engine import MONAIEngine, generate_synthetic_ct_volume
    engine = MONAIEngine()
    vol, _ = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(1.5, 0.8, 0.8))

    # Test COPD Emphysema Analyzer model execution
    res_copd = engine.analyze_volume(volume=vol, spacing=(1.5, 0.8, 0.8), model_name="copd_emphysema_analyzer")
    assert res_copd["status"] == "success"
    assert "emphysema" in res_copd["recist_metrics"]
    assert res_copd["key_slice_png_base64"].startswith("data:image/png;base64,")

    # Test Liver lesion segmenter with bone-exclusion cascaded envelope
    res_liver = engine.analyze_volume(volume=vol, spacing=(1.5, 0.8, 0.8), model_name="liver_lesion_segmenter")
    assert res_liver["status"] == "success"
    assert res_liver["recist_metrics"]["has_lesion"] in (True, False)


def test_model_registry_and_endpoints():
    from model_registry import list_registered_models, pull_model, verify_model, OFFICIAL_MODEL_REGISTRY
    models = list_registered_models()
    assert len(models) >= 5
    names = [m["name"] for m in models]
    assert "lung_nodule_ct" in names
    assert "totalsegmentator" in names
    assert "vista3d" in names

    client = TestClient(app)
    # Test GET /api/v1/models
    res = client.get("/api/v1/models")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["total"] >= 5

    # Test POST /api/v1/models/pull
    res_pull = client.post("/api/v1/models/pull", json={"model_name": "spleen_ct", "force": False})
    assert res_pull.status_code == 200
    pull_data = res_pull.json()
    assert pull_data["status"] in ("success", "already_installed")

    # Test POST /api/v1/models/verify
    res_v = client.post("/api/v1/models/verify", json={"model_name": "spleen_ct"})
    assert res_v.status_code == 200
    assert "installed" in res_v.json()


def test_dicom_anonymization_and_endpoint():
    import io
    import zipfile
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, CTImageStorage, generate_uid
    from dicom_io import anonymize_dicom_dataset, anonymize_dicom_zip

    # Create synthetic pydicom dataset with PHI
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
    ds.Modality = "CT"
    ds.PatientName = "Zhang^San"
    ds.PatientID = "HOSP-998877"
    ds.PatientBirthDate = "19750512"
    ds.InstitutionName = "First Affiliated Hospital"
    ds.ReferringPhysicianName = "Dr^Li"
    ds.Rows = 16
    ds.Columns = 16
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 1
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelSpacing = [1.0, 1.0]
    ds.SliceThickness = "2.0"
    ds.ImagePositionPatient = [0.0, 0.0, 10.0]
    ds.PixelData = np.zeros((16, 16), dtype=np.int16).tobytes()

    # Test in-memory dataset anonymization
    anon_ds = anonymize_dicom_dataset(ds, anonymous_id="TEST01")
    assert "ANONYMIZED^TEST01" == str(anon_ds.PatientName)
    assert "ANON-TEST01" == str(anon_ds.PatientID)
    assert "Heurion" in str(anon_ds.InstitutionName)

    # Test zip anonymization
    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    dcm_bytes = buf.getvalue()

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w") as zf:
        zf.writestr("slice_001.dcm", dcm_bytes)
        zf.writestr("__MACOSX/._slice_001.dcm", b"junk")
    
    zip_bytes = zip_buf.getvalue()
    out_bytes, report = anonymize_dicom_zip(zip_bytes, anonymous_id="BATCH01")
    assert report["total_slices_anonymized"] == 1
    assert report["skipped_files_count"] == 1
    assert len(out_bytes) > 0

    # Test API endpoint
    client = TestClient(app)
    res = client.post(
        "/api/v1/dicom/anonymize",
        data={"anonymous_id": "API01", "retain_dates": "false"},
        files={"file": ("test_series.zip", zip_bytes, "application/zip")}
    )
    assert res.status_code == 200
    assert res.headers["x-anonymous-id"] == "API01"
    assert res.headers["x-anonymized-slices"] == "1"


def test_async_task_queue_and_endpoints():
    client = TestClient(app)

    # 1. Submit async inference task
    res_submit = client.post("/api/v1/tasks/analyze", json={
        "sample_id": "chest_lung_ct",
        "model_name": "lung_nodule_segmenter"
    })
    assert res_submit.status_code == 200
    data = res_submit.json()
    assert "task_id" in data
    assert data["status"] in ("queued", "running")
    task_id = data["task_id"]

    # 2. Poll task status
    import time
    max_wait = 10
    start = time.time()
    final_task = None
    while time.time() - start < max_wait:
        res_poll = client.get(f"/api/v1/tasks/{task_id}")
        assert res_poll.status_code == 200
        poll_data = res_poll.json()
        if poll_data["status"] == "completed":
            final_task = poll_data
            break
        time.sleep(0.3)

    assert final_task is not None
    assert final_task["status"] == "completed"
    assert final_task["progress_pct"] == 100
    assert "recist_metrics" in final_task["result"]
    assert "key_slice_png_base64" in final_task["result"]

    # 3. List tasks
    res_list = client.get("/api/v1/tasks")
    assert res_list.status_code == 200
    tasks_list = res_list.json()
    assert any(t["task_id"] == task_id for t in tasks_list["tasks"])


