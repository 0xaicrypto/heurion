import os
import glob
import numpy as np
from typing import Dict, Any, Tuple, Optional

# Clinical CT Windows (Center / Width)
CT_WINDOWS = {
    "abdomen": {"level": 40, "width": 400},
    "mediastinum": {"level": 40, "width": 350},
    "lung": {"level": -600, "width": 1500},
    "bone": {"level": 400, "width": 1800},
    "brain": {"level": 40, "width": 80},
}

def apply_ct_window(volume: np.ndarray, window_name: str = "abdomen") -> np.ndarray:
    """
    Applies Hounsfield Unit (HU) windowing to CT volume, scaling to [0, 255] uint8.
    """
    win = CT_WINDOWS.get(window_name, CT_WINDOWS["abdomen"])
    level = win["level"]
    width = win["width"]
    lower = level - width / 2.0
    upper = level + width / 2.0
    clipped = np.clip(volume, lower, upper)
    normalized = ((clipped - lower) / (upper - lower) * 255.0).astype(np.uint8)
    return normalized

def scrub_dicom_metadata(metadata: Dict[str, Any], anonymous_id: str) -> Dict[str, Any]:
    """
    Removes Protected Health Information (PHI) from DICOM headers.
    """
    phi_keys = [
        "PatientName", "PatientID", "PatientBirthDate", "PatientAddress",
        "InstitutionName", "InstitutionalDepartmentName", "ReferringPhysicianName",
        "PerformingPhysicianName", "OperatorsName", "AccessionNumber", "OtherPatientIDs"
    ]
    scrubbed = dict(metadata)
    for k in phi_keys:
        if k in scrubbed:
            scrubbed.pop(k, None)
    
    scrubbed["PatientID"] = f"ANON-{anonymous_id}"
    scrubbed["PatientName"] = f"Subject^{anonymous_id}"
    scrubbed["InstitutionName"] = "Heurion Research Anonymized Center"
    return scrubbed

def load_nifti(path: str) -> Tuple[np.ndarray, Tuple[float, float, float]]:
    """
    Loads a NIfTI volume (.nii or .nii.gz) returning canonical (Z, Y, X) array and (dz, dy, dx) voxel spacing.
    """
    import nibabel as nib
    nimg = nib.load(path)
    data = nimg.get_fdata(dtype=np.float32)
    if data.ndim == 4:
        data = data[..., 0]
    header = nimg.header
    zooms = header.get_zooms()[:3]
    # NIfTI is typically (X, Y, Z); transpose to (Z, Y, X) for axial slice processing
    vol_zyx = np.transpose(data, (2, 1, 0))
    spacing_zyx = (float(zooms[2]), float(zooms[1]), float(zooms[0]))
    return vol_zyx, spacing_zyx

def load_dicom_series(folder_path: str) -> Tuple[np.ndarray, Tuple[float, float, float], Dict[str, Any]]:
    """
    Reads a folder of DICOM slices, sorts them by spatial position, and returns (Z, Y, X) volume and spacing.
    """
    import pydicom
    files = glob.glob(os.path.join(folder_path, "*.dcm"))
    if not files:
        files = [os.path.join(folder_path, f) for f in os.listdir(folder_path) if os.path.isfile(os.path.join(folder_path, f))]
    
    slices = []
    for f in files:
        try:
            ds = pydicom.dcmread(f, force=True)
            if hasattr(ds, "pixel_array"):
                slices.append(ds)
        except Exception:
            continue
            
    if not slices:
        raise ValueError(f"No valid DICOM slices found in {folder_path}")
        
    # Sort slices by ImagePositionPatient Z coordinate or InstanceNumber
    try:
        slices.sort(key=lambda s: float(s.ImagePositionPatient[2]))
    except Exception:
        slices.sort(key=lambda s: getattr(s, "InstanceNumber", 0))
        
    # Extract spacing
    first = slices[0]
    pixel_spacing = getattr(first, "PixelSpacing", [1.0, 1.0])
    slice_thickness = getattr(first, "SliceThickness", 1.0)
    spacing = (float(slice_thickness), float(pixel_spacing[0]), float(pixel_spacing[1]))
    
    # Rescale slope and intercept for CT HU
    slope = getattr(first, "RescaleSlope", 1.0)
    intercept = getattr(first, "RescaleIntercept", 0.0)
    
    vol = np.stack([s.pixel_array.astype(np.float32) * float(slope) + float(intercept) for s in slices], axis=0)
    meta = {
        "modality": getattr(first, "Modality", "CT"),
        "slices_count": len(slices),
        "rows": first.Rows,
        "cols": first.Columns,
    }
    return vol, spacing, scrub_dicom_metadata(meta, "ANON-STUDY")
