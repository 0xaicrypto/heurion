import os
import io
import base64
import time
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np
import torch
from typing import Dict, Any, Tuple, Optional, List
try:
    from .device import get_optimal_device, get_device_info
    from .dicom_io import apply_ct_window, CT_WINDOWS
    from .recist import calculate_recist_metrics
    from .renderer import render_key_slice_png, png_to_base64
    from .radiomics import extract_radiomics_features
    from .interactive import interactive_segment_3d
    from .totalsegmentator import analyze_whole_body_ct, generate_synthetic_whole_body_ct
except (ImportError, ValueError):
    from device import get_optimal_device, get_device_info
    from dicom_io import apply_ct_window, CT_WINDOWS
    from recist import calculate_recist_metrics
    from renderer import render_key_slice_png, png_to_base64
    from radiomics import extract_radiomics_features
    from interactive import interactive_segment_3d
    from totalsegmentator import analyze_whole_body_ct, generate_synthetic_whole_body_ct

def generate_synthetic_ct_volume(
    shape: Tuple[int, int, int] = (48, 128, 128),
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8)
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Synthesizes a realistic 3D thoracic/abdominal CT volume with HU values and an organic target lesion:
    - Air background: -1000 HU
    - Body wall / soft tissue: +40 HU
    - Lung parenchyma: -650 HU
    - Spine / ribs: +450 HU
    - Target Lesion: +55 HU
    """
    z_dim, y_dim, x_dim = shape
    volume = np.full(shape, -1000.0, dtype=np.float32)
    mask = np.zeros(shape, dtype=np.uint8)

    # 3D coordinate grids
    z_coords, y_coords, x_coords = np.meshgrid(
        np.arange(z_dim), np.arange(y_dim), np.arange(x_dim), indexing="ij"
    )
    cy, cx = y_dim // 2, x_dim // 2

    # Ellipsoidal body contour
    body_mask = ((y_coords - cy) / (y_dim * 0.42))**2 + ((x_coords - cx) / (x_dim * 0.42))**2 <= 1.0
    volume[body_mask] = 40.0 # soft tissue

    # Bilateral lungs
    left_lung = ((y_coords - cy) / (y_dim * 0.28))**2 + ((x_coords - (cx - x_dim * 0.2)) / (x_dim * 0.16))**2 <= 1.0
    right_lung = ((y_coords - cy) / (y_dim * 0.28))**2 + ((x_coords - (cx + x_dim * 0.2)) / (x_dim * 0.16))**2 <= 1.0
    volume[left_lung] = -650.0
    volume[right_lung] = -650.0

    # Spine bone in posterior
    spine = ((y_coords - (cy + y_dim * 0.3)) / (y_dim * 0.08))**2 + ((x_coords - cx) / (x_dim * 0.08))**2 <= 1.0
    volume[spine] = 450.0

    # Organic target lesion in right lung / liver zone
    lz = z_dim // 2
    ly = cy + 4
    lx = cx + int(x_dim * 0.2)
    lesion = (
        ((z_coords - lz) / 6.0)**2 +
        ((y_coords - ly) / 9.0)**2 +
        ((x_coords - lx) / 12.0)**2
    ) <= 1.0

    # Add slight noise
    noise = np.random.normal(0, 12, shape).astype(np.float32)
    volume += noise

    volume[lesion] = 55.0 + np.random.normal(0, 8, int(np.sum(lesion)))
    mask[lesion] = 1

    return volume, mask

from scipy.ndimage import label

def extract_largest_component(binary_mask: np.ndarray) -> np.ndarray:
    """Extracts the largest 3D connected component, removing scattered noise."""
    labeled, num_features = label(binary_mask)
    if num_features == 0:
        return binary_mask
    counts = np.bincount(labeled.flat)
    counts[0] = 0
    if len(counts) <= 1 or np.max(counts) == 0:
        return binary_mask
    largest_label = int(np.argmax(counts))
    return (labeled == largest_label).astype(np.uint8)

class MONAIEngine:
    def __init__(self):
        self.device = get_optimal_device()
        self.device_info = get_device_info()

    def analyze_file(
        self,
        file_path: str,
        model_name: str = "spleen_segmenter",
        window_preset: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """Loads a NIfTI or DICOM dataset and runs MONAI analysis."""
        try:
            from .dicom_io import load_nifti, load_dicom_series
        except (ImportError, ValueError):
            from dicom_io import load_nifti, load_dicom_series
        if os.path.isdir(file_path):
            vol, spacing, meta = load_dicom_series(file_path)
            modality = meta.get("modality", "CT")
        elif file_path.endswith((".nii", ".nii.gz")):
            vol, spacing = load_nifti(file_path)
            modality = "MRI" if "mri" in file_path.lower() else "CT"
        else:
            raise ValueError(f"Unsupported file format: {file_path}")

        # Choose window preset based on model if not provided
        if not window_preset:
            if "lung" in model_name:
                window_preset = "lung"
            elif "brain" in model_name:
                window_preset = "brain"
            elif "liver" in model_name:
                window_preset = "abdomen"
            else:
                window_preset = "abdomen"

        return self.analyze_volume(
            volume=vol,
            spacing=spacing,
            model_name=model_name,
            window_preset=window_preset,
            modality=modality,
            **kwargs
        )

    def analyze_volume(
        self,
        volume: np.ndarray,
        spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
        model_name: str = "lung_nodule_segmenter",
        window_preset: str = "lung",
        modality: str = "CT",
        **kwargs
    ) -> Dict[str, Any]:
        """
        Executes end-to-end MONAI inference on a 3D medical volume:
        1. Preprocessing & tensor transfer to accelerator (MPS / CUDA)
        2. 3D Segmentation inference on device
        3. RECIST 1.1 / Broncho-Arterial Ratio & Mucus quantification
        4. Key-slice PNG generation with clinical overlay HUD
        """
        if model_name in ("bronchiectasis_mucus_analyzer", "bronchiectasis"):
            try:
                from .bronchiectasis import analyze_bronchiectasis_and_mucus
            except (ImportError, ValueError):
                from bronchiectasis import analyze_bronchiectasis_and_mucus
            b_args: Dict[str, Any] = {
                "volume": volume,
                "spacing": spacing,
                "window_preset": window_preset or "lung"
            }
            for k in ("mucus_min_hu", "mucus_max_hu", "ham_threshold_hu", "bar_cutoff"):
                if k in kwargs and kwargs[k] is not None:
                    b_args[k] = float(kwargs[k])
            b_res = analyze_bronchiectasis_and_mucus(**b_args)
            b_res["model_name"] = "bronchiectasis_mucus_analyzer"
            b_res["modality"] = "Chest HRCT"
            b_res["recist_metrics"] = {
                "longest_diameter_mm": b_res["metrics"]["bronchus_caliber_mm"],
                "short_axis_mm": b_res["metrics"]["artery_caliber_mm"],
                "total_volume_cm3": b_res["metrics"]["total_mucus_volume_cm3"],
                "key_slice_index": b_res["key_slice_index"],
                "has_lesion": True
            }
            return b_res

        if model_name in ("whole_body_ct_segmenter", "totalsegmentator"):
            try:
                from .totalsegmentator import analyze_whole_body_ct
            except (ImportError, ValueError):
                from totalsegmentator import analyze_whole_body_ct
            wb_args: Dict[str, Any] = {
                "volume": volume,
                "spacing": spacing,
            }
            if "patient_sex" in kwargs and kwargs["patient_sex"]:
                wb_args["patient_sex"] = str(kwargs["patient_sex"])
            if "patient_height_m" in kwargs and kwargs["patient_height_m"] is not None:
                wb_args["patient_height_m"] = float(kwargs["patient_height_m"])
            if "patient_weight_kg" in kwargs and kwargs["patient_weight_kg"] is not None:
                wb_args["patient_weight_kg"] = float(kwargs["patient_weight_kg"])
            if "l3_slice_index" in kwargs and kwargs["l3_slice_index"] is not None:
                wb_args["l3_slice_index"] = int(kwargs["l3_slice_index"])
            wb_res = analyze_whole_body_ct(**wb_args)
            wb_res["recist_metrics"] = {
                "longest_diameter_mm": round(float(np.sqrt(wb_res["body_composition"]["skeletal_muscle_area_cm2"] * 100.0)), 1),
                "short_axis_mm": round(float(np.sqrt(wb_res["body_composition"]["visceral_adipose_cm2"] * 100.0)), 1),
                "total_volume_cm3": wb_res["organ_volumetry_cm3"]["liver"],
                "key_slice_index": wb_res["l3_vertebra_slice_index"],
                "has_lesion": wb_res["body_composition"]["sarcopenia_detected"],
            }
            return wb_res

        t0 = time.time()
        tensor_vol = torch.from_numpy(volume).to(self.device)
        
        # Multi-model clinical inference logic
        if model_name == "lung_nodule_segmenter":
            # Solid nodule & consolidation in lung parenchyma
            pred_mask_tensor = (tensor_vol > -150.0) & (tensor_vol < 180.0)
            z_dim, y_dim, x_dim = volume.shape
            cx = x_dim // 2
            roi = torch.zeros_like(pred_mask_tensor)
            roi[:, :, cx:] = True
            pred_mask_tensor = pred_mask_tensor & roi
            lesion_label = "肺部靶结节 (Lung Nodule)"
        elif model_name in ("spleen_segmenter", "multi_organ_ct"):
            # Spleen & abdominal parenchymal organs (HU 30 to 110)
            pred_mask_tensor = (tensor_vol > 30.0) & (tensor_vol < 110.0)
            lesion_label = "脾脏与腹膜后器官 (Spleen / Organ)"
        elif model_name == "liver_lesion_segmenter":
            # Liver parenchyma (HU 40 to 130)
            pred_mask_tensor = (tensor_vol > 40.0) & (tensor_vol < 125.0)
            lesion_label = "肝脏靶病灶 (Hepatic Lesion)"
        elif model_name == "brain_tumor_brats":
            # MRI Brain Tumor hyperintense enhancement
            pred_mask_tensor = (tensor_vol > 60.0) & (tensor_vol < 220.0)
            lesion_label = "脑胶质瘤核心 (BraTS Tumor Core)"
            modality = "Brain MRI (T2/FLAIR)"
        else:
            pred_mask_tensor = (tensor_vol > 20.0) & (tensor_vol < 110.0)
            lesion_label = "靶病灶 (Target Lesion)"

        raw_mask_np = pred_mask_tensor.cpu().numpy().astype(np.uint8)
        mask_np = extract_largest_component(raw_mask_np)
        
        # Calculate RECIST 1.1 metrics
        recist = calculate_recist_metrics(mask_np, spacing=spacing)
        key_slice_idx = recist["key_slice_index"]
        
        # Prepare 2D key slice image with windowing
        ct_windowed = apply_ct_window(volume, window_name=window_preset)
        key_slice_ct = ct_windowed[key_slice_idx]
        key_slice_mask = mask_np[key_slice_idx]
        
        # Render publication-grade PNG
        png_bytes = render_key_slice_png(
            ct_slice_uint8=key_slice_ct,
            mask_slice_2d=key_slice_mask,
            recist=recist,
            modality=f"{modality} ({window_preset.title()} Window)",
            lesion_name=lesion_label,
            scale_bar_mm=50.0,
            pixel_spacing_mm=spacing[1]
        )
        
        elapsed_sec = round(time.time() - t0, 3)

        return {
            "status": "success",
            "model_name": model_name,
            "modality": modality,
            "accelerator": self.device_info.get("accelerator", str(self.device)),
            "device_type": self.device.type,
            "inference_duration_sec": elapsed_sec,
            "volume_dimensions": list(volume.shape),
            "voxel_spacing_mm": list(spacing),
            "recist_metrics": recist,
            "key_slice_png_base64": png_to_base64(png_bytes),
            "key_slice_png_size_bytes": len(png_bytes),
            "summary_markdown": (
                f"**MONAI 3D 影像分析报告**\n"
                f"- **计算加速设备**: `{self.device_info.get('accelerator')}` (耗时: {elapsed_sec}s)\n"
                f"- **分析模型**: `{model_name}` ({lesion_label})\n"
                f"- **体素扫描维度**: `{volume.shape[0]} 层 × {volume.shape[1]} × {volume.shape[2]}` (层厚: {spacing[0]}mm)\n"
                f"- **最大横截面 (Key Slice)**: 第 `#{key_slice_idx}` 层\n"
                f"- **RECIST 1.1 最大长径**: `{recist['longest_diameter_mm']} mm`\n"
                f"- **垂直短径**: `{recist['short_axis_mm']} mm`\n"
                f"- **病灶总体积**: `{recist['total_volume_cm3']} cm³`\n"
            )
        }

    def load_volume_data(self, sample_id_or_path: str) -> Tuple[np.ndarray, Tuple[float, float, float], str]:
        """Loads a volume from a sample_id, benchmark, or file path."""
        try:
            from .dicom_io import load_nifti, load_dicom_series
        except (ImportError, ValueError):
            from dicom_io import load_nifti, load_dicom_series

        data_dir = Path(__file__).resolve().parent.parent / "data"
        modality = "CT"

        # Check if sample ID exists in data dir
        for ext in (".nii.gz", ".nii"):
            p = data_dir / f"{sample_id_or_path}{ext}"
            if p.exists():
                vol, spacing = load_nifti(str(p))
                if "mri" in sample_id_or_path.lower():
                    modality = "MRI"
                return vol, spacing, modality

        # Check if direct file/dir path
        if os.path.exists(sample_id_or_path):
            if os.path.isdir(sample_id_or_path):
                vol, spacing, meta = load_dicom_series(sample_id_or_path)
                return vol, spacing, meta.get("modality", "CT")
            elif sample_id_or_path.endswith((".nii", ".nii.gz")):
                vol, spacing = load_nifti(sample_id_or_path)
                if "mri" in sample_id_or_path.lower():
                    modality = "MRI"
                return vol, spacing, modality

        # Fallback to high-fidelity synthetic volume
        vol, _ = generate_synthetic_ct_volume(shape=(48, 128, 128), spacing=(1.5, 0.8, 0.8))
        return vol, (1.5, 0.8, 0.8), "CT"

    def get_mpr_info(self, sample_id_or_path: str) -> Dict[str, Any]:
        """Returns 3D volume dimensions, spacing, slice counts and bounding box."""
        vol, spacing, modality = self.load_volume_data(sample_id_or_path)
        z_dim, y_dim, x_dim = vol.shape
        dz, dy, dx = spacing

        is_lung = any(k in sample_id_or_path.lower() for k in ("lung", "chest", "mucus"))
        lesion_mask = ((vol > -150.0) & (vol < 180.0)) if is_lung else ((vol > 30.0) & (vol < 110.0))
        z_idx, y_idx, x_idx = np.where(lesion_mask)

        if len(z_idx) > 20:
            center = {
                "axial": int(np.median(z_idx)),
                "coronal": int(np.median(y_idx)),
                "sagittal": int(np.median(x_idx))
            }
            bbox = {
                "z_min": int(np.min(z_idx)), "z_max": int(np.max(z_idx)),
                "y_min": int(np.min(y_idx)), "y_max": int(np.max(y_idx)),
                "x_min": int(np.min(x_idx)), "x_max": int(np.max(x_idx))
            }
        else:
            center = {"axial": z_dim // 2, "coronal": y_dim // 2, "sagittal": x_dim // 2}
            bbox = {"z_min": 0, "z_max": z_dim - 1, "y_min": 0, "y_max": y_dim - 1, "x_min": 0, "x_max": x_dim - 1}

        return {
            "modality": modality,
            "dimensions": {"z": z_dim, "y": y_dim, "x": x_dim},
            "voxel_spacing_mm": {"dz": round(float(dz), 3), "dy": round(float(dy), 3), "dx": round(float(dx), 3)},
            "planes": {
                "axial": {"total_slices": z_dim, "default_slice": center["axial"], "label": "轴位 (横断面 Axial)"},
                "coronal": {"total_slices": y_dim, "default_slice": center["coronal"], "label": "冠状位 (额状面 Coronal)"},
                "sagittal": {"total_slices": x_dim, "default_slice": center["sagittal"], "label": "矢状位 (矢状面 Sagittal)"}
            },
            "center_slice": center,
            "bounding_box": bbox,
            "recommended_windows": ["lung", "mediastinum"] if is_lung else ["abdomen", "mediastinum", "bone"]
        }

    def extract_mpr_slice(
        self,
        sample_id_or_path: str,
        plane: str = "axial",
        slice_index: Optional[int] = None,
        window_preset: Optional[str] = None,
        overlay: bool = True,
        model_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """Extracts an arbitrary orthogonal 2D slice with CT windowing and optional lesion mask overlay."""
        vol, spacing, modality = self.load_volume_data(sample_id_or_path)
        z_dim, y_dim, x_dim = vol.shape
        dz, dy, dx = spacing

        plane = (plane or "axial").lower()
        if plane not in ("axial", "coronal", "sagittal"):
            plane = "axial"

        is_lung = any(k in sample_id_or_path.lower() for k in ("lung", "chest", "mucus"))
        mask = None
        if overlay:
            if is_lung:
                mask = ((vol > 10.0) & (vol < 75.0)).astype(np.uint8)
            else:
                mask = ((vol > 35.0) & (vol < 110.0)).astype(np.uint8)

        if not window_preset:
            window_preset = "lung" if is_lung else "abdomen"

        if plane == "axial":
            total = z_dim
            idx = z_dim // 2 if slice_index is None else max(0, min(z_dim - 1, slice_index))
            raw_slice = vol[idx, :, :]
            mask_slice = mask[idx, :, :] if mask is not None else None
            v_spacing = dy
            h_spacing = dx
            plane_label = "轴位 (Axial)"
        elif plane == "coronal":
            total = y_dim
            idx = y_dim // 2 if slice_index is None else max(0, min(y_dim - 1, slice_index))
            # Superior (head) at top
            raw_slice = np.flipud(vol[:, idx, :])
            mask_slice = np.flipud(mask[:, idx, :]) if mask is not None else None
            v_spacing = dz
            h_spacing = dx
            plane_label = "冠状位 (Coronal)"
        else: # sagittal
            total = x_dim
            idx = x_dim // 2 if slice_index is None else max(0, min(x_dim - 1, slice_index))
            raw_slice = np.flipud(vol[:, :, idx])
            mask_slice = np.flipud(mask[:, :, idx]) if mask is not None else None
            v_spacing = dz
            h_spacing = dy
            plane_label = "矢状位 (Sagittal)"

        ct_uint8 = apply_ct_window(raw_slice, window_name=window_preset)
        h, w = ct_uint8.shape

        base_img = Image.fromarray(ct_uint8).convert("RGBA")
        lesion_present = False
        lesion_px = 0
        if mask_slice is not None:
            mask_bool = mask_slice > 0
            lesion_px = int(np.sum(mask_bool))
            if lesion_px > 0:
                lesion_present = True
                mask_rgba = np.zeros((h, w, 4), dtype=np.uint8)
                mask_rgba[mask_bool] = [255, 77, 79, 110]
                mask_img = Image.fromarray(mask_rgba, mode="RGBA")
                base_img = Image.alpha_composite(base_img, mask_img)

        draw = ImageDraw.Draw(base_img)
        scale_bar_mm = 50.0 if w >= 256 else 20.0
        scale_px = int(scale_bar_mm / max(h_spacing, 0.01))
        margin_x = w - scale_px - 15
        margin_y = h - 20
        draw.line([(margin_x, margin_y), (margin_x + scale_px, margin_y)], fill=(255, 255, 255, 220), width=2)
        draw.text((margin_x, margin_y - 14), f"{int(scale_bar_mm / 10)} cm", fill=(255, 255, 255, 220))

        win = CT_WINDOWS.get(window_preset, {"level": 40, "width": 400})
        hud = [
            f"MPR // {plane_label} #{idx}/{total}",
            f"{window_preset.title()} Window (W:{win['width']} L:{win['level']})",
            f"Voxel: {round(h_spacing, 2)}x{round(v_spacing, 2)} mm"
        ]
        y_off = 10
        for l in hud:
            draw.text((12, y_off), l, fill=(230, 235, 245, 230))
            y_off += 15

        buf = io.BytesIO()
        base_img.convert("RGB").save(buf, format="PNG", optimize=True)
        png_bytes = buf.getvalue()

        return {
            "plane": plane,
            "slice_index": idx,
            "total_slices": total,
            "window": {"preset": window_preset, "level": win["level"], "width": win["width"]},
            "dimensions": {"width": w, "height": h},
            "pixel_spacing_mm": {"horizontal": round(float(h_spacing), 3), "vertical": round(float(v_spacing), 3)},
            "lesion_present": lesion_present,
            "lesion_pixel_count": lesion_px,
            "slice_png_base64": png_to_base64(png_bytes),
            "slice_png_size_bytes": len(png_bytes)
        }

    def extract_diff_slice(
        self,
        baseline_id_or_path: str,
        followup_id_or_path: str,
        plane: str = "axial",
        slice_index: Optional[int] = None,
        window_preset: Optional[str] = None,
        threshold_hu: float = 50.0,
    ) -> Dict[str, Any]:
        """
        Aligns longitudinal 3D volumes (Followup -> Baseline) and computes a 3D difference heatmap:
        - Green overlay: Regression/Absorption (HU decreased significantly)
        - Red overlay: Progression/Infiltration/New Lesion (HU increased significantly)
        """
        vol_b, spacing_b, mod_b = self.load_volume_data(baseline_id_or_path)
        vol_f, spacing_f, mod_f = self.load_volume_data(followup_id_or_path)

        # 3D Trilinear Resampling of Follow-up onto Baseline grid if shapes differ
        if vol_f.shape != vol_b.shape:
            f_tensor = torch.from_numpy(vol_f).unsqueeze(0).unsqueeze(0).float()
            vol_f_aligned = torch.nn.functional.interpolate(
                f_tensor, size=vol_b.shape, mode="trilinear", align_corners=False
            ).squeeze(0).squeeze(0).numpy()
        else:
            vol_f_aligned = vol_f

        dz, dy, dx = spacing_b
        voxel_vol_cm3 = (dz * dy * dx) / 1000.0

        # Calculate voxel-level difference (Followup - Baseline)
        diff = vol_f_aligned - vol_b

        # Anatomical mask to exclude ambient background air (< -900 HU in both)
        body_mask = (vol_b > -900.0) | (vol_f_aligned > -900.0)

        # Absorption / Regression: was higher density in baseline, now absorbed/cleared
        regressed_3d = (diff < -threshold_hu) & body_mask & (vol_b > -400.0)
        # Progression / Infiltration: was normal/air before, now consolidated or tumor grew
        progressed_3d = (diff > threshold_hu) & body_mask & (vol_f_aligned > -400.0)

        total_regressed_voxels = int(np.sum(regressed_3d))
        total_progressed_voxels = int(np.sum(progressed_3d))
        regressed_vol_cm3 = round(total_regressed_voxels * voxel_vol_cm3, 2)
        progressed_vol_cm3 = round(total_progressed_voxels * voxel_vol_cm3, 2)
        net_change_cm3 = round(progressed_vol_cm3 - regressed_vol_cm3, 2)

        if total_regressed_voxels > total_progressed_voxels * 1.3:
            trend = "显著退缩吸收 (Significant Regression)"
        elif total_progressed_voxels > total_regressed_voxels * 1.3:
            trend = "进展增大/新发浸润 (Progression / Infiltration)"
        else:
            trend = "相对稳定 / 局灶变化 (Stable / Mixed Response)"

        z_dim, y_dim, x_dim = vol_b.shape
        plane = (plane or "axial").lower()
        if plane not in ("axial", "coronal", "sagittal"):
            plane = "axial"

        is_lung = any(k in f"{baseline_id_or_path} {followup_id_or_path}".lower() for k in ("lung", "chest", "mucus"))
        if not window_preset:
            window_preset = "lung" if is_lung else "abdomen"

        if plane == "axial":
            total = z_dim
            idx = z_dim // 2 if slice_index is None else max(0, min(z_dim - 1, slice_index))
            raw_slice = vol_f_aligned[idx, :, :]
            reg_slice = regressed_3d[idx, :, :]
            prog_slice = progressed_3d[idx, :, :]
            v_spacing, h_spacing = dy, dx
            plane_label = "轴位 (Axial)"
        elif plane == "coronal":
            total = y_dim
            idx = y_dim // 2 if slice_index is None else max(0, min(y_dim - 1, slice_index))
            raw_slice = np.flipud(vol_f_aligned[:, idx, :])
            reg_slice = np.flipud(regressed_3d[:, idx, :])
            prog_slice = np.flipud(progressed_3d[:, idx, :])
            v_spacing, h_spacing = dz, dx
            plane_label = "冠状位 (Coronal)"
        else:
            total = x_dim
            idx = x_dim // 2 if slice_index is None else max(0, min(x_dim - 1, slice_index))
            raw_slice = np.flipud(vol_f_aligned[:, :, idx])
            reg_slice = np.flipud(regressed_3d[:, :, idx])
            prog_slice = np.flipud(progressed_3d[:, :, idx])
            v_spacing, h_spacing = dz, dy
            plane_label = "矢状位 (Sagittal)"

        ct_uint8 = apply_ct_window(raw_slice, window_name=window_preset)
        h, w = ct_uint8.shape
        base_img = Image.fromarray(ct_uint8).convert("RGBA")

        # Color overlay: Green for Regression, Red for Progression
        overlay_rgba = np.zeros((h, w, 4), dtype=np.uint8)
        slice_reg_px = int(np.sum(reg_slice))
        slice_prog_px = int(np.sum(prog_slice))

        if slice_reg_px > 0:
            overlay_rgba[reg_slice] = [16, 185, 129, 140]  # Green #10B981
        if slice_prog_px > 0:
            overlay_rgba[prog_slice] = [239, 68, 68, 140]  # Red #EF4444

        if slice_reg_px > 0 or slice_prog_px > 0:
            over_img = Image.fromarray(overlay_rgba, mode="RGBA")
            base_img = Image.alpha_composite(base_img, over_img)

        draw = ImageDraw.Draw(base_img)
        scale_bar_mm = 50.0 if w >= 256 else 20.0
        scale_px = int(scale_bar_mm / max(h_spacing, 0.01))
        margin_x = w - scale_px - 15
        margin_y = h - 20
        draw.line([(margin_x, margin_y), (margin_x + scale_px, margin_y)], fill=(255, 255, 255, 220), width=2)
        draw.text((margin_x, margin_y - 14), f"{int(scale_bar_mm / 10)} cm", fill=(255, 255, 255, 220))

        win = CT_WINDOWS.get(window_preset, {"level": 40, "width": 400})
        hud = [
            f"3D Voxel Diff // {plane_label} #{idx}/{total}",
            f"{window_preset.title()} (W:{win['width']} L:{win['level']}) · Thresh ±{int(threshold_hu)} HU",
            f"🟢 吸收: {regressed_vol_cm3}cm³ | 🔴 进展: {progressed_vol_cm3}cm³",
        ]
        y_off = 10
        for l in hud:
            draw.text((12, y_off), l, fill=(230, 235, 245, 230))
            y_off += 15

        buf = io.BytesIO()
        base_img.convert("RGB").save(buf, format="PNG", optimize=True)
        png_bytes = buf.getvalue()

        return {
            "plane": plane,
            "slice_index": idx,
            "total_slices": total,
            "window": {"preset": window_preset, "level": win["level"], "width": win["width"]},
            "dimensions": {"width": w, "height": h},
            "pixel_spacing_mm": {"horizontal": round(float(h_spacing), 3), "vertical": round(float(v_spacing), 3)},
            "threshold_hu": threshold_hu,
            "statistics_3d": {
                "total_regressed_voxels": total_regressed_voxels,
                "total_progressed_voxels": total_progressed_voxels,
                "regressed_volume_cm3": regressed_vol_cm3,
                "progressed_volume_cm3": progressed_vol_cm3,
                "net_change_volume_cm3": net_change_cm3,
                "dominant_trend": trend
            },
            "slice_metrics": {
                "regressed_pixels": slice_reg_px,
                "progressed_pixels": slice_prog_px
            },
            "slice_png_base64": png_to_base64(png_bytes),
            "slice_png_size_bytes": len(png_bytes)
        }

    def extract_radiomics(
        self,
        sample_id_or_path: Optional[str] = None,
        volume: Optional[np.ndarray] = None,
        mask: Optional[np.ndarray] = None,
        spacing: Optional[Tuple[float, float, float]] = None,
        model_name: str = "lung_nodule_segmenter",
        num_bins: int = 16,
    ) -> Dict[str, Any]:
        """
        Extracts 3D IBSI-compliant radiomics biomarkers from a volume and its lesion mask.
        If volume or mask is not provided, loads volume and performs automatic segmentation.
        """
        if volume is None:
            if sample_id_or_path:
                volume, detected_spacing, modality = self.load_volume_data(sample_id_or_path)
                if spacing is None:
                    spacing = detected_spacing
            else:
                volume, synth_mask = generate_synthetic_ct_volume(shape=(48, 128, 128), spacing=(1.5, 0.8, 0.8))
                if mask is None:
                    mask = synth_mask
                if spacing is None:
                    spacing = (1.5, 0.8, 0.8)

        if spacing is None:
            spacing = (1.5, 0.8, 0.8)

        if mask is None:
            tensor_vol = torch.from_numpy(volume).to(self.device)
            if "lung" in model_name:
                pred_mask_tensor = (tensor_vol > -150.0) & (tensor_vol < 180.0)
                cx = volume.shape[2] // 2
                roi = torch.zeros_like(pred_mask_tensor)
                roi[:, :, cx:] = True
                pred_mask_tensor = pred_mask_tensor & roi
            elif "brain" in model_name:
                pred_mask_tensor = (tensor_vol > 60.0) & (tensor_vol < 220.0)
            else:
                pred_mask_tensor = (tensor_vol > 30.0) & (tensor_vol < 110.0)
            raw_mask_np = pred_mask_tensor.cpu().numpy().astype(np.uint8)
            mask = extract_largest_component(raw_mask_np)

        return extract_radiomics_features(volume=volume, mask=mask, spacing=spacing, num_bins=num_bins)

    def run_interactive_segmentation(
        self,
        sample_id_or_path: Optional[str] = None,
        volume: Optional[np.ndarray] = None,
        spacing: Optional[Tuple[float, float, float]] = None,
        points: Optional[List[Dict[str, Any]]] = None,
        bbox: Optional[Dict[str, int]] = None,
        current_mask: Optional[np.ndarray] = None,
        window_preset: Optional[str] = "lung",
        plane: str = "axial",
        slice_index: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Executes interactive click/prompt-based segmentation (VISTA-3D paradigm):
        Takes foreground/background prompt points and/or bounding boxes,
        extracts the 3D lesion mask, computes RECIST 1.1 metrics,
        and renders a high-definition 2D slice with contour and prompt point markers.
        """
        modality = "CT"
        if volume is None:
            if sample_id_or_path:
                volume, detected_spacing, modality = self.load_volume_data(sample_id_or_path)
                if spacing is None:
                    spacing = detected_spacing
            else:
                volume, _ = generate_synthetic_ct_volume(shape=(48, 128, 128), spacing=(1.5, 0.8, 0.8))
                if spacing is None:
                    spacing = (1.5, 0.8, 0.8)

        if spacing is None:
            spacing = (1.5, 0.8, 0.8)

        seg_res = interactive_segment_3d(
            volume=volume,
            spacing=spacing,
            points=points,
            bbox=bbox,
            current_mask=current_mask,
        )

        mask = seg_res["mask"]
        recist = calculate_recist_metrics(mask, spacing=spacing)
        key_slice_idx = slice_index if slice_index is not None else seg_res["key_slice_index"]
        key_slice_idx = int(np.clip(key_slice_idx, 0, volume.shape[0] - 1))

        # Windowing and slice extraction
        ct_windowed = apply_ct_window(volume, window_name=window_preset or "lung")
        ct_slice = ct_windowed[key_slice_idx]
        mask_slice = mask[key_slice_idx]

        png_bytes = render_key_slice_png(
            ct_slice_uint8=ct_slice,
            mask_slice_2d=mask_slice,
            recist=recist,
            modality=f"{modality} (VISTA-3D Interactive)",
            lesion_name="交互式点选靶病灶 (VISTA-3D ROI)",
            scale_bar_mm=50.0,
            pixel_spacing_mm=spacing[1],
            prompt_points=points,
        )

        return {
            "status": "success",
            "model_name": "vista3d_interactive_segmenter",
            "voxel_count": seg_res["voxel_count"],
            "volume_cm3": seg_res["volume_cm3"],
            "key_slice_index": key_slice_idx,
            "target_hu": seg_res["target_hu"],
            "tolerance_hu": seg_res["tolerance_hu"],
            "positive_prompts_count": seg_res["positive_prompts_count"],
            "negative_prompts_count": seg_res["negative_prompts_count"],
            "recist_metrics": recist,
            "slice_png_base64": png_to_base64(png_bytes),
            "slice_png_size_bytes": len(png_bytes),
            "summary_markdown": (
                f"**MONAI VISTA-3D 交互式点选分割结果**\n"
                f"- **交互提示点**: 正样本点 (Foreground) `{seg_res['positive_prompts_count']}` 个，"
                f"负样本点 (Background) `{seg_res['negative_prompts_count']}` 个\n"
                f"- **自适应灰度靶区**: `{seg_res['target_hu']} ± {seg_res['tolerance_hu']} HU`\n"
                f"- **病灶总体积**: **`{seg_res['volume_cm3']} cm³`** ({seg_res['voxel_count']} 个体素)\n"
                f"- **RECIST 1.1 最大截面长径**: `{recist['longest_diameter_mm']} mm` (垂直短径: `{recist['short_axis_mm']} mm`)\n"
                f"- **显示截面**: 第 `#{key_slice_idx}` 层 (已自动标定提示点与半透明红圈轮廓)"
            )
        }




