import io
import base64
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from typing import Dict, Any, Optional

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
    
    # 1. Base grayscale image converted to RGB
    base_img = Image.fromarray(ct_slice_uint8).convert("RGBA")
    
    # 2. Semi-transparent mask overlay (Red #FF4D4F with alpha 100)
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    
    mask_bool = mask_slice_2d > 0
    if np.any(mask_bool):
        # Color: Coral Red with 40% opacity
        mask_rgba = np.zeros((h, w, 4), dtype=np.uint8)
        mask_rgba[mask_bool] = [255, 77, 79, 110]
        mask_img = Image.fromarray(mask_rgba, mode="RGBA")
        base_img = Image.alpha_composite(base_img, mask_img)
    
    # 3. Draw calipers, prompt clicks & HUD on a clean overlay
    draw = ImageDraw.Draw(base_img)

    # Draw interactive prompt points on current slice
    if prompt_points:
        key_slice_idx = recist.get("key_slice_index", 0)
        for pt in prompt_points:
            pz = pt.get("z", key_slice_idx)
            if pz == key_slice_idx or abs(pz - key_slice_idx) <= 1:
                px = int(pt.get("x", 0))
                py = int(pt.get("y", 0))
                is_pos = pt.get("is_positive", True)
                color = (52, 211, 153, 255) if is_pos else (248, 113, 113, 255) # emerald vs rose
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
            my = int((p1[1] + p2[1]) / 2) - 15
            label = f"Total LD: {length_mm} mm"
            draw.text((mx, my), label, fill=(0, 240, 255, 255))

    # Inner solid core caliper if subsolid nodule
    solid_caliper = recist.get("solid_core_caliper")
    solid_ld = recist.get("solid_core_diameter_mm", 0.0)
    if solid_caliper and "p1" in solid_caliper and "p2" in solid_caliper and solid_ld > 0:
        sp1 = tuple(solid_caliper["p1"])
        sp2 = tuple(solid_caliper["p2"])
        # High-visibility Amber / Orange line
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
            draw.text((smx, smy), f"Solid: {solid_ld} mm", fill=(253, 186, 116, 255))

    # 4. Scale bar (lower right corner)
    scale_px = int(scale_bar_mm / pixel_spacing_mm)
    margin_x = w - scale_px - 20
    margin_y = h - 25
    draw.line([(margin_x, margin_y), (margin_x + scale_px, margin_y)], fill=(255, 255, 255, 220), width=3)
    draw.text((margin_x, margin_y - 15), f"{int(scale_bar_mm / 10)} cm", fill=(255, 255, 255, 220))

    # 5. Diagnostic HUD (top left)
    key_slice = recist.get("key_slice_index", 0)
    vol = recist.get("total_volume_cm3", 0.0)
    ld = recist.get("longest_diameter_mm", 0.0)
    ctr = recist.get("consolidation_tumor_ratio")
    rads = recist.get("lung_rads")
    
    hud_lines = [
        f"HEURION IMAGING // MONAI 3D",
        f"Modality: {modality} | Slice: #{key_slice}",
        f"Target: {lesion_name}",
    ]
    if ctr is not None and solid_ld > 0:
        hud_lines.append(f"RECIST LD: {ld} mm | Solid: {solid_ld} mm (CTR: {int(ctr*100)}%)")
    else:
        hud_lines.append(f"RECIST LD: {ld} mm | Vol: {vol} cm³")
    
    if rads and isinstance(rads, dict):
        hud_lines.append(f"ACR Lung-RADS: {rads.get('name', '')}")

    qc = recist.get("quality_control")
    if qc and isinstance(qc, dict):
        slice_th = qc.get("slice_thickness_mm")
        if qc.get("tier") == "thick_slice_warning":
            hud_lines.append(f"QC ALERT: Slice {slice_th} mm (Thick - Recommend HRCT)")
        elif slice_th:
            hud_lines.append(f"Scan QC: Slice {slice_th} mm ({'HRCT' if qc.get('is_thin_slice') else 'Standard'})")
    
    y_offset = 12
    for line in hud_lines:
        draw.text((14, y_offset), line, fill=(230, 235, 245, 240))
        y_offset += 16

    # Export to PNG buffer
    buf = io.BytesIO()
    base_img.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()

def png_to_base64(png_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
