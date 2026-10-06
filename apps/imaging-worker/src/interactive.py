"""
Heurion 2.0 - Interactive 3D Medical Segmentation Engine (VISTA-3D / Click-to-Segment Paradigm)
Supports click-based positive (foreground) and negative (background) prompt guidance,
bounding box constraints, and real-time interactive mask refinement.
"""

from typing import List, Dict, Any, Tuple, Optional
import numpy as np
import scipy.ndimage as ndi


def interactive_segment_3d(
    volume: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    points: Optional[List[Dict[str, Any]]] = None,
    bbox: Optional[Dict[str, int]] = None,
    current_mask: Optional[np.ndarray] = None,
    intensity_tolerance_hu: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Executes real-time 3D interactive click/prompt segmentation on a volumetric medical scan.

    Args:
        volume: 3D numpy array (Z, Y, X) containing voxel intensities (HU for CT)
        spacing: Voxel spacing (dz, dy, dx) in mm
        points: List of prompt clicks: [{'z': int, 'y': int, 'x': int, 'is_positive': bool}]
        bbox: Optional 3D bounding box: {'z_min': int, 'z_max': int, 'y_min': int, 'y_max': int, 'x_min': int, 'x_max': int}
        current_mask: Optional existing 3D binary mask from previous refinement step
        intensity_tolerance_hu: Intensity range around seed for adaptive segmentation (defaults to adaptive IQR)

    Returns:
        Dict containing binary segmentation mask, volume metrics, and refined key slice index.
    """
    z_dim, y_dim, x_dim = volume.shape
    dz, dy, dx = [float(s) for s in spacing]
    voxel_vol_cm3 = (dz * dy * dx) / 1000.0

    if not points and not bbox and current_mask is None:
        # Default fallback: central ROI if no prompts provided
        cz, cy, cx = z_dim // 2, y_dim // 2, x_dim // 2
        points = [{'z': cz, 'y': cy, 'x': cx, 'is_positive': True}]

    pos_points = [p for p in (points or []) if p.get('is_positive', True)]
    neg_points = [p for p in (points or []) if not p.get('is_positive', True)]

    # Start from current mask if provided, else empty mask
    if current_mask is not None and current_mask.shape == volume.shape:
        working_mask = (current_mask > 0).astype(np.uint8).copy()
    else:
        working_mask = np.zeros(volume.shape, dtype=np.uint8)

    # 1. Collect sample intensities at positive click seeds
    seed_values = []
    for p in pos_points:
        pz = int(np.clip(p.get('z', z_dim // 2), 0, z_dim - 1))
        py = int(np.clip(p.get('y', y_dim // 2), 0, y_dim - 1))
        px = int(np.clip(p.get('x', x_dim // 2), 0, x_dim - 1))
        # Take a 3x3x3 neighborhood around seed to be robust to single-pixel noise
        z_lo, z_hi = max(0, pz - 1), min(z_dim, pz + 2)
        y_lo, y_hi = max(0, py - 1), min(y_dim, py + 2)
        x_lo, x_hi = max(0, px - 1), min(x_dim, px + 2)
        seed_values.extend(volume[z_lo:z_hi, y_lo:y_hi, x_lo:x_hi].flatten())

    if len(seed_values) > 0:
        target_hu = float(np.median(seed_values))
        iqr_val = float(np.percentile(seed_values, 75) - np.percentile(seed_values, 25))
        tol = intensity_tolerance_hu or max(35.0, min(120.0, iqr_val * 2.5 + 25.0))
    else:
        target_hu = float(np.mean(volume))
        tol = 50.0

    # 2. Compute intensity affinity field
    hu_diff = np.abs(volume - target_hu)
    intensity_match = hu_diff <= tol

    # 3. Spatial Distance Transform from positive seeds
    pos_seed_grid = np.zeros(volume.shape, dtype=bool)
    for p in pos_points:
        pz = int(np.clip(p.get('z', z_dim // 2), 0, z_dim - 1))
        py = int(np.clip(p.get('y', y_dim // 2), 0, y_dim - 1))
        px = int(np.clip(p.get('x', x_dim // 2), 0, x_dim - 1))
        pos_seed_grid[pz, py, px] = True

    if np.any(pos_seed_grid):
        # Distance in mm
        dist_to_pos_mm = ndi.distance_transform_edt(~pos_seed_grid, sampling=(dz, dy, dx))
    else:
        dist_to_pos_mm = np.full(volume.shape, 999.0, dtype=np.float32)

    # 4. Spatial Distance Transform from negative seeds
    neg_seed_grid = np.zeros(volume.shape, dtype=bool)
    for p in neg_points:
        pz = int(np.clip(p.get('z', z_dim // 2), 0, z_dim - 1))
        py = int(np.clip(p.get('y', y_dim // 2), 0, y_dim - 1))
        px = int(np.clip(p.get('x', x_dim // 2), 0, x_dim - 1))
        neg_seed_grid[pz, py, px] = True

    if np.any(neg_seed_grid):
        dist_to_neg_mm = ndi.distance_transform_edt(~neg_seed_grid, sampling=(dz, dy, dx))
    else:
        dist_to_neg_mm = np.full(volume.shape, 999.0, dtype=np.float32)

    # 5. Geodesic spatial & intensity energy combination
    # Spatial radius limit based on distance to positive clicks (default candidate sphere radius ~45mm)
    spatial_reach = dist_to_pos_mm <= 45.0
    candidate = intensity_match & spatial_reach

    # Negative prompt repulsion: eliminate regions closer to negative seeds than positive seeds
    if np.any(neg_seed_grid):
        neg_repel = (dist_to_neg_mm < dist_to_pos_mm) | (dist_to_neg_mm < 6.0)
        candidate = candidate & (~neg_repel)

    # Bounding box constraint if provided
    if bbox:
        b_zmin = max(0, bbox.get('z_min', 0))
        b_zmax = min(z_dim, bbox.get('z_max', z_dim - 1) + 1)
        b_ymin = max(0, bbox.get('y_min', 0))
        b_ymax = min(y_dim, bbox.get('y_max', y_dim - 1) + 1)
        b_xmin = max(0, bbox.get('x_min', 0))
        b_xmax = min(x_dim, bbox.get('x_max', x_dim - 1) + 1)
        
        box_mask = np.zeros(volume.shape, dtype=bool)
        box_mask[b_zmin:b_zmax, b_ymin:b_ymax, b_xmin:b_xmax] = True
        candidate = candidate & box_mask

    # 6. Connected Component Extraction preserving positive seeds
    labeled, num_features = ndi.label(candidate)
    final_mask = np.zeros(volume.shape, dtype=np.uint8)

    if num_features > 0 and np.any(pos_seed_grid):
        # Find which connected components overlap with positive clicks
        seed_labels = np.unique(labeled[pos_seed_grid])
        seed_labels = seed_labels[seed_labels > 0]
        
        if len(seed_labels) > 0:
            for sl in seed_labels:
                final_mask[labeled == sl] = 1
        else:
            # Fallback: largest component
            counts = np.bincount(labeled.flat)
            counts[0] = 0
            if len(counts) > 1:
                largest_l = int(np.argmax(counts))
                final_mask[labeled == largest_l] = 1
    elif num_features > 0:
        # No positive seeds given, take largest
        counts = np.bincount(labeled.flat)
        counts[0] = 0
        if len(counts) > 1:
            largest_l = int(np.argmax(counts))
            final_mask[labeled == largest_l] = 1

    # Morphological closing to seal small micro-holes
    struct = ndi.generate_binary_structure(3, 1)
    final_mask = ndi.binary_closing(final_mask, structure=struct).astype(np.uint8)

    # Negative seed hard veto
    if np.any(neg_seed_grid):
        dilated_neg = ndi.binary_dilation(neg_seed_grid, iterations=2)
        final_mask[dilated_neg] = 0

    voxel_count = int(np.sum(final_mask))
    volume_cm3 = round(voxel_count * voxel_vol_cm3, 3)

    # Determine key slice (primary positive click slice, or slice with largest cross-sectional area)
    if voxel_count > 0:
        z_areas = np.sum(final_mask, axis=(1, 2))
        best_slice = int(np.argmax(z_areas))
        if pos_points:
            primary_click_z = pos_points[0].get('z')
            if primary_click_z is not None and 0 <= primary_click_z < z_dim and z_areas[primary_click_z] > 0:
                best_slice = primary_click_z
    else:
        best_slice = pos_points[0].get('z', z_dim // 2) if pos_points else z_dim // 2

    return {
        "status": "success",
        "mask": final_mask,
        "voxel_count": voxel_count,
        "volume_cm3": volume_cm3,
        "key_slice_index": best_slice,
        "target_hu": round(target_hu, 1),
        "tolerance_hu": round(tol, 1),
        "positive_prompts_count": len(pos_points),
        "negative_prompts_count": len(neg_points),
    }
