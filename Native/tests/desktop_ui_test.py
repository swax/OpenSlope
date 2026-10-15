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
        capture = root / 'menu.ppm'
        result = subprocess.run([str(exe), '--map', str(root / 'A'), '--on-foot', '--ui-menu',
                                 '--capture', str(capture), '--seconds', '.1', '--no-audio'],
                                capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        _, dimensions, _, pixels = capture.read_bytes().split(b'\n', 3)
        w, h = map(int, dimensions.split())
        assert (w, h) == (1280, 720)
        dark = [(i // 3 % w, i // 3 // w) for i in range(0, len(pixels), 3)
                if pixels[i] < 15 and pixels[i+1] < 20 and pixels[i+2] < 30]
        left, right = min(x for x, y in dark), max(x for x, y in dark)
        top, bottom = min(y for x, y in dark), max(y for x, y in dark)
        assert right-left < w*.5 and bottom-top < h*.65, 'Menu still occupies too much of the viewport'
        mint, white = [], []
        for y in range(top + int((bottom-top)*.02), top + int((bottom-top)*.22)):
            for x in range(left + int((right-left)*.05), left + int((right-left)*.65)):
                r, g, b = pixels[(y*w+x)*3:(y*w+x)*3+3]
                if g > 180 and g > r*1.5 and b > r*1.3:
                    mint.append(y)
                if r > 210 and g > 220 and b > 230:
                    white.append(y)
        assert mint and white and min(white)-max(mint) >= 5, 'Menu heading rows overlap in the real 16:9 render'
        print('PASS: compact 16:9 desktop menu with separated heading rows')


if __name__ == '__main__':
    main()
