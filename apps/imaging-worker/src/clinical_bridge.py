import numpy as np
from typing import Dict, Any, Tuple, Optional, List
from scipy.spatial import ConvexHull
from scipy.spatial.distance import pdist, squareform

try:
    from .dicom_io import apply_ct_window
    from .renderer import render_key_slice_png, png_to_base64
    from .recist import detect_pulmonary_vessel_cross_section
except (ImportError, ValueError):
    from dicom_io import apply_ct_window
    from renderer import render_key_slice_png, png_to_base64
    from recist import detect_pulmonary_vessel_cross_section


def calculate_convex_hull_diameters(
    slice_2d: np.ndarray,
    dy: float,
    dx: float
) -> Tuple[float, float, Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """
    Computes RECIST 1.1 longest in-plane diameter (LD) and orthogonal short axis (SA)
    using an accelerated 2D Convex Hull algorithm on physical millimeter coordinates.
    """
    y_coords, x_coords = np.where(slice_2d > 0)
    if len(x_coords) < 2:
        return 0.0, 0.0, None, None

    pts = np.column_stack((x_coords * dx, y_coords * dy))

    if len(pts) >= 4:
        try:
            hull = ConvexHull(pts)
            hull_idx = hull.vertices
            hull_pts = pts[hull_idx]
            dists = squareform(pdist(hull_pts))
            hi, hj = np.unravel_index(np.argmax(dists), dists.shape)
            i = hull_idx[hi]
            j = hull_idx[hj]
            longest_diameter_mm = round(float(dists[hi, hj]), 1)
        except Exception:
            dists = squareform(pdist(pts))
            i, j = np.unravel_index(np.argmax(dists), dists.shape)
            longest_diameter_mm = round(float(dists[i, j]), 1)
    else:
        dists = squareform(pdist(pts))
        i, j = np.unravel_index(np.argmax(dists), dists.shape)
        longest_diameter_mm = round(float(dists[i, j]), 1)

    p1 = [int(x_coords[i]), int(y_coords[i])]
    p2 = [int(x_coords[j]), int(y_coords[j])]

    caliper_longest = {
        "p1": p1,
        "p2": p2,
        "length_mm": longest_diameter_mm
    }

    # Orthogonal short-axis search
    dx_vec = pts[j, 0] - pts[i, 0]
    dy_vec = pts[j, 1] - pts[i, 1]
    norm = np.hypot(dx_vec, dy_vec)
    if norm > 0:
        perp_x = -dy_vec / norm
        perp_y = dx_vec / norm
        proj = pts[:, 0] * perp_x + pts[:, 1] * perp_y
        short_axis_mm = round(float(np.ptp(proj)), 1)
        k_min = int(np.argmin(proj))
        k_max = int(np.argmax(proj))
        caliper_short = {
            "p1": [int(x_coords[k_min]), int(y_coords[k_min])],
            "p2": [int(x_coords[k_max]), int(y_coords[k_max])],
            "length_mm": short_axis_mm
        }
    else:
        short_axis_mm = 0.0
        caliper_short = None

    return longest_diameter_mm, short_axis_mm, caliper_longest, caliper_short


def extract_clinical_features(
    volume: np.ndarray,
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    modality: str = "CT",
    target_name: str = "lesion",
    window_preset: Optional[str] = None,
    solid_hu_threshold: float = -150.0
) -> Dict[str, Any]:
    """
    Transforms raw MONAI 3D output tensors (pred_mask and volume) into structured clinical features.
    
    1. Physical volume calculations (voxel volume = dx * dy * dz, total mm3 and cm3).
    2. RECIST 1.1 caliper dimensions on the maximum area 2D key slice.
    3. Radiodensity distribution (HU metrics, percentiles, solid vs GGO vs calcification composition).
    4. Subsolid & consolidation ratio (CTR = solid_diameter / total_diameter).
    5. CT scan quality control (slice thickness and partial volume risk).
    6. Publication-grade key slice overlay rendering.
    """
    dz, dy, dx = [float(s) for s in spacing]
    voxel_vol_mm3 = dz * dy * dx
    total_voxels = int(np.sum(mask > 0))
    total_volume_mm3 = round(total_voxels * voxel_vol_mm3, 2)
    total_volume_cm3 = round(total_volume_mm3 / 1000.0, 3)

    # 1. Quality Control
    slice_thickness_mm = round(dz, 2)
    if slice_thickness_mm <= 1.5:
        qc_tier = "optimal"
        qc_badge = "HRCT 薄层标准"
        qc_desc = f"薄层高分辨率扫描 ({slice_thickness_mm}mm ≤ 1.5mm)，满足 Fleischner 与 Lung-RADS 精确测量标准。"
        qc_warning = None
    elif slice_thickness_mm <= 2.5:
        qc_tier = "acceptable"
        qc_badge = "常规层厚"
        qc_desc = f"常规切片层厚 ({slice_thickness_mm}mm)，具有临床参考价值。"
        qc_warning = None
    else:
        qc_tier = "thick_slice_warning"
        qc_badge = "厚层质控警示"
        qc_desc = f"扫描层厚偏厚 ({slice_thickness_mm}mm > 2.5mm)。"
        qc_warning = (
            f"扫描层厚偏厚 ({slice_thickness_mm}mm)，部分容积效应可能导致病灶边界及微小浸润成分测值偏差，"
            f"建议行薄层 HRCT (≤1.25mm) 靶扫描复查。"
        )

    qc_info = {
        "slice_thickness_mm": slice_thickness_mm,
        "pixel_spacing_mm": [round(dy, 3), round(dx, 3)],
        "voxel_volume_mm3": round(voxel_vol_mm3, 4),
        "is_thin_slice": slice_thickness_mm <= 1.5,
        "tier": qc_tier,
        "badge": qc_badge,
        "description": qc_desc,
        "warning": qc_warning,
    }

    if total_voxels == 0:
        return {
            "has_lesion": False,
            "target_name": target_name,
            "modality": modality,
            "physical_metrics": {
                "positive_voxels": 0,
                "total_volume_mm3": 0.0,
                "total_volume_cm3": 0.0,
                "key_slice_index": 0,
                "key_slice_area_mm2": 0.0,
                "longest_diameter_mm": 0.0,
                "short_axis_mm": 0.0,
                "craniocaudal_span_mm": 0.0,
            },
            "density_metrics": None,
            "subsolid_metrics": None,
            "quality_control": qc_info,
            "key_slice_png_base64": None,
        }

    # 2. Key Slice and Physical RECIST Metrics
    slice_areas = np.sum(mask > 0, axis=(1, 2))
    key_slice_idx = int(np.argmax(slice_areas))
    key_slice_area_mm2 = round(float(slice_areas[key_slice_idx] * dy * dx), 2)

    slice_2d = mask[key_slice_idx] > 0
    longest_d_mm, short_a_mm, caliper_longest, caliper_short = calculate_convex_hull_diameters(slice_2d, dy, dx)

    # 3D spatial span
    z_indices, y_indices, x_indices = np.where(mask > 0)
    z_span_mm = round(float((np.max(z_indices) - np.min(z_indices) + 1) * dz), 1)
    y_span_mm = round(float((np.max(y_indices) - np.min(y_indices) + 1) * dy), 1)
    x_span_mm = round(float((np.max(x_indices) - np.min(x_indices) + 1) * dx), 1)

    physical_metrics = {
        "positive_voxels": total_voxels,
        "total_volume_mm3": total_volume_mm3,
        "total_volume_cm3": total_volume_cm3,
        "key_slice_index": key_slice_idx,
        "key_slice_area_mm2": key_slice_area_mm2,
        "longest_diameter_mm": longest_d_mm,
        "short_axis_mm": short_a_mm,
        "craniocaudal_span_mm": z_span_mm,
        "bounding_box_mm": {"z": z_span_mm, "y": y_span_mm, "x": x_span_mm},
        "caliper_longest": caliper_longest,
        "caliper_short": caliper_short,
    }

    # 3. Radiodensity HU Analysis (for CT)
    density_metrics = None
    subsolid_metrics = None

    if modality.upper() == "CT":
        lesion_hu = volume[mask > 0].astype(np.float32)
        mean_hu = round(float(np.mean(lesion_hu)), 1)
        median_hu = round(float(np.median(lesion_hu)), 1)
        std_hu = round(float(np.std(lesion_hu)), 1)
        min_hu = round(float(np.min(lesion_hu)), 1)
        max_hu = round(float(np.max(lesion_hu)), 1)
        p10_hu = round(float(np.percentile(lesion_hu, 10)), 1)
        p25_hu = round(float(np.percentile(lesion_hu, 25)), 1)
        p75_hu = round(float(np.percentile(lesion_hu, 75)), 1)
        p90_hu = round(float(np.percentile(lesion_hu, 90)), 1)

        # Attenuation fractions
        emphysema_pct = round(float(np.mean(lesion_hu < -950.0) * 100.0), 1)
        ggo_pct = round(float(np.mean((lesion_hu >= -950.0) & (lesion_hu < -300.0)) * 100.0), 1)
        solid_pct = round(float(np.mean((lesion_hu >= -150.0) & (lesion_hu < 130.0)) * 100.0), 1)
        calc_pct = round(float(np.mean(lesion_hu >= 130.0) * 100.0), 1)

        density_metrics = {
            "mean_hu": mean_hu,
            "median_hu": median_hu,
            "std_hu": std_hu,
            "min_hu": min_hu,
            "max_hu": max_hu,
            "p10_hu": p10_hu,
            "p25_hu": p25_hu,
            "p75_hu": p75_hu,
            "p90_hu": p90_hu,
            "composition": {
                "emphysema_air_percent": emphysema_pct,
                "ground_glass_percent": ggo_pct,
                "soft_tissue_solid_percent": solid_pct,
                "calcification_percent": calc_pct,
            }
        }

        # Subsolid / Lung Nodule morphology analysis
        solid_mask = (mask > 0) & (volume >= solid_hu_threshold)
        solid_vox_count = int(np.sum(solid_mask))
        solid_vol_mm3 = round(solid_vox_count * voxel_vol_mm3, 2)
        solid_vol_cm3 = round(solid_vol_mm3 / 1000.0, 3)

        if solid_vox_count > 0:
            solid_key_slice = solid_mask[key_slice_idx] > 0
            if np.sum(solid_key_slice) >= 2:
                s_ld, s_sa, s_caliper, _ = calculate_convex_hull_diameters(solid_key_slice, dy, dx)
            else:
                solid_slice_areas = np.sum(solid_mask, axis=(1, 2))
                s_key_idx = int(np.argmax(solid_slice_areas))
                s_ld, s_sa, s_caliper, _ = calculate_convex_hull_diameters(solid_mask[s_key_idx] > 0, dy, dx)
        else:
            s_ld, s_sa, s_caliper = 0.0, 0.0, None

        ctr = round(min(1.0, float(s_ld / max(longest_d_mm, 0.01))), 2)

        vessel_check = detect_pulmonary_vessel_cross_section(
            volume=volume,
            mask=mask,
            spacing=spacing,
            key_slice_idx=key_slice_idx
        )
        is_vessel = vessel_check.get("is_vessel", False)

        if is_vessel:
            morphology = "normal_vessel"
            morphology_zh = "正常肺血管分支断面 (非肺结节)"
            target_name = "正常肺血管分支断面 (伴行血管, 非肺结节)"
        elif solid_vox_count == 0 or s_ld == 0.0:
            morphology = "pure_ggo"
            morphology_zh = "纯磨玻璃结节 (pGGN)"
        elif calc_pct >= 50.0:
            morphology = "calcified"
            morphology_zh = "钙化结节 (良性特征)"
        elif ctr < 0.8:
            morphology = "part_solid"
            morphology_zh = "部分实性/亚实性结节 (PSN)"
        else:
            morphology = "solid"
            morphology_zh = "实性结节 (SN)"

        subsolid_metrics = {
            "morphological_type": morphology,
            "morphological_type_zh": morphology_zh,
            "solid_core_diameter_mm": s_ld,
            "solid_core_short_axis_mm": s_sa,
            "solid_core_volume_cm3": solid_vol_cm3,
            "consolidation_tumor_ratio": ctr,
            "solid_caliper": s_caliper,
            "is_vessel": is_vessel,
            "vessel_info": vessel_check,
        }

    # 4. Key Slice Overlay Rendering
    if not window_preset:
        if "lung" in target_name.lower() or "chest" in target_name.lower():
            window_preset = "lung"
        elif "brain" in target_name.lower():
            window_preset = "brain"
        elif "bone" in target_name.lower() or "vertebra" in target_name.lower():
            window_preset = "bone"
        else:
            window_preset = "abdomen"

    windowed_volume = apply_ct_window(volume, window_name=window_preset)
    ct_slice_uint8 = windowed_volume[key_slice_idx]
    mask_slice_2d = mask[key_slice_idx]

    recist_proxy = {
        "longest_diameter_mm": longest_d_mm,
        "short_axis_mm": short_a_mm,
        "total_volume_cm3": total_volume_cm3,
        "key_slice_index": key_slice_idx,
        "caliper_longest": caliper_longest,
        "caliper_short": caliper_short,
        "consolidation_tumor_ratio": subsolid_metrics.get("consolidation_tumor_ratio") if subsolid_metrics else None,
        "solid_core_diameter_mm": subsolid_metrics.get("solid_core_diameter_mm") if subsolid_metrics else None,
        "quality_control": qc_info,
        "is_vessel": subsolid_metrics.get("is_vessel", False) if subsolid_metrics else False,
        "lung_rads": {
            "category": "not_applicable",
            "name": "正常解剖结构 (非肺结节)"
        } if (subsolid_metrics and subsolid_metrics.get("is_vessel")) else None,
        "has_lesion": True,
    }

    png_bytes = render_key_slice_png(
        ct_slice_uint8=ct_slice_uint8,
        mask_slice_2d=mask_slice_2d,
        recist=recist_proxy,
        modality=f"{modality} ({window_preset.title()} Window)",
        lesion_name=target_name,
        scale_bar_mm=50.0,
        pixel_spacing_mm=dy
    )

    return {
        "has_lesion": True,
        "target_name": target_name,
        "modality": modality,
        "window_preset": window_preset,
        "physical_metrics": physical_metrics,
        "density_metrics": density_metrics,
        "subsolid_metrics": subsolid_metrics,
        "quality_control": qc_info,
        "key_slice_png_base64": png_to_base64(png_bytes),
        "key_slice_png_size_bytes": len(png_bytes),
    }
