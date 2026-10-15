"""Public map export and imported music lifecycle through production Vulkan/PCM."""
from pathlib import Path
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from audio_scene_test import fixture, tone, write, rms
from board_performance_replay_test import frequency, window


def run(executable, root, steps, on_foot=True):
    write(root / 'input.json', dict(Schema='openslope-replay/v1',
          Placement=dict(Position=[5, 0, 0], Forward=[0, 0, -1]), Steps=steps))
    args = [str(executable), '--map', str(root), '--replay', str(root / 'input.json'),
            '--capture', str(root / 'frame.ppm'), '--audio-capture', str(root / 'mix.wav')]
    if on_foot:
        args.append('--on-foot')
    result = subprocess.run(args, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
    with wave.open(str(root / 'mix.wav')) as data:
        samples = struct.unpack('<' + str(data.getnframes() * 2) + 'h', data.readframes(data.getnframes()))[::2]
    match = re.search(r'streamed bytes (\d+)', result.stdout)
    assert match and int(match[1]) <= 768000, result.stdout
    return samples, result.stdout


def graph(root, name, hz):
    folder = root / 'Audio/Music' / name
    tone(folder / 'chunk.wav', hz, .5)
    write(folder / 'graph.json', dict(Schema='openslope-music-graph/v1', Tracks=1, Sections=1,
          Events=0, EventTable='', Routers=[], Vars=[], VariableMaps=[], Volume=.2,
          Nodes=[dict(Index=0, Sample=1, Flags=0, Word1=1, Word2=1 << 24, Links=[0], LinkRaw=[127 << 8])],
          Samples=[dict(Wav='chunk.wav', Meta=500, MusOffset=0)]))


def main():
    executable = Path(sys.argv[1]).resolve()
    repository = Path(__file__).resolve().parents[2]
    frames = 0
    with tempfile.TemporaryDirectory(prefix='openslope-music-lifecycle-') as temporary:
        base = Path(temporary)
        flat = base / 'flat'
        fixture(flat, mass=0)
        root = base / 'Exported'
        result = subprocess.run(['node', '--import', 'tsx', str(repository / 'tools/authored-audio-export-fixture.mts'),
                                 str(root), '--music'], cwd=repository / 'Slopesmith',
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        shutil.copy2(flat / 'Patches.json', root / 'Patches.json')
        assert (root / 'Music/track.wav').is_file(), 'Public export did not stage the master'
        data, report = run(executable, root, [dict(Ticks=120)]); frames += 120
        assert abs(frequency(data, 1.6, 1.9) - 110) < 5, report
        data, report = run(executable, root, [dict(Ticks=120), dict(Ticks=1, Mount=True), dict(Ticks=180)]); frames += 301
        assert 'Boarding: on foot 0' in report, report
        assert abs(frequency(data, 4.6, 4.9) - 660) < 5, report
        assert rms(window(data, 4.6, 4.9)) > 100, report
        # Remove the environment so the attack is distinguishable during remount.
        write(root / 'Audio/Environment.json', dict(Schema='openslope-environment-audio/v1', Bed=None))
        steps = [dict(Ticks=120), dict(Ticks=1, Mount=True), dict(Ticks=180), dict(Ticks=1, Mount=True),
                 dict(Ticks=180), dict(Ticks=1, SpawnBoard=True), dict(Ticks=1, Mount=True), dict(Ticks=24)]
        data, report = run(executable, root, steps); frames += sum(s['Ticks'] for s in steps)
        assert rms(window(data, 7.7, 8.0)) == 0, 'Dismount did not stop the master: ' + report
        assert abs(frequency(data, 8.2, 8.4) - 220) < 6, 'Remount skipped the master attack: ' + report
        # A root master overrides a valid reference playlist.
        graph(root, 'shadow', 880)
        write(root / 'Audio/Music/playlist.json', ['shadow'])
        data, report = run(executable, root, [dict(Ticks=180)], False); frames += 180
        assert abs(frequency(data, 2.5, 2.9) - 660) < 5 and 'music node -1' in report, report
        # Reference-only course: C intro wins over A/B, then a run-selected graph.
        root = base / 'Imported'
        fixture(root, mass=0)
        write(root / 'Instances.json', dict(Instances=[]))
        tone(root / 'Audio/Intro/Course-A1.wav', 110, .2)
        tone(root / 'Audio/Intro/Course-B1.wav', 550, .3)
        tone(root / 'Audio/Intro/Course-C1.wav', 330, .4)
        tone(root / 'Audio/Intro/end.wav', 1100, .5)
        graph(root, 'alpha', 220); graph(root, 'beta', 880)
        write(root / 'Audio/Music/playlist.json', ['alpha', 'beta'])
        data, report = run(executable, root, [dict(Ticks=120)]); frames += 120
        assert abs(frequency(data, 1.6, 1.9) - 330) < 5, report
        steps = [dict(Ticks=180), dict(Ticks=1, Mount=True), dict(Ticks=180), dict(Ticks=1, SpawnBoard=True),
                 dict(Ticks=1, Mount=True), dict(Ticks=180)]
        data, report = run(executable, root, steps, False); frames += sum(s['Ticks'] for s in steps)
        first, last = frequency(data, 2.5, 2.9), frequency(data, 8.5, 8.9)
        assert min(abs(first - 220), abs(first - 880)) < 5, report
        assert abs(first - last) < 5, 'Dismount changed the run-selected song: ' + report
        write(root / 'Audio/Environment.json', dict(Schema='openslope-environment-audio/v1', Bed=None))
        data, report = run(executable, root, [dict(Ticks=120)]); frames += 120
        assert rms(data) == 0, 'Explicit environment off unexpectedly used intro music: ' + report
    print(f'PASS: {frames} production Vulkan/PCM frames verify public authored export, loop region, mount/dismount/remount, intro priority, run song and bounded streaming')


if __name__ == '__main__':
    main()
