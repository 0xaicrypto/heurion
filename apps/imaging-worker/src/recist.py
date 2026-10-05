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
    else:
        short_axis_mm = 0.0

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
        "has_lesion": True
    }
