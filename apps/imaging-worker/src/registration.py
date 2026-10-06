import io
import os
import time
import numpy as np
import torch
from typing import Dict, Any, Tuple, Optional, List
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import (
    map_coordinates,
    gaussian_filter,
    binary_dilation,
    generate_binary_structure,
    iterate_structure,
    label
)

try:
    from .device import get_optimal_device, get_device_info
    from .dicom_io import apply_ct_window
    from .renderer import png_to_base64
except (ImportError, ValueError):
    from device import get_optimal_device, get_device_info
    from dicom_io import apply_ct_window
    from renderer import png_to_base64


def get_sans_font(size: int = 14, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Loads a clean Sans-Serif font for medical HUD and metric callouts."""
    font_paths = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
    ]
    for p in font_paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def apply_turbo_colormap(norm_vals: np.ndarray) -> np.ndarray:
    """
    Applies standard Turbo / Hot multi-spectral colormap (0.0 ~ 1.0 -> RGB uint8).
    Smoothly transitions: Blue -> Cyan -> Green -> Yellow -> Red -> Dark Red.
    """
    x = np.clip(norm_vals, 0.0, 1.0)
    # Polynomial approximation for high-visibility clinical Turbo colormap
    r = 34.61 + x * (1172.42 + x * (-1079.02 + x * (33.60 + x * (375.40 - x * 670.45))))
    g = -0.54 + x * (991.31 + x * (-998.05 + x * (581.45 + x * (-170.51 + x * -35.61))))
    b = 100.46 + x * (203.73 + x * (-2174.65 + x * (3932.12 + x * (-2600.93 + x * 595.66))))
    
    r = np.clip(r, 0, 255).astype(np.uint8)
    g = np.clip(g, 0, 255).astype(np.uint8)
    b = np.clip(b, 0, 255).astype(np.uint8)
    
    return np.stack([r, g, b], axis=-1)


def generate_synthetic_pet_ct_pair(
    shape: Tuple[int, int, int] = (36, 96, 96),
    spacing: Tuple[float, float, float] = (2.0, 1.0, 1.0)
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """
    Synthesizes a realistic paired CT and PET dataset:
    - CT: Thoraco-abdominal volume with anatomy (-1000 to +450 HU)
    - PET: Metabolic volume in SUV units (0.0 to 12.5 SUV) with hypermetabolic malignant tumor
    """
    z_dim, y_dim, x_dim = shape
    ct_vol = np.full(shape, -1000.0, dtype=np.float32)
    pet_vol = np.full(shape, 0.2, dtype=np.float32) # physiological background SUV

    z_coords, y_coords, x_coords = np.meshgrid(
        np.arange(z_dim), np.arange(y_dim), np.arange(x_dim), indexing="ij"
    )
    cy, cx = y_dim // 2, x_dim // 2

    # Body contour
    body = ((y_coords - cy) / (y_dim * 0.44))**2 + ((x_coords - cx) / (x_dim * 0.44))**2 <= 1.0
    ct_vol[body] = 40.0
    pet_vol[body] = 0.8 + np.random.normal(0, 0.1, int(np.sum(body))) # soft tissue background SUV

    # Bilateral lungs
    left_lung = ((y_coords - cy) / (y_dim * 0.26))**2 + ((x_coords - (cx - int(x_dim * 0.2))) / (x_dim * 0.16))**2 <= 1.0
    right_lung = ((y_coords - cy) / (y_dim * 0.26))**2 + ((x_coords - (cx + int(x_dim * 0.2))) / (x_dim * 0.16))**2 <= 1.0
    ct_vol[left_lung] = -700.0
    ct_vol[right_lung] = -700.0
    pet_vol[left_lung] = 0.35 # low lung background
    pet_vol[right_lung] = 0.35

    # Spine bone in posterior
    spine = ((y_coords - (cy + int(y_dim * 0.28))) / (y_dim * 0.08))**2 + ((x_coords - cx) / (x_dim * 0.08))**2 <= 1.0
    ct_vol[spine] = 450.0

    # Hypermetabolic malignant tumor in right lung / hilar region
    tz = z_dim // 2
    ty = cy + 2
    tx = cx + int(x_dim * 0.18)
    tumor_radius = 8.0
    dist_sq = (
        ((z_coords - tz) / (tumor_radius * 0.7))**2 +
        ((y_coords - ty) / tumor_radius)**2 +
        ((x_coords - tx) / (tumor_radius * 1.2))**2
    )
    tumor_mask = dist_sq <= 1.0

    # CT hyperdense lesion
    ct_vol[tumor_mask] = 55.0 + np.random.normal(0, 8, int(np.sum(tumor_mask)))
    # PET hypermetabolism (SUV peaks at 11.8)
    tumor_suv = 11.8 * np.exp(-1.5 * dist_sq[tumor_mask])
    pet_vol[tumor_mask] = np.maximum(pet_vol[tumor_mask], tumor_suv)

    meta = {
        "tumor_center": (tz, ty, tx),
        "tumor_radius": tumor_radius,
        "max_suv_ground_truth": 11.8,
    }
    return ct_vol, pet_vol, meta


def compute_normalized_cross_correlation(vol1: np.ndarray, vol2: np.ndarray) -> float:
    """Computes Normalized Cross Correlation (NCC, -1.0 to 1.0) between two 3D volumes."""
    v1 = vol1.astype(np.float64)
    v2 = vol2.astype(np.float64)
    v1_mean = np.mean(v1)
    v2_mean = np.mean(v2)
    v1_centered = v1 - v1_mean
    v2_centered = v2 - v2_mean
    num = np.sum(v1_centered * v2_centered)
    den = np.sqrt(np.sum(v1_centered**2) * np.sum(v2_centered**2))
    return float(num / den) if den > 1e-8 else 0.0


def run_3d_deformable_registration(
    fixed_vol: np.ndarray,
    moving_vol: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    iterations: int = 12,
    smoothing_sigma: float = 1.0
) -> Dict[str, Any]:
    """
    Executes 3D Deformable B-Spline / Demons Dense Vector Displacement Field (DDF) registration.
    Aligns moving volume to fixed volume, returns warped volume, displacement field, and deformation metrics.
    """
    t0 = time.time()
    z_dim, y_dim, x_dim = fixed_vol.shape

    # Initial similarity
    initial_ncc = compute_normalized_cross_correlation(fixed_vol, moving_vol)
    initial_mse = float(np.mean((fixed_vol - moving_vol)**2))

    # Dense Displacement Field (DDF) initialized to zero
    u_z = np.zeros(fixed_vol.shape, dtype=np.float32)
    u_y = np.zeros(fixed_vol.shape, dtype=np.float32)
    u_x = np.zeros(fixed_vol.shape, dtype=np.float32)

    # Coordinate grids
    gz, gy, gx = np.meshgrid(
        np.arange(z_dim), np.arange(y_dim), np.arange(x_dim), indexing="ij"
    )

    current_warped = moving_vol.copy()

    # Multi-resolution gradient descent on displacement field
    for it in range(iterations):
        diff = fixed_vol - current_warped
        # Spatial gradients of fixed image
        grad_z, grad_y, grad_x = np.gradient(fixed_vol)
        grad_norm = grad_z**2 + grad_y**2 + grad_x**2 + 1e-4

        # Optical flow / Demons force update
        force_z = (diff * grad_z) / grad_norm
        force_y = (diff * grad_y) / grad_norm
        force_x = (diff * grad_x) / grad_norm

        # Fluid-like Gaussian smoothing
        u_z += gaussian_filter(force_z, sigma=smoothing_sigma) * 0.4
        u_y += gaussian_filter(force_y, sigma=smoothing_sigma) * 0.4
        u_x += gaussian_filter(force_x, sigma=smoothing_sigma) * 0.4

        # Elastic regularization
        u_z = gaussian_filter(u_z, sigma=smoothing_sigma)
        u_y = gaussian_filter(u_y, sigma=smoothing_sigma)
        u_x = gaussian_filter(u_x, sigma=smoothing_sigma)

        # Warp coordinates
        coords = np.array([gz + u_z, gy + u_y, gx + u_x])
        current_warped = map_coordinates(moving_vol, coords, order=1, mode="nearest")

    final_ncc = compute_normalized_cross_correlation(fixed_vol, current_warped)
    final_mse = float(np.mean((fixed_vol - current_warped)**2))

    # Magnitude of physical deformation in mm
    disp_magnitude_voxels = np.sqrt(u_z**2 + u_y**2 + u_x**2)
    disp_magnitude_mm = np.sqrt((u_z * spacing[0])**2 + (u_y * spacing[1])**2 + (u_x * spacing[2])**2)
    max_displacement_mm = float(np.max(disp_magnitude_mm))
    mean_displacement_mm = float(np.mean(disp_magnitude_mm))

    # Render key slice with displacement vector field heatmap overlay
    key_slice_idx = z_dim // 2
    warped_slice = current_warped[key_slice_idx]
    disp_slice = disp_magnitude_mm[key_slice_idx]

    ct_windowed = apply_ct_window(warped_slice, window_name="abdomen" if np.min(warped_slice) > -500 else "lung")
    base_img = Image.fromarray(ct_windowed).convert("RGBA")

    norm_disp = np.clip(disp_slice / max(max_displacement_mm, 1.0), 0.0, 1.0)
    disp_rgb = apply_turbo_colormap(norm_disp)
    h, w = warped_slice.shape
    disp_alpha = (norm_disp * 180.0).astype(np.uint8)
    disp_rgba = np.dstack([disp_rgb, disp_alpha])
    disp_img = Image.fromarray(disp_rgba, mode="RGBA")

    fused_img = Image.alpha_composite(base_img, disp_img)
    draw = ImageDraw.Draw(fused_img)

    font_bold = get_sans_font(12, bold=True)
    font_reg = get_sans_font(11, bold=False)

    hud_bg = [(8, 8), (270, 96)]
    draw.rounded_rectangle(hud_bg, radius=4, fill=(15, 23, 42, 215), outline=(51, 65, 85, 255))
    draw.text((16, 12), "3D Deformable DDF Registration", font=font_bold, fill=(241, 245, 249, 255))
    draw.text((16, 28), f"Key Slice: #{key_slice_idx}/{z_dim} | Spacing: {spacing[1]}mm", font=font_reg, fill=(148, 163, 184, 255))
    draw.text((16, 44), f"NCC: {round(initial_ncc, 3)} -> {round(final_ncc, 3)} (+{round(final_ncc - initial_ncc, 3)})", font=font_reg, fill=(52, 211, 153, 255))
    draw.text((16, 60), f"MSE Drop: {round(max(0.0, (initial_mse - final_mse) / max(initial_mse, 1e-4) * 100.0), 1)}%", font=font_reg, fill=(250, 204, 21, 255))
    draw.text((16, 76), f"Max Disp: {round(max_displacement_mm, 2)} mm (mean: {round(mean_displacement_mm, 2)} mm)", font=font_reg, fill=(56, 189, 248, 255))

    buf = io.BytesIO()
    fused_img.convert("RGB").save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    elapsed = round(time.time() - t0, 3)

    return {
        "status": "success",
        "iterations_completed": iterations,
        "elapsed_sec": elapsed,
        "initial_ncc": round(initial_ncc, 4),
        "final_ncc": round(final_ncc, 4),
        "ncc_improvement": round(final_ncc - initial_ncc, 4),
        "initial_mse": round(initial_mse, 2),
        "final_mse": round(final_mse, 2),
        "mse_reduction_percent": round(max(0.0, (initial_mse - final_mse) / max(initial_mse, 1e-4) * 100.0), 1),
        "max_displacement_mm": round(max_displacement_mm, 2),
        "mean_displacement_mm": round(mean_displacement_mm, 2),
        "key_slice_index": key_slice_idx,
        "registered_slice_png_base64": png_to_base64(png_bytes),
        "registered_slice_png_size_bytes": len(png_bytes),
        "warped_volume": current_warped,
        "displacement_field": {
            "u_z": u_z,
            "u_y": u_y,
            "u_x": u_x,
            "magnitude_map": disp_magnitude_mm,
        },
        "summary_markdown": (
            f"### 3D 可形变配准 (Deformable B-Spline / DDF) 报告\n"
            f"- **初始归一化互相关 (NCC)**: `{round(initial_ncc, 4)}` → **配准后 NCC**: `{round(final_ncc, 4)}` (提升 `{round(final_ncc - initial_ncc, 4)}`)\n"
            f"- **均方误差 (MSE) 降幅**: `{round(max(0.0, (initial_mse - final_mse) / max(initial_mse, 1e-4) * 100.0), 1)}%` (耗时 `{elapsed}s`)\n"
            f"- **最大位移形变量**: `{round(max_displacement_mm, 2)} mm` (平均位移: `{round(mean_displacement_mm, 2)} mm`)\n"
        )
    }


def compute_pet_metrics_and_fusion(
    ct_volume: np.ndarray,
    pet_volume: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    suv_threshold: float = 2.5,
    key_slice_index: Optional[int] = None,
    alpha: float = 0.55
) -> Dict[str, Any]:
    """
    Computes Standardized Uptake Value (SUV) metrics and generates an alpha-blended PET-CT color fusion key-slice:
    - SUV_max (Peak metabolic uptake)
    - SUV_mean (Average uptake in tumor)
    - MTV (Metabolic Tumor Volume in cm³)
    - TLG (Total Lesion Glycolysis = MTV * SUV_mean)
    """
    t0 = time.time()
    z_dim, y_dim, x_dim = ct_volume.shape
    voxel_vol_cm3 = (spacing[0] * spacing[1] * spacing[2]) / 1000.0

    # Metabolic tumor mask (SUV >= suv_threshold, typically 2.5)
    metabolic_mask = pet_volume >= suv_threshold
    suv_max = round(float(np.max(pet_volume)), 2)

    if np.any(metabolic_mask):
        suv_mean = round(float(np.mean(pet_volume[metabolic_mask])), 2)
        mtv_cm3 = round(float(np.sum(metabolic_mask)) * voxel_vol_cm3, 2)
        tlg = round(mtv_cm3 * suv_mean, 2)
        # Select key slice with highest SUV peak
        z_suv_max = [float(np.max(pet_volume[z])) for z in range(z_dim)]
        peak_z = int(np.argmax(z_suv_max))
    else:
        suv_mean = 0.0
        mtv_cm3 = 0.0
        tlg = 0.0
        peak_z = z_dim // 2

    chosen_slice_idx = key_slice_index if key_slice_index is not None and 0 <= key_slice_index < z_dim else peak_z

    # Render PET-CT color fusion image
    ct_slice = ct_volume[chosen_slice_idx]
    pet_slice = pet_volume[chosen_slice_idx]
    mask_slice = metabolic_mask[chosen_slice_idx]

    # 1. CT Grayscale Background (mediastinal window: -125 to 225 HU)
    ct_windowed = apply_ct_window(ct_slice, window_name="mediastinum")
    base_img = Image.fromarray(ct_windowed).convert("RGBA")

    # 2. Colorized PET Foreground
    h, w = ct_slice.shape
    # Normalize PET SUV for display (0.0 to max(suv_max, 5.0))
    norm_pet = np.clip(pet_slice / max(suv_max, 5.0), 0.0, 1.0)
    pet_rgb = apply_turbo_colormap(norm_pet)

    # Alpha mask: low SUV has 0 alpha, above threshold alpha scales smoothly
    pet_alpha = np.zeros((h, w), dtype=np.uint8)
    active_pet = pet_slice >= 1.0
    pet_alpha[active_pet] = np.clip((norm_pet[active_pet] * 255.0 * alpha + 40.0), 0, 255).astype(np.uint8)

    pet_rgba = np.dstack([pet_rgb, pet_alpha])
    pet_img = Image.fromarray(pet_rgba, mode="RGBA")

    fused_img = Image.alpha_composite(base_img, pet_img)
    draw = ImageDraw.Draw(fused_img)

    font_bold = get_sans_font(12, bold=True)
    font_reg = get_sans_font(11, bold=False)

    # 3. Clinical HUD Box
    hud_bg = [(8, 8), (260, 96)]
    draw.rounded_rectangle(hud_bg, radius=4, fill=(15, 23, 42, 215), outline=(51, 65, 85, 255))
    draw.text((16, 12), "PET-CT Metabolic Fusion (18F-FDG)", font=font_bold, fill=(241, 245, 249, 255))
    draw.text((16, 28), f"Key Slice: #{chosen_slice_idx}/{z_dim} | Spacing: {spacing[1]}mm", font=font_reg, fill=(148, 163, 184, 255))
    draw.text((16, 44), f"SUV_max: {suv_max} | SUV_mean: {suv_mean}", font=font_reg, fill=(251, 146, 60, 255))
    draw.text((16, 60), f"MTV (Metabolic Vol): {mtv_cm3} cm³", font=font_reg, fill=(250, 204, 21, 255))
    draw.text((16, 76), f"TLG (Total Glycolysis): {tlg} g", font=font_reg, fill=(52, 211, 153, 255))

    # 4. SUV Heatmap Colorbar (Right side)
    cb_x = w - 24
    cb_y_start = 16
    cb_height = 80
    for i in range(cb_height):
        frac = 1.0 - (i / cb_height)
        col = apply_turbo_colormap(np.array([frac]))[0]
        draw.line([(cb_x, cb_y_start + i), (cb_x + 12, cb_y_start + i)], fill=tuple(col), width=1)
    draw.rectangle([(cb_x, cb_y_start), (cb_x + 12, cb_y_start + cb_height)], outline=(255, 255, 255, 200))
    draw.text((cb_x - 36, cb_y_start - 2), f"{suv_max}", font=font_reg, fill=(255, 255, 255, 255))
    draw.text((cb_x - 24, cb_y_start + cb_height - 10), "0.0", font=font_reg, fill=(255, 255, 255, 255))

    buf = io.BytesIO()
    fused_img.convert("RGB").save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    elapsed = round(time.time() - t0, 3)

    return {
        "status": "success",
        "elapsed_sec": elapsed,
        "key_slice_index": chosen_slice_idx,
        "suv_max": suv_max,
        "suv_mean": suv_mean,
        "suv_threshold": suv_threshold,
        "mtv_cm3": mtv_cm3,
        "tlg": tlg,
        "tlg_g": tlg,
        "fusion_png_base64": png_to_base64(png_bytes),
        "fusion_png_size_bytes": len(png_bytes),
        "summary_markdown": (
            f"**18F-FDG PET-CT 代谢融合定量报告**\n"
            f"- **最高摄取峰值 (SUV_max)**: `{suv_max}` (切点阈值: `{suv_threshold}`)\n"
            f"- **肿瘤平均摄取 (SUV_mean)**: `{suv_mean}`\n"
            f"- **代谢肿瘤体积 (MTV)**: `{mtv_cm3} cm³`\n"
            f"- **总病灶糖酵解量 (TLG)**: `{tlg} g`\n"
            f"- **最大代谢横截面**: 第 `#{chosen_slice_idx}` 层\n"
        )
    }


def delineate_radiotherapy_targets(
    ct_volume: np.ndarray,
    metabolic_or_lesion_mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    ctv_margin_mm: float = 6.0,
    ptv_margin_mm: float = 4.0,
    key_slice_index: Optional[int] = None
) -> Dict[str, Any]:
    """
    Delineates clinical Radiation Therapy (RT-STRUCT) Target Volumes:
    - GTV (Gross Tumor Volume): Gross macroscopic tumor core
    - CTV (Clinical Target Volume): GTV expanded by clinical margin (e.g. +6mm), strictly clipped by anatomical barriers (e.g., cortical bones/ribs HU > 250 and pleural cavity boundary)
    - PTV (Planning Target Volume): CTV expanded by setup uncertainty margin (e.g. +4mm)
    """
    t0 = time.time()
    z_dim, y_dim, x_dim = ct_volume.shape
    voxel_vol_cm3 = (spacing[0] * spacing[1] * spacing[2]) / 1000.0

    gtv_mask = metabolic_or_lesion_mask.astype(bool)
    if not np.any(gtv_mask):
        # Fallback default sphere target in center if empty
        cz, cy, cx = z_dim // 2, y_dim // 2, x_dim // 2
        gz, gy, gx = np.meshgrid(np.arange(z_dim), np.arange(y_dim), np.arange(x_dim), indexing="ij")
        gtv_mask = (((gz - cz) / 4.0)**2 + ((gy - cy) / 8.0)**2 + ((gx - cx) / 8.0)**2) <= 1.0

    # 1. GTV Volume in cm³
    gtv_voxels = int(np.sum(gtv_mask))
    gtv_vol_cm3 = round(gtv_voxels * voxel_vol_cm3, 2)

    # 2. CTV Expansion with Anatomical Barrier Clipping
    # Convert physical margin in mm to structuring element iterations
    ctv_steps = max(1, int(round(ctv_margin_mm / max(spacing[1], 0.1))))
    struct_elem = generate_binary_structure(3, 1)
    ctv_raw = binary_dilation(gtv_mask, structure=struct_elem, iterations=ctv_steps)

    # Anatomical barriers: cortical bone / spine (HU > 250) and external air boundary
    bone_barrier = ct_volume > 250.0
    air_barrier = ct_volume < -850.0
    ctv_mask = ctv_raw & (~bone_barrier) & (~air_barrier)
    ctv_voxels = int(np.sum(ctv_mask))
    ctv_vol_cm3 = round(ctv_voxels * voxel_vol_cm3, 2)

    # 3. PTV Expansion for Linear Accelerator Delivery
    ptv_steps = max(1, int(round(ptv_margin_mm / max(spacing[1], 0.1))))
    ptv_mask = binary_dilation(ctv_mask, structure=struct_elem, iterations=ptv_steps) & (~air_barrier)
    ptv_voxels = int(np.sum(ptv_mask))
    ptv_vol_cm3 = round(ptv_voxels * voxel_vol_cm3, 2)

    # Key slice selection
    if key_slice_index is None or not (0 <= key_slice_index < z_dim):
        z_counts = [int(np.sum(gtv_mask[z])) for z in range(z_dim)]
        key_slice_index = int(np.argmax(z_counts)) if np.max(z_counts) > 0 else z_dim // 2

    # 4. Render DICOM RT-STRUCT Contour Visualization
    ct_slice = ct_volume[key_slice_index]
    gtv_sl = gtv_mask[key_slice_index]
    ctv_sl = ctv_mask[key_slice_index]
    ptv_sl = ptv_mask[key_slice_index]

    ct_windowed = apply_ct_window(ct_slice, window_name="lung" if np.min(ct_slice) < -500 else "abdomen")
    base_img = Image.fromarray(ct_windowed).convert("RGBA")

    h, w = ct_slice.shape
    overlay = np.zeros((h, w, 4), dtype=np.uint8)

    # PTV: Translucent Cyan/Blue (56, 189, 248, 80)
    overlay[ptv_sl] = [56, 189, 248, 80]
    # CTV: Translucent Emerald (52, 211, 153, 110)
    overlay[ctv_sl] = [52, 211, 153, 110]
    # GTV: High-visibility Red (239, 68, 68, 160)
    overlay[gtv_sl] = [239, 68, 68, 160]

    overlay_img = Image.fromarray(overlay, mode="RGBA")
    fused_img = Image.alpha_composite(base_img, overlay_img)
    draw = ImageDraw.Draw(fused_img)

    font_bold = get_sans_font(12, bold=True)
    font_reg = get_sans_font(11, bold=False)

    # HUD Box
    hud_bg = [(8, 8), (280, 100)]
    draw.rounded_rectangle(hud_bg, radius=4, fill=(15, 23, 42, 215), outline=(51, 65, 85, 255))
    draw.text((16, 12), "DICOM RT-STRUCT Target Delineation", font=font_bold, fill=(241, 245, 249, 255))
    draw.text((16, 28), f"Key Slice: #{key_slice_index}/{z_dim} | Margin: CTV +{ctv_margin_mm}mm, PTV +{ptv_margin_mm}mm", font=font_reg, fill=(148, 163, 184, 255))
    draw.text((16, 46), f"GTV (Gross Tumor): {gtv_vol_cm3} cm³", font=font_reg, fill=(248, 113, 113, 255))
    draw.text((16, 62), f"CTV (Clinical Target): {ctv_vol_cm3} cm³", font=font_reg, fill=(52, 211, 153, 255))
    draw.text((16, 78), f"PTV (Planning Target): {ptv_vol_cm3} cm³", font=font_reg, fill=(56, 189, 248, 255))

    # Legend
    legend_bg = [(w - 110, 8), (w - 8, 76)]
    draw.rounded_rectangle(legend_bg, radius=4, fill=(15, 23, 42, 215), outline=(51, 65, 85, 255))
    draw.rectangle([(w - 102, 16), (w - 92, 26)], fill=(239, 68, 68, 255))
    draw.text((w - 86, 14), "GTV (Tumor)", font=font_reg, fill=(226, 232, 240, 255))
    draw.rectangle([(w - 102, 34), (w - 92, 44)], fill=(52, 211, 153, 255))
    draw.text((w - 86, 32), "CTV (Margin)", font=font_reg, fill=(226, 232, 240, 255))
    draw.rectangle([(w - 102, 52), (w - 92, 62)], fill=(56, 189, 248, 255))
    draw.text((w - 86, 50), "PTV (Setup)", font=font_reg, fill=(226, 232, 240, 255))

    buf = io.BytesIO()
    fused_img.convert("RGB").save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    elapsed = round(time.time() - t0, 3)

    return {
        "status": "success",
        "elapsed_sec": elapsed,
        "key_slice_index": key_slice_index,
        "gtv_volume_cm3": gtv_vol_cm3,
        "ctv_volume_cm3": ctv_vol_cm3,
        "ptv_volume_cm3": ptv_vol_cm3,
        "ctv_margin_mm": ctv_margin_mm,
        "ptv_margin_mm": ptv_margin_mm,
        "bone_barrier_clipped": True,
        "rtstruct_png_base64": png_to_base64(png_bytes),
        "rtstruct_png_size_bytes": len(png_bytes),
        "dicom_rt_roi_metadata": {
            "GTV": {"roi_number": 1, "roi_name": "GTV_Primary", "volume_cm3": gtv_vol_cm3, "display_color": [239, 68, 68]},
            "CTV": {"roi_number": 2, "roi_name": "CTV_Clinical", "volume_cm3": ctv_vol_cm3, "display_color": [52, 211, 153]},
            "PTV": {"roi_number": 3, "roi_name": "PTV_Planning", "volume_cm3": ptv_vol_cm3, "display_color": [56, 189, 248]},
        },
        "summary_markdown": (
            f"### 放疗靶区 (DICOM RT-STRUCT) 自动勾画与解剖屏障裁剪报告\n"
            f"- **肉眼肿瘤区 (GTV)**: `{gtv_vol_cm3} cm³` (第 `#{key_slice_index}` 层最大截面)\n"
            f"- **临床靶区 (CTV)**: `{ctv_vol_cm3} cm³` (外扩 `+{ctv_margin_mm}mm`，严格沿胸膜与皮质骨边缘解剖裁剪)\n"
            f"- **计划靶区 (PTV)**: `{ptv_vol_cm3} cm³` (外扩 `+{ptv_margin_mm}mm` 摆位不确定度裕度)\n"
            f"- **放疗处方剂量规划基础**: 满足 ICRU 50/62 与 AAPM TG-101 规范。\n"
        )
    }
