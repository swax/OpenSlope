#!/usr/bin/env python3
"""Package explicitly selected Linux/macOS executables and their runtime notices."""

from __future__ import annotations

import argparse
import io
import json
import os
import plistlib
import re
import shutil
import struct
import tarfile
import tempfile
from pathlib import Path

from package_release import NATIVE, notice_files, run, sha

PROGRAMS = ("openslope_player", "openslope_import", "openslope_inspect")
PLATFORMS = {"linux-x64": "Linux-x64", "macos-arm64": "macOS-arm64", "macos-x64": "macOS-x64"}
LINUX_SYSTEM = {
    "libc.so.6",
    "libm.so.6",
    "libdl.so.2",
    "libpthread.so.0",
    "librt.so.1",
    "libstdc++.so.6",
    "libgcc_s.so.1",
    "libatomic.so.1",
    "ld-linux-x86-64.so.2",
}


def validate_elf(data: bytes) -> None:
    if (
        data[:7] != b"\x7fELF\x02\x01\x01"
        or len(data) < 64
        or struct.unpack_from("<H", data, 16)[0] not in (2, 3)
        or struct.unpack_from("<H", data, 18)[0] != 62
    ):
        raise ValueError("Linux package requires x64 ELF executables")


def linux_dependencies(path: Path) -> list[str]:
    dependencies = re.findall(r"\(NEEDED\).*?\[(.*?)\]", run("readelf", "-d", path))
    for name in dependencies:
        if name not in LINUX_SYSTEM:
            raise ValueError(f"Unbundled Linux dependency: {name}")
    return dependencies


def mac_dependencies(path: Path, architecture: str) -> list[str]:
    if architecture not in run("lipo", "-archs", path).split():
        raise ValueError(f"Missing {architecture} Mach-O slice: {path.name}")
    dependencies = [
        line.strip().split(" (", 1)[0] for line in run("otool", "-arch", architecture, "-L", path).splitlines()[1:]
    ]
    for name in dependencies:
        if not name.startswith(("/System/Library/", "/usr/lib/")) and name != "@rpath/libMoltenVK.dylib":
            raise ValueError(f"Unbundled macOS dependency: {name}")
    return dependencies


def write_tar(path: Path, files: dict[str, bytes], executable: set[str], prefix: str) -> None:
    with tarfile.open(path, "x:gz") as archive:
        for name, data in sorted(files.items()):
            if Path(name).is_absolute() or ".." in name.split("/") or "\\" in name:
                raise ValueError(f"Invalid package path: {name}")
            entry = tarfile.TarInfo(f"{prefix}/{name}")
            entry.mode = 0o755 if name in executable else 0o644
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))


def sign_mac(bundle: Path) -> dict:
    identity = os.environ.get("OPENSLOPE_MACOS_SIGN_IDENTITY", "-")
    options = ["--options", "runtime", "--timestamp"] if identity != "-" else []
    for name in ("Frameworks/libMoltenVK.dylib", "MacOS/openslope_import", "MacOS/openslope_inspect"):
        run("codesign", "--force", "--sign", identity, *options, bundle / "Contents" / name)
    run("codesign", "--force", "--sign", identity, *options, bundle)
    notarized = False
    profile = os.environ.get("OPENSLOPE_MACOS_NOTARY_PROFILE")
    if profile:
        if identity == "-":
            raise ValueError("Notarization requires a Developer ID signing identity")
        with tempfile.TemporaryDirectory() as temporary:
            upload = Path(temporary) / "OpenSlope.zip"
            run("ditto", "-c", "-k", "--keepParent", bundle, upload)
            result = json.loads(
                run(
                    "xcrun",
                    "notarytool",
                    "submit",
                    upload,
                    "--keychain-profile",
                    profile,
                    "--wait",
                    "--output-format",
                    "json",
                )
            )
            if result.get("status") != "Accepted":
                raise ValueError("Apple did not accept the notarization submission")
            run("xcrun", "stapler", "staple", bundle)
            run("xcrun", "stapler", "validate", bundle)
            notarized = True
    run("codesign", "--verify", "--deep", "--strict", bundle)
    return {"identity": "ad-hoc" if identity == "-" else identity, "notarized": notarized}


def package(build: Path, output: Path, platform: str, preview: bool) -> Path:
    version = (NATIVE / "VERSION.txt").read_text().strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Invalid Native version")
    revision = run("git", "rev-parse", "HEAD").strip()
    dirty = bool(run("git", "status", "--porcelain").strip())
    if dirty and not preview:
        raise ValueError("Public packages require clean committed source")
    cache = (build / "CMakeCache.txt").read_text()
    if f"CMAKE_PROJECT_VERSION:STATIC={version}\n" not in cache or "OPENSLOPE_BUILD_PLAYER:BOOL=ON\n" not in cache:
        raise ValueError("Desktop build version or player configuration differs from the release source")
    label = f"OpenSlope-Native-{version}" + ("-preview" if preview else "")
    prefix = f"{label}-{PLATFORMS[platform]}"
    destination = output / prefix
    destination.mkdir(parents=True, exist_ok=False)
    notices = notice_files()
    dependencies = {}
    signing = None
    if platform == "linux-x64":
        files = {f"licenses/{name}": data for name, data in notices.items()}
        for name in PROGRAMS:
            path = build / name
            files[name] = path.read_bytes()
            validate_elf(files[name])
            dependencies[name] = linux_dependencies(path)
        files["Play OpenSlope.sh"] = (
            b'#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec ./openslope_player --on-foot --ui-menu "$@"\n'
        )
        files["START HERE.txt"] = (NATIVE / "distribution/linux-readme.txt").read_bytes()
        files["Maps/README.txt"] = (NATIVE / "distribution/maps-readme.txt").read_bytes()
        archive = destination / f"{prefix}.tar.gz"
        write_tar(archive, files, set(PROGRAMS) | {"Play OpenSlope.sh"}, prefix)
        inventory = {name: sha(data) for name, data in sorted(files.items())}
    else:
        architecture = "arm64" if platform == "macos-arm64" else "x86_64"
        source = build / "openslope_player.app/Contents"
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary) / prefix
            bundle = stage / "OpenSlope.app"
            contents = bundle / "Contents"
            (contents / "MacOS").mkdir(parents=True)
            (contents / "Frameworks").mkdir()
            for name in PROGRAMS:
                path = source / "MacOS" / name if name == "openslope_player" else build / name
                dependencies[name] = mac_dependencies(path, architecture)
                shutil.copyfile(path, contents / "MacOS" / name)
                (contents / "MacOS" / name).chmod(0o755)
            runtime = source / "Frameworks/libMoltenVK.dylib"
            dependencies["libMoltenVK.dylib"] = mac_dependencies(runtime, architecture)
            run("lipo", runtime, "-thin", architecture, "-output", contents / "Frameworks/libMoltenVK.dylib")
            (contents / "Frameworks/libMoltenVK.dylib").chmod(0o755)
            info = plistlib.loads((source / "Info.plist").read_bytes())
            if (
                info.get("CFBundleShortVersionString") != version
                or info.get("CFBundleExecutable") != "openslope_player"
            ):
                raise ValueError("macOS bundle identity/version differs from the release")
            (contents / "Info.plist").write_bytes(plistlib.dumps(info))
            for name, data in notices.items():
                path = contents / "Resources/licenses" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            signing = sign_mac(bundle)
            (stage / "START HERE.txt").write_bytes((NATIVE / "distribution/macos-readme.txt").read_bytes())
            files = {p.relative_to(stage).as_posix(): p.read_bytes() for p in stage.rglob("*") if p.is_file()}
            archive = destination / f"{prefix}.zip"
            # Apple's archiver preserves bundle permissions and stapled ticket metadata.
            run("ditto", "-c", "-k", "--keepParent", stage, archive)
            verified = Path(temporary) / "verified"
            run("ditto", "-x", "-k", archive, verified)
            verified_bundle = verified / prefix / "OpenSlope.app"
            run("codesign", "--verify", "--deep", "--strict", verified_bundle)
            if signing["notarized"]:
                run("xcrun", "stapler", "validate", verified_bundle)
            inventory = {name: sha(data) for name, data in sorted(files.items())}
    manifest = {
        "schema": "openslope-native-platform/v1",
        "version": version,
        "source_commit": revision,
        "source_dirty": dirty,
        "preview": preview,
        "platform": platform,
        "dependencies": dependencies,
        "signing": signing,
        "graphics_smoke": os.environ.get("OPENSLOPE_GRAPHICS_SMOKE") == "true",
        "files": inventory,
        "artifacts": {archive.name: sha(archive.read_bytes())},
    }
    (destination / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--platform", required=True, choices=PLATFORMS)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    print(package(args.build, args.output, args.platform, args.preview))


if __name__ == "__main__":
    main()
