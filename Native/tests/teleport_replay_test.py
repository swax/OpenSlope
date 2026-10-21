"""Actual Vulkan/PCM checks for authored teleports and their destination camera."""
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


def main():
    executable = str(Path(sys.argv[1]).resolve())
    frames = 0
    with tempfile.TemporaryDirectory(prefix='openslope-teleport-replay-') as temporary:
        root = Path(temporary)
        for folder in ['Meshes', 'Textures', 'Audio/SFX/course']:
            (root/folder).mkdir(parents=True)

        def write(name, value):
            (root/name).write_text(json.dumps(value))

        write('Patches.json', dict(Patches=[dict(PatchName='Teleport replay floor',
            SurfaceType=1, TrickOnlyPatch=False, TexturePath='', LightmapID=-1,
            LightMapPoint=[0, 0, 0, 0], UVPoints=[[0, 0], [0, 1], [1, 0], [1, 1]],
            Points=[[(u/3-.5)*40000, (v/3-.5)*40000, 0]
                    for u in range(4) for v in range(4)])]))
        (root/'Meshes/marker.obj').write_text(
            'v -100 0 0\nv 100 0 0\nv 100 0 250\nv -100 0 250\n'
            'vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn 0 1 0\n'
            'f 1/1/1 2/2/1 3/3/1\nf 1/1/1 3/3/1 4/4/1\n'
            'f 3/3/1 2/2/1 1/1/1\nf 4/4/1 3/3/1 1/1/1\n')
        (root/'Textures/marker.png').write_bytes(rgba(1, 1, [240, 15, 220, 255]))
        write('Materials.json', dict(Materials=[dict(TexturePath='marker.png', UnknownInt18=1 << 17)]))
        write('Models.json', dict(Models=[dict(ModelObjects=[dict(ParentID=-1,
            MeshData=[], CollisionBounds=dict(Min=[-100, -100, -50], Max=[100, 100, 250]))]),
            dict(ModelObjects=[dict(ParentID=-1, MeshData=[dict(MeshPath='marker.obj', MaterialID=0)])])]))
        write('Audio/SoundIndex.json', dict(Schema='openslope-sound-index/v1',
            Banks={'2': 'course'}, CollisionEvents={}))
        with wave.open(str(root/'Audio/SFX/course/122.wav'), 'wb') as sound:
            sound.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
            sound.writeframes(struct.pack('<4800h', *[int(7000*math.sin(2*math.pi*660*i/48000))
                                                     for i in range(4800)]))
        nodes = [dict(mainType=8, payload=dict(SoundPlay=122), references={}),
                 dict(mainType=24, payload=dict(TeleportInstanceIndex=9999),
                      references=dict(instance='instance:1'))]
        write('Effects.json', dict(kind='openslope-effects', version=1,
            graphs=[dict(id='entry', nodes=nodes)], slots=[dict(id='slot',
            circumstances=dict(collision='entry'))], functions=[], instances=[],
            objectProperties=[], splines=[]))
        for name, mode, ticks, rotated, foot, height in [
            ('mounted', 'freeride', 1, False, False, .5),
            ('rotated', 'freeride', 1, True, False, .5),
            ('walking', 'freeride', 1, False, True, .5),
            ('showoff', 'showoff', 1, False, False, .5),
            ('no-floor', 'freeride', 1, False, False, 20),
        ]:
            rotation = [0, 0, math.sin(math.pi/4), math.cos(math.pi/4)] if rotated else [0, 0, 0, 1]
            instances = [dict(ModelID=0, Location=[0, 0, 0], Visable=False, PlayerCollision=True,
                PlayerBounce=False, U0=0, CollsionMode=2, SurfaceType=-1, EffectSlotIndex=0),
                dict(ModelID=0, Location=[4000, -3000, height*100], Rotation=rotation,
                     Visable=False, PlayerCollision=False, CollsionMode=0, EffectSlotIndex=-1),
                dict(ModelID=1, Location=[3500, -3300, 0] if rotated else [3700, -2500, 0],
                     Rotation=rotation, Visable=True, PlayerCollision=False, EffectSlotIndex=-1,
                     AmbentLightColour=[256, 256, 256])]
            write('Instances.json', dict(Instances=instances))
            write('AIP.json', dict(StartPosList=[], AIPaths=[], RaceLines=[dict(PathPos=[-1000, 0, 0],
                PathPoints=[[11000, 0, 0]], DistanceToFinish=2000, PathEvents=[dict(
                    EventType=11, EventValue=50, EventStart=1500, EventEnd=1500)])]))
            write('replay.json', dict(Schema='openslope-replay/v1', Placement=dict(
                Position=[0, -.005, 0], Forward=[1, 0, 0]), Steps=[dict(Ticks=ticks)]))
            args = [executable, '--map', str(root), '--mode', mode, '--first-person',
                    '--replay', str(root/'replay.json'), '--capture', str(root/f'{name}.ppm'),
                    '--audio-capture', str(root/f'{name}.wav'), '--no-audio']
            if foot:
                args.append('--on-foot')
            result = subprocess.run(args, capture_output=True, text=True, timeout=120)
            assert result.returncode == 0, result.stdout + result.stderr
            text = result.stdout
            print(name, text, sep='\n')
            assert 'Transport: 1 teleports;' in text and 'velocity [0,0,0]' in text, text
            position = [float(x) for x in re.search(r'position \[([^]]+)\]', text)[1].split(',')]
            expected = [40, 0, 33] if rotated else [37, height if height > 3 else 0, 30]
            assert all(abs(a-b) < .001 for a, b in zip(position, expected)), text
            assert 'checkpoints 0;' in text and '; RUNNING;' in text, text
            assert f'Boarding: on foot {int(foot)};' in text, text
            if mode == 'showoff':
                assert 'clock 1:59.98;' in text, text
            with wave.open(str(root/f'{name}.wav'), 'rb') as sound:
                samples = [x[0] for x in struct.iter_unpack('<h', sound.readframes(sound.getnframes()))]
            assert max(map(abs, samples)) > 1000, 'Entry cue disappeared at the remote listener'
            rgb = (root/f'{name}.ppm').read_bytes().split(b'\n', 3)[3]
            if height < 3:
                purple = sum(r > 120 and g < 60 and b > 120
                    for r, g, b in zip(rgb[0::3], rgb[1::3], rgb[2::3]))
                assert purple > 1000, ('Destination-facing camera misses its marker', name, purple)
            frames += ticks
    print(f'PASS: {frames} production Vulkan frames verify stopped/native-probed arrivals, '
          'destination-facing pixels, entry cue PCM, walking and skipped-course-event suppression')


if __name__ == '__main__':
    main()
