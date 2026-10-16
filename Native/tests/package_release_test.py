#!/usr/bin/env python3
"""Exercise distribution boundaries without proprietary courses or a signing key."""
import importlib.util
import json
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("package_release", Path(__file__).parents[1] / "tools/package_release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def executable(dll="KERNEL32.dll", machine=0x8664):
    data = bytearray(1024)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 128)
    data[128:132] = b"PE\0\0"
    struct.pack_into("<HH", data, 132, machine, 1)
    struct.pack_into("<H", data, 148, 240)
    struct.pack_into("<H", data, 152, 0x20B)
    struct.pack_into("<II", data, 272, 0x1000, 40)
    struct.pack_into("<IIII", data, 400, 512, 0x1000, 512, 512)
    struct.pack_into("<IIIII", data, 512, 1, 0, 0, 0x1080, 1)
    name = dll.encode("ascii") + b"\0"
    data[640:640 + len(name)] = name
    return bytes(data)


def apk(path, notices, extra=None):
    files = {f"assets/{name}": data for name, data in notices.items()}
    files.update({"AndroidManifest.xml": b"manifest", "classes.dex": b"dex",
                  "resources.arsc": b"resources", "res/layout/menu.xml": b"layout",
                  "lib/arm64-v8a/libopenslope_player.so": b"library"})
    files.update(extra or {})
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)


class PackagingTests(unittest.TestCase):
    def test_windows_architecture_and_runtime(self):
        self.assertEqual(release.validate_windows(executable()), ["kernel32.dll"])
        for data in (executable(machine=0x14C), executable("VCRUNTIME140.dll"), executable("unexpected.dll")):
            with self.assertRaises(ValueError):
                release.validate_windows(data)

    def test_apk_contains_only_notices_and_arm64_runtime(self):
        notices = {"LICENSE": b"terms"}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "app.apk"
            apk(path, notices)
            release.validate_apk_files(path, notices)
            apk(path, notices, {"META-INF/version-control-info.textproto": b"generate_error_reason: NO_SUPPORTED_VCS_FOUND\n",
                                "res/0J.xml": b"compiled application resource"})
            release.validate_apk_files(path, notices)
            for extra in ({"assets/course.iso": b"private"}, {"Maps/DEMO/Patches.json": b"private"},
                          {"META-INF/private.iso": b"private"},
                          {"lib/x86/test.so": b"library"}, {"assets/LICENSE": b"old terms"}):
                apk(path, notices, extra)
                with self.assertRaises(ValueError):
                    release.validate_apk_files(path, notices)

    def test_public_apk_rejects_debug_build_or_debug_certificate(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "app.apk"
            apk(path, {})
            badge = "package: name='org.openslope.nativeplayer' versionCode='69' versionName='0.66.0'\nnative-code: 'arm64-v8a'\n"
            certificate = "Signer #1 certificate SHA-256 digest: " + "ab" * 32
            with patch.object(release, "run", side_effect=[badge, certificate]):
                result = release.validate_android(path, Path(folder), "0.66.0", 69, False, {})
                self.assertFalse(result["debuggable"])
                self.assertFalse(result["debug_certificate"])
            for extra_badge, extra_cert in (("application-debuggable", ""), ("", "CN=Android Debug")):
                with patch.object(release, "run", side_effect=[badge + extra_badge, certificate + extra_cert]):
                    with self.assertRaises(ValueError):
                        release.validate_android(path, Path(folder), "0.66.0", 69, False, {})
                with patch.object(release, "run", side_effect=[badge + extra_badge, certificate + extra_cert]):
                    result = release.validate_android(path, Path(folder), "0.66.0", 69, True, {})
                    self.assertEqual(result["signer_sha256"], "ab" * 32)
            with patch.object(release, "run", return_value=badge.replace("0.66.0", "0.65.0")):
                with self.assertRaises(ValueError):
                    release.validate_android(path, Path(folder), "0.66.0", 69, False, {})

    def test_portable_zip_uses_explicit_inputs_and_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            native = root / "Native"
            (native / "distribution").mkdir(parents=True)
            (native / "releases").mkdir()
            (native / "android/app").mkdir(parents=True)
            (native / "VERSION.txt").write_text("0.66.0\n")
            (native / "android/app/build.gradle").write_text("versionCode 69\n")
            (native / "releases/0.66.0.md").write_text("# Test release\n")
            for source in ("windows-readme.txt", "maps-readme.txt", "Import-Courses.ps1"):
                (native / "distribution" / source).write_text("instructions\n")
            build = root / "build"
            (build / "Release/Maps/PRIVATE").mkdir(parents=True)
            (build / "Release/Maps/PRIVATE/Patches.json").write_text("private")
            (build / "Release/private.iso").write_bytes(b"private")
            (build / "Release/unexpected.dll").write_bytes(b"private")
            (build / "CMakeCache.txt").write_text("CMAKE_PROJECT_VERSION:STATIC=0.66.0\nCMAKE_MSVC_RUNTIME_LIBRARY:STRING=MultiThreaded\n")
            for name in release.WINDOWS_PROGRAMS:
                (build / "Release" / name).write_bytes(executable())
            source_apk = root / "source.apk"
            source_apk.write_bytes(b"verified separately")
            with (patch.object(release, "ROOT", root), patch.object(release, "NATIVE", native),
                  patch.object(release, "notice_files", return_value={"LICENSE": b"terms"}),
                  patch.object(release, "validate_android", return_value={"signer_sha256": "ab" * 32}),
                  patch.object(release, "run", side_effect=lambda *args: "a" * 40 if args[1] == "rev-parse" else "")):
                destination = release.package(build, source_apk, root / "output", root, False)
                archive = next(destination.glob("*.zip"))
                with zipfile.ZipFile(archive) as packaged:
                    names = packaged.namelist()
                    self.assertTrue(any(name.endswith("/Maps/README.txt") for name in names))
                    self.assertTrue(any(name.endswith("/OpenSlope.exe") for name in names))
                    self.assertFalse(any("PRIVATE" in name or name.endswith((".iso", ".dll", "Patches.json")) for name in names))
                manifest = json.loads((destination / "release-manifest.json").read_text())
                self.assertFalse(manifest["preview"])
                self.assertFalse(manifest["source_dirty"])
                for line in (destination / "SHA256SUMS.txt").read_text().splitlines():
                    digest, name = line.split("  ", 1)
                    self.assertEqual(release.sha((destination / name).read_bytes()), digest)
                with self.assertRaisesRegex(ValueError, "already exists"):
                    release.package(build, source_apk, root / "output", root, False)

    def test_public_packages_require_clean_source(self):
        with patch.object(release, "run", side_effect=["a" * 40, " M Native/VERSION.txt"]):
            with self.assertRaisesRegex(ValueError, "clean committed"):
                release.package(Path("unused"), Path("unused"), Path("unused"), Path("unused"), False)

    def test_zip_paths_cannot_escape_package(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                release.write_zip(Path(folder) / "test.zip", {"../escape": b"data"}, "package")


if __name__ == "__main__":
    unittest.main()
