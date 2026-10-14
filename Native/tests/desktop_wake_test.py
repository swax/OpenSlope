"""Verify wake-only art and surface/prop contacts through the production host."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from appearance_test import rgba
from desktop_collision_test import fixture as prop_fixture


def write(path, value):
    path.write_text(json.dumps(value), encoding='utf-8')


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-desktop-wake-') as temporary:
        base = Path(temporary)
        for name, surface, steer, deck in [('straight', 1, 0, False), ('carve', 1, .75, False),
                                           ('powder', 3, 0, False), ('ice', 5, 0, False),
                                           ('rock', 9, 0, False), ('deck', 1, 0, True)]:
            root = base / name
            if deck:
                prop_fixture(root, 1, 1, 1)
                mesh = 'v -4000 -4000 150\nv 4000 -4000 150\nv 4000 4000 150\nv -4000 4000 150\nvn 0 0 1\nf 1//1 2//1 3//1\nf 1//1 3//1 4//1\n'
                for path in ['Meshes/prop.obj', 'Collision/deck.obj']:
                    (root / path).write_text(mesh)
                models = json.loads((root / 'Models.json').read_text())
                models['Models'][0]['ModelObjects'][0]['CollisionBounds'] = dict(Min=[-4000,-4000,150], Max=[4000,4000,150])
                write(root / 'Models.json', models)
                write(root / 'Materials.json', dict(Materials=[dict(TexturePath='ground.png')]))
            else:
                root.mkdir()
                points = [[(u / 3 - .5) * 100000, (v / 3 - .5) * 100000, 0] for u in range(4) for v in range(4)]
                write(root / 'Patches.json', dict(Patches=[dict(PatchName='Authored wake floor', SurfaceType=surface, Points=points,
                      TrickOnlyPatch=False, UVPoints=[[0,0],[1,0],[0,1],[1,1]], TexturePath='ground.png', LightmapID=-1, LightMapPoint=[0,0,0,0])]))
            (root / 'Textures').mkdir()
            (root / 'Textures/ground.png').write_bytes(rgba(1, 1, [240,240,240,255]))
            # A single pre-shaded edge, mirrored by the second pass into two grooves.
            art = [c for y in range(32) for x in range(32) for c in [100,100,100,200 if x < 8 else 0]]
            (root / 'Textures/wake.png').write_bytes(rgba(32, 32, art))
            profile = dict(Schema='openslope-riding-effects/v1', Wake='wake.png')
            write(root / 'replay.json', dict(Schema='openslope-replay/v1',
                  Placement=dict(Position=[0,1.495 if deck else -.005,0], Forward=[0,0,-1], Velocity=[0,0,-18]),
                  Steps=[dict(Ticks=90, Steer=steer)]))
            captures, states = [], []
            for enabled in [False, True]:
                profile['Enabled'] = enabled
                write(root / 'RidingEffects.json', profile)
                output = root / f'{enabled}.ppm'
                result = subprocess.run([str(executable), '--map', str(root), '--replay', str(root / 'replay.json'),
                                         '--capture', str(output)], capture_output=True, text=True, timeout=90)
                assert result.returncode == 0, result.stdout + result.stderr
                assert 'grounded 1' in result.stdout and '0 drawn sprites' in result.stdout, result.stdout
                if deck:
                    assert 'ground prop 0' in result.stdout, result.stdout
                wake = re.search(r'Wake: (\d+) sections; (\d+) segments; (\d+) alpha passes', result.stdout)
                assert wake, result.stdout
                sections, segments, passes = map(int, wake.groups())
                assert sections <= 100 and segments <= 99
                assert (passes == 2 and segments > 8) == (enabled and surface != 9), result.stdout
                states.append(re.search(r'position \[[^\]]+\]; velocity \[[^\]]+\]', result.stdout).group())
                header = output.read_bytes().split(b'\n', 3)
                assert header[:3] == [b'P6', b'1280 720', b'255']
                captures.append(header[3])
            assert states[0] == states[1], 'Rendering the wake changed riding state'
            changed = sum(a != b for a, b in zip(*captures))
            assert (changed > 90) if surface != 9 else changed == 0, (name, changed)
            print(f'PASS: desktop {name} wake ({changed} changed channels, unchanged riding state)')


if __name__ == '__main__':
    main()
