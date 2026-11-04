#!/usr/bin/env python3
"""Cross-platform archive and release-assembly contracts, using synthetic binaries."""

import json
import os
import plistlib
import struct
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import assemble_release as assemble
import package_desktop as desktop
import package_release as release


def elf(machine=62, kind=3):
    data = bytearray(64)
    data[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HH", data, 16, kind, machine)
    return bytes(data)


class DesktopPackagingTests(unittest.TestCase):
    def test_linux_binary_architecture(self):
        desktop.validate_elf(elf())
        for data in (elf(machine=183), elf(kind=1), b"MZ", elf()[:18]):
            with self.assertRaises(ValueError):
                desktop.validate_elf(data)

    def test_linux_dependencies_must_be_system_libraries(self):
        with patch.object(desktop, "run", return_value="(NEEDED) Shared library: [libstdc++.so.6]"):
            self.assertEqual(desktop.linux_dependencies(Path("player")), ["libstdc++.so.6"])
        with patch.object(desktop, "run", return_value="(NEEDED) Shared library: [libprivate.so]"):
            with self.assertRaisesRegex(ValueError, "Unbundled"):
                desktop.linux_dependencies(Path("player"))

    def test_mac_architecture_and_dependency_paths(self):
        system = "player:\n\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0)\n"
        with patch.object(desktop, "run", side_effect=["arm64 x86_64", system]):
            self.assertEqual(desktop.mac_dependencies(Path("player"), "arm64"), ["/usr/lib/libc++.1.dylib"])
        for architecture, libraries in (
            ("x86_64", system),
            ("arm64", "player:\n\t/opt/homebrew/lib/libSDL3.dylib (version 1)"),
        ):
            with patch.object(desktop, "run", side_effect=[architecture, libraries]):
                with self.assertRaises(ValueError):
                    desktop.mac_dependencies(Path("player"), "arm64")

    def test_archive_permissions_and_path_boundaries(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            files = {"bin/player": elf(), "licenses/LICENSE": b"license"}
            desktop.write_tar(root / "linux.tar.gz", files, {"bin/player"}, "package")
            with tarfile.open(root / "linux.tar.gz") as archive:
                self.assertEqual(archive.getmember("package/bin/player").mode, 0o755)
                self.assertEqual(archive.getmember("package/licenses/LICENSE").mode, 0o644)
            release.write_zip(root / "mac.zip", files, "package", {"bin/player"})
            with zipfile.ZipFile(root / "mac.zip") as archive:
                self.assertEqual(archive.getinfo("package/bin/player").external_attr >> 16, 0o755)
                self.assertEqual(archive.getinfo("package/licenses/LICENSE").external_attr >> 16, 0o644)
            with self.assertRaises(ValueError):
                desktop.write_tar(root / "escape.tar.gz", {"../private": b"data"}, set(), "package")

    def test_linux_package_allowlist_excludes_private_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            native = root / "Native"
            (native / "distribution").mkdir(parents=True)
            (native / "VERSION.txt").write_text("1.2.3\n")
            for name in ("linux-readme.txt", "maps-readme.txt"):
                (native / "distribution" / name).write_text("readme\n")
            build = root / "build"
            build.mkdir()
            (build / "CMakeCache.txt").write_text(
                "CMAKE_PROJECT_VERSION:STATIC=1.2.3\nOPENSLOPE_BUILD_PLAYER:BOOL=ON\n"
            )
            for name in desktop.PROGRAMS:
                (build / name).write_bytes(elf())
            (build / "private.iso").write_bytes(b"private")
            with (
                patch.object(desktop, "NATIVE", native),
                patch.object(desktop, "notice_files", return_value={"LICENSE": b"terms"}),
                patch.object(desktop, "run", side_effect=["a" * 40, ""]),
                patch.object(desktop, "linux_dependencies", return_value=["libc.so.6"]),
            ):
                destination = desktop.package(build, root / "output", "linux-x64", False)
            manifest = json.loads((destination / "release-manifest.json").read_text())
            self.assertEqual(manifest["platform"], "linux-x64")
            for name, digest in manifest["artifacts"].items():
                self.assertEqual(release.sha((destination / name).read_bytes()), digest)
            with tarfile.open(next(destination.glob("*.tar.gz"))) as archive:
                self.assertFalse(any("private" in name for name in archive.getnames()))
                self.assertEqual(len(archive.getnames()), 7)

    def test_public_package_requires_clean_source(self):
        with patch.object(desktop, "run", side_effect=["a" * 40, " M Native/src/desktop_app.cpp"]):
            with self.assertRaisesRegex(ValueError, "clean committed"):
                desktop.package(Path("unused"), Path("unused"), "linux-x64", False)

    def test_mac_bundle_selects_only_runtime_inputs_and_preserves_signatures(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            native = root / "Native"
            (native / "distribution").mkdir(parents=True)
            (native / "VERSION.txt").write_text("1.2.3\n")
            (native / "distribution/macos-readme.txt").write_text("instructions")
            build = root / "build"
            contents = build / "openslope_player.app/Contents"
            (contents / "MacOS").mkdir(parents=True)
            (contents / "Frameworks").mkdir()
            (contents / "MacOS/openslope_player").write_bytes(b"player")
            (contents / "MacOS/private.iso").write_bytes(b"private")
            (contents / "Frameworks/libMoltenVK.dylib").write_bytes(b"runtime")
            (contents / "Info.plist").write_bytes(
                plistlib.dumps({"CFBundleShortVersionString": "1.2.3", "CFBundleExecutable": "openslope_player"})
            )
            (build / "CMakeCache.txt").write_text(
                "CMAKE_PROJECT_VERSION:STATIC=1.2.3\nOPENSLOPE_BUILD_PLAYER:BOOL=ON\n"
            )
            for name in desktop.PROGRAMS[1:]:
                (build / name).write_bytes(b"tool")

            def command(*args):
                if args[0] == "git":
                    return "a" * 40 if args[1] == "rev-parse" else ""
                if args[0] == "lipo":
                    Path(args[-1]).write_bytes(b"thin runtime")
                elif args[0] == "ditto" and "-c" in args:
                    stage = Path(args[-2])
                    files = {p.relative_to(stage).as_posix(): p.read_bytes() for p in stage.rglob("*") if p.is_file()}
                    release.write_zip(Path(args[-1]), files, stage.name)
                elif args[0] == "ditto":
                    with zipfile.ZipFile(args[-2]) as archive:
                        archive.extractall(args[-1])
                else:
                    self.assertEqual(args[:2], ("codesign", "--verify"))
                    self.assertTrue(Path(args[-1]).is_dir())
                return ""

            def sign(bundle):
                (bundle / "Contents/_CodeSignature").mkdir()
                (bundle / "Contents/_CodeSignature/CodeResources").write_bytes(b"signature")
                return {"identity": "ad-hoc", "notarized": False}

            with (
                patch.object(desktop, "NATIVE", native),
                patch.object(desktop, "notice_files", return_value={"LICENSE": b"terms"}),
                patch.object(desktop, "run", side_effect=command),
                patch.object(desktop, "sign_mac", side_effect=sign),
                patch.object(desktop, "mac_dependencies", return_value=[]),
            ):
                destination = desktop.package(build, root / "output", "macos-arm64", False)
            with zipfile.ZipFile(next(destination.glob("*.zip"))) as archive:
                signature = next(name for name in archive.namelist() if name.endswith("_CodeSignature/CodeResources"))
                self.assertEqual(archive.read(signature), b"signature")
                self.assertFalse(any("private" in name for name in archive.namelist()))

    def test_notarization_cannot_use_ad_hoc_identity(self):
        with (
            patch.dict(os.environ, {"OPENSLOPE_MACOS_SIGN_IDENTITY": "-", "OPENSLOPE_MACOS_NOTARY_PROFILE": "test"}),
            patch.object(desktop, "run", return_value=""),
        ):
            with self.assertRaisesRegex(ValueError, "Developer ID"):
                desktop.sign_mac(Path("bundle"))


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.native = self.root / "Native"
        (self.native / "releases").mkdir(parents=True)
        (self.native / "VERSION.txt").write_text("1.2.3\n")
        (self.native / "releases/1.2.3.md").write_text("# Changes\n")
        self.inputs = []
        for platform, suffixes in {
            "windows-quest": ["Windows-x64.zip", "Quest-arm64.apk"],
            "linux-x64": ["Linux-x64.tar.gz"],
            "macos-arm64": ["macOS-arm64.zip"],
            "macos-x64": ["macOS-x64.zip"],
        }.items():
            directory = self.root / platform
            directory.mkdir()
            artifacts = {}
            for suffix in suffixes:
                name = f"OpenSlope-Native-1.2.3-{suffix}"
                (directory / name).write_bytes(platform.encode())
                artifacts[name] = release.sha(platform.encode())
            if platform == "windows-quest":
                (directory / "RELEASE-NOTES.md").write_bytes(b"notes")
                artifacts["RELEASE-NOTES.md"] = release.sha(b"notes")
            manifest = {
                "platform": platform,
                "source_commit": "a" * 40,
                "version": "1.2.3",
                "source_dirty": False,
                "preview": False,
                "artifacts": artifacts,
                "signing": {"identity": "ad-hoc", "notarized": False},
            }
            (directory / "release-manifest.json").write_text(json.dumps(manifest))
            self.inputs.append(directory)

    def assemble(self):
        with patch.object(assemble, "NATIVE", self.native), patch.object(assemble, "run", return_value="a" * 40):
            return assemble.assemble(self.inputs, self.root / "output")

    def test_complete_release_checksums_cover_every_platform(self):
        destination = self.assemble()
        self.assertEqual(len(list(destination.iterdir())), 8)
        manifest = json.loads((destination / "release-manifest.json").read_text())
        self.assertEqual(len(manifest["platforms"]), 4)
        for line in (destination / "SHA256SUMS.txt").read_text().splitlines():
            digest, name = line.split("  ")
            self.assertEqual(release.sha((destination / name).read_bytes()), digest)
        self.assertIn("Apple notarized: no", (destination / "RELEASE-NOTES.md").read_text())
        with self.assertRaises(FileExistsError):
            self.assemble()

    def test_release_requires_every_platform(self):
        self.inputs.pop()
        with self.assertRaisesRegex(ValueError, "requires"):
            self.assemble()

    def test_release_rejects_modified_artifact(self):
        next(self.inputs[1].glob("*.tar.gz")).write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.assemble()

    def test_release_rejects_mixed_commit_dirty_and_preview(self):
        path = self.inputs[1] / "release-manifest.json"
        original = json.loads(path.read_text())
        for key, value in (
            ("source_commit", "b" * 40),
            ("version", "1.2.2"),
            ("source_dirty", True),
            ("preview", True),
        ):
            path.write_text(json.dumps({**original, key: value}))
            with self.assertRaises(ValueError):
                self.assemble()


if __name__ == "__main__":
    unittest.main()
