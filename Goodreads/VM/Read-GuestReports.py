"""Extract allowlisted guest reports without mounting or modifying the VHDX.

Used by the privileged host only after it verifies the owned VM is powered off.
Dissect and the embedded Python runtime must be installed in the protected host
runtime. BitLocker volumes are readable only when they contain a clear key.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

NAMES = ("vm-last-run.json", "daily-last-run.json", "daily-verification.json",
         "daily-incomplete.json", "daily.log", "vm-runner.log")
MAXIMUM_BYTES = 10 * 1024 * 1024


def read_report(fs, name):
    if name not in NAMES:
        raise ValueError("Unknown guest report")
    path = ""
    for component in ("GoodreadsVM", "output", name):
        path = path + "\\" + component if path else component
        record = fs.mft.get(path)
        # FILE_ATTRIBUTE_REPARSE_POINT. Never follow guest links on the host.
        if record.attributes.STANDARD_INFORMATION[0].file_attributes & 0x400:
            raise ValueError("Guest report links and reparse points are not allowed")
        if component != name and not record.is_dir():
            raise ValueError("Invalid guest report directory")
    if record.is_dir():
        raise ValueError("Invalid guest report file")
    with record.open() as handle:
        data = handle.read(MAXIMUM_BYTES + 1)
    if len(data) > MAXIMUM_BYTES:
        raise ValueError("Oversized guest report")
    return data


def extract(disk_path, output):
    sys.path.insert(0, str(Path(__file__).parent / "packages"))
    from dissect.hypervisor.disk.vhdx import VHDX
    from dissect.volume.disk import Disk
    from dissect.fve.bde import BDE
    from dissect.ntfs import NTFS

    before = disk_path.stat()
    with disk_path.open("rb") as raw:
        image = VHDX(raw)
        if image.has_parent:
            raise ValueError("Unexpected differencing disk")
        partitions = [p for p in Disk(image, sector_size=image.sector_size).partitions
                      if str(p.type) == "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"]
        if len(partitions) != 1:
            raise ValueError("Expected one Windows data partition")
        volume = partitions[0].open()
        volume.seek(3)
        encrypted = volume.read(8) == b"-FVE-FS-"
        volume.seek(0)
        if encrypted:
            bde = BDE(volume)
            if not bde.has_clear_key():
                raise ValueError("Guest BitLocker volume requires a separate report-export arrangement")
            volume = bde.unlock_with_clear_key().open()
        fs = NTFS(volume)
        reports = {}
        for name in NAMES:
            try:
                reports[name] = read_report(fs, name)
            except FileNotFoundError:
                if name == "vm-last-run.json":
                    raise
    after = disk_path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError("Guest disk changed during extraction")
    output.mkdir(parents=True, exist_ok=True)
    for name, data in reports.items():
        target = output / name
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_bytes(data)
        temporary.replace(target)
    for name in set(NAMES) - reports.keys():
        (output / name).unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disk", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    extract(args.disk, args.output)
