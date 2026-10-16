"""Check steep-corner containment through Maps loading, fixed ticks and Vulkan."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def fixture(root, runup):
    width = .02
    patches = []
    for name in ['floor', 'side', 'front', 'top']:
        points = []
        for u in range(4):
            for v in range(4):
                if name == 'floor':
                    x, y, z = (u / 3 - .5) * 200, 0, (v / 3 - .5) * 200
                elif name == 'side':
                    x, y, z = width * u / 3, 10 * u / 3, 20 * v / 3
                elif name == 'front':
                    x, y, z = 20 * u / 3, 10 * v / 3, width * v / 3
                else:
                    x, y, z = width + 20 * u / 3, 10, width + 20 * v / 3
                points.append([100*x, -100*z, 100*y])
        patches.append(dict(PatchName='Authored jump ' + name, SurfaceType=1,
                            TrickOnlyPatch=False, Points=points, TexturePath='',
                            LightmapID=-1, LightMapPoint=[0, 0, 0, 0],
                            UVPoints=[[0, 0], [1, 0], [0, 1], [1, 1]]))
    (root / 'Patches.json').write_text(json.dumps(dict(Patches=patches)))
    (root / 'replay.json').write_text(json.dumps(dict(Schema='openslope-replay/v1',
        Placement=dict(Position=[-.05, -.005, -runup], Forward=[0, 0, 1], Velocity=[2, 0, 15]),
        Steps=[dict(Ticks=120, Steer=.5)])))


def main():
    executable = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix='openslope-jump-corner-') as temporary:
        root = Path(temporary)
        for runup in [.5, 2, 5]:
            fixture(root, runup)
            image = root / 'corner.ppm'
            result = subprocess.run([executable, '--map', str(root), '--replay', str(root / 'replay.json'),
                                 '--capture', str(image), '--no-audio', '--snow', '0',
                                 '--render-scale', '100', '--msaa', '1'],
                                capture_output=True, text=True, timeout=120)
            assert result.returncode == 0, result.stdout + result.stderr
            position = re.search(r'position \[([^]]+)\]', result.stdout)
            assert position, result.stdout
            assert float(position[1].split(',')[1]) >= -.3, f'runup {runup}\n{result.stdout}'
            assert 'wipeout 0;' in result.stdout and 'pending 0; fade 0' in result.stdout, result.stdout
            picture = image.read_bytes().split(b'\n', 3)
            assert picture[:3] == [b'P6', b'1280 720', b'255'] and len(picture[3]) == 1280*720*3
            assert len(set(picture[3])) > 20, 'Corner scene did not render'
    print('PASS: 360 production Vulkan frames retain steep-corner containment without a knockdown or reset')


if __name__ == '__main__':
    main()
