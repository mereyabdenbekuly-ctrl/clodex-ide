#!/usr/bin/env python3
"""Extract one untrusted ZIP without following links or accepting path tricks."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import unicodedata
import zipfile


ALLOWED_COMPRESSION = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
CHUNK_BYTES = 1024 * 1024


def fail(message: str) -> None:
    raise ValueError(message)


def safe_member_name(value: str) -> tuple[PurePosixPath, str]:
    if not value or "\x00" in value or "\\" in value:
        fail(f"unsafe ZIP member name: {value!r}")
    if unicodedata.normalize("NFC", value) != value:
        fail(f"ZIP member name is not NFC-normalized: {value!r}")
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        fail(f"unsafe ZIP member path: {value!r}")
    normalized = candidate.as_posix()
    if normalized != value.rstrip("/"):
        fail(f"non-canonical ZIP member path: {value!r}")
    return candidate, normalized


def member_type(info: zipfile.ZipInfo) -> str:
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(unix_mode)
    if info.is_dir():
        if file_type not in {0, stat.S_IFDIR}:
            fail(f"ZIP directory has invalid mode: {info.filename!r}")
        return "directory"
    if file_type not in {0, stat.S_IFREG}:
        fail(f"ZIP member is not a regular file: {info.filename!r}")
    return "file"


def open_exclusive(path: Path):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    return os.fdopen(descriptor, "wb")


def lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def reject_exact_symlink(path: Path, label: str) -> None:
    try:
        candidate_stat = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(candidate_stat.st_mode):
        fail(f"{label} must not be a symlink: {path}")


def extract_archive(
    archive: Path,
    output: Path,
    *,
    max_entries: int,
    max_total_bytes: int,
    max_file_bytes: int,
) -> dict[str, object]:
    reject_exact_symlink(archive, "ZIP archive path")
    reject_exact_symlink(output.parent, "ZIP output parent")
    if output.exists() or output.is_symlink():
        fail("ZIP extraction output must not already exist")
    output.mkdir(mode=0o700, parents=False)

    records: list[dict[str, object]] = []
    total_bytes = 0
    seen_exact: set[str] = set()
    seen_portable: set[str] = set()
    try:
        open_flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            open_flags |= os.O_NOFOLLOW
        archive_descriptor = os.open(archive, open_flags)
        archive_stat = os.fstat(archive_descriptor)
        if not stat.S_ISREG(archive_stat.st_mode) or archive_stat.st_size <= 0:
            os.close(archive_descriptor)
            fail("ZIP archive must be a non-empty regular file")
        with os.fdopen(archive_descriptor, "rb") as archive_file, zipfile.ZipFile(
            archive_file, "r", allowZip64=True
        ) as source:
            members = source.infolist()
            if not members or len(members) > max_entries:
                fail(f"ZIP entry count is outside 1..{max_entries}")
            for info in members:
                candidate, normalized = safe_member_name(info.filename)
                portable = normalized.casefold()
                if normalized in seen_exact or portable in seen_portable:
                    fail(f"duplicate or portable-colliding ZIP member: {info.filename!r}")
                seen_exact.add(normalized)
                seen_portable.add(portable)
                if info.flag_bits & 0x1:
                    fail(f"encrypted ZIP member is forbidden: {info.filename!r}")
                if info.compress_type not in ALLOWED_COMPRESSION:
                    fail(f"unsupported ZIP compression method: {info.compress_type}")
                kind = member_type(info)
                destination = output.joinpath(*candidate.parts)
                if kind == "directory":
                    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                    destination_stat = destination.lstat()
                    if not stat.S_ISDIR(destination_stat.st_mode) or stat.S_ISLNK(
                        destination_stat.st_mode
                    ):
                        fail(f"ZIP directory extraction target is invalid: {info.filename!r}")
                    continue
                if info.file_size <= 0 or info.file_size > max_file_bytes:
                    fail(f"ZIP member size is outside the allowed range: {info.filename!r}")
                if info.compress_size == 0 and info.file_size != 0:
                    fail(f"ZIP member has an impossible compression size: {info.filename!r}")
                if info.compress_size > 0 and info.file_size > info.compress_size * 1_000:
                    fail(f"ZIP member compression ratio exceeds the safety limit: {info.filename!r}")
                total_bytes += info.file_size
                if total_bytes > max_total_bytes:
                    fail("ZIP expanded size exceeds the safety limit")
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                digest = hashlib.sha256()
                observed = 0
                with source.open(info, "r") as reader, open_exclusive(destination) as writer:
                    while True:
                        chunk = reader.read(CHUNK_BYTES)
                        if not chunk:
                            break
                        observed += len(chunk)
                        if observed > info.file_size:
                            fail(f"ZIP member expanded beyond its declared size: {info.filename!r}")
                        digest.update(chunk)
                        writer.write(chunk)
                if observed != info.file_size:
                    fail(f"ZIP member size differs after extraction: {info.filename!r}")
                records.append(
                    {
                        "bytes": observed,
                        "fileName": normalized,
                        "sha256": digest.hexdigest(),
                    }
                )
    except Exception:
        shutil.rmtree(output, ignore_errors=True)
        raise
    records.sort(key=lambda record: str(record["fileName"]))
    return {
        "archive": archive.name,
        "entries": records,
        "entryCount": len(records),
        "totalBytes": total_bytes,
    }


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--max-entries", default=128, type=positive_int)
    parser.add_argument("--max-total-bytes", default=8 * 1024**3, type=positive_int)
    parser.add_argument("--max-file-bytes", default=4 * 1024**3, type=positive_int)
    args = parser.parse_args()
    result = extract_archive(
        lexical_absolute(args.archive),
        lexical_absolute(args.output),
        max_entries=args.max_entries,
        max_total_bytes=args.max_total_bytes,
        max_file_bytes=args.max_file_bytes,
    )
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - terminal CLI boundary
        print(f"[safe-extract-zip] FAILED: {error}", file=sys.stderr)
        raise SystemExit(1) from error
