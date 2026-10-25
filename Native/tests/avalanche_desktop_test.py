"""Drive the production native library from a packed authored RVZ."""
from pathlib import Path
import json
import shutil
import subprocess
import sys
import tempfile
from avalanche_import_test import COURSES, course_packages, gcm, rvz


def main():
    source = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-avalanche-desktop-') as temporary:
        root = Path(temporary)
        app = root/'app with spaces'; app.mkdir()
        working = root/'different working directory'; working.mkdir()
        executable = app/'OpenSlope.exe'
        shutil.copy2(source, executable)
        image = app/'First Avalanche.RVZ'
        image.write_bytes(rvz(gcm(course_packages()), packing=True))
        for _ in range(2):
            result = subprocess.run([str(executable), '--library-smoke', '--no-audio'], cwd=working,
                                    capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stdout+result.stderr
            assert 'Desktop library smoke: PASS' in result.stdout, result.stdout
            assert 'Vulkan window/swapchain smoke: PASS' in result.stdout, result.stdout
            for stem, _difficulty in COURSES:
                course = app/('Maps/AVALANCHE_'+stem.upper())
                assert json.loads((course/'Import.json').read_text())['TrunkProxies'] == 1
                assert (course/'Textures/ava-0.png').is_file()
        assert not (working/'Maps').exists()
        assert not any(p.name.startswith('.openslope-import-') for p in (app/'Maps').iterdir())
    print('PASS: production native RVZ discovery, queued extraction, texture staging, Play and existing-map reuse')


if __name__ == '__main__':
    main()
