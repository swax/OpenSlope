"""Gameplay-triggered audio through the desktop host, with authored tone assets."""
import base64
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import wave
from desktop_collision_test import fixture


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


def tone(path, frequency=440, seconds=.5):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as output:
        output.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
        output.writeframes(b''.join(struct.pack('<h', round(6000 * math.sin(2 * math.pi * frequency * i / 8000))) for i in range(round(seconds * 8000))))


def capture(executable, root, ticks, placement):
    replay = root / 'sequence.json'
    write(replay, dict(Schema='openslope-replay/v1', Placement=placement, Steps=[dict(Ticks=ticks)]))
    output = root / 'mix.wav'
    result = subprocess.run([str(executable), '--map', str(root), '--replay', str(replay), '--capture', str(root / 'frame.ppm'), '--audio-capture', str(output)], capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    with wave.open(str(output)) as data:
        assert data.getnchannels() == 2 and data.getframerate() == 48000 and data.getnframes() == ticks * 800
        samples = struct.unpack('<' + str(data.getnframes() * 2) + 'h', data.readframes(data.getnframes()))
    return samples, result.stdout


def rms(samples):
    return math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples)))


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-audio-scene-') as temporary:
        base = Path(temporary)
        root = base / 'contact'
        fixture(root, mass=0)
        tone(root / 'Audio/SFX/test/000.wav')
        write(root / 'Audio/SoundIndex.json', dict(Schema='openslope-sound-index/v1', Banks={'2': 'test'}, CollisionEvents={'201': dict(Group=2, Slot=0, Bank='test', Clip='Audio/SFX/test/000.wav')}))
        rows = json.loads((root / 'Instances.json').read_text())
        rows['Instances'][0].update(IncludeSound=True, Sounds=dict(CollisonSound=201, ExternalSounds=[]))
        write(root / 'Instances.json', rows)
        samples, report = capture(executable, root, 30, dict(Position=[-2, -.005, 0], Forward=[1, 0, 0], Velocity=[12, 0, 0]))
        assert 'contact sounds 1' in report and 'bounces 0' in report, report
        assert rms(samples) > 200, report
        # Entry inside a pressure volume has no incoming surface-normal impact.
        samples, report = capture(executable, root, 90, dict(Position=[0, -.005, 0], Forward=[1, 0, 0], Velocity=[0, 0, 0]))
        assert 'contact sounds 1' in report and rms(samples) > 100, report
        root = base / 'interactive'
        fixture(root, mass=0)
        tone(root / 'Audio/SFX/test/000.wav', 1000)
        tone(root / 'Audio/SFX/test/000.loop.wav', 1000)
        write(root / 'Audio/SoundIndex.json', dict(Schema='openslope-sound-index/v1', Banks={'2': 'test'}, CollisionEvents={'16': dict(Group=2, Slot=0, Bank='test', Clip='Audio/SFX/test/000.wav')}))
        rows = json.loads((root / 'Instances.json').read_text())
        emitter = dict(U0=0, SoundIndex=16, U2=0, U3=0, U4=0, U5=10000, U6=2)
        rows['Instances'][0].update(IncludeSound=True, Sounds=dict(CollisonSound=0, ExternalSounds=[emitter]))
        write(root / 'Instances.json', rows)
        samples, report = capture(executable, root, 40, dict(Position=[-2, -.005, 0], Forward=[1, 0, 0], Velocity=[12, 0, 0]))
        assert 'contact sounds 0' in report and 'ambient voices 1' in report, report
        assert rms(samples[:4 * 800 * 2]) == 0 and rms(samples[-10 * 800 * 2:]) > 500, report
        root = base / 'board'
        fixture(root, mass=0)
        tone(root / 'Audio/SFX/test/004.wav')
        tone(root / 'Audio/SFX/test/004.loop.wav')
        write(root / 'Audio/SoundIndex.json', dict(Schema='openslope-sound-index/v1', Banks={'1': 'test'}, CollisionEvents={}))
        write(root / 'Audio/BoardSoundIndex.json', dict(Schema='openslope-board-sound-index/v1', SurfaceGroups=[0] * 20))
        (root / 'Audio/SNOW.INF').write_text('[PACK]\n[GLIDE]\nLoad 100\nAssignVol\nLoad 0\nAssignBend\n')
        grounded, report = capture(executable, root, 20, dict(Position=[5, -.005, 0], Forward=[1, 0, 0], Velocity=[12, 0, 0]))
        assert rms(grounded) > 500, report
        airborne, report = capture(executable, root, 20, dict(Position=[5, 60, 0], Forward=[1, 0, 0], Velocity=[12, 0, 0]))
        assert rms(airborne) == 0, report
        root = base / 'music'
        fixture(root, mass=0)
        folder = root / 'Audio/Music/test'
        for i, frequency in enumerate([440, 880, 660]):
            tone(folder / f'chunk_{i:03}.wav', frequency)
        def node(index, sample, links):
            return dict(Index=index, Sample=sample, Track=0, Flags=0, Word1=1, Word2=len(links) << 24, Links=[target for low, high, target in links], LinkRaw=[low | high << 8 | target << 16 for low, high, target in links])
        graph = dict(Schema='openslope-music-graph/v1', Tracks=1, Sections=1, Events=1, EventTable=base64.b64encode(b'\0').decode(), Routers=[0x80ff], Vars=[], VariableMaps=[], Volume=.5,
                     Nodes=[node(0, 0, [(0, 40, 1), (40, 127, 2)]), node(1, 1, [(0, 127, 1)]), node(2, 2, [(0, 127, 3)]), node(3, 3, [(0, 127, 2)])],
                     Samples=[dict(Wav=f'chunk_{i:03}.wav', Meta=500, MusOffset=0) for i in range(3)])
        write(folder / 'graph.json', graph)
        write(root / 'Audio/Music/playlist.json', ['test'])
        samples, report = capture(executable, root, 60, dict(Position=[5, -.005, 0], Forward=[1, 0, 0], Velocity=[12, 0, 0]))
        left = samples[::2]
        def frequency(start, end):
            data = left[round(start * 48000):round(end * 48000)]
            return sum(a <= 0 < b for a, b in zip(data, data[1:])) / (end - start)
        assert abs(frequency(.1, .4) - 880) < 8 and abs(frequency(.6, .9) - 660) < 8, report
        assert all(any(abs(sample) > 100 for sample in left[i:i + 100]) for i in range(23000, 25000, 100)), 'Music has a gap at its chunk boundary'
    print('PASS: actual-host contact-only sound, independent hit-gated ambience, ground/air board gates and gapless music routing')


if __name__ == '__main__':
    main()
