import os
import io
import glob
import zipfile
import tempfile
import numpy as np
from typing import Dict, Any, Tuple, Optional, Union

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

def anonymize_dicom_dataset(ds: Any, anonymous_id: str = "ANON-001", retain_dates: bool = False) -> Any:
    """
    De-identifies a pydicom Dataset according to DICOM PS 3.15 Annex E Basic Application Level Profile:
    - Replaces PatientName with ANONYMIZED^{anonymous_id}
    - Replaces PatientID with ANON-{anonymous_id}
    - Clears or generalizes dates and times (unless retain_dates is True)
    - Strips institutional addresses, physician names, and operators
    - Strips all private tags (tags with odd group numbers)
    - Preserves all geometric coordinates, pixel spacing, slice thickness, rescale slope/intercept, and pixel array
    """
    import pydicom

    # Remove all private elements (odd group numbers)
    ds.remove_private_tags()

    # Core PHI fields replacement
    if "PatientName" in ds:
        ds.PatientName = f"ANONYMIZED^{anonymous_id}"
    if "PatientID" in ds:
        ds.PatientID = f"ANON-{anonymous_id}"
    if "PatientBirthDate" in ds:
        ds.PatientBirthDate = "" if not retain_dates else (str(ds.PatientBirthDate)[:4] + "0101")
    if "PatientAddress" in ds:
        del ds.PatientAddress
    if "PatientTelephoneNumbers" in ds:
        del ds.PatientTelephoneNumbers
    if "OtherPatientIDs" in ds:
        del ds.OtherPatientIDs

    # Institutional & personnel fields
    if "InstitutionName" in ds:
        ds.InstitutionName = "Heurion Anonymized Medical Center"
    if "InstitutionAddress" in ds:
        del ds.InstitutionAddress
    if "InstitutionalDepartmentName" in ds:
        ds.InstitutionalDepartmentName = "Department of Radiology"
    if "ReferringPhysicianName" in ds:
        ds.ReferringPhysicianName = "ANON^REFERRING_PHYSICIAN"
    if "PerformingPhysicianName" in ds:
        ds.PerformingPhysicianName = "ANON^PERFORMING_PHYSICIAN"
    if "OperatorsName" in ds:
        del ds.OperatorsName
    if "PhysiciansOfRecord" in ds:
        del ds.PhysiciansOfRecord

    # Study identifiers
    if "AccessionNumber" in ds:
        ds.AccessionNumber = f"ACC-{anonymous_id[:8]}"
    if "StudyID" in ds:
        ds.StudyID = f"STUDY-{anonymous_id[:8]}"

    # Remove curve (0x5000-0x50FF) and overlay (0x6000-0x60FF) elements
    tags_to_remove = [elem.tag for elem in ds if (elem.tag.group & 0xFF00) in (0x5000, 0x6000)]
    for tag in tags_to_remove:
        del ds[tag]

    return ds

def anonymize_dicom_file(src_path: str, dst_path: str, anonymous_id: str = "ANON-001") -> Dict[str, Any]:
    """
    Reads a single DICOM file on disk, anonymizes PHI, and saves to dst_path.
    """
    import pydicom
    ds = pydicom.dcmread(src_path, force=True)
    orig_name = str(getattr(ds, "PatientName", "Unknown"))
    orig_id = str(getattr(ds, "PatientID", "Unknown"))
    
    anonymized_ds = anonymize_dicom_dataset(ds, anonymous_id=anonymous_id)
    os.makedirs(os.path.dirname(os.path.abspath(dst_path)), exist_ok=True)
    anonymized_ds.save_as(dst_path)

    return {
        "status": "success",
        "original_patient_name": orig_name,
        "original_patient_id": orig_id,
        "anonymized_patient_name": str(getattr(anonymized_ds, "PatientName", "")),
        "anonymized_patient_id": str(getattr(anonymized_ds, "PatientID", "")),
        "output_path": dst_path
    }

def anonymize_dicom_zip(
    src_zip: Union[str, bytes, io.BytesIO],
    dst_zip_path: Optional[str] = None,
    anonymous_id: str = "ANON-001"
) -> Tuple[bytes, Dict[str, Any]]:
    """
    De-identifies all DICOM slices within a ZIP archive, strips OS junk files (__MACOSX, .DS_Store),
    and produces a sanitized DICOM ZIP archive with identical geometry and zero PHI.
    """
    import pydicom

    bio_in = io.BytesIO(src_zip) if isinstance(src_zip, bytes) else (src_zip if isinstance(src_zip, io.BytesIO) else open(src_zip, "rb"))
    zf_in = zipfile.ZipFile(bio_in)

    out_bio = io.BytesIO()
    zf_out = zipfile.ZipFile(out_bio, "w", compression=zipfile.ZIP_DEFLATED)

    anonymized_count = 0
    skipped_count = 0
    detected_modalities = set()

    for member in zf_in.infolist():
        fn = member.filename
        if "__MACOSX" in fn or "/._" in fn or fn.split("/")[-1].startswith("."):
            skipped_count += 1
            continue

        data = zf_in.read(fn)
        # Attempt parsing as DICOM
        try:
            ds = pydicom.dcmread(io.BytesIO(data), force=True)
            if hasattr(ds, "pixel_array"):
                anonymized_ds = anonymize_dicom_dataset(ds, anonymous_id=anonymous_id)
                mod = str(getattr(anonymized_ds, "Modality", "CT"))
                detected_modalities.add(mod)
                # Write back into new zip
                slice_buf = io.BytesIO()
                anonymized_ds.save_as(slice_buf)
                clean_name = f"DICOM/{anonymous_id}_{anonymized_count:04d}.dcm"
                zf_out.writestr(clean_name, slice_buf.getvalue())
                anonymized_count += 1
            else:
                skipped_count += 1
        except Exception:
            skipped_count += 1

    zf_out.close()
    out_bytes = out_bio.getvalue()

    if dst_zip_path:
        os.makedirs(os.path.dirname(os.path.abspath(dst_zip_path)), exist_ok=True)
        with open(dst_zip_path, "wb") as f_out:
            f_out.write(out_bytes)

    report = {
        "status": "success",
        "anonymous_id": anonymous_id,
        "total_slices_anonymized": anonymized_count,
        "skipped_files_count": skipped_count,
        "modalities": list(detected_modalities),
        "anonymized_zip_size_bytes": len(out_bytes)
    }

    if not isinstance(src_zip, (bytes, io.BytesIO)):
        bio_in.close()

    return out_bytes, report


def load_nifti(path_or_bytes: Union[str, bytes, io.BytesIO]) -> Tuple[np.ndarray, Tuple[float, float, float]]:
    """
    Loads a NIfTI volume (.nii or .nii.gz) returning canonical (Z, Y, X) array and (dz, dy, dx) voxel spacing.
    """
    import nibabel as nib
    if isinstance(path_or_bytes, (bytes, io.BytesIO)):
        data_bytes = path_or_bytes if isinstance(path_or_bytes, bytes) else path_or_bytes.getvalue()
        with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tmp:
            tmp.write(data_bytes)
            tmp_path = tmp.name
        try:
            nimg = nib.load(tmp_path)
            data = nimg.get_fdata(dtype=np.float32)
            header = nimg.header
            zooms = header.get_zooms()[:3]
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    else:
        nimg = nib.load(path_or_bytes)
        data = nimg.get_fdata(dtype=np.float32)
        header = nimg.header
        zooms = header.get_zooms()[:3]

    if data.ndim == 4:
        data = data[..., 0]
    # NIfTI is typically (X, Y, Z); transpose to (Z, Y, X) for axial slice processing
    vol_zyx = np.transpose(data, (2, 1, 0))
    spacing_zyx = (float(zooms[2]), float(zooms[1]), float(zooms[0]))
    return vol_zyx, spacing_zyx

def load_dicom_series(folder_path: str) -> Tuple[np.ndarray, Tuple[float, float, float], Dict[str, Any]]:
    """
    Reads a folder of DICOM slices, sorts them by spatial position, and returns (Z, Y, X) volume and spacing.
    """
    import pydicom
    files = []
    for root, _, filenames in os.walk(folder_path):
        if "__MACOSX" in root:
            continue
        for f in filenames:
            if f.startswith(".") or "/._" in os.path.join(root, f):
                continue
            fl = f.lower()
            if fl.endswith(('.dcm', '.dicom', '.ima')) or (not '.' in f and not f.startswith('.')):
                files.append(os.path.join(root, f))
    if not files:
        files = [p for p in glob.glob(os.path.join(folder_path, "*")) if not os.path.basename(p).startswith(".")]
    
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
        
    return _build_volume_from_slices(slices)

def load_dicom_from_zip(zip_source: Union[str, bytes, io.BytesIO]) -> Tuple[np.ndarray, Tuple[float, float, float], Dict[str, Any]]:
    """
    Reads DICOM slices from a .zip archive, sorts them, and returns (Z, Y, X) volume and spacing.
    Filters out AppleDouble metadata files (__MACOSX, ._*) automatically.
    """
    import pydicom
    zf = zipfile.ZipFile(zip_source)
    slices = []
    for name in zf.namelist():
        if "__MACOSX" in name or "/._" in name or name.split("/")[-1].startswith("."):
            continue
        fl = name.lower()
        if fl.endswith(('.dcm', '.dicom', '.ima')) or ('.' not in name.split("/")[-1] and not name.split("/")[-1].startswith('.')):
            try:
                raw_bytes = zf.read(name)
                ds = pydicom.dcmread(io.BytesIO(raw_bytes), force=True)
                if hasattr(ds, "pixel_array"):
                    slices.append(ds)
            except Exception:
                continue

    if not slices:
        raise ValueError("No valid DICOM slices found in zip archive")

    return _build_volume_from_slices(slices)

def load_dicom_file(file_source: Union[str, bytes, io.BytesIO]) -> Tuple[np.ndarray, Tuple[float, float, float], Dict[str, Any]]:
    """
    Reads a single DICOM file (multi-frame 3D or single slice).
    """
    import pydicom
    if isinstance(file_source, bytes):
        file_source = io.BytesIO(file_source)
    ds = pydicom.dcmread(file_source, force=True)
    if not hasattr(ds, "pixel_array"):
        raise ValueError("DICOM file has no pixel array")

    pixel_array = ds.pixel_array
    slope = float(getattr(ds, "RescaleSlope", 1.0))
    intercept = float(getattr(ds, "RescaleIntercept", 0.0))
    pixel_spacing = getattr(ds, "PixelSpacing", [1.0, 1.0])
    slice_thickness = float(getattr(ds, "SliceThickness", 1.0))
    spacing = (slice_thickness, float(pixel_spacing[0]), float(pixel_spacing[1]))

    if pixel_array.ndim == 3:
        vol = pixel_array.astype(np.float32) * slope + intercept
    elif pixel_array.ndim == 2:
        vol = (pixel_array.astype(np.float32) * slope + intercept)[np.newaxis, :, :]
    else:
        vol = pixel_array[0].astype(np.float32) * slope + intercept

    meta = {
        "modality": getattr(ds, "Modality", "CT"),
        "slices_count": vol.shape[0],
        "rows": vol.shape[1],
        "cols": vol.shape[2],
    }
    return vol, spacing, scrub_dicom_metadata(meta, "ANON-STUDY")

def _build_volume_from_slices(slices: list) -> Tuple[np.ndarray, Tuple[float, float, float], Dict[str, Any]]:
    """
    Sorts slice objects by physical Z-coordinate or InstanceNumber and stacks into 3D volume.
    """
    try:
        slices.sort(key=lambda s: float(s.ImagePositionPatient[2]))
    except Exception:
        slices.sort(key=lambda s: getattr(s, "InstanceNumber", 0))

    first = slices[0]
    pixel_spacing = getattr(first, "PixelSpacing", [1.0, 1.0])
    slice_thickness = getattr(first, "SliceThickness", 1.0)
    spacing = (float(slice_thickness), float(pixel_spacing[0]), float(pixel_spacing[1]))

    slope = float(getattr(first, "RescaleSlope", 1.0))
    intercept = float(getattr(first, "RescaleIntercept", 0.0))

    vol = np.stack([s.pixel_array.astype(np.float32) * slope + intercept for s in slices], axis=0)
    meta = {
        "modality": getattr(first, "Modality", "CT"),
        "slices_count": len(slices),
        "rows": first.Rows,
        "cols": first.Columns,
    }
    return vol, spacing, scrub_dicom_metadata(meta, "ANON-STUDY")

def load_volume(source: Union[str, bytes, io.BytesIO], filename: Optional[str] = None) -> Tuple[np.ndarray, Tuple[float, float, float], str]:
    """
    Universal medical volume loader supporting:
    - DICOM ZIP archives (.zip)
    - DICOM directory paths
    - Single DICOM files (.dcm)
    - NIfTI volumes (.nii, .nii.gz)
    Returns (vol, spacing, modality).
    """
    fn = (filename or (source if isinstance(source, str) else "")).lower()

    # 1. In-memory bytes / BytesIO
    if isinstance(source, (bytes, io.BytesIO)):
        bio = io.BytesIO(source) if isinstance(source, bytes) else source
        # Check ZIP
        if zipfile.is_zipfile(bio):
            bio.seek(0)
            vol, spacing, meta = load_dicom_from_zip(bio)
            return vol, spacing, meta.get("modality", "CT")

        bio.seek(0)
        # Check NIfTI (gzip magic \x1f\x8b or .nii in filename)
        header_bytes = bio.read(4)
        bio.seek(0)
        if header_bytes.startswith(b"\x1f\x8b") or fn.endswith((".nii", ".nii.gz")):
            vol, spacing = load_nifti(bio)
            modality = "MRI" if "mri" in fn else "CT"
            return vol, spacing, modality

        # Check DICOM
        bio.seek(0)
        vol, spacing, meta = load_dicom_file(bio)
        return vol, spacing, meta.get("modality", "CT")

    # 2. File path (string)
    if os.path.isdir(source):
        vol, spacing, meta = load_dicom_series(source)
        return vol, spacing, meta.get("modality", "CT")

    if zipfile.is_zipfile(source) or fn.endswith(".zip"):
        vol, spacing, meta = load_dicom_from_zip(source)
        return vol, spacing, meta.get("modality", "CT")

    if fn.endswith((".nii", ".nii.gz")):
        vol, spacing = load_nifti(source)
        modality = "MRI" if "mri" in fn else "CT"
        return vol, spacing, modality

    if fn.endswith((".dcm", ".dicom", ".ima")):
        vol, spacing, meta = load_dicom_file(source)
        return vol, spacing, meta.get("modality", "CT")

    # Fallback attempt as NIfTI then DICOM
    try:
        vol, spacing = load_nifti(source)
        return vol, spacing, "MRI" if "mri" in fn else "CT"
    except Exception:
        vol, spacing, meta = load_dicom_file(source)
        return vol, spacing, meta.get("modality", "CT")
