import io
import os
import base64
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from typing import Dict, Any, Optional, List

try:
    from .font_utils import get_cjk_font, get_sans_font, sanitize_text
except (ImportError, ValueError):
    from font_utils import get_cjk_font, get_sans_font, sanitize_text

def render_key_slice_png(
    ct_slice_uint8: np.ndarray,
    mask_slice_2d: np.ndarray,
    recist: Dict[str, Any],
    modality: str = "CT",
    lesion_name: str = "Target Lesion",
    scale_bar_mm: float = 50.0, # 5cm scale bar
    pixel_spacing_mm: float = 0.8,
    prompt_points: Optional[list] = None
) -> bytes:
    """
    Renders a publication-ready radiological key-slice image with contour mask overlay,
    RECIST measurement caliper, prompt click markers, diagnostic HUD overlay, and clinical scale bar.
    """
    h, w = ct_slice_uint8.shape
    
    # 1. Base grayscale image converted to RGBA
    base_img = Image.fromarray(ct_slice_uint8).convert("RGBA")
    
    # 2. Semi-transparent mask overlay (Coral Red #FF4D4F with alpha 110)
    mask_bool = mask_slice_2d > 0
    if np.any(mask_bool):
        mask_rgba = np.zeros((h, w, 4), dtype=np.uint8)
        mask_rgba[mask_bool] = [255, 77, 79, 110]
        mask_img = Image.fromarray(mask_rgba, mode="RGBA")
        base_img = Image.alpha_composite(base_img, mask_img)
    
    # 3. Fonts and text sanitization
    font_hud_title = get_sans_font(size=12 if h >= 400 else 10, bold=True)
    font_hud, supports_cjk = get_cjk_font(size=11 if h >= 400 else 9)
    font_caliper, _ = get_cjk_font(size=11 if h >= 400 else 9)
    font_scale = get_sans_font(size=10, bold=True)

    # 4. Diagnostic HUD banner (top left)
    key_slice = recist.get("key_slice_index", 0)
    vol = recist.get("total_volume_cm3", 0.0)
    ld = recist.get("longest_diameter_mm", 0.0)
    ctr = recist.get("consolidation_tumor_ratio")
    rads = recist.get("lung_rads")
    
    clean_lesion_name = sanitize_text(lesion_name, supports_cjk)
    hud_lines = [
        "HEURION IMAGING // MONAI 3D",
        f"Modality: {modality} | Slice: #{key_slice}",
        f"Target: {clean_lesion_name}",
    ]
    if ctr is not None and recist.get("solid_core_diameter_mm", 0.0) > 0:
        solid_ld = recist.get("solid_core_diameter_mm", 0.0)
        hud_lines.append(f"RECIST LD: {ld} mm | Solid: {solid_ld} mm (CTR: {int(ctr*100)}%)")
    else:
        hud_lines.append(f"RECIST LD: {ld} mm | Vol: {vol} cm3")
    
    if rads and isinstance(rads, dict):
        rads_name = sanitize_text(rads.get('name', ''), supports_cjk)
        hud_lines.append(f"ACR Lung-RADS: {rads_name}")

    qc = recist.get("quality_control")
    if qc and isinstance(qc, dict):
        slice_th = qc.get("slice_thickness_mm")
        if qc.get("tier") == "thick_slice_warning":
            hud_lines.append(f"QC ALERT: Slice {slice_th} mm (Thick - Recommend HRCT)")
        elif slice_th:
            hud_lines.append(f"Scan QC: Slice {slice_th} mm ({'HRCT' if qc.get('is_thin_slice') else 'Standard'})")

    hud_box_w = min(360, w - 20)
    hud_box_h = 16 + len(hud_lines) * 16
    hud_overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    hud_draw = ImageDraw.Draw(hud_overlay)
    hud_draw.rounded_rectangle([8, 8, 8 + hud_box_w, 8 + hud_box_h], radius=4, fill=(15, 23, 42, 215), outline=(51, 65, 85, 220))
    base_img = Image.alpha_composite(base_img, hud_overlay)

    draw = ImageDraw.Draw(base_img)

    # Draw HUD text
    y_offset = 14
    for idx, line in enumerate(hud_lines):
        clean_line = sanitize_text(line, supports_cjk)
        f = font_hud_title if idx == 0 else font_hud
        col = (56, 189, 248, 255) if idx == 0 else (230, 235, 245, 240)
        draw.text((16, y_offset), clean_line, fill=col, font=f)
        y_offset += 16

    # Draw interactive prompt points on current slice
    if prompt_points:
        for pt in prompt_points:
            pz = pt.get("z", key_slice)
            if pz == key_slice or abs(pz - key_slice) <= 1:
                px = int(pt.get("x", 0))
                py = int(pt.get("y", 0))
                is_pos = pt.get("is_positive", True)
                color = (52, 211, 153, 255) if is_pos else (248, 113, 113, 255)
                r = 5
                draw.ellipse([(px - r, py - r), (px + r, py + r)], outline=color, width=2)
                if is_pos:
                    draw.line([(px - 3, py), (px + 3, py)], fill=color, width=2)
                    draw.line([(px, py - 3), (px, py + 3)], fill=color, width=2)
                else:
                    draw.line([(px - 3, py - 3), (px + 3, py + 3)], fill=color, width=2)
                    draw.line([(px - 3, py + 3), (px + 3, py - 3)], fill=color, width=2)
    
    # Caliper line if RECIST points are present
    caliper = recist.get("caliper_longest")
    if caliper and "p1" in caliper and "p2" in caliper:
        p1 = tuple(caliper["p1"])
        p2 = tuple(caliper["p2"])
        length_mm = caliper.get("length_mm", 0.0)
        
        # Draw high-visibility cyan caliper line
        draw.line([p1, p2], fill=(0, 220, 255, 255), width=2)
        
        # End caps (perpendicular ticks)
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        dist = np.hypot(dx, dy)
        if dist > 0:
            nx = -dy / dist * 5
            ny = dx / dist * 5
            draw.line([(p1[0] - nx, p1[1] - ny), (p1[0] + nx, p1[1] + ny)], fill=(0, 220, 255, 255), width=2)
            draw.line([(p2[0] - nx, p2[1] - ny), (p2[0] + nx, p2[1] + ny)], fill=(0, 220, 255, 255), width=2)
            
            # Midpoint text
            mx = int((p1[0] + p2[0]) / 2)
            my = int((p1[1] + p2[1]) / 2) - 16
            label = f"Total LD: {length_mm} mm"
            draw.text((mx, my), label, fill=(0, 240, 255, 255), font=font_caliper)

    # Inner solid core caliper if subsolid nodule
    solid_caliper = recist.get("solid_core_caliper")
    solid_ld = recist.get("solid_core_diameter_mm", 0.0)
    if solid_caliper and "p1" in solid_caliper and "p2" in solid_caliper and solid_ld > 0:
        sp1 = tuple(solid_caliper["p1"])
        sp2 = tuple(solid_caliper["p2"])
        draw.line([sp1, sp2], fill=(251, 146, 60, 255), width=2)
        sdx = sp2[0] - sp1[0]
        sdy = sp2[1] - sp1[1]
        sdist = np.hypot(sdx, sdy)
        if sdist > 0:
            snx = -sdy / sdist * 4
            sny = sdx / sdist * 4
            draw.line([(sp1[0] - snx, sp1[1] - sny), (sp1[0] + snx, sp1[1] + sny)], fill=(251, 146, 60, 255), width=2)
            draw.line([(sp2[0] - snx, sp2[1] - sny), (sp2[0] + snx, sp2[1] + sny)], fill=(251, 146, 60, 255), width=2)
            smx = int((sp1[0] + sp2[0]) / 2)
            smy = int((sp1[1] + sp2[1]) / 2) + 6
            draw.text((smx, smy), f"Solid: {solid_ld} mm", fill=(253, 186, 116, 255), font=font_caliper)

    # Scale bar (lower right corner)
    scale_px = int(scale_bar_mm / max(pixel_spacing_mm, 0.01))
    margin_x = w - scale_px - 20
    margin_y = h - 25
    draw.line([(margin_x, margin_y), (margin_x + scale_px, margin_y)], fill=(255, 255, 255, 220), width=3)
    draw.text((margin_x, margin_y - 15), f"{int(scale_bar_mm / 10)} cm", fill=(255, 255, 255, 220), font=font_scale)

    # Export to PNG buffer
    buf = io.BytesIO()
    base_img.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()

def png_to_base64(png_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
