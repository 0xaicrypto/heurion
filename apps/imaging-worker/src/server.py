import os
import uvicorn
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any

try:
    from .device import get_device_info
    from .engine import MONAIEngine, generate_synthetic_ct_volume
except (ImportError, ValueError):
    from device import get_device_info
    from engine import MONAIEngine, generate_synthetic_ct_volume

from fastapi import FastAPI, HTTPException, Body, UploadFile, File
import tempfile
from pathlib import Path

app = FastAPI(
    title="Heurion 2.0 MONAI Medical Imaging Worker",
    description="High-performance medical imaging inference worker supporting Apple Silicon MPS, NVIDIA CUDA, and CPU.",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = MONAIEngine()
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

class BenchmarkRequest(BaseModel):
    model_name: Optional[str] = "lung_nodule_segmenter"
    window_preset: Optional[str] = "lung"
    z_slices: Optional[int] = 48
    y_dim: Optional[int] = 128
    x_dim: Optional[int] = 128

class SampleRequest(BaseModel):
    sample_id: str = "spleen_test"
    model_name: Optional[str] = "spleen_segmenter"
    window_preset: Optional[str] = None

class FileAnalysisRequest(BaseModel):
    file_path: str
    model_name: Optional[str] = "spleen_segmenter"
    window_preset: Optional[str] = None

@app.get("/health")
def health_check():
    dev_info = get_device_info()
    return {
        "status": "healthy",
        "service": "heurion-monai-worker",
        "device": dev_info,
        "supported_modalities": ["CT", "MR", "PET", "NIfTI", "DICOM"],
    }

@app.get("/api/v1/models")
def list_clinical_models():
    return {
        "models": [
            {
                "id": "spleen_segmenter",
                "name": "腹部实质脏器与脾脏分割 (MONAI 3D SegResNet)",
                "modality": "Abdominal CT",
                "target": "Spleen / Parenchymal Organs",
                "recommended_window": "abdomen"
            },
            {
                "id": "multi_organ_ct",
                "name": "全腹部多器官分割 (MONAI SwinUNETR)",
                "modality": "Abdominal CT",
                "target": "Liver, Spleen, Kidneys, Pancreas, Aorta",
                "recommended_window": "abdomen"
            },
            {
                "id": "lung_nodule_segmenter",
                "name": "肺结节与实变自动分割 (MONAI 3D SegResNet)",
                "modality": "Chest CT",
                "target": "Pulmonary Nodules / Lesions",
                "recommended_window": "lung"
            },
            {
                "id": "liver_lesion_segmenter",
                "name": "肝脏与局灶病灶分割 (MONAI UNet)",
                "modality": "Abdominal CT",
                "target": "Liver Parenchyma & Focal Metastases",
                "recommended_window": "abdomen"
            },
            {
                "id": "brain_tumor_brats",
                "name": "脑胶质瘤多序列分割 (MONAI BraTS DynUNet)",
                "modality": "Brain MRI (T1, T1c, T2, FLAIR)",
                "target": "Enhancing Tumor, Edema, Necrotic Core",
                "recommended_window": "brain"
            },
            {
                "id": "bronchiectasis_mucus_analyzer",
                "name": "支气管扩张与粘液栓 (Mucus Plug) 定量分析",
                "modality": "Chest HRCT",
                "target": "Airway Tree, Broncho-Arterial Ratio (BAR), Mucus Occlusion, Tree-in-Bud",
                "recommended_window": "lung"
            }
        ]
    }

@app.get("/api/v1/samples")
def list_samples():
    samples = []
    spleen_path = DATA_DIR / "spleen_test.nii.gz"
    if spleen_path.exists():
        samples.append({
            "id": "spleen_test",
            "name": "真实临床腹部增强 CT 扫描 (96层 512x512)",
            "modality": "CT",
            "default_model": "spleen_segmenter",
            "default_window": "abdomen",
            "size_mb": round(spleen_path.stat().st_size / (1024 * 1024), 1)
        })
    mri_path = DATA_DIR / "prostate_mri.nii.gz"
    if mri_path.exists():
        samples.append({
            "id": "prostate_mri",
            "name": "真实临床前列腺 T2 加权 MRI (19层 320x320)",
            "modality": "MRI",
            "default_model": "liver_lesion_segmenter",
            "default_window": "abdomen",
            "size_mb": round(mri_path.stat().st_size / (1024 * 1024), 1)
        })
    return {"samples": samples}

@app.post("/api/v1/analyze/benchmark")
def run_benchmark_analysis(req: BenchmarkRequest = Body(...)):
    """Generates synthetic anatomical volume and runs MONAI inference on device."""
    model_name = req.model_name or "lung_nodule_segmenter"
    if model_name in ("bronchiectasis_mucus_analyzer", "bronchiectasis"):
        try:
            from .bronchiectasis import generate_synthetic_bronchiectasis_ct
        except (ImportError, ValueError):
            from bronchiectasis import generate_synthetic_bronchiectasis_ct
        vol, _, _ = generate_synthetic_bronchiectasis_ct(
            shape=(req.z_slices or 48, req.y_dim or 128, req.x_dim or 128),
            spacing=(1.5, 0.8, 0.8)
        )
        return engine.analyze_volume(
            volume=vol,
            spacing=(1.5, 0.8, 0.8),
            model_name="bronchiectasis_mucus_analyzer",
            window_preset="lung"
        )

    vol, _ = generate_synthetic_ct_volume(
        shape=(req.z_slices, req.y_dim, req.x_dim),
        spacing=(1.5, 0.8, 0.8)
    )
    result = engine.analyze_volume(
        volume=vol,
        spacing=(1.5, 0.8, 0.8),
        model_name=model_name,
        window_preset=req.window_preset or "lung"
    )
    return result

@app.post("/api/v1/analyze/bronchiectasis")
def run_bronchiectasis_analysis(req: BenchmarkRequest = Body(...)):
    """Specialized endpoint for HRCT Bronchiectasis & Mucus Plug quantification."""
    try:
        from .bronchiectasis import generate_synthetic_bronchiectasis_ct
    except (ImportError, ValueError):
        from bronchiectasis import generate_synthetic_bronchiectasis_ct
    vol, _, _ = generate_synthetic_bronchiectasis_ct(
        shape=(req.z_slices or 48, req.y_dim or 128, req.x_dim or 128),
        spacing=(1.5, 0.8, 0.8)
    )
    return engine.analyze_volume(
        volume=vol,
        spacing=(1.5, 0.8, 0.8),
        model_name="bronchiectasis_mucus_analyzer",
        window_preset="lung"
    )

@app.post("/api/v1/analyze/sample")
def run_sample_analysis(req: SampleRequest = Body(...)):
    """Runs MONAI inference on a pre-loaded clinical sample."""
    sample_file = DATA_DIR / f"{req.sample_id}.nii.gz"
    if not sample_file.exists():
        sample_file = DATA_DIR / f"{req.sample_id}.nii"
    if not sample_file.exists():
        raise HTTPException(status_code=404, detail=f"Sample '{req.sample_id}' not found in data directory")

    model_name = req.model_name or ("spleen_segmenter" if "spleen" in req.sample_id else "lung_nodule_segmenter")
    try:
        return engine.analyze_file(
            file_path=str(sample_file),
            model_name=model_name,
            window_preset=req.window_preset
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {str(e)}")

@app.post("/api/v1/analyze/file")
def run_file_analysis(req: FileAnalysisRequest = Body(...)):
    """Runs MONAI inference on a specified local file path."""
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {req.file_path}")
    try:
        return engine.analyze_file(
            file_path=req.file_path,
            model_name=req.model_name or "spleen_segmenter",
            window_preset=req.window_preset
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {str(e)}")

@app.post("/api/v1/analyze/upload")
async def run_upload_analysis(
    file: UploadFile = File(...),
    model_name: str = "spleen_segmenter",
    window_preset: Optional[str] = None
):
    """Uploads a .nii or .nii.gz file and executes MONAI inference."""
    suffix = ".nii.gz" if file.filename.endswith(".nii.gz") else ".nii"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        res = engine.analyze_file(
            file_path=tmp_path,
            model_name=model_name,
            window_preset=window_preset
        )
        return res
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

def start_server():
    port = int(os.environ.get("PORT", "8004"))
    uvicorn.run("apps.imaging-worker.src.server:app", host="127.0.0.1", port=port, reload=False)

if __name__ == "__main__":
    start_server()
