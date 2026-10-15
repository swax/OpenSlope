"""Production player/renderer coverage for the board's geometry afterimage."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from appearance_test import rgba


def main():
    executable = str(Path(sys.argv[1]).resolve())
    keep = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    if keep:
        keep.mkdir(parents=True, exist_ok=True)
    frames = 0
    with tempfile.TemporaryDirectory(prefix='openslope-boost-trail-replay-') as temporary:
        root = Path(temporary)
        (root/'Textures').mkdir()
        (root/'Textures/floor.png').write_bytes(rgba(1, 1, [20, 30, 40, 255]))

        def write(name, value):
            (root/name).write_text(json.dumps(value))

        write('Patches.json', dict(Patches=[dict(PatchName='Afterimage floor', SurfaceType=1,
            TrickOnlyPatch=False, TexturePath='floor.png', LightmapID=-1,
            LightMapPoint=[0, 0, 0, 0], UVPoints=[[0, 0], [0, 1], [1, 0], [1, 1]],
            Points=[[(u/3-.5)*200000, (v/3-.5)*200000, 0]
                    for u in range(4) for v in range(4)])]))
        write('Models.json', dict(Models=[dict(ModelObjects=[dict(ParentID=-1, MeshData=[],
            CollisionBounds=dict(Min=[-100, -100, -50], Max=[100, 100, 250]))])]))
        write('Materials.json', dict(Materials=[]))
        images = {}
        cases = [
            ('idle', 21, 0, 0), ('engage-before', 5, 1, 0), ('engage-first', 6, 2, 1),
            ('held', 21, 7, 1), ('release-short', 36, 2, 1),
            ('release-hidden', 39, 1, 0), ('release-empty', 42, 0, 0),
            ('air-idle', 21, 0, 0), ('air-held', 21, 7, 1),
            ('yellow', 201, 7, 1), ('orange', 341, 7, 1),
            ('pad', 201, 7, 1), ('trick-pad', 201, 0, 0), ('walking', 21, 0, 0),
            ('restart', 9, 0, 0),
        ]
        for name, ticks, records, draws in cases:
            timed = name in ['yellow', 'orange', 'pad', 'trick-pad']
            pad = name in ['pad', 'trick-pad']
            opcode = 18 if name == 'trick-pad' else 17
            nodes = [dict(mainType=opcode, payload={f'type{opcode}': 5}, references={}),
                dict(mainType=0, payload=dict(type0=dict(SubType=5, DeadNodeMode=2)), references={})]
            write('Effects.json', dict(kind='openslope-effects', version=1,
                graphs=[dict(id='pickup', nodes=nodes if pad else [])],
                slots=[dict(id='slot', circumstances=dict(collision='pickup'))],
                functions=[], instances=[], objectProperties=[], splines=[]))
            write('Instances.json', dict(Instances=[dict(ModelID=0, Location=[0, 0, 0],
                Visable=False, PlayerCollision=pad, PlayerBounce=False, U0=0, CollsionMode=2,
                SurfaceType=-1, EffectSlotIndex=0)]))
            steps = [dict(Ticks=ticks, Boost=name not in ['idle', 'air-idle', 'pad', 'trick-pad'])]
            if name.startswith('release'):
                steps = [dict(Ticks=21, Boost=True), dict(Ticks=ticks-21)]
            if name == 'orange':
                steps = [dict(Ticks=180), dict(Ticks=80, Steer=1), dict(Ticks=60), dict(Ticks=21, Boost=True)]
            if name == 'restart':
                steps = [dict(Ticks=8, Boost=True), dict(Ticks=1, RunRestart=True)]
            position = [0, 19 if name == 'orange' else 30 if name.startswith('air-') else -.005, 0]
            velocity = [0, 0, 0 if timed else -20]
            write('replay.json', dict(Schema='openslope-replay/v1', Placement=dict(
                Position=position, Forward=[0, 0, -1], Velocity=velocity), Steps=steps))
            args = [executable, '--map', str(root), '--mode', 'showoff' if timed else 'freeride',
                    '--replay', str(root/'replay.json'), '--capture', str(root/f'{name}.ppm'), '--no-audio']
            if name == 'walking':
                args.append('--on-foot')
            result = subprocess.run(args, capture_output=True, text=True, timeout=120)
            assert result.returncode == 0, result.stdout + result.stderr
            text = result.stdout
            assert f'Boost trail: {records} records; {records if draws else 0} segments; {draws} draws;' in text, text
            assert 'Riding effects: 0 drawn sprites;' in text, text
            expected = '1,0.9645,0' if name == 'yellow' else '1,0.4746,0' if name == 'orange' else '1,0.0758,0.002'
            if records:
                assert f'colour [{expected}]' in text, text
            if name.startswith('air-'):
                assert 'grounded 0;' in text, text
            if name == 'pad':
                assert re.search(r'Score:.*boost 0.25;', text), text
            rgb = (root/f'{name}.ppm').read_bytes().split(b'\n', 3)[3]
            assert len(rgb) == 1280*720*3
            images[name] = rgb
            if keep:
                shutil.copy2(root/f'{name}.ppm', keep/f'{name}.ppm')
                (keep/f'{name}.log').write_text(text)
            print(name, re.search(r'Boost trail:.*', text)[0])
            frames += ticks

        def red_changes(a, b):
            return sum(a[i]-b[i] > 8 and a[i]-b[i] > 2*max(0, a[i+1]-b[i+1])
                and a[i]-b[i] > 2*max(0, a[i+2]-b[i+2]) for i in range(0, len(a), 3))

        for effect, plain in [('held', 'idle'), ('air-held', 'air-idle')]:
            count = red_changes(images[effect], images[plain])
            assert count > 100, (effect, count)
            print(effect, count, 'additional red afterimage pixels without particle textures')
    print(f'PASS: {frames} production Vulkan frames verify engage/drain cadence, grounded/air pixels, '
          'meter colours, speed-pad override, trick-pad exclusion and walking suppression')


if __name__ == '__main__':
    main()
