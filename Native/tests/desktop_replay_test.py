from gear_pixels import board_pixel
"""Run a complete authored jump/spin/landing through the actual desktop Vulkan host."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    executable = Path(sys.argv[1]).resolve()
    sequence = Path(__file__).with_name('replay-ollie.json').resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-desktop-replay-') as temporary:
        root = Path(temporary)
        row = dict(PatchName='Authored replay floor', SurfaceType=1, TrickOnlyPatch=False,
                   Points=[[(u / 3 - .5) * 100000, (v / 3 - .5) * 100000, 0] for u in range(4) for v in range(4)],
                   UVPoints=[[0, 0], [1, 0], [0, 1], [1, 1]], TexturePath='', LightmapID=-1, LightMapPoint=[0, 0, 0, 0])
        (root / 'Patches.json').write_text(json.dumps(dict(Patches=[row])), encoding='utf-8')
        output = root / 'landing.ppm'
        result = subprocess.run([str(executable), '--map', str(root), '--capture', str(output), '--replay', str(sequence)], capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        for expected in ['Replay: 269 rendered frames', 'launches 1', 'landings 1', 'grounded 1', 'switch 1', 'spin -180']:
            assert expected in result.stdout, result.stdout
        header = output.read_bytes().split(b'\n', 3)
        assert header[:3] == [b'P6', b'1280 720', b'255']
        pixels = header[3]; assert len(pixels) == 1280 * 720 * 3
        board = sum(board_pixel(pixels[i:i+3]) for i in range(0, len(pixels), 3))
        assert board > 25, f'Only {board} board pixels in the final actual-renderer frame'
    print('PASS: 269 desktop Vulkan frames cover charged launch, half-spin, switch touchdown, continued riding and visible board geometry')


if __name__ == '__main__':
    main()
