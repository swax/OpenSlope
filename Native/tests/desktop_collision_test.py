"""Authored prop contacts through the production desktop Vulkan host."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def write(path, value):
    path.write_text(json.dumps(value), encoding='utf-8')


def fixture(root, mode=2, mass=1, surface=-1, draw=True):
    root.mkdir()
    points = [[(u / 3 - .5) * 40000, (v / 3 - .5) * 40000, 0] for u in range(4) for v in range(4)]
    write(root / 'Patches.json', dict(Patches=[dict(PatchName='Authored world-contact floor', SurfaceType=1,
          TrickOnlyPatch=False, Points=points, UVPoints=[[0, 0], [1, 0], [0, 1], [1, 1]],
          TexturePath='', LightmapID=-1, LightMapPoint=[0, 0, 0, 0])]))
    (root / 'Meshes').mkdir()
    if mode == 2:
        mesh = 'v -50 -300 0\nv -50 300 0\nv -50 300 400\nv -50 -300 400\nv 50 -300 0\nv 50 300 0\nv 50 300 400\nv 50 -300 400\nf 1 2 3 4\nf 8 7 6 5\nf 1 5 6 2\nf 4 3 7 8\nf 1 4 8 5\nf 2 6 7 3\n'
        bounds = dict(Min=[-50, -300, 0], Max=[50, 300, 400])
    else:
        mesh = 'v -400 -400 150\nv 400 -400 150\nv 400 400 150\nv -400 400 150\nvn 0 0 1\nf 1//1 2//1 3//1\nf 1//1 3//1 4//1\n'
        bounds = dict(Min=[-400, -400, 150], Max=[400, 400, 150])
        (root / 'Collision').mkdir()
        (root / 'Collision/deck.obj').write_text(mesh)
    (root / 'Meshes/prop.obj').write_text(mesh)
    write(root / 'Models.json', dict(Models=[dict(ModelObjects=[dict(ParentID=-1, CollisionBounds=bounds,
          MeshData=[dict(MeshPath='prop.obj', MaterialID=0)] if draw else [])])]))
    write(root / 'Materials.json', dict(Materials=[dict(TexturePath=None)]))
    write(root / 'Instances.json', dict(Instances=[dict(ModelID=0, CollsionMode=mode, PlayerCollision=True,
          PlayerBounce=True, U0=mass, PlayerBounceAmmount=.5, SurfaceType=surface, Visable=mass != 0,
          CollsionModelPaths=['deck.obj'] if mode == 1 else None, EffectSlotIndex=7)]))


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-desktop-collision-') as temporary:
        base = Path(temporary)
        for name, mode, mass, surface, placement, ticks, expected in [
                ('solid', 2, 1, -1, dict(Position=[-1.5, -.005, 0], Forward=[1, 0, 0], Velocity=[12, 0, 0]), 20, ['contacts 1', 'bounces 1', 'wipeout 0']),
                ('trigger', 2, 0, -1, dict(Position=[-2, -.005, 0], Forward=[1, 0, 0], Velocity=[12, 0, 0]), 30, ['contacts 1', 'bounces 0', 'wipeout 0']),
                ('deck', 1, 1, 5, dict(Position=[0, 2.2, 0], Forward=[0, 0, -1], Velocity=[0, -25, 0]), 2, ['landings 1', 'grounded 1', 'surface 5', 'ground prop 0', 'bounces 0']),
                ('bounds', 2, 1, 5, dict(Position=[0, 4.2, 0], Forward=[0, 0, -1], Velocity=[0, -25, 0]), 1, ['landings 1', 'grounded 1', 'surface 5', 'ground prop 0', 'bounces 0'])]:
            root = base / name
            fixture(root, mode, mass, surface, name != 'bounds')
            replay, capture = root / 'replay.json', root / 'frame.ppm'
            write(replay, dict(Schema='openslope-replay/v1', Placement=placement, Steps=[dict(Ticks=ticks)]))
            result = subprocess.run([str(executable), '--map', str(root), '--replay', str(replay), '--capture', str(capture)], capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stdout + result.stderr
            for value in expected:
                assert value in result.stdout, result.stdout
            values = re.search(r'position \[([^\]]+)\]; velocity \[([^\]]+)\]', result.stdout)
            position, velocity = [list(map(float, value.split(','))) for value in values.groups()]
            if name == 'solid':
                assert position[0] < -.5 and velocity[0] < 0, result.stdout
            if name == 'trigger':
                assert position[0] > .5 and velocity[0] > 0, result.stdout
            if name == 'deck':
                assert abs(position[1] - 1.5) < .001, result.stdout
            if name == 'bounds':
                assert abs(position[1] - 4) < .001 and 'Visible props: 0' in result.stdout, result.stdout
            header = capture.read_bytes().split(b'\n', 3)
            assert header[:3] == [b'P6', b'1280 720', b'255']
            assert len(header[3]) == 1280 * 720 * 3
            pixels = header[3]
            board = sum(all(abs(channel - expected) <= 1 for channel, expected in zip(pixels[i:i+3], (13, 166, 153))) for i in range(0, len(pixels), 3))
            assert board > 25, f'{name}: only {board} rendered board pixels'
            print(f'PASS: desktop Vulkan {name} replay ({ticks} rendered frames)')


if __name__ == '__main__':
    main()
