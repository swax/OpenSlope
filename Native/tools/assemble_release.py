#!/usr/bin/env python3
"""Join checked platform artifacts from one source commit into one Native release."""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

from package_release import NATIVE, run, sha


def assemble(inputs: list[Path], output: Path) -> Path:
    version = (NATIVE / "VERSION.txt").read_text().strip()
    revision = run("git", "rev-parse", "HEAD").strip()
    manifests = {}
    assets = {}
    for directory in inputs:
        manifest = json.loads((directory / "release-manifest.json").read_text())
        platform = manifest.get("platform", "windows-quest")
        if platform in manifests or platform not in {"windows-quest", "linux-x64", "macos-arm64", "macos-x64"}:
            raise ValueError(f"Duplicate or unknown platform: {platform}")
        if manifest["version"] != version or manifest["source_commit"] != revision:
            raise ValueError("Platform packages must have the same version and source commit as this checkout")
        if manifest["source_dirty"] or manifest["preview"]:
            raise ValueError("Release assembly rejects dirty-source and development-preview packages")
        expected = (
            {
                f"OpenSlope-Native-{version}-Windows-x64.zip",
                f"OpenSlope-Native-{version}-Quest-arm64.apk",
                "RELEASE-NOTES.md",
            }
            if platform == "windows-quest"
            else {
                f"OpenSlope-Native-{version}-"
                + {"linux-x64": "Linux-x64.tar.gz", "macos-arm64": "macOS-arm64.zip", "macos-x64": "macOS-x64.zip"}[
                    platform
                ]
            }
        )
        if set(manifest["artifacts"]) != expected:
            raise ValueError(f"Unexpected artifact inventory for {platform}")
        for name, digest in manifest["artifacts"].items():
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or sha((directory / name).read_bytes()) != digest:
                raise ValueError(f"Artifact path/hash mismatch: {name}")
            if name != "RELEASE-NOTES.md":
                if name in assets:
                    raise ValueError(f"Duplicate artifact: {name}")
                assets[name] = directory / name
        if platform.startswith("macos-"):
            signing = manifest.get("signing")
            if (
                not isinstance(signing, dict)
                or not signing.get("identity")
                or type(signing.get("notarized")) is not bool
            ):
                raise ValueError("Missing macOS signing metadata")
        # The assembled notes replace the Windows input's notes; retain download hashes only.
        manifest["artifacts"] = {
            name: digest for name, digest in manifest["artifacts"].items() if name != "RELEASE-NOTES.md"
        }
        manifests[platform] = manifest
    if set(manifests) != {"windows-quest", "linux-x64", "macos-arm64", "macos-x64"}:
        raise ValueError("Release assembly requires Windows/Quest, Linux x64 and both macOS architectures")
    destination = output / f"OpenSlope-Native-{version}"
    destination.mkdir(parents=True, exist_ok=False)
    for name, path in assets.items():
        shutil.copyfile(path, destination / name)
    notes = (NATIVE / "releases" / f"{version}.md").read_text(encoding="utf-8")
    notes += "\n\n## Desktop downloads\n\nLinux x64, macOS Apple Silicon (arm64), and macOS Intel (x64) are included.\n"
    for platform in ("macos-arm64", "macos-x64"):
        signing = manifests[platform]["signing"]
        notes += f"\n- {platform}: {signing['identity']}; Apple notarized: {'yes' if signing['notarized'] else 'no'}."
        if not manifests[platform].get("graphics_smoke"):
            notes += " Graphics smoke was not run on this build host; GPU-equipped Mac validation is still needed."
    notes += "\n\nSee START HERE.txt in each desktop archive for installation and storage locations.\n"
    (destination / "RELEASE-NOTES.md").write_text(notes, encoding="utf-8", newline="\n")
    manifest = {
        "schema": "openslope-native-release/v2",
        "version": version,
        "source_commit": revision,
        "source_dirty": False,
        "preview": False,
        "platforms": manifests,
        "artifacts": {p.name: sha(p.read_bytes()) for p in sorted(destination.iterdir())},
    }
    (destination / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    sums = [f"{sha(p.read_bytes())}  {p.name}\n" for p in sorted(destination.iterdir())]
    (destination / "SHA256SUMS.txt").write_text("".join(sums), encoding="ascii")
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(assemble(args.input, args.output))


if __name__ == "__main__":
    main()
