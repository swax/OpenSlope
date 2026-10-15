"""Production Vulkan/PCM coverage of pads, authored forces and held boost."""
import json
import math
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import wave

from appearance_test import rgba


def node(main, payload):
    return dict(mainType=main, payload=payload, references={})


def prop(kind, fields):
    return node(0, dict(type0=dict(SubType=kind, **{f'type0Sub{kind}': fields})))


def main():
    executable = str(Path(sys.argv[1]).resolve())
    frames = 0
    with tempfile.TemporaryDirectory(prefix='openslope-boost-replay-') as temporary:
        root = Path(temporary)
        for folder in ['Meshes', 'Textures', 'Audio/SFX/main']:
            (root/folder).mkdir(parents=True)

        def write(name, doc):
            (root/name).write_text(json.dumps(doc))

        write('Patches.json', dict(Patches=[dict(PatchName='Boost replay floor',
            SurfaceType=1, TrickOnlyPatch=False, TexturePath='', LightmapID=-1,
            LightMapPoint=[0, 0, 0, 0], UVPoints=[[0, 0], [0, 1], [1, 0], [1, 1]],
            Points=[[(u/3-.5)*200000, (v/3-.5)*200000, 0]
                    for u in range(4) for v in range(4)])]))
        (root/'Textures/pad.png').write_bytes(rgba(1, 1, [230, 15, 245, 255]))
        (root/'Meshes/pad.obj').write_text(
            'v 0 -65 40\nv 0 65 40\nv 0 65 180\nv 0 -65 180\n'
            'vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn -1 0 0\n'
            'f 1/1/1 2/2/1 3/3/1\nf 1/1/1 3/3/1 4/4/1\n')
        write('Models.json', dict(Models=[dict(ModelObjects=[dict(ParentID=-1,
            MeshData=[dict(MeshPath='pad.obj', MaterialID=0)],
            CollisionBounds=dict(Min=[-1000, -1000, -100], Max=[1000, 1000, 10000]))])]))
        write('Materials.json', dict(Materials=[dict(TexturePath='pad.png', UnknownInt18=1 << 17)]))
        write('Audio/SoundIndex.json', dict(Schema='openslope-sound-index/v1',
            Banks={'0': 'main'}, CollisionEvents={}))
        for slot, frequency in [(114, 440), (115, 660), (120, 880)]:
            samples = [int(7000*math.sin(2*math.pi*frequency*i/48000)) for i in range(4800)]
            with wave.open(str(root/f'Audio/SFX/main/{slot}.wav'), 'wb') as sound:
                sound.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
                sound.writeframes(struct.pack('<4800h', *samples))

        def run(name, graphs, position, ticks=1, velocity=None, steps=None, audio=False,
                visible=False, rotation=None):
            nonlocal frames
            instances = [dict(ModelID=0, Location=[0, 0, 0], Visable=visible,
                PlayerCollision=True, PlayerBounce=False, U0=0, CollsionMode=2,
                Rotation=rotation or [0, 0, 0, 1], SurfaceType=-1, EffectSlotIndex=i,
                AmbentLightColour=[256, 256, 256]) for i in range(len(graphs))]
            write('Instances.json', dict(Instances=instances))
            write('Effects.json', dict(kind='openslope-effects', version=1,
                graphs=[dict(id=f'g{i}', nodes=nodes) for i, nodes in enumerate(graphs)],
                slots=[dict(id=f's{i}', circumstances=dict(collision=f'g{i}'))
                       for i in range(len(graphs))], functions=[], instances=[],
                objectProperties=[], splines=[]))
            placement = dict(Position=position, Forward=[1, 0, 0], Velocity=velocity or [0, 0, 0])
            steps = steps or [dict(Ticks=ticks)]
            write('replay.json', dict(Schema='openslope-replay/v1', Placement=placement, Steps=steps))
            args = [executable, '--map', str(root), '--first-person', '--replay',
                    str(root/'replay.json'), '--capture', str(root/f'{name}.ppm'), '--no-audio']
            if audio:
                args += ['--audio-capture', str(root/f'{name}.wav')]
            result = subprocess.run(args, capture_output=True, text=True, timeout=120)
            assert result.returncode == 0, result.stdout + result.stderr
            print(name, result.stdout, sep='\n')
            frames += sum(step['Ticks'] for step in steps)
            if audio:
                with wave.open(str(root/f'{name}.wav'), 'rb') as sound:
                    pcm = sound.readframes(sound.getnframes())
                assert max(abs(x[0]) for x in struct.iter_unpack('<h', pcm)) > 1000, result.stdout
            return result.stdout, (root/f'{name}.ppm').read_bytes().split(b'\n', 3)[3]

        pad = [node(17, dict(type17=5)), node(18, dict(type18=10)),
               node(0, dict(type0=dict(SubType=5, DeadNodeMode=2)))]
        before, rgb = run('pad-before', [pad], [-15, -.005, 0], visible=True)
        assert 'Visible props: 1;' in before, before
        purple = lambda pixels: sum(r > 100 and b > 100 and g < 60
            for r, g, b in zip(pixels[0::3], pixels[1::3], pixels[2::3]))
        assert purple(rgb) > 1000
        after, rgb = run('pad-collected', [pad], [-3, -.005, 0], ticks=4, visible=True, audio=True)
        assert 'Visible props: 0;' in after and purple(rgb) == 0, after
        assert 'Boost: speed pad 4.95 s; trick pad 9.95 s;' in after, after
        assert 'transients 2;' in after, after

        force = node(0, dict(type0=dict(SubType=7, Boost=dict(Mode=1, U1=0,
            U2=3, BoostAmount=100, BoostDir=[0, 0, 1]))))
        vent, _ = run('vent', [[force]], [0, .01, 0], ticks=30)
        velocity = [float(x) for x in re.search(r'velocity \[([^]]+)\]', vent)[1].split(',')]
        assert velocity[1] > 40 and 'grounded 0;' in vent, vent
        assert 'Boost: speed pad 0 s; trick pad 0 s;' in vent, vent
        snap = prop(18, dict(U0=4, U1=25, U2=0, U3=0, U4=1, U5=4000, U6=100000))
        shaft, _ = run('shaft-snap', [[snap]], [0, 4, 0], velocity=[2, 12, 3])
        assert re.search(r'position \[[^,]+,40,[^]]+\]', shaft), shaft
        velocity = [float(x) for x in re.search(r'velocity \[([^]]+)\]', shaft)[1].split(',')]
        assert velocity[0] == velocity[2] == 0 and 11 < velocity[1] < 12, shaft

        lap = prop(15, dict(U0=5, U1=25, U2=0, U3=0, U4=1))
        fields = {f'U{i}': 0 for i in range(19)}
        fields.update(U0=1, U2=2, U7=1, U10=0, U12=1, U13=1, U16=27, U17=35, U18=35)
        tube, _ = run('tube-stage-two', [[lap], [prop(24, fields)]], [5, 20, 0])
        assert 'tube stage 2;' in tube, tube
        velocity = [float(x) for x in re.search(r'velocity \[([^]]+)\]', tube)[1].split(',')]
        assert abs(velocity[0]-35*2/60) < .00001, tube

        held, _ = run('held-engage', [[]], [0, 200, 0], audio=True,
            velocity=[10, 0, 0], steps=[dict(Ticks=8, Boost=True),
                dict(Ticks=1), dict(Ticks=1, Boost=True)])
        assert 'transients 2;' in held, held
    print(f'PASS: {frames} production Vulkan frames verify pad pixels/despawn/durations, '
          'pad and engage PCM, uncapped vent lift, altitude snap and stage-two tube launch')


if __name__ == '__main__':
    main()
