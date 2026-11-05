"""Check a clean source release locally; print locations, never matched values."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import struct
import zlib

REQUIRED = {
    ".gitignore", ".gitattributes", "README.md", "SECURITY.md",
    "dual-arc.js", "quota_launcher.py", "安装快捷方式.ps1",
    "docs/theme-comparison.html", "docs/quota-states.png", "docs/number-flip.gif",
    "tools/check_release.py",
}
OPTIONAL = {"LICENSE"}
PATTERNS = {
    "OpenAI-key": r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{18,}",
    "GitHub-token": r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})",
    "cloud-access-key": r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "private-key": r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY",
    "JWT": r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
    "bearer-value": r"(?i)\bBearer\s+[A-Za-z0-9_~+/.-]{16,}",
    "credential-literal": r'''(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization)\s*[:=]\s*["'][^"'\s]{12,}["']''',
    "credential-URL": r"(?i)(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):/" r"/[^\s/@:]+:[^\s/@]+@",
    "email": r"(?<![\w.+-])[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-])",
    "personal-Windows-path": r"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s\"<>]+",
    "personal-Unix-path": r"/(?:Users|home)/[A-Za-z0-9_.-]+/",
    "account-ID-literal": r"\b(?:acct|org|user|account)[_-][A-Za-z0-9]{16,}",
    "UUID-literal": r"\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b",
    "CN-ID-number": r"(?<!\d)[1-9]\d{5}(?:19|20)\d{9}[0-9Xx](?!\d)",
    "CN-phone-number": r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)",
}


def scan_text(text: str, name: str) -> list[tuple[str, str, int]]:
    findings = []
    for label, pattern in PATTERNS.items():
        for match in re.finditer(pattern, text):
            findings.append((label, name, text.count("\n", 0, match.start()) + 1))
    return findings


def png_without_metadata(data: bytes) -> bool:
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return False
    position = 8
    kinds = []
    while position + 12 <= len(data):
        size = struct.unpack_from(">I", data, position)[0]
        end = position + 12 + size
        if end > len(data):
            return False
        kind = data[position + 4:position + 8]
        payload = data[position + 8:position + 8 + size]
        checksum = struct.unpack_from(">I", data, position + 8 + size)[0]
        if checksum != zlib.crc32(kind + payload) & 0xFFFFFFFF:
            return False
        if kind not in {b"IHDR", b"PLTE", b"IDAT", b"IEND"}:
            return False
        kinds.append(kind)
        position = end
        if kind == b"IEND":
            return position == len(data) and kinds[0] == b"IHDR" and b"IDAT" in kinds
    return False


def gif_without_metadata(data: bytes) -> bool:
    if len(data) < 14 or data[:6] not in {b"GIF87a", b"GIF89a"}:
        return False
    position = 13
    if data[10] & 0x80:
        position += 3 * (2 ** ((data[10] & 7) + 1))
    frames = 0

    def blocks(offset):
        payload = bytearray()
        while offset < len(data):
            size = data[offset]
            offset += 1
            if not size:
                return offset, bytes(payload)
            if offset + size > len(data):
                return len(data) + 1, b""
            payload.extend(data[offset:offset + size])
            offset += size
        return len(data) + 1, b""

    while position < len(data):
        kind = data[position]
        position += 1
        if kind == 0x3B:
            return position == len(data) and frames > 1
        if kind == 0x21:
            if position >= len(data):
                return False
            label = data[position]
            position += 1
            if label == 0xF9:
                if position + 6 > len(data) or data[position] != 4 or data[position + 5] != 0:
                    return False
                position += 6
            elif label == 0xFF:
                if position + 12 > len(data) or data[position] != 11 or data[position + 1:position + 12] != b"NETSCAPE2.0":
                    return False
                position, payload = blocks(position + 12)
                if payload != b"\x01\x00\x00":
                    return False
            else:
                return False
        elif kind == 0x2C:
            if position + 9 > len(data):
                return False
            packed = data[position + 8]
            position += 9
            if packed & 0x80:
                position += 3 * (2 ** ((packed & 7) + 1))
            if position >= len(data):
                return False
            position, _ = blocks(position + 1)
            frames += 1
        else:
            return False
    return False


def check(root: Path) -> tuple[list[str], list[tuple[str, str, int]]]:
    root = root.resolve()
    files = []
    issues = []
    if not root.is_dir():
        return [], [("missing-release-directory", ".", 0)]
    for directory, folders, names in os.walk(root, followlinks=False):
        base = Path(directory)
        for name in list(folders):
            folder = base / name
            relative = folder.relative_to(root).as_posix()
            if folder.is_symlink() or getattr(folder.lstat(), "st_file_attributes", 0) & 0x400:
                issues.append(("reparse-directory", relative, 0))
                folders.remove(name)
            elif name == ".git":
                folders.remove(name)
        for name in names:
            path = base / name
            relative = path.relative_to(root).as_posix()
            files.append(relative)
            if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400:
                issues.append(("reparse-file", relative, 0))
                continue
            if relative not in REQUIRED | OPTIONAL:
                issues.append(("unexpected-release-file", relative, 0))
                continue
            data = path.read_bytes()
            if relative.endswith(".png"):
                if not png_without_metadata(data):
                    issues.append(("PNG-metadata-or-invalid-container", relative, 0))
                continue
            if relative.endswith(".gif"):
                if not gif_without_metadata(data):
                    issues.append(("GIF-metadata-or-invalid-container", relative, 0))
                continue
            try:
                text = data.decode("utf-8-sig")
            except UnicodeError:
                issues.append(("non-UTF8-text", relative, 0))
                continue
            issues.extend(scan_text(text, relative))
            if relative.endswith(".html") and "const SOURCE=" in text:
                try:
                    embedded, _ = json.JSONDecoder().raw_decode(text.split("const SOURCE=", 1)[1])
                    issues.extend(scan_text(embedded, relative + " [embedded source]"))
                except (ValueError, TypeError):
                    issues.append(("invalid-embedded-source", relative, 0))
    issues.extend(("missing-required-file", name, 0) for name in sorted(REQUIRED - set(files)))
    return sorted(files), issues


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    options = parser.parse_args()
    files, findings = check(options.root)
    for label, name, line in findings:
        print(f"FAIL {label}: {name}" + (f":{line}" if line else ""))
    if findings:
        print(f"FAIL: {len(findings)} finding(s); matched values were not printed.")
        return 1
    print(f"PASS: {len(files)} allowlisted files; no supported secret or personal-path pattern found.")
    print("This check does not prove the absence of all personal data or vulnerabilities.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
