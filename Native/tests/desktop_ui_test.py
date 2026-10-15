"""Drive actual desktop menu actions and replace a live map through the Vulkan window host."""
from pathlib import Path
import subprocess
import sys
import tempfile
from desktop_collision_test import fixture


def main():
    exe = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-menu-map-') as folder:
        root = Path(folder)
        # Neither map has a race finish: mode selection must skip that unsupported event.
        fixture(root / 'A', mass=0, draw=False)
        fixture(root / 'B', mass=0, draw=False)
        result = subprocess.run([str(exe), '--map', str(root / 'A'), '--ui-smoke', '--seconds', '10', '--no-audio'],
                                cwd=root, capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'Desktop UI/map load smoke: PASS' in result.stdout, result.stdout
        assert 'Vulkan window/swapchain smoke: PASS' in result.stdout, result.stdout
        print(result.stdout.strip())


if __name__ == '__main__':
    main()
