"""Production-host four-rail spray checks with independently authored map/art."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from appearance_test import rgba


def write(path, value):
    path.write_text(json.dumps(value), encoding='utf-8')


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-desktop-sheet-') as temporary:
        base = Path(temporary)
        for name, surface, steer in [('left',1,.75), ('right',1,-.75), ('powder',3,.75),
                                      ('deep',4,.75), ('straight',1,0), ('light',1,.2),
                                      ('ice',5,.75), ('rock',9,.75)]:
            root = base / name
            (root / 'Textures').mkdir(parents=True)
            points = [[(u / 3 - .5) * 100000, (v / 3 - .5) * 100000, 0] for u in range(4) for v in range(4)]
            write(root / 'Patches.json', dict(Patches=[dict(PatchName='Authored sheet floor', SurfaceType=surface,
                  Points=points, TrickOnlyPatch=False, UVPoints=[[0,0],[1,0],[0,1],[1,1]],
                  TexturePath='ground.png', LightmapID=-1, LightMapPoint=[0,0,0,0])]))
            (root / 'Textures/ground.png').write_bytes(rgba(1,1,[100,140,180,255]))
            (root / 'Textures/sheet.png').write_bytes(rgba(1,1,[255,255,255,200]))
            write(root / 'replay.json', dict(Schema='openslope-replay/v1',
                  Placement=dict(Position=[0,-.005,0], Forward=[0,0,-1], Velocity=[0,0,-18]),
                  Steps=[dict(Ticks=80,Steer=steer)]))
            states, frames = [], []
            for enabled in [False,True]:
                write(root / 'RidingEffects.json', dict(Schema='openslope-riding-effects/v1', Enabled=enabled, Sheet='sheet.png'))
                output = root / f'{enabled}.ppm'
                result = subprocess.run([str(executable),'--map',str(root),'--replay',str(root/'replay.json'),
                                         '--capture',str(output)],text=True,capture_output=True,timeout=90)
                assert result.returncode == 0, result.stdout + result.stderr
                assert 'grounded 1' in result.stdout and '0 drawn sprites' in result.stdout, result.stdout
                values = re.search(r'Spray sheet: (\d+) columns; (\d+) segments; (\d+) additive draws', result.stdout)
                assert values, result.stdout
                columns, segments, draws = map(int,values.groups())
                assert columns <= 128 and segments <= 127
                should_draw = enabled and surface in (1,3,4) and abs(steer) > .3
                assert (draws == 1 and segments > 4) == should_draw, result.stdout
                states.append(re.search(r'position \[[^\]]+\]; velocity \[[^\]]+\]',result.stdout).group())
                header = output.read_bytes().split(b'\n',3)
                assert header[:3] == [b'P6',b'1280 720',b'255']
                frames.append(header[3])
            assert states[0] == states[1], 'Spray rendering changed player state'
            changed = sum(a != b for a,b in zip(*frames))
            assert (changed > 90) if should_draw else changed == 0, (name,changed)
            print(f'PASS: desktop {name} sheet ({changed} changed channels, unchanged rider state)')


if __name__ == '__main__':
    main()
