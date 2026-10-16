#!/usr/bin/env python3
"""Create allowlisted Windows/Quest packages; never copy a build directory wholesale."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / "Native"
WINDOWS_PROGRAMS = {
    "openslope_player.exe": "OpenSlope.exe",
    "openslope_import.exe": "openslope_import.exe",
    "openslope_inspect.exe": "openslope_inspect.exe",
}


def run(*args: str | Path) -> str:
    result = subprocess.run([str(a) for a in args], cwd=ROOT, capture_output=True,
                            text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise ValueError(f"{Path(args[0]).name} failed: {result.stdout}{result.stderr}")
    return result.stdout


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def notice_files() -> dict[str, bytes]:
    names = run("git", "ls-files", "Native/ThirdPartyNotices").splitlines()
    result = {p.removeprefix("Native/ThirdPartyNotices/"): (ROOT / p).read_bytes() for p in names}
    result.update({
        "LICENSE": (NATIVE / "LICENSE").read_bytes(),
        "NOTICE": (NATIVE / "NOTICE").read_bytes(),
        "stick-figure-NOTICE.txt": (NATIVE / "assets/NOTICE.txt").read_bytes(),
        "shared-contracts-NOTICE.txt": (ROOT / "Contracts/NOTICE").read_bytes(),
    })
    return result


def pe_imports(data: bytes) -> list[str]:
    """Read the PE32+ import directory without executing an input executable."""
    if data[:2] != b"MZ":
        raise ValueError("Expected a Windows executable")
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("Invalid PE signature")
    machine, count = struct.unpack_from("<HH", data, pe + 4)
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    if machine != 0x8664 or struct.unpack_from("<H", data, optional)[0] != 0x20B:
        raise ValueError("Windows package requires x64 PE32+ executables")
    sections = []
    for index in range(count):
        offset = optional + optional_size + 40 * index
        virtual_size, address, size, raw = struct.unpack_from("<IIII", data, offset + 8)
        sections.append((address, max(size, virtual_size), raw, size))

    def location(rva: int) -> int:
        for address, size, raw, raw_size in sections:
            if address <= rva < address + size and rva - address < raw_size:
                return raw + rva - address
        raise ValueError("Invalid PE import address")

    import_rva, import_size = struct.unpack_from("<II", data, optional + 120)
    if not import_rva:
        return []
    imports = []
    start = location(import_rva)
    for offset in range(start, start + import_size, 20):
        fields = struct.unpack_from("<IIIII", data, offset)
        if not any(fields):
            return imports
        name = location(fields[3])
        end = data.index(b"\0", name, name + 256)
        imports.append(data[name:end].decode("ascii").lower())
    raise ValueError("Unterminated PE import directory")


def validate_windows(data: bytes) -> list[str]:
    dependencies = pe_imports(data)
    system = {"kernel32.dll", "user32.dll", "gdi32.dll", "advapi32.dll", "shell32.dll",
              "ole32.dll", "oleaut32.dll", "ws2_32.dll", "winmm.dll", "shlwapi.dll",
              "setupapi.dll", "cfgmgr32.dll", "bcrypt.dll", "ntdll.dll", "version.dll",
              "imm32.dll", "comdlg32.dll", "ucrtbase.dll"}
    for name in dependencies:
        if name not in system and not name.startswith(("api-ms-win-", "ext-ms-win-")):
            raise ValueError(f"Unbundled Windows DLL dependency: {name}; build with the static C++ runtime")
    return dependencies


def validate_apk_files(apk: Path, notices: dict[str, bytes]) -> None:
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate APK entries")
        expected_assets = {f"assets/{name}" for name in notices}
        assets = {name for name in names if name.startswith("assets/")}
        if assets != expected_assets:
            raise ValueError(f"APK assets differ from the license-only allowlist: {sorted(assets ^ expected_assets)}")
        for name, data in notices.items():
            if archive.read(f"assets/{name}") != data:
                raise ValueError(f"Stale APK notice: {name}")
        libraries = [name for name in names if name.startswith("lib/")]
        if libraries != ["lib/arm64-v8a/libopenslope_player.so"]:
            raise ValueError(f"Unexpected APK native libraries: {libraries}")
        for name in names:
            allowed = (name in expected_assets or name in libraries
                       or name in {"AndroidManifest.xml", "resources.arsc", "META-INF/version-control-info.textproto"}
                       or re.fullmatch(r"classes\d*\.dex", name)
                       or re.fullmatch(r"res/[A-Za-z0-9_/-]+\.xml", name)
                       or re.fullmatch(r"META-INF/(?:MANIFEST\.MF|[A-Z0-9_-]+\.(?:SF|RSA|DSA|EC)|com/android/build/gradle/app-metadata\.properties)", name))
            if not allowed or ".." in name.split("/") or "\\" in name:
                raise ValueError(f"Unexpected APK entry: {name}")


def validate_android(apk: Path, tools: Path, version: str, code: int, preview: bool,
                     notices: dict[str, bytes]) -> dict:
    validate_apk_files(apk, notices)
    badging = run(tools / "aapt2.exe", "dump", "badging", apk)
    expected = f"package: name='org.openslope.nativeplayer' versionCode='{code}' versionName='{version}'"
    if expected not in badging or "native-code: 'arm64-v8a'" not in badging:
        raise ValueError("APK application ID, version or architecture differs from the source")
    debuggable = "application-debuggable" in badging
    certificates = run(tools / "apksigner.bat", "verify", "--verbose", "--print-certs", apk)
    digests = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})", certificates)
    if len(digests) != 1:
        raise ValueError("Expected exactly one verified APK signing certificate")
    debug_key = "CN=Android Debug" in certificates
    if not preview and (debuggable or debug_key):
        raise ValueError("Public packages require a non-debuggable APK signed with a release key")
    return {"application_id": "org.openslope.nativeplayer", "version_code": code,
            "debuggable": debuggable, "debug_certificate": debug_key,
            "signer_sha256": digests[0].lower()}


def write_zip(path: Path, files: dict[str, bytes], prefix: str) -> None:
    with zipfile.ZipFile(path, "x", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            if Path(name).is_absolute() or ".." in name.split("/") or "\\" in name:
                raise ValueError(f"Invalid package path: {name}")
            entry = zipfile.ZipInfo(f"{prefix}/{name}", (2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, data)


def package(build: Path, apk: Path, output: Path, tools: Path, preview: bool) -> Path:
    version = (NATIVE / "VERSION.txt").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Native/VERSION.txt must contain a three-part version")
    code = int(re.search(r"versionCode\s+(\d+)", (NATIVE / "android/app/build.gradle").read_text())[1])
    revision = run("git", "rev-parse", "HEAD").strip()
    dirty = bool(run("git", "status", "--porcelain").strip())
    if dirty and not preview:
        raise ValueError("Public packages require a clean committed source tree")
    cache = (build / "CMakeCache.txt").read_text(encoding="utf-8")
    if f"CMAKE_PROJECT_VERSION:STATIC={version}\n" not in cache:
        raise ValueError("Windows build version differs from Native/VERSION.txt")
    if "CMAKE_MSVC_RUNTIME_LIBRARY:UNINITIALIZED=MultiThreaded\n" not in cache and "CMAKE_MSVC_RUNTIME_LIBRARY:STRING=MultiThreaded\n" not in cache:
        raise ValueError("Use Native/release.ps1 to build the portable static-runtime executables")
    notices = notice_files()
    android = validate_android(apk, tools, version, code, preview, notices)
    files = {f"licenses/{name}": data for name, data in notices.items()}
    dependencies = {}
    for source, destination in WINDOWS_PROGRAMS.items():
        data = (build / "Release" / source).read_bytes()
        dependencies[destination] = validate_windows(data)
        files[destination] = data
    for source, destination in {"windows-readme.txt": "START HERE.txt",
                                "maps-readme.txt": "Maps/README.txt",
                                "Import-Courses.ps1": "Import-Courses.ps1"}.items():
        files[destination] = (NATIVE / "distribution" / source).read_bytes()
    launchers = {
        "Play OpenSlope.cmd": 'OpenSlope.exe --on-foot --ui-menu %*',
        "Play in VR.cmd": 'OpenSlope.exe --xr --on-foot %*',
        "Import courses.cmd": 'powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Import-Courses.ps1" %*',
    }
    for name, command in launchers.items():
        files[name] = f'@echo off\r\ncd /d "%~dp0"\r\n{command}\r\nif errorlevel 1 pause\r\n'.encode("ascii")
    label = f"OpenSlope-Native-{version}" + ("-preview" if preview else "")
    destination = output / label
    if destination.exists():
        raise ValueError(f"Package destination already exists: {destination}. Choose a fresh output folder.")
    destination.mkdir(parents=True)
    archive = destination / f"{label}-Windows-x64.zip"
    write_zip(archive, files, f"{label}-Windows-x64")
    apk_output = destination / f"{label}-Quest-arm64.apk"
    apk_data = apk.read_bytes()
    apk_output.write_bytes(apk_data)
    notes = (NATIVE / "releases" / f"{version}.md").read_text(encoding="utf-8")
    if preview:
        notes = ("# Local preview package\n\nThis is a debug-signed development APK, not the public release. "
                 "It updates only installations with the same debug certificate. "
                 "Source may contain uncommitted release tooling.\n\n" + notes)
    (destination / "RELEASE-NOTES.md").write_text(notes, encoding="utf-8", newline="\n")
    manifest = {"schema": "openslope-native-release/v1", "version": version, "source_commit": revision,
                "source_dirty": dirty, "preview": preview, "quest": android,
                "windows_imports": dependencies,
                "windows_files": {name: sha(data) for name, data in sorted(files.items())},
                "artifacts": {path.name: sha(path.read_bytes()) for path in sorted(destination.iterdir())}}
    (destination / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    sums = [f"{sha(path.read_bytes())}  {path.name}\n" for path in sorted(destination.iterdir())]
    (destination / "SHA256SUMS.txt").write_text("".join(sums), encoding="ascii")
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--windows-build", required=True, type=Path)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--android-tools", type=Path, default=ROOT / ".openslope/native-android/sdk/build-tools/35.0.0")
    parser.add_argument("--preview", action="store_true", help="Clearly mark development artifacts; never publish as a release")
    args = parser.parse_args()
    try:
        print(package(args.windows_build, args.apk, args.output, args.android_tools, args.preview))
        return 0
    except (ValueError, OSError, struct.error, zipfile.BadZipFile) as error:
        print(f"Release packaging: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
