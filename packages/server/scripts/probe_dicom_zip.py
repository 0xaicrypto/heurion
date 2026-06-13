#!/usr/bin/env python3
"""Diagnostic probe for DICOM zip detection — #150.

When `looks_like_dicom_archive` returns False on a zip you expected
to be a DICOM study, this script tells you EXACTLY which check
fell through and prints the first few file headers in hex so we
can see what magic the archive actually has.

Usage:
    cd packages/server
    python3 scripts/probe_dicom_zip.py /path/to/PET-CT.zip

Output sections:
  - Archive metadata (name count, dir count, dcm-ext count)
  - DICOMDIR present? Y/N
  - First 10 .dcm entries: probed, magic bytes at offset 128
  - First 10 no-extension entries: probed
  - Final verdict + suggested fix
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path


def hex_at(data: bytes, off: int, length: int = 4) -> str:
    """Return space-separated hex bytes at offset, for inspection."""
    if len(data) < off + length:
        return f"<short — only {len(data)} bytes>"
    return " ".join(f"{b:02x}" for b in data[off:off + length])


def main(zip_path_str: str) -> int:
    zip_path = Path(zip_path_str)
    if not zip_path.exists():
        print(f"✗ file not found: {zip_path}")
        return 2

    print(f"=== Probing {zip_path.name} ===")
    print(f"size: {zip_path.stat().st_size:,} bytes "
          f"({zip_path.stat().st_size // (1024 * 1024)} MB)")
    print()

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            print(f"entries: {len(names)}")
            non_dirs = [n for n in names if not n.endswith("/")]
            print(f"  non-dir: {len(non_dirs)}")
            dcm_ext = [n for n in non_dirs if n.lower().endswith(".dcm")]
            print(f"  .dcm extension: {len(dcm_ext)}")
            no_ext = [
                n for n in non_dirs
                if not Path(n).suffix and Path(n).name
            ]
            print(f"  no extension: {len(no_ext)}")
            dicomdir = [n for n in names if Path(n).name.upper() == "DICOMDIR"]
            print(f"  DICOMDIR present: {bool(dicomdir)} "
                  f"({dicomdir[0] if dicomdir else '-'})")
            print()

            # DICOM magic bytes are "DICM" (0x44 0x49 0x43 0x4d) at offset 128.
            EXPECTED = b"DICM"

            def probe(label: str, candidates: list[str], limit: int = 10):
                print(f"--- {label} (showing first {min(limit, len(candidates))}) ---")
                for n in candidates[:limit]:
                    try:
                        with zf.open(n) as fh:
                            head = fh.read(140)
                        magic = head[128:132] if len(head) >= 132 else b""
                        is_dicom = magic == EXPECTED
                        marker = "✓ DICM" if is_dicom else "✗ ----"
                        print(f"  {marker} | offset 0..16: {hex_at(head, 0, 16)} "
                              f"| offset 128..132: {hex_at(head, 128, 4)} "
                              f"| {Path(n).name[:60]}")
                    except Exception as e:  # noqa: BLE001
                        print(f"  ! read failed for {n}: {e}")
                print()

            if dcm_ext:
                probe("Entries with .dcm extension", dcm_ext)
            if no_ext:
                probe("Entries with no extension (PACS-style)", no_ext)
            if not dcm_ext and not no_ext and non_dirs:
                probe("Other non-dir entries", non_dirs)

            # Standalone detector — reimplemented inline so this probe
            # works without the whole nexus_server stack importing
            # (fastapi etc.). Mirrors looks_like_dicom_archive's
            # logic exactly so what we print is what the server would
            # decide.
            print("=== detector verdict (standalone, no nexus_server import) ===")
            DICOM_OFFSET = 128
            DICOM_MAGIC = b"DICM"
            non_dirs_clean = [
                n for n in non_dirs
                if not Path(n).name.startswith("._")    # macOS AppleDouble
                and Path(n).name != ".DS_Store"        # macOS finder cruft
            ]
            print(f"after macOS cruft filter: {len(non_dirs_clean)} entries")

            def probe_one(n: str) -> bool:
                try:
                    with zf.open(n) as fh:
                        head = fh.read(DICOM_OFFSET + 4)
                    return (
                        len(head) >= DICOM_OFFSET + 4 and
                        head[DICOM_OFFSET:DICOM_OFFSET + 4] == DICOM_MAGIC
                    )
                except Exception:  # noqa: BLE001
                    return False

            verdict = False
            # DICOMDIR check
            if any(Path(n).name.upper() == "DICOMDIR" for n in names):
                verdict = True
                print("  hit via DICOMDIR")
            if not verdict:
                # .dcm extension scan (5)
                for n in [x for x in non_dirs_clean if x.lower().endswith(".dcm")][:5]:
                    if probe_one(n):
                        verdict = True
                        print(f"  hit via .dcm ext: {Path(n).name[:60]}")
                        break
            if not verdict:
                # no-ext scan (50)
                for n in [x for x in non_dirs_clean if not Path(x).suffix][:50]:
                    if probe_one(n):
                        verdict = True
                        print(f"  hit via no-ext: {Path(n).name[:60]}")
                        break
            if not verdict:
                # last-ditch (50)
                for n in non_dirs_clean[:50]:
                    if probe_one(n):
                        verdict = True
                        print(f"  hit via fallback: {Path(n).name[:60]}")
                        break

            print(f"\nFINAL: looks_like_dicom_archive() → {verdict}")
            if verdict:
                print()
                print("✓ Detector would accept this zip. If your running server")
                print("  still says 'empty file', it's running OLD code —")
                print("  rebuild .dmg + reinstall to pick up the new detector.")
            else:
                print()
                print("✗ Detector would reject this zip — share this output.")
    except zipfile.BadZipFile as e:
        print(f"✗ corrupted zip: {e}")
        return 1

    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: probe_dicom_zip.py <path-to-zip>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
