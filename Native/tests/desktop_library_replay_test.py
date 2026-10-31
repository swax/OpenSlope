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
from audio_import_test import archive, disc
from ssx3_import_test import members as ssx3_members
from course_titles_test import executable as title_executable, boot_files


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
        assert all((folder / "Maps" / ("TRICKY_" + name) / "Patches.json").is_file() for name in names), "Every selected row must extract, including the course reached by scrolling"
        course = folder / "Maps" / "TRICKY_FIXTURE"
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
        ssx3_app = root / 'named SSX3 app'; ssx3_app.mkdir()
        ssx3_player = ssx3_app / 'OpenSlope.exe'; shutil.copy2(source, ssx3_player)
        files = ssx3_members()
        database = bytearray(files['data/worlds/bam.sdb'])
        database[80 + 88:80 + 88 + 16] = b'ARA1'.ljust(16, b'\0')
        files['data/worlds/bam.sdb'] = bytes(database)
        boot = bytearray(title_executable(streamed=True))
        boot[512 + 48:512 + 64] = b'ARA1'.ljust(16, b'\0')
        (ssx3_app / 'SSX3.iso').write_bytes(disc({'DATA/WORLDS/BAM.BIG': archive(files), **boot_files(bytes(boot))}))
        result = subprocess.run([str(ssx3_player), '--library-smoke', '--no-audio'], cwd=cwd,
                                capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'Desktop library smoke: PASS' in result.stdout
        metadata = json.loads((ssx3_app / 'Maps/SSX3_ARA1/Import.json').read_text())
        assert metadata['DisplayName'] == 'Disc Snow Run' and metadata['MapType'] == 'run'
        assert metadata['WorldId'] == 'ssx-3:bam'
        assert sorted(path.name for path in (ssx3_app / 'Maps').iterdir()) == ['SSX3_ARA1'], 'Default selection must skip hubs and full peaks'
    print("PASS: production Vulkan library flows: empty setup, corrupt/unsupported ISO, queued extraction and scrolling, explicit Play, existing-map reuse, ISO-free playback and named SSX3 runs without hubs or peaks")


if __name__ == "__main__":
    main()
