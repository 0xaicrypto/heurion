import numpy as np
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


def calculate_subsolid_metrics(
    volume: np.ndarray,
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.0, 1.0, 1.0),
    solid_hu_threshold: float = -150.0
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
    """
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
        return total_metrics

    nodule_voxels = mask > 0
    solid_voxels = nodule_voxels & (volume >= solid_hu_threshold)
    solid_count = int(np.sum(solid_voxels))

    total_ld = total_metrics["longest_diameter_mm"]
    total_vol = total_metrics["total_volume_cm3"]

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
            elif total_ld < 8.0:
                rads = {
                    "category": "3",
                    "name": "Lung-RADS 3 类",
                    "description": f"可能良性实性结节 (长径 {total_ld}mm 在 6-8mm 区间)",
                    "recommendation": "建议 6 个月后低剂量 CT 复查"
                }
            elif total_ld < 15.0:
                rads = {
                    "category": "4A",
                    "name": "Lung-RADS 4A 类",
                    "description": f"中度可疑实性病灶 (长径 {total_ld}mm 在 8-15mm 区间)",
                    "recommendation": "建议 3 个月后低剂量 CT 复查或专科评估 PET-CT"
                }
            else:
                rads = {
                    "category": "4B",
                    "name": "Lung-RADS 4B 类",
                    "description": f"高度恶性可疑实性病灶 (长径 {total_ld}mm ≥15mm 或实性肿块)",
                    "recommendation": "强烈建议胸外科/呼吸介入专科急会诊，评估胸部增强 CT、穿刺活检或微创手术"
                }
        else:
            nodule_type = "part_solid"
            nodule_type_zh = "亚实性/混合磨玻璃结节 (Part-Solid)"
            # Subsolid classification is dictated by solid core diameter d_solid (Lung-RADS v2022)
            if solid_ld < 6.0:
                rads = {
                    "category": "3",
                    "name": "Lung-RADS 3 类",
                    "description": f"亚实性结节 (实性成分 {solid_ld}mm <6mm，总长径 {total_ld}mm，CTR {int(ctr*100)}%)",
                    "recommendation": "建议 6 个月后低剂量 CT 复查，观察实性核心有无增大"
                }
            elif solid_ld < 8.0:
                rads = {
                    "category": "4A",
                    "name": "Lung-RADS 4A 类",
                    "description": f"可疑浸润性亚实性结节 (实性核心 {solid_ld}mm 在 6-8mm，总长径 {total_ld}mm)",
                    "recommendation": "建议 3 个月后胸部高分辨 CT (HRCT) 复查或呼吸内科专科门诊评估"
                }
            else:
                rads = {
                    "category": "4B",
                    "name": "Lung-RADS 4B 类",
                    "description": f"高危亚实性病灶 (实性核心 {solid_ld}mm ≥8mm，浸润性腺癌高风险)",
                    "recommendation": "强烈建议胸外科/呼吸介入专科会诊，评估 PET-CT、CT 引导下经皮肺穿刺活检或外科手术"
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
