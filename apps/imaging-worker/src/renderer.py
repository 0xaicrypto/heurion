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
    pixel_spacing_mm: float = 0.8
) -> bytes:
    """
    Renders a publication-ready radiological key-slice image with contour mask overlay,
    RECIST measurement caliper, diagnostic HUD overlay, and clinical scale bar.
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
    
    # 3. Draw calipers & HUD on a clean overlay
    draw = ImageDraw.Draw(base_img)
    
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
            label = f"LD: {length_mm} mm"
            draw.text((mx, my), label, fill=(0, 240, 255, 255))

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
    
    hud_lines = [
        f"HEURION IMAGING // MONAI 3D",
        f"Modality: {modality} | Slice: #{key_slice}",
        f"Target: {lesion_name}",
        f"RECIST LD: {ld} mm | Vol: {vol} cm³"
    ]
    
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
