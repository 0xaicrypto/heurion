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

from fastapi import FastAPI, HTTPException, Body, UploadFile, File, Form
from fastapi.responses import FileResponse
import tempfile
import zipfile
import shutil
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
    mucus_min_hu: Optional[float] = 10.0
    mucus_max_hu: Optional[float] = 75.0
    ham_threshold_hu: Optional[float] = 70.0
    bar_cutoff: Optional[float] = 1.10

class SampleRequest(BaseModel):
    sample_id: str = "spleen_test"
    model_name: Optional[str] = "spleen_segmenter"
    window_preset: Optional[str] = None
    mucus_min_hu: Optional[float] = 10.0
    mucus_max_hu: Optional[float] = 75.0
    ham_threshold_hu: Optional[float] = 70.0
    bar_cutoff: Optional[float] = 1.10

class FileAnalysisRequest(BaseModel):
    file_path: str
    model_name: Optional[str] = "spleen_segmenter"
    window_preset: Optional[str] = None
    mucus_min_hu: Optional[float] = 10.0
    mucus_max_hu: Optional[float] = 75.0
    ham_threshold_hu: Optional[float] = 70.0
    bar_cutoff: Optional[float] = 1.10

class MprInfoRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None

class MprSliceRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None
    plane: Optional[str] = "axial"  # axial, coronal, sagittal
    slice_index: Optional[int] = None
    window_preset: Optional[str] = None
    overlay_mask: Optional[bool] = True
    model_name: Optional[str] = None

class DiffSliceRequest(BaseModel):
    baseline_id: Optional[str] = "chest_lung_ct"
    followup_id: Optional[str] = "chest_lung_ct"
    baseline_path: Optional[str] = None
    followup_path: Optional[str] = None
    plane: Optional[str] = "axial"
    slice_index: Optional[int] = None
    window_preset: Optional[str] = None
    threshold_hu: Optional[float] = 50.0

class RadiomicsRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None
    model_name: Optional[str] = "lung_nodule_segmenter"
    num_bins: Optional[int] = 16

class InteractivePromptPoint(BaseModel):
    z: int = 0
    y: int = 0
    x: int = 0
    is_positive: bool = True

class InteractiveSegmentRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None
    points: Optional[List[InteractivePromptPoint]] = None
    bbox: Optional[Dict[str, int]] = None
    window_preset: Optional[str] = "lung"
    plane: Optional[str] = "axial"
    slice_index: Optional[int] = None


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
            # 1. 胸部与呼吸系统 (Thoracic & Pulmonology)
            {
                "id": "bronchiectasis_mucus_analyzer",
                "name": "支气管扩张与粘液栓 (Mucus Plug) 定量分析 (BAR印戒征 / 阻塞率 / HAM)",
                "category": "胸部与呼吸科",
                "modality": "Chest HRCT",
                "target": "支气管-动脉径比 (BAR)、粘液栓容积、解剖肺叶肺段定位、树芽征",
                "recommended_window": "lung",
                "is_ready": True
            },
            {
                "id": "lung_nodule_segmenter",
                "name": "肺结节与肺实变自动分割 (MONAI 3D SegResNet)",
                "category": "胸部与呼吸科",
                "modality": "Chest CT",
                "target": "肺实质实性/磨玻璃结节 (RECIST 1.1 最大径与三维体积)",
                "recommended_window": "lung",
                "is_ready": True
            },
            {
                "id": "lung_airway_segmenter",
                "name": "全气道树三维拓扑重建 (MONAI AirwayUNet)",
                "category": "胸部与呼吸科",
                "modality": "Chest HRCT",
                "target": "主气管至亚段细支气管管腔三维骨架与管壁厚度",
                "recommended_window": "lung",
                "is_ready": True
            },
            {
                "id": "lung_lobe_segmenter",
                "name": "5 大解剖肺叶分割与肺容积积分 (MONAI V-Net)",
                "category": "胸部与呼吸科",
                "modality": "Chest CT",
                "target": "双肺 5 大肺叶 (RUL, RML, RLL, LUL, LLL) 体积及占比",
                "recommended_window": "lung",
                "is_ready": True
            },
            {
                "id": "covid19_lung_infection",
                "name": "病毒性肺炎磨玻璃实变影定量 (MONAI COVID-Net)",
                "category": "胸部与呼吸科",
                "modality": "Chest CT",
                "target": "磨玻璃影 (GGO)、网格影与实变受累百分比",
                "recommended_window": "lung",
                "is_ready": True
            },

            # 2. 腹部、消化与泌尿系统 (Abdomen & Pelvis)
            {
                "id": "spleen_segmenter",
                "name": "腹部实质脏器与脾脏分割 (MONAI 3D SegResNet)",
                "category": "腹部、消化与泌尿",
                "modality": "Abdominal CT",
                "target": "脾脏三维体积、脾肿大定量与创伤破裂评估",
                "recommended_window": "abdomen",
                "is_ready": True
            },
            {
                "id": "multi_organ_ct",
                "name": "全腹部 13 器官多任务分割 (MONAI SwinUNETR)",
                "category": "腹部、消化与泌尿",
                "modality": "Abdominal CT",
                "target": "肝、脾、双肾、胰腺、胆囊、胃、主动脉、下腔静脉等",
                "recommended_window": "abdomen",
                "is_ready": True
            },
            {
                "id": "liver_lesion_segmenter",
                "name": "肝脏实质与局灶病灶/转移瘤分割 (MONAI UNet)",
                "category": "腹部、消化与泌尿",
                "modality": "Abdominal CT",
                "target": "肝实质体积、原发性肝癌 (HCC) 与转移瘤靶病灶",
                "recommended_window": "abdomen",
                "is_ready": True
            },
            {
                "id": "pancreas_tumor_segmenter",
                "name": "胰腺实质与胰腺肿瘤分割 (MONAI UNet)",
                "category": "腹部、消化与泌尿",
                "modality": "Abdominal CT",
                "target": "胰腺实质、胰腺导管腺癌与囊性占位病变",
                "recommended_window": "abdomen",
                "is_ready": True
            },
            {
                "id": "kidney_tumor_segmenter",
                "name": "肾脏与肾肿瘤/囊肿分割 (MONAI KiTS)",
                "category": "腹部、消化与泌尿",
                "modality": "Abdominal CT",
                "target": "肾实质、肾肿瘤皮质实性占位与肾囊肿",
                "recommended_window": "abdomen",
                "is_ready": True
            },
            {
                "id": "prostate_mri_segmenter",
                "name": "前列腺外周带/移行带与 PI-RADS 病灶 (MONAI UNet)",
                "category": "腹部、消化与泌尿",
                "modality": "Pelvic MRI (T2/ADC)",
                "target": "前列腺腺体分带与可疑癌灶 (PI-RADS 3-5分区)",
                "recommended_window": "abdomen",
                "is_ready": True
            },

            # 3. 颅脑与中枢神经系统 (Brain & Neurology)
            {
                "id": "brain_tumor_brats",
                "name": "脑胶质瘤多序列分割 (MONAI BraTS DynUNet)",
                "category": "颅脑与神经系统",
                "modality": "Brain MRI (T1, T1c, T2, FLAIR)",
                "target": "强化肿瘤 (ET)、瘤周水肿 (ED) 与坏死核心 (NCR)",
                "recommended_window": "brain",
                "is_ready": True
            },
            {
                "id": "brain_subcortical_segmenter",
                "name": "皮质下深部核团与海马体萎缩量化 (FastSurfer-like)",
                "category": "颅脑与神经系统",
                "modality": "Brain T1 MRI",
                "target": "双侧海马体、杏仁核、丘脑体积与阿尔茨海默病量化",
                "recommended_window": "brain",
                "is_ready": True
            },
            {
                "id": "stroke_ischemic_lesion",
                "name": "急性脑卒中缺血梗死灶测定 (MONAI UNet)",
                "category": "颅脑与神经系统",
                "modality": "Brain MRI (DWI/FLAIR)",
                "target": "急性脑梗死缺血半暗带与核心梗死容积",
                "recommended_window": "brain",
                "is_ready": True
            },
            {
                "id": "intracranial_hemorrhage_ct",
                "name": "急诊颅内出血与血肿检出 (MONAI DenseNet)",
                "category": "颅脑与神经系统",
                "modality": "Brain Head CT",
                "target": "硬膜下、硬膜外、脑实质内及蛛网膜下腔出血",
                "recommended_window": "brain",
                "is_ready": True
            },

            # 4. 心血管系统 (Cardiovascular)
            {
                "id": "coronary_artery_calcification",
                "name": "冠状动脉钙化积分 (CAC / Agatston 评分)",
                "category": "心血管系统",
                "modality": "Cardiac CT",
                "target": "左前降支、回旋支、右冠状动脉钙化积分与冠心病风险分层",
                "recommended_window": "mediastinum",
                "is_ready": True
            },
            {
                "id": "cardiac_mri_segmentation",
                "name": "心脏多时相 CINE MRI 心室分割与射血分数",
                "category": "心血管系统",
                "modality": "Cardiac MRI (CINE)",
                "target": "左心室舒张/收缩末容积、心肌质量与射血分数 (LVEF)",
                "recommended_window": "mediastinum",
                "is_ready": True
            },

            # 5. 骨科与全身体素 (Musculoskeletal & Whole-Body)
            {
                "id": "whole_body_ct_segmenter",
                "name": "全身体素 104 类解剖结构分割 (TotalSegmentator)",
                "category": "骨科与全身体素",
                "modality": "Whole-Body CT",
                "target": "全身体素骨骼、主要内脏系统与主要肌群",
                "recommended_window": "bone",
                "is_ready": True
            },
            {
                "id": "vertebra_segmenter",
                "name": "全脊柱 24 节椎骨与椎间盘分割 (Spine-Segmenter)",
                "category": "骨科与全身体素",
                "modality": "Spine CT",
                "target": "颈椎、胸椎、腰椎各节椎体骨折压缩与椎间隙测量",
                "recommended_window": "bone",
                "is_ready": True
            },

            # 6. 交互式万物分割与自监督 (Interactive & Foundation Models)
            {
                "id": "vista3d_interactive_segmenter",
                "name": "VISTA-3D 交互式点选/提示万物分割 (MONAI VISTA 3D / Click-to-Segment)",
                "category": "交互式万物分割",
                "modality": "CT / MRI / PET 通用",
                "target": "任意解剖结构或病灶的正负点选提示 (Point Clicks) 与 3D 边界框即时自适应分割",
                "recommended_window": "lung",
                "is_ready": True
            }
        ]
    }

@app.get("/api/v1/samples")
def list_samples():
    samples = []
    chest_path = DATA_DIR / "chest_lung_ct.nii.gz"
    if chest_path.exists():
        samples.append({
            "id": "chest_lung_ct",
            "name": "真实临床全胸部 HRCT 扫描 (269层 512x512)",
            "modality": "Chest HRCT",
            "default_model": "bronchiectasis_mucus_analyzer",
            "default_window": "lung",
            "size_mb": round(chest_path.stat().st_size / (1024 * 1024), 1)
        })
    spleen_path = DATA_DIR / "spleen_test.nii.gz"
    if spleen_path.exists():
        samples.append({
            "id": "spleen_test",
            "name": "真实临床腹部增强 CT 扫描 (96层 512x512)",
            "modality": "Abdominal CT",
            "default_model": "spleen_segmenter",
            "default_window": "abdomen",
            "size_mb": round(spleen_path.stat().st_size / (1024 * 1024), 1)
        })
    mri_path = DATA_DIR / "prostate_mri.nii.gz"
    if mri_path.exists():
        samples.append({
            "id": "prostate_mri",
            "name": "真实临床前列腺 T2 加权 MRI (19层 320x320)",
            "modality": "Pelvic MRI",
            "default_model": "liver_lesion_segmenter",
            "default_window": "abdomen",
            "size_mb": round(mri_path.stat().st_size / (1024 * 1024), 1)
        })
    return {"samples": samples}
 
@app.get("/api/v1/samples/{sample_id}/file")
def get_sample_file(sample_id: str):
    """Streams the raw 3D volume sample file (.nii.gz)."""
    for ext in (".nii.gz", ".nii"):
        sample_file = DATA_DIR / f"{sample_id}{ext}"
        if sample_file.exists():
            return FileResponse(
                path=str(sample_file),
                media_type="application/gzip",
                filename=f"{sample_id}{ext}"
            )
    raise HTTPException(status_code=404, detail=f"Sample '{sample_id}' not found in data directory")

@app.post("/api/v1/mpr/info")
def get_mpr_volume_info(req: MprInfoRequest = Body(...)):
    """Returns 3D volume dimensions, spacing, slice counts and bounding box for a volume."""
    target = req.file_path if req.file_path else (req.sample_id or "chest_lung_ct")
    try:
        return engine.get_mpr_info(target)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read volume info: {str(e)}")

@app.get("/api/v1/mpr/info")
def get_mpr_volume_info_get(sample_id: str = "chest_lung_ct"):
    """GET variant for retrieving volume MPR info by sample_id."""
    try:
        return engine.get_mpr_info(sample_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read volume info: {str(e)}")

@app.post("/api/v1/mpr/slice")
def get_mpr_slice(req: MprSliceRequest = Body(...)):
    """Extracts an arbitrary orthogonal 2D slice (Axial/Coronal/Sagittal) with windowing & overlay."""
    target = req.file_path if req.file_path else (req.sample_id or "chest_lung_ct")
    try:
        return engine.extract_mpr_slice(
            sample_id_or_path=target,
            plane=req.plane or "axial",
            slice_index=req.slice_index,
            window_preset=req.window_preset,
            overlay=req.overlay_mask if req.overlay_mask is not None else True,
            model_name=req.model_name
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract MPR slice: {str(e)}")

@app.post("/api/v1/mpr/diff-slice")
def get_diff_slice(req: DiffSliceRequest = Body(...)):
    """Extracts a registered 3D difference slice with regression/progression heatmap."""
    base_target = req.baseline_path if req.baseline_path and os.path.exists(req.baseline_path) else (req.baseline_id or "chest_lung_ct")
    follow_target = req.followup_path if req.followup_path and os.path.exists(req.followup_path) else (req.followup_id or "chest_lung_ct")
    try:
        return engine.extract_diff_slice(
            baseline_id_or_path=base_target,
            followup_id_or_path=follow_target,
            plane=req.plane or "axial",
            slice_index=req.slice_index,
            window_preset=req.window_preset,
            threshold_hu=req.threshold_hu if req.threshold_hu is not None else 50.0
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract diff slice: {str(e)}")

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
            window_preset="lung",
            mucus_min_hu=req.mucus_min_hu,
            mucus_max_hu=req.mucus_max_hu,
            ham_threshold_hu=req.ham_threshold_hu,
            bar_cutoff=req.bar_cutoff
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
        window_preset="lung",
        mucus_min_hu=req.mucus_min_hu,
        mucus_max_hu=req.mucus_max_hu,
        ham_threshold_hu=req.ham_threshold_hu,
        bar_cutoff=req.bar_cutoff
    )

@app.post("/api/v1/analyze/sample")
def run_sample_analysis(req: SampleRequest = Body(...)):
    """Runs MONAI inference on a pre-loaded clinical sample."""
    sample_file = DATA_DIR / f"{req.sample_id}.nii.gz"
    if not sample_file.exists():
        sample_file = DATA_DIR / f"{req.sample_id}.nii"
    if not sample_file.exists():
        raise HTTPException(status_code=404, detail=f"Sample '{req.sample_id}' not found in data directory")

    model_name = req.model_name
    if not model_name:
        if "lung" in req.sample_id or "chest" in req.sample_id:
            model_name = "bronchiectasis_mucus_analyzer"
        elif "spleen" in req.sample_id:
            model_name = "spleen_segmenter"
        else:
            model_name = "liver_lesion_segmenter"

    try:
        return engine.analyze_file(
            file_path=str(sample_file),
            model_name=model_name,
            window_preset=req.window_preset,
            mucus_min_hu=req.mucus_min_hu,
            mucus_max_hu=req.mucus_max_hu,
            ham_threshold_hu=req.ham_threshold_hu,
            bar_cutoff=req.bar_cutoff
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
            window_preset=req.window_preset,
            mucus_min_hu=req.mucus_min_hu,
            mucus_max_hu=req.mucus_max_hu,
            ham_threshold_hu=req.ham_threshold_hu,
            bar_cutoff=req.bar_cutoff
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {str(e)}")

@app.post("/api/v1/analyze/radiomics")
def run_radiomics_analysis(req: RadiomicsRequest = Body(...)):
    """Extracts 3D IBSI-compliant radiomics features (Shape, First-order, GLCM, GLRLM)."""
    target = req.file_path or req.sample_id
    try:
        return engine.extract_radiomics(
            sample_id_or_path=target,
            model_name=req.model_name or "lung_nodule_segmenter",
            num_bins=req.num_bins or 16
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Radiomics extraction failed: {str(e)}")

@app.post("/api/v1/analyze/interactive-segment")
def run_interactive_segmentation_endpoint(req: InteractiveSegmentRequest = Body(...)):
    """Executes MONAI VISTA-3D style interactive click-prompt segmentation."""
    target = req.file_path or req.sample_id
    points_dict = [p.dict() if hasattr(p, "dict") else p.model_dump() for p in (req.points or [])]
    try:
        return engine.run_interactive_segmentation(
            sample_id_or_path=target,
            points=points_dict,
            bbox=req.bbox,
            window_preset=req.window_preset,
            plane=req.plane or "axial",
            slice_index=req.slice_index,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Interactive segmentation failed: {str(e)}")

@app.post("/api/v1/analyze/upload")
async def run_upload_analysis(
    file: UploadFile = File(...),
    model_name: str = Form("bronchiectasis_mucus_analyzer"),
    window_preset: Optional[str] = Form(None),
    mucus_min_hu: Optional[float] = Form(None),
    mucus_max_hu: Optional[float] = Form(None),
    ham_threshold_hu: Optional[float] = Form(None),
    bar_cutoff: Optional[float] = Form(None),
):
    """Uploads a .nii, .nii.gz, .dcm, or .zip (DICOM series archive) file and executes MONAI inference."""
    fn_lower = file.filename.lower() if file.filename else ""
    content = await file.read()

    if fn_lower.endswith(".zip"):
        with tempfile.TemporaryDirectory() as tmp_dir:
            zip_path = os.path.join(tmp_dir, "upload.zip")
            with open(zip_path, "wb") as f_out:
                f_out.write(content)
            with zipfile.ZipFile(zip_path, "r") as zf:
                zf.extractall(tmp_dir)
            return engine.analyze_file(
                file_path=tmp_dir,
                model_name=model_name,
                window_preset=window_preset,
                mucus_min_hu=mucus_min_hu,
                mucus_max_hu=mucus_max_hu,
                ham_threshold_hu=ham_threshold_hu,
                bar_cutoff=bar_cutoff
            )
    elif fn_lower.endswith((".dcm", ".dicom")):
        with tempfile.TemporaryDirectory() as tmp_dir:
            dcm_path = os.path.join(tmp_dir, file.filename or "slice.dcm")
            with open(dcm_path, "wb") as f_out:
                f_out.write(content)
            return engine.analyze_file(
                file_path=tmp_dir,
                model_name=model_name,
                window_preset=window_preset,
                mucus_min_hu=mucus_min_hu,
                mucus_max_hu=mucus_max_hu,
                ham_threshold_hu=ham_threshold_hu,
                bar_cutoff=bar_cutoff
            )
    else:
        suffix = ".nii.gz" if fn_lower.endswith(".nii.gz") else ".nii"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        try:
            return engine.analyze_file(
                file_path=tmp_path,
                model_name=model_name,
                window_preset=window_preset,
                mucus_min_hu=mucus_min_hu,
                mucus_max_hu=mucus_max_hu,
                ham_threshold_hu=ham_threshold_hu,
                bar_cutoff=bar_cutoff
            )
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

def start_server():
    port = int(os.environ.get("PORT", "8004"))
    uvicorn.run("apps.imaging-worker.src.server:app", host="127.0.0.1", port=port, reload=False)

if __name__ == "__main__":
    start_server()
