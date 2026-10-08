import pytest
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from fastapi.testclient import TestClient
from server import app
from clinical_audit import (
    run_all_clinical_audits,
    audit_case_01_li_xiang,
    audit_case_02_nsclc_tcia,
    audit_case_03_wang_wei,
    audit_case_04_zhang_min,
    PHYSIOLOGICAL_LIMITS
)

client = TestClient(app)
CASES_DIR = "/Users/huizhao/Downloads/medical_imaging_test_cases"

def test_clinical_audit_case_01():
    """Validates Case 1 (Li Xiang) physiological mucus limits and scan boundaries."""
    res = audit_case_01_li_xiang(CASES_DIR)
    assert res["case_id"] == "PT-BRONCHO-001"
    assert res["clinical_audit_passed"] is True
    # Verify physiological bound
    mucus_vol = res["quantitative_findings"]["total_mucus_volume_cm3"]
    assert mucus_vol <= PHYSIOLOGICAL_LIMITS["bronchial_mucus_max_cm3"], f"Mucus volume {mucus_vol} exceeds physiological limit"
    # Verify scan range does not contain L3
    assert res["scan_geometry"]["contains_l3_vertebra"] is False
    assert len(res["discrepancies_fixed"]) >= 3

def test_clinical_audit_case_02():
    """Validates Case 2 (TCIA Lung Cancer) DICOM PS 3.15 and oncology nomenclature."""
    res = audit_case_02_nsclc_tcia(CASES_DIR)
    assert res["case_id"] == "PT-NSCLC-002"
    assert res["clinical_audit_passed"] is True
    assert res["dicom_compliance"]["ps_3_15_phi_deidentified"] is True
    assert "一线单药分子靶向治疗" in res["oncology_therapy_classification"]
    assert res["target_lesion_recist"]["recist_change_pct"] == -45.0

def test_clinical_audit_case_03():
    """Validates Case 3 (Wang Wei Abdomen CT) splenomegaly and normal pancreas/liver."""
    res = audit_case_03_wang_wei(CASES_DIR)
    assert res["case_id"] == "PT-ABDOMEN-003"
    assert res["clinical_audit_passed"] is True
    assert res["organ_metrics"]["splenomegaly_diagnosed"] is True
    assert res["organ_metrics"]["spleen_volume_cm3"] > PHYSIOLOGICAL_LIMITS["normal_spleen_max_volume_cm3"]
    assert "未见局灶占位" in res["organ_metrics"]["liver_status"]
    assert "未见占位" in res["organ_metrics"]["pancreas_status"]

def test_clinical_audit_case_04():
    """Validates Case 4 (Zhang Min Prostate MRI) TZI and PI-RADS v2.1 scoring."""
    res = audit_case_04_zhang_min(CASES_DIR)
    assert res["case_id"] == "PT-PROSTATE-004"
    assert res["clinical_audit_passed"] is True
    assert res["prostate_metrics"]["transition_zone_index_tzi"] >= PHYSIOLOGICAL_LIMITS["bph_tzi_cutoff"]
    assert res["prostate_metrics"]["pi_rads_v2_1_score"] == 2
    assert "规避非必要经直肠有创穿刺活检" in res["prostate_metrics"]["clinical_cdss_recommendation"]

def test_run_all_clinical_audits_endpoint():
    """Tests the /api/v1/clinical/audit-cases REST API endpoint."""
    response = client.get("/api/v1/clinical/audit-cases", params={"cases_dir": CASES_DIR})
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert data["all_cases_passed"] is True
    assert data["total_cases_audited"] == 4
