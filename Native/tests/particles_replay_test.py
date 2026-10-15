"""Authored particle graphs through real input, Vulkan pixels and course-sound PCM."""
from pathlib import Path
import json
import re
import struct
import subprocess
import sys
import tempfile
import wave
from appearance_test import rgba
from audio_scene_test import tone, write, rms
from desktop_collision_test import fixture


def node(main, payload, references=None):
    return dict(mainType=main, payload=payload, references=references or {})


def emitter(window, blue=False):
    fields = {f'U{i}': 0 for i in range(51)}
    fields.update(U0=60, U1=2, U2=window, U3=1, U4=16, U5=1,
                  U8=.025, U10=150 if blue else 0,
                  U21=50, U25=40, U29=40)
    for stop in range(4):
        fields.update({f'U{33 + stop * 4}': .85 if stop < 3 else 0,
                       f'U{34 + stop * 4}': 0 if blue else 1,
                       f'U{36 + stop * 4}': 1 if blue else 0})
    return node(2, dict(type2=dict(SubType=0, type2Sub0=fields)))


def document(window, stop=False):
    layers = [emitter(window), emitter(window, True), node(8, dict(SoundPlay=42))]
    if stop:
        layers += [node(4, dict(WaitTime=.5)), node(0, dict(type0=dict(SubType=5, DeadNodeMode=3)))]
    return dict(kind='openslope-effects', version=1,
                graphs=[dict(id='contact', nodes=[node(0, dict(type0=dict(SubType=5, DeadNodeMode=2))), node(4, dict(WaitTime=.2)),
                            node(21, {}, dict(function='relay'))]), dict(id='burst', nodes=layers)],
                functions=[dict(id='relay', nodes=[node(7, {}, dict(instance='instance:1', effectGraph='burst'))])],
                slots=[dict(id='slot', circumstances=dict(collision='contact'))])


def main():
    exe = str(Path(sys.argv[1]).resolve())
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    if output:
        output.mkdir(parents=True, exist_ok=True)
    frames = 0
    with tempfile.TemporaryDirectory(prefix='openslope-particle-replay-') as directory:
        root = Path(directory) / 'Authored'
        fixture(root, mass=0, draw=False)
        rows = json.loads((root / 'Instances.json').read_text())['Instances']
        rows[0]['EffectSlotIndex'] = 0
        rows += [dict(ModelID=0, Location=[500, 0, 200], Rotation=[0, 0, 0, 1], Scale=[1, 1, 1],
                      Visable=False, PlayerCollision=False, EffectSlotIndex=-1)]
        write(root / 'Instances.json', dict(Instances=rows))
        (root / 'Textures/Particles').mkdir(parents=True)
        (root / 'Textures/Particles/part.png').write_bytes(rgba(1, 1, [255, 255, 255, 255]))
        write(root / 'World.json', dict(Schema='openslope-world/v1', SkyColor=[15, 25, 40], Fog=dict(Enabled=False)))
        write(root / 'Audio/SoundIndex.json', dict(Schema='openslope-sound-index/v1', Banks={'2': 'course'}, CollisionEvents={}))
        tone(root / 'Audio/SFX/course/042.wav', 800, .35)
        for foot in (False, True):
            for name, ticks, window, stop in [('before', 8, .4, False), ('burst', 35, .4, False),
                                               ('expired', 120, .4, False), ('stream', 180, -1, False),
                                               ('stopped', 80, -1, True), ('restart', 36, -1, False)]:
                write(root / 'Effects.json', document(window, stop))
                steps = [dict(Ticks=ticks, Posture=0 if foot else -1)]
                if name == 'restart':
                    steps = [dict(Ticks=ticks - 1, Posture=0 if foot else -1), dict(Ticks=1, RunRestart=True)]
                write(root / 'replay.json', dict(Schema='openslope-replay/v1',
                      Placement=dict(Position=[0, -.005, 0], Forward=[1, 0, 0]), Steps=steps))
                label = f'{"walk" if foot else "ride"}-{name}'
                picture = (output or root) / (label + '.ppm')
                sound = (output or root) / (label + '.wav')
                args = [exe, '--map', str(root), '--first-person', '--replay', str(root / 'replay.json'),
                        '--capture', str(picture), '--audio-capture', str(sound)]
                if foot:
                    args += ['--on-foot']
                result = subprocess.run(args, capture_output=True, text=True, timeout=120)
                assert result.returncode == 0, result.stdout + result.stderr
                state = re.search(r'World particles: (\d+) emitters; (\d+) drawn sprites; (\d+) draws', result.stdout)
                assert state, result.stdout
                active = name in ('burst', 'stream')
                assert int(state[1]) == (2 if active else 0), (label, state.groups(), result.stdout)
                assert (int(state[2]) > 60) == active, (label, state.groups(), result.stdout)
                rgb = picture.read_bytes().split(b'\n', 3)[3]
                red = sum(r > 150 and r > 2 * g and r > 2 * b for r, g, b in zip(rgb[0::3], rgb[1::3], rgb[2::3]))
                blue = sum(b > 150 and b > 2 * r and b > 2 * g for r, g, b in zip(rgb[0::3], rgb[1::3], rgb[2::3]))
                if active:
                    assert red > 100 and blue > 100, (label, red, blue, result.stdout)
                else:
                    assert red < 100, (label, red, result.stdout)
                with wave.open(str(sound)) as file:
                    assert file.getnchannels() == 2 and file.getframerate() == 48000
                    data = file.readframes(file.getnframes())
                    pcm = struct.unpack('<' + 'h' * (len(data) // 2), data)
                if name == 'before':
                    assert rms(pcm) == 0, 'Graph wait must delay the report too'
                if name == 'burst':
                    assert rms(pcm[:8000]) == 0 and rms(pcm[24000:]) > 10, 'Report must follow the delayed burst'
                frames += ticks
                print(f'PASS: {label} ({ticks} production frames, {red} red/{blue} blue particle pixels)', flush=True)
    print(f'PASS: {frames} Vulkan/PCM frames verify delayed multi-layer bursts, streams, stops and reset')


if __name__ == '__main__':
    main()
