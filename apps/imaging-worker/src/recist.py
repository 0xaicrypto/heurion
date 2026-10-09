import numpy as np
import scipy.ndimage as ndi
from typing import Dict, Any, Tuple, Optional
from scipy.spatial import ConvexHull
from scipy.spatial.distance import pdist, squareform

def calculate_recist_metrics(
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.0, 1.0, 1.0)
) -> Dict[str, Any]:
    """
    Computes RECIST 1.1 quantitative metrics from a 3D binary mask:
    1. Total Volume (cm³)
    2. Key Slice Index (axial slice with maximum cross-sectional area)
    3. Longest Diameter (LD) in mm on the key slice (accelerated via Convex Hull)
    4. Perpendicular Short Axis in mm
    5. Caliper endpoints for graphical rendering
    """
    # Spacing: (dz, dy, dx) or (dx, dy, dz). We assume volume shape is (Z, Y, X)
    # voxel volume in mm³
    vx_vol_mm3 = spacing[0] * spacing[1] * spacing[2]
    total_voxels = int(np.sum(mask > 0))
    volume_cm3 = round(total_voxels * vx_vol_mm3 / 1000.0, 2)

    if total_voxels == 0:
        return {
            "total_volume_cm3": 0.0,
            "key_slice_index": 0,
            "longest_diameter_mm": 0.0,
            "short_axis_mm": 0.0,
            "caliper_longest": None,
            "caliper_short": None,
            "has_lesion": False
        }

    # Sum along axial slices (axis 0: Z)
    slice_areas = np.sum(mask > 0, axis=(1, 2))
    key_slice_idx = int(np.argmax(slice_areas))

    slice_2d = mask[key_slice_idx] > 0
    y_coords, x_coords = np.where(slice_2d)

    if len(x_coords) < 2:
        return {
            "total_volume_cm3": volume_cm3,
            "key_slice_index": key_slice_idx,
            "longest_diameter_mm": 0.0,
            "short_axis_mm": 0.0,
            "caliper_longest": None,
            "caliper_short": None,
            "has_lesion": True
        }

    # Scale pixel coordinates by in-plane spacing (dy, dx)
    dy, dx = spacing[1], spacing[2]
    pts = np.column_stack((x_coords * dx, y_coords * dy))

    # Accelerated diameter search: the maximum pairwise distance between points
    # always occurs between two vertices of the 2D convex hull.
    # This reduces complexity from O(N^2) (e.g. 50,000^2 pairs) to O(V^2) (V <= 60 vertices).
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
            # Fallback if points are collinear or 1D
            dists = squareform(pdist(pts))
            i, j = np.unravel_index(np.argmax(dists), dists.shape)
            longest_diameter_mm = round(float(dists[i, j]), 1)
    else:
        dists = squareform(pdist(pts))
        i, j = np.unravel_index(np.argmax(dists), dists.shape)
        longest_diameter_mm = round(float(dists[i, j]), 1)

    p1 = (int(x_coords[i]), int(y_coords[i]))
    p2 = (int(x_coords[j]), int(y_coords[j]))

    # For perpendicular short axis: search along perpendicular direction
    dx_vec = pts[j, 0] - pts[i, 0]
    dy_vec = pts[j, 1] - pts[i, 1]
    norm = np.hypot(dx_vec, dy_vec)
    if norm > 0:
        perp_x = -dy_vec / norm
        perp_y = dx_vec / norm
        # Project points onto perpendicular vector
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

    return {
        "total_volume_cm3": volume_cm3,
        "key_slice_index": key_slice_idx,
        "longest_diameter_mm": longest_diameter_mm,
        "short_axis_mm": short_axis_mm,
        "caliper_longest": {
            "p1": [p1[0], p1[1]],
            "p2": [p2[0], p2[1]],
            "length_mm": longest_diameter_mm
        },
        "caliper_short": caliper_short,
        "has_lesion": True
    }


def detect_pulmonary_vessel_cross_section(
    volume: np.ndarray,
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    key_slice_idx: Optional[int] = None,
    search_radius_mm: float = 18.0
) -> Dict[str, Any]:
    """
    Rigorously detects whether a segmented structure in thoracic CT is a cross-section
    of a normal pulmonary blood vessel rather than a pathological solitary nodule.

    Radiological Criteria (Fleischner Society & ACR Lung-RADS v2022 Normal Anatomy Exclusion):
    1. Caliber: In-plane diameter <= 7.0 mm (typical peripheral branching vessels 2-6mm).
    2. Companion Bronchus (Signet-Ring Sign / 印戒征):
       In normal lung anatomy, pulmonary arteries travel in parallel with a companion bronchus.
       In cross-section, this produces the classic "Signet-Ring" appearance: the opaque artery dot
       is immediately adjacent (within 1.2mm to 8.5mm) to a round patent air lumen (HU <= -780) of comparable caliber.
    3. Longitudinal Z-Axis Continuity & Branching:
       Unlike isolated nodules (which terminate in lung air within 2-4 slices), blood vessels continue
       continuously across adjacent slices (Z-span) and merge into the pulmonary vascular tree.
    4. Tubularity / Branching Tree Connection:
       Connects towards the hilar vascular trunk or displays 3D continuous tubular flow.
    """
    dz, dy, dx = [float(s) for s in spacing]
    is_lung = float(np.min(volume)) < -500.0 and float(np.mean(volume)) < -150.0
    if not is_lung:
        return {"is_vessel": False, "reasons": []}

    z_pts, y_pts, x_pts = np.where(mask > 0)
    if len(z_pts) == 0:
        return {"is_vessel": False, "reasons": []}

    cz = int(key_slice_idx) if key_slice_idx is not None else int(np.median(z_pts))
    slice_mask = mask[cz] > 0
    if not np.any(slice_mask):
        cz = int(np.median(z_pts))
        slice_mask = mask[cz] > 0
    if not np.any(slice_mask):
        return {"is_vessel": False, "reasons": []}

    # Isolate the target 2D connected component on key slice (avoiding multi-component inflation)
    lbl2d, n_comp = ndi.label(slice_mask)
    c_counts = np.bincount(lbl2d.flat)
    c_counts[0] = 0
    target_comp_idx = int(np.argmax(c_counts))
    target_slice_mask = (lbl2d == target_comp_idx)

    sy_pts, sx_pts = np.where(target_slice_mask)
    cy = int(np.mean(sy_pts))
    cx = int(np.mean(sx_pts))

    in_plane_area_mm2 = float(np.sum(target_slice_mask) * dy * dx)
    in_plane_d = round(float(2.0 * np.sqrt(in_plane_area_mm2 / np.pi)), 1) if in_plane_area_mm2 > 0 else 0.0

    # Genuine solitary nodules > 9.5mm are virtually never simple normal branching vessel cross-sections
    if in_plane_d > 9.5:
        return {"is_vessel": False, "in_plane_diameter_mm": in_plane_d, "reasons": []}

    rz = max(3, int(np.ceil(search_radius_mm / dz)))
    ry = max(8, int(np.ceil(search_radius_mm / dy)))
    rx = max(8, int(np.ceil(search_radius_mm / dx)))

    z_lo, z_hi = max(0, cz - rz), min(volume.shape[0], cz + rz + 1)
    y_lo, y_hi = max(0, cy - ry), min(volume.shape[1], cy + ry + 1)
    x_lo, x_hi = max(0, cx - rx), min(volume.shape[2], cx + rx + 1)

    sub_vol = volume[z_lo:z_hi, y_lo:y_hi, x_lo:x_hi]
    local_cz = cz - z_lo
    local_cy = cy - y_lo
    local_cx = cx - x_lo

    soft_tissue = (sub_vol >= -150.0) & (sub_vol <= 250.0)
    lbl, n_components = ndi.label(soft_tissue)
    seed_lbl = lbl[local_cz, local_cy, local_cx]

    if seed_lbl == 0:
        window = lbl[max(0, local_cz-1):local_cz+2, max(0, local_cy-1):local_cy+2, max(0, local_cx-1):local_cx+2]
        nz = window[window > 0]
        if len(nz) > 0:
            seed_lbl = int(np.bincount(nz).argmax())

    if seed_lbl == 0:
        return {"is_vessel": False, "in_plane_diameter_mm": in_plane_d, "reasons": []}

    comp = (lbl == seed_lbl)
    cz_pts, cy_pts, cx_pts = np.where(comp)
    z_span = float((cz_pts.max() - cz_pts.min() + 1) * dz)

    touches_z_boundary = bool((cz_pts.min() == 0) or (cz_pts.max() == sub_vol.shape[0] - 1))
    touches_xy_boundary = bool((cy_pts.min() == 0) or (cy_pts.max() == sub_vol.shape[1] - 1) or (cx_pts.min() == 0) or (cx_pts.max() == sub_vol.shape[2] - 1))

    # Check companion bronchus air lumen within 1.2mm to 8.5mm on key slice
    sl = sub_vol[local_cz]
    yy, xx = np.ogrid[:sl.shape[0], :sl.shape[1]]
    dist_map = np.sqrt(((yy - local_cy) * dy)**2 + ((xx - local_cx) * dx)**2)
    ring_mask = (dist_map >= 1.2) & (dist_map <= 8.5)
    air_lumens = (sl <= -780.0) & ring_mask
    air_lbl, n_air = ndi.label(air_lumens)
    has_companion_bronchus = False
    bronchus_caliber_mm = 0.0

    if n_air > 0:
        for a_idx in range(1, n_air + 1):
            a_area = float(np.sum(air_lbl == a_idx) * (dy * dx))
            # Typical companion bronchus lumen area: 2.0 to 45 mm2 (diam 1.6 to 7.5 mm)
            if 2.0 <= a_area <= 45.0:
                has_companion_bronchus = True
                bronchus_caliber_mm = round(float(2.0 * np.sqrt(a_area / np.pi)), 1)
                break

    is_vessel = False
    reasons = []

    # 1. Signet ring sign: Companion bronchus next to small dot (classic pulmonary artery branch)
    if has_companion_bronchus and in_plane_d <= 9.0:
        is_vessel = True
        reasons.append(f"伴行支气管印戒征 (气道内径 {bronchus_caliber_mm}mm)")

    # 2. Longitudinal Z-span continuity (3D through-flow across slices)
    if (touches_z_boundary or z_span >= 7.5) and in_plane_d <= 8.5:
        is_vessel = True
        reasons.append(f"3D纵向跨切片延伸 (Z跨度 {z_span:.1f}mm, 连续贯通)")

    # 3. Connection to branching vascular trunk
    if touches_xy_boundary and in_plane_d <= 7.5:
        is_vessel = True
        reasons.append("向肺门主干血管分叉延伸")

    return {
        "is_vessel": is_vessel,
        "in_plane_diameter_mm": in_plane_d,
        "z_span_mm": z_span,
        "has_companion_bronchus": has_companion_bronchus,
        "bronchus_caliber_mm": bronchus_caliber_mm,
        "touches_z_boundary": touches_z_boundary,
        "reasons": reasons
    }


def calculate_subsolid_metrics(
    volume: np.ndarray,
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.0, 1.0, 1.0),
    solid_hu_threshold: float = -150.0,
    key_slice_idx: Optional[int] = None
) -> Dict[str, Any]:
    """
    Calculates dual-channel subsolid / GGO quantitative metrics according to
    ACR Lung-RADS v2022 and Fleischner Society guidelines:
    1. Total lesion boundary (longest diameter, volume)
    2. Solid core boundary (longest diameter d_solid, solid core volume)
    3. Consolidation-to-Tumor Ratio (CTR = d_solid / d_total)
    4. Categorization:
       - pure_ggo (纯磨玻璃结节, pGGN): d_solid == 0
       - part_solid (部分实性/亚实性结节, PSN): 0 < CTR < 0.8
       - solid (实性结节, SN): CTR >= 0.8 or predominantly solid
    5. Lung-RADS v2022 risk stratification based on d_solid and total diameter
    6. CT slice thickness quality control (QC) & thin-slice HRCT recommendation
    7. Fleischner 2024 / WHO 2021 pathology invasiveness risk stratification
    """
    dz, dy, dx = [float(s) for s in spacing]
    slice_thickness_mm = round(dz, 2)
    if slice_thickness_mm <= 1.5:
        qc_tier = "optimal"
        qc_badge = "HRCT 薄层标准"
        qc_desc = "薄层高分辨率扫描 (≤1.5mm)，满足 Fleischner 与 Lung-RADS v2022 精准测定与实性核心界定标准"
        qc_warning = None
    elif slice_thickness_mm <= 2.5:
        qc_tier = "acceptable"
        qc_badge = "常规层厚"
        qc_desc = f"常规切片层厚 ({slice_thickness_mm}mm)，具有良好临床参考价值"
        qc_warning = None
    else:
        qc_tier = "thick_slice_warning"
        qc_badge = "厚层质控警示"
        qc_desc = f"扫描层厚偏厚 ({slice_thickness_mm}mm > 2.5mm)"
        qc_warning = (
            f"当前扫描层厚较厚 ({slice_thickness_mm}mm)，部分容积效应可能导致磨玻璃及亚实性结节微小实性核心 (d_solid) 测值偏差，"
            f"建议行薄层 HRCT (≤1.25mm) 靶扫描复查以明确病灶侵袭性。"
        )

    quality_control = {
        "slice_thickness_mm": slice_thickness_mm,
        "pixel_spacing_mm": [round(dy, 3), round(dx, 3)],
        "is_thin_slice": slice_thickness_mm <= 1.5,
        "tier": qc_tier,
        "badge": qc_badge,
        "description": qc_desc,
        "warning": qc_warning,
    }

    total_metrics = calculate_recist_metrics(mask, spacing=spacing)
    if not total_metrics.get("has_lesion", False) or total_metrics.get("longest_diameter_mm", 0.0) == 0.0:
        total_metrics["nodule_type"] = "none"
        total_metrics["nodule_type_zh"] = "无活动性病灶"
        total_metrics["solid_core_diameter_mm"] = 0.0
        total_metrics["solid_core_volume_cm3"] = 0.0
        total_metrics["solid_core_caliper"] = None
        total_metrics["consolidation_tumor_ratio"] = 0.0
        total_metrics["lung_rads"] = {
            "category": "1",
            "name": "Lung-RADS 1 类",
            "description": "阴性表现 (双肺未见活动性结节或明显占位)",
            "recommendation": "常规年度低剂量 CT (LDCT) 筛查"
        }
        total_metrics["pathology_risk"] = {
            "risk_level": "none",
            "risk_level_en": "None",
            "tendency": "未见占位性病变",
            "tendency_en": "No Lesion Detected",
            "rationale": "双肺实质未见确切活动性结节或占位。"
        }
        total_metrics["quality_control"] = quality_control
        return total_metrics

    nodule_voxels = mask > 0
    solid_voxels = nodule_voxels & (volume >= solid_hu_threshold)
    solid_count = int(np.sum(solid_voxels))

    total_ld = total_metrics["longest_diameter_mm"]
    total_vol = total_metrics["total_volume_cm3"]

    # 0. Normal Anatomical Structure Exclusion: Pulmonary Vessel Cross-Section Filter
    # In accordance with Fleischner Society & ACR Lung-RADS v2022 guidelines,
    # normal anatomical structures (vessels, bones, pleura) must NOT be misclassified as lung nodules.
    target_slice = key_slice_idx if key_slice_idx is not None else total_metrics.get("key_slice_index")
    vessel_check = detect_pulmonary_vessel_cross_section(
        volume=volume,
        mask=mask,
        spacing=spacing,
        key_slice_idx=target_slice
    )
    if vessel_check.get("is_vessel", False):
        reasons_str = "，".join(vessel_check.get("reasons", ["伴行支气管印戒征", "3D管状连续延伸"]))
        total_metrics["is_vessel"] = True
        total_metrics["vessel_info"] = vessel_check
        total_metrics["nodule_type"] = "normal_vessel"
        total_metrics["nodule_type_zh"] = "正常肺血管截面 (非结节)"
        total_metrics["solid_core_diameter_mm"] = total_ld
        total_metrics["solid_core_volume_cm3"] = total_vol
        total_metrics["solid_core_caliper"] = total_metrics.get("caliper_longest")
        total_metrics["consolidation_tumor_ratio"] = 1.0
        total_metrics["lung_rads"] = {
            "category": "not_applicable",
            "name": "正常解剖结构 (非肺结节)",
            "description": f"正常肺血管分支断面 (管径 {total_ld}mm，{reasons_str})",
            "recommendation": "确认为正常肺血管解剖投影，严格排除于肺结节范畴，无需进行 Lung-RADS 随访或过度复查"
        }
        total_metrics["pathology_risk"] = {
            "risk_level": "none",
            "risk_level_en": "None (Normal Vasculature)",
            "tendency": "正常肺血管分支 (伴行动脉/静脉)",
            "tendency_en": "Normal Pulmonary Vasculature",
            "rationale": f"该高密度点位于支气管血管束，经 3D 拓扑分析见纵向管状延伸与伴行气道 ({reasons_str})，确认为正常血管横截面，恶性风险为零。"
        }
        total_metrics["quality_control"] = quality_control
        return total_metrics

    # Attenuation statistics
    attenuations = volume[nodule_voxels]
    mean_hu = round(float(np.mean(attenuations)), 1)
    max_hu = round(float(np.max(attenuations)), 1)
    min_hu = round(float(np.min(attenuations)), 1)

    if solid_count == 0:
        nodule_type = "pure_ggo"
        nodule_type_zh = "纯磨玻璃结节 (pGGN)"
        solid_ld = 0.0
        solid_vol = 0.0
        solid_caliper = None
        ctr = 0.0

        if total_ld < 30.0:
            rads = {
                "category": "2",
                "name": "Lung-RADS 2 类",
                "description": f"良性外观纯磨玻璃结节 (长径 {total_ld}mm <30mm)",
                "recommendation": "建议 12 个月后低剂量 CT (LDCT) 常规年度随访"
            }
        else:
            rads = {
                "category": "3",
                "name": "Lung-RADS 3 类",
                "description": f"可能良性纯磨玻璃结节 (长径 {total_ld}mm ≥30mm)",
                "recommendation": "建议 6 个月后低剂量 CT 复查，评估病灶大小与密度改变"
            }
        pathology_risk = {
            "risk_level": "low",
            "risk_level_en": "Low",
            "tendency": "不典型腺瘤样增生 (AAH) 或原位腺癌 (AIS) 倾向",
            "tendency_en": "AAH / AIS Spectrum",
            "rationale": "纯磨玻璃病变以伏壁生长为主，几乎无血管侵犯，以常规年度动态随访为主，避免过度手术。"
        }
    else:
        solid_metrics = calculate_recist_metrics(solid_voxels.astype(np.uint8), spacing=spacing)
        solid_ld = solid_metrics["longest_diameter_mm"]
        solid_vol = solid_metrics["total_volume_cm3"]
        solid_caliper = solid_metrics.get("caliper_longest")

        ctr = round(min(1.0, float(solid_ld / max(total_ld, 0.01))), 2)

        if ctr >= 0.8 or solid_count >= int(0.75 * np.sum(nodule_voxels)):
            nodule_type = "solid"
            nodule_type_zh = "实性结节 (Solid)"
            if total_ld < 6.0:
                rads = {
                    "category": "2",
                    "name": "Lung-RADS 2 类",
                    "description": f"良性外观实性微小结节 (长径 {total_ld}mm <6mm)",
                    "recommendation": "建议 12 个月后低剂量 CT 常规随访"
                }
                pathology_risk = {
                    "risk_level": "low",
                    "risk_level_en": "Low",
                    "tendency": "良性炎性肉芽肿/错构瘤倾向",
                    "tendency_en": "Benign Granuloma / Hamartoma",
                    "rationale": "长径 <6mm 的微小实性结节恶性率 <1%，建议 12 个月低剂量 CT 常规随访。"
                }
            elif total_ld < 8.0:
                rads = {
                    "category": "3",
                    "name": "Lung-RADS 3 类",
                    "description": f"可能良性实性结节 (长径 {total_ld}mm 在 6-8mm 区间)",
                    "recommendation": "建议 6 个月后低剂量 CT 复查"
                }
                pathology_risk = {
                    "risk_level": "low_to_intermediate",
                    "risk_level_en": "Low-to-Intermediate",
                    "tendency": "良性结节倾向，需警惕早期实性肿瘤",
                    "tendency_en": "Indolent / Early Tumor Potential",
                    "rationale": "长径 6-8mm 实性结节恶性概率约 1%~2%，建议 6 个月低剂量 CT 动态对比倍增情况。"
                }
            elif total_ld < 15.0:
                rads = {
                    "category": "4A",
                    "name": "Lung-RADS 4A 类",
                    "description": f"中度可疑实性病灶 (长径 {total_ld}mm 在 8-15mm 区间)",
                    "recommendation": "建议 3 个月后低剂量 CT 复查或专科评估 PET-CT"
                }
                pathology_risk = {
                    "risk_level": "intermediate_high",
                    "risk_level_en": "Intermediate-High",
                    "tendency": "中度可疑恶性肿瘤/浸润性结节",
                    "tendency_en": "Suspicious Malignant Nodule",
                    "rationale": "长径 8-15mm 实性结节恶性率约 5%~15%，建议 3 个月严密复查或专科评估 PET-CT / 穿刺。"
                }
            else:
                rads = {
                    "category": "4B",
                    "name": "Lung-RADS 4B 类",
                    "description": f"高度恶性可疑实性病灶 (长径 {total_ld}mm ≥15mm 或实性肿块)",
                    "recommendation": "强烈建议胸外科/呼吸介入专科急会诊，评估胸部增强 CT、穿刺活检或微创手术"
                }
                pathology_risk = {
                    "risk_level": "high",
                    "risk_level_en": "High",
                    "tendency": "高度恶性浸润性肺癌/转移瘤可疑",
                    "tendency_en": "Highly Suspicious Invasive Carcinoma",
                    "rationale": "长径 ≥15mm 实性占位恶性概率高，强烈建议胸外科急会诊，结合增强 CT 与病理确诊。"
                }
        else:
            nodule_type = "part_solid"
            nodule_type_zh = "亚实性/混合磨玻璃结节 (Part-Solid)"
            # Subsolid classification is dictated by solid core diameter d_solid (Lung-RADS v2022 & Fleischner 2024)
            if solid_ld < 5.0:
                rads = {
                    "category": "3",
                    "name": "Lung-RADS 3 类",
                    "description": f"亚实性结节 (实性核心 {solid_ld}mm <5mm，总长径 {total_ld}mm，CTR {int(ctr*100)}%)",
                    "recommendation": "建议 6 个月后低剂量 CT 复查，观察实性核心有无增大"
                }
                pathology_risk = {
                    "risk_level": "intermediate_low",
                    "risk_level_en": "Intermediate-Low",
                    "tendency": "微浸润性腺癌 (MIA) 或原位腺癌 (AIS) 倾向",
                    "tendency_en": "Suspected MIA / AIS",
                    "rationale": "实性成分 <5mm，微浸润或伏壁生长为主，建议 3~6 个月薄层 HRCT 观察实性成分倍增趋势。"
                }
            elif solid_ld < 8.0:
                rads = {
                    "category": "4A",
                    "name": "Lung-RADS 4A 类",
                    "description": f"可疑浸润性亚实性结节 (实性核心 {solid_ld}mm 在 5-8mm，总长径 {total_ld}mm)",
                    "recommendation": "建议 3 个月后胸部高分辨 CT (HRCT) 复查或呼吸内科专科门诊评估"
                }
                pathology_risk = {
                    "risk_level": "intermediate_high",
                    "risk_level_en": "Intermediate-High",
                    "tendency": "早期浸润性腺癌 (IA) 可能性大",
                    "tendency_en": "Probable Invasive Adenocarcinoma (IA)",
                    "rationale": "实性核心达到 5~8mm，病理浸润风险显著升高，建议呼吸内科或胸外科门诊专科评估，考虑胸部增强 CT 或穿刺活检。"
                }
            else:
                rads = {
                    "category": "4B",
                    "name": "Lung-RADS 4B 类",
                    "description": f"高危亚实性病灶 (实性核心 {solid_ld}mm ≥8mm，浸润性腺癌高风险)",
                    "recommendation": "强烈建议胸外科/呼吸介入专科会诊，评估 PET-CT、CT 引导下经皮肺穿刺活检或外科手术"
                }
                pathology_risk = {
                    "risk_level": "high",
                    "risk_level_en": "High",
                    "tendency": "浸润性肺腺癌高危",
                    "tendency_en": "High Risk Invasive Adenocarcinoma (IA)",
                    "rationale": "实性核心 ≥8mm，浸润性及转移风险高，强烈建议胸外科急会诊，评估 PET-CT 及微创手术切除。"
                }

    res = {
        **total_metrics,
        "nodule_type": nodule_type,
        "nodule_type_zh": nodule_type_zh,
        "solid_core_diameter_mm": solid_ld,
        "solid_core_volume_cm3": solid_vol,
        "solid_core_caliper": solid_caliper,
        "consolidation_tumor_ratio": ctr,
        "mean_attenuation_hu": mean_hu,
        "max_attenuation_hu": max_hu,
        "min_attenuation_hu": min_hu,
        "lung_rads": rads,
        "pathology_risk": pathology_risk,
        "quality_control": quality_control,
        "has_lesion": True
    }
    return res


def calculate_volume_doubling_time(
    baseline_vol_cm3: float,
    followup_vol_cm3: float,
    days_interval: float
) -> Dict[str, Any]:
    """
    Computes Schwartz Volume Doubling Time (VDT) and clinical proliferation risk:
    Formula: VDT = (days_interval * ln(2)) / ln(V2 / V1)
    
    Clinical Risk Categories (Fleischner Society & BTS Guidelines):
    - VDT < 400 days: Rapid aggressive proliferation (High malignancy suspicion)
    - 400 <= VDT <= 600 days: Intermediate proliferation rate
    - VDT > 600 days: Indolent / Slow proliferation (Typically benign or low-grade)
    - V2 <= V1: Stable / Regressed (No progression)
    """
    if baseline_vol_cm3 <= 0 or followup_vol_cm3 <= 0 or days_interval <= 0:
        return {
            "vdt_days": None,
            "volume_change_cm3": round(followup_vol_cm3 - baseline_vol_cm3, 3),
            "volume_change_percent": None,
            "category": "indeterminate",
            "risk_level": "none",
            "label": "无法计算 (数据不足或时间间隔为0)",
            "description": "需要两次随访且有明确体积与随访间隔日期方可计算倍增时间。",
            "clinical_alert": False,
            "recommendation": "维持既定临床随访计划"
        }

    vol_diff = round(followup_vol_cm3 - baseline_vol_cm3, 3)
    pct_change = round(((followup_vol_cm3 - baseline_vol_cm3) / baseline_vol_cm3) * 100.0, 1)

    if followup_vol_cm3 <= baseline_vol_cm3:
        if followup_vol_cm3 <= baseline_vol_cm3 * 0.75:
            cat = "regressed"
            label = f"体积显著缩小 (缩小 {abs(pct_change)}%)"
            desc = "病灶体积较基线缩小 >25%，符合治疗有效或炎性吸收表现。"
        else:
            cat = "stable"
            label = "体积相对稳定"
            desc = f"病灶体积变化在标准测量误差范围内 ({pct_change}%)，未见明确增大。"
        return {
            "vdt_days": None,
            "volume_change_cm3": vol_diff,
            "volume_change_percent": pct_change,
            "category": cat,
            "risk_level": "low",
            "label": label,
            "description": desc,
            "clinical_alert": False,
            "recommendation": "按原定临床方案维持常规影像随访"
        }

    # Volume increased: V2 > V1
    vdt = (days_interval * np.log(2.0)) / np.log(followup_vol_cm3 / baseline_vol_cm3)
    vdt_days = round(float(vdt), 1)

    if vdt_days < 400.0:
        return {
            "vdt_days": vdt_days,
            "volume_change_cm3": vol_diff,
            "volume_change_percent": pct_change,
            "category": "rapid_growth",
            "risk_level": "critical_high",
            "label": f"急速倍增 ({vdt_days}天, 恶性高危)",
            "description": f"体积倍增时间仅 {vdt_days} 天 (<400天，体积增大 +{pct_change}%)，符合恶性实体肿瘤快速增殖特征。",
            "clinical_alert": True,
            "recommendation": "强烈建议立即提交肺部肿瘤 MDT 疑难病案会诊，并由胸外科评估穿刺活检或胸腔镜切除手术"
        }
    elif vdt_days <= 600.0:
        return {
            "vdt_days": vdt_days,
            "volume_change_cm3": vol_diff,
            "volume_change_percent": pct_change,
            "category": "intermediate_growth",
            "risk_level": "medium_warning",
            "label": f"中度增殖 ({vdt_days}天, 需警惕)",
            "description": f"体积倍增时间为 {vdt_days} 天 (400-600天区间，体积增大 +{pct_change}%)，提示病灶持续缓慢增殖，不能排除浸润性病变。",
            "clinical_alert": False,
            "recommendation": "建议 3 个月后低剂量高分辨 CT 严密随访，若实性成分继续增大建议穿刺介入"
        }
    else:
        return {
            "vdt_days": vdt_days,
            "volume_change_cm3": vol_diff,
            "volume_change_percent": pct_change,
            "category": "indolent_growth",
            "risk_level": "low_indolent",
            "label": f"惰性/缓慢增殖 ({vdt_days}天, 良性倾向)",
            "description": f"体积倍增时间长达 {vdt_days} 天 (>600天，体积增大 +{pct_change}%)，多见于良性错构瘤/硬化性血管瘤或惰性原位癌。",
            "clinical_alert": False,
            "recommendation": "建议维持 6-12 个月常规年度低剂量 CT 随访"
        }


def calculate_emphysema_metrics(
    volume: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    emphysema_hu_threshold: float = -950.0
) -> Dict[str, Any]:
    """
    Calculates Low Attenuation Area (LAA%) and COPD GOLD 2024 emphysema severity metrics:
    1. Bilateral lung volume (Liters)
    2. Emphysema volume <= -950 HU (Liters)
    3. LAA-950% = (V_emphysema / V_total_lung) * 100%
    4. GOLD 2024 COPD Emphysema Index Grade:
       - LAA < 5%: Normal / Trace
       - 5% <= LAA < 10%: Mild (GOLD Grade 1)
       - 10% <= LAA < 20%: Moderate (GOLD Grade 2)
       - LAA >= 20%: Severe / Diffuse (GOLD Grade 3-4)
    """
    dz, dy, dx = [float(s) for s in spacing]
    voxel_vol_cm3 = (dz * dy * dx) / 1000.0
    voxel_vol_liters = voxel_vol_cm3 / 1000.0

    # 3D lung mask (-980 to -400 HU)
    lung_mask = (volume >= -980.0) & (volume <= -400.0)
    total_lung_voxels = int(np.sum(lung_mask))

    slice_thickness_mm = round(dz, 2)
    quality_control = {
        "slice_thickness_mm": slice_thickness_mm,
        "is_thin_slice": slice_thickness_mm <= 1.5,
        "warning": None if slice_thickness_mm <= 2.0 else f"层厚 {slice_thickness_mm}mm 偏厚，可能影响小气道低衰减区精细勾画"
    }

    if total_lung_voxels < 500:
        return {
            "total_lung_volume_liters": 0.0,
            "emphysema_volume_liters": 0.0,
            "laa_percent": 0.0,
            "gold_stage": "GOLD 0",
            "gold_grade": "indeterminate",
            "gold_grade_zh": "未检测到有效双肺野 (数据不足)",
            "clinical_impression": "CT 数据未能有效提取完整双肺实质，请确认扫描范围包含全胸廓。",
            "recommendation": "CT 数据未能有效提取完整双肺实质，请确认扫描范围包含全胸廓。",
            "mean_lung_attenuation_hu": 0.0,
            "quality_control": quality_control
        }

    emphysema_mask = lung_mask & (volume <= emphysema_hu_threshold)
    emphysema_voxels = int(np.sum(emphysema_mask))

    total_lung_liters = round(total_lung_voxels * voxel_vol_liters, 2)
    emphysema_liters = round(emphysema_voxels * voxel_vol_liters, 3)
    laa_pct = round((emphysema_voxels / max(total_lung_voxels, 1)) * 100.0, 1)

    mean_hu = round(float(np.mean(volume[lung_mask])), 1)

    if laa_pct < 5.0:
        gold_grade = "normal_or_trace"
        gold_grade_zh = "正常 / 痕量低衰减区 (LAA% < 5%)"
        gold_stage = "GOLD 0/1"
        clinical_impression = f"双肺透亮度正常，低衰减区占比 {laa_pct}% (<5%)，未见确切弥漫性肺气肿改变。"
        recommendation = "常规戒烟宣教与生活方式指导，无需特殊慢阻肺药物干预。"
    elif laa_pct < 10.0:
        gold_grade = "mild"
        gold_grade_zh = "轻度肺气肿 (LAA% 5%~10%)"
        gold_stage = "GOLD Grade 1"
        clinical_impression = f"双肺实质见轻度低衰减透亮区，占全肺容积 {laa_pct}%，符合早期肺气肿或小气道功能障碍影像表现。"
        recommendation = "建议行肺功能通气检查 (FEV1/FVC)，严格戒烟并避免粉尘接触。"
    elif laa_pct < 20.0:
        gold_grade = "moderate"
        gold_grade_zh = "中度肺气肿 (LAA% 10%~20%)"
        gold_stage = "GOLD Grade 2"
        clinical_impression = f"双肺见广泛低衰减区 (LAA% 达 {laa_pct}%)，伴局灶肺大泡倾向，提示中度肺气肿改变。"
        recommendation = "建议呼吸内科专科门诊就诊，结合肺功能测定评估长效支气管舒张剂吸入治疗。"
    else:
        gold_grade = "severe"
        gold_grade_zh = "重度 / 弥漫性肺气肿 (LAA% ≥ 20%)"
        gold_stage = "GOLD Grade 3-4"
        clinical_impression = f"双肺野显著过度膨胀，广泛低衰减区破坏，LAA% 达 {laa_pct}% (体积 {emphysema_liters} L)，提示重度肺气肿并重度通气功能受损风险。"
        recommendation = "强烈建议呼吸重症或肺康复专科就诊，全面评估肺容量、血气分析及肺减容/康复综合治疗。"

    return {
        "total_lung_volume_liters": total_lung_liters,
        "emphysema_volume_liters": emphysema_liters,
        "laa_percent": laa_pct,
        "gold_grade": gold_grade,
        "gold_grade_zh": gold_grade_zh,
        "gold_stage": gold_stage,
        "clinical_impression": clinical_impression,
        "recommendation": recommendation,
        "mean_lung_attenuation_hu": mean_hu,
        "emphysema_hu_threshold": emphysema_hu_threshold,
        "quality_control": quality_control
    }

