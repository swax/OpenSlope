"""Drive the real desktop ISO/library UI from an unrelated working directory."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from import_test import big, course_members, iso
from desktop_library_test import multi_iso


def main():
    source = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix="openslope-portable-library-") as temporary:
        root = Path(temporary)
        folder = root / "app with spaces"
        folder.mkdir()
        cwd = root / "different working directory"
        cwd.mkdir()
        executable = folder / "OpenSlope.exe"
        shutil.copy2(source, executable)

        def run(option):
            result = subprocess.run([str(executable), option, "--no-audio"], cwd=cwd,
                                    capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stdout + result.stderr
            assert "Desktop library smoke: PASS" in result.stdout, result.stdout
            assert "Vulkan window/swapchain smoke: PASS" in result.stdout, result.stdout
            return result

        run("--library-empty-smoke")
        image = folder / "My Disc.ISO"
        image.write_bytes(b"invalid image")
        run("--library-error-smoke")
        assert not (folder / "Maps").exists(), "Inspecting an unsupported source must not create or modify maps"
        unsupported = course_members()
        unsupported["fixture.pbd"] = bytes(4) + unsupported["fixture.pbd"][4:]
        image.write_bytes(iso(big(unsupported)))
        result = run("--library-error-smoke")
        assert "Only SSX Tricky PS2 courses are supported" in result.stderr, result.stderr

        names = ["FIXTURE", "SECOND", "THIRD", "FOURTH", "FIFTH", "SIXTH"]
        image.write_bytes(multi_iso(names))
        iso_hash = hashlib.sha256(image.read_bytes()).digest()
        run("--library-smoke")
        assert all((folder / "Maps" / name / "Patches.json").is_file() for name in names), "Every selected row must extract, including the course reached by scrolling"
        course = folder / "Maps" / "FIXTURE"
        assert json.loads((course / "Patches.json").read_text())["Patches"]
        (course / "keep-local.txt").write_text("local edits")
        hashes = {p.relative_to(course): hashlib.sha256(p.read_bytes()).digest()
                  for p in course.rglob("*") if p.is_file()}
        run("--library-smoke")
        assert all(hashlib.sha256((course / p).read_bytes()).digest() == digest for p, digest in hashes.items())
        assert hashlib.sha256(image.read_bytes()).digest() == iso_hash
        image.unlink()
        run("--library-smoke")
        assert not (cwd / "Maps").exists(), "Setup used the process working directory instead of the executable folder"
        assert not any(p.name.startswith(".openslope-import-") for p in (folder / "Maps").iterdir())
    print("PASS: six production Vulkan library flows: empty setup, corrupt/unsupported ISO, six-row queued extraction and scrolling, explicit Play, existing-map reuse and ISO-free playback from a different working directory")


if __name__ == "__main__":
    main()
