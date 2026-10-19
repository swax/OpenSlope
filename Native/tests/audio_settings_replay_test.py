"""Live menu persistence and saved audio choices through production Vulkan/PCM."""
from pathlib import Path
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from audio_scene_test import fixture, write, rms
from board_performance_replay_test import frequency
from music_lifecycle_replay_test import graph


def call(args, cwd=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def capture(executable, root, preferences, on_foot=False):
    write(root / 'input.json', dict(Schema='openslope-replay/v1',
          Placement=dict(Position=[10, 5, 0] if on_foot else [5, 0, 0], Forward=[0, 0, -1]), Steps=[dict(Ticks=180)]))
    args = [executable, '--map', root, '--audio-preferences', preferences, '--replay', root / 'input.json',
            '--capture', root / 'frame.ppm', '--audio-capture', root / 'mix.wav']
    if on_foot:
        args.append('--on-foot')
    report = call(args)
    with wave.open(str(root / 'mix.wav')) as data:
        samples = struct.unpack('<' + str(data.getnframes() * 2) + 'h', data.readframes(data.getnframes()))[::2]
    return samples, report


def main():
    executable = Path(sys.argv[1]).resolve()
    previews = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    repository = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix='openslope-audio-settings-') as temporary:
        base = Path(temporary); root = base / 'A'; second = base / 'B'; flat = base / 'Flat'
        call(['node', '--import', 'tsx', repository / 'tools/native/authored-audio-export-fixture.mts', root], repository / 'Slopesmith')
        fixture(flat, mass=0, draw=False)
        shutil.copy2(flat / 'Patches.json', root / 'Patches.json')
        # Keep the helper floor outside the live map library.
        flat.rename(base / 'Helper')
        (base / 'Helper/Patches.json').unlink()
        fixture(second, mass=0, draw=False)
        for name in ['AIP.json', 'SOP.json']:
            shutil.copy2(root / name, second / name)
        authored_instances = json.loads((root / 'Instances.json').read_text())
        write(root / 'Instances.json', dict(Instances=[])); write(second / 'Instances.json', dict(Instances=[]))
        graph(root, 'alpha', 220); graph(root, 'beta', 880); graph(second, 'beta', 880)
        write(root / 'Audio/Music/playlist.json', ['alpha', 'beta'])
        write(second / 'Audio/Music/playlist.json', ['beta'])
        preferences = base / 'User/audio-preferences.json'
        for expected_volume, expected_music in [(.9, False), (.8, True)]:
            report = call([executable, '--map', root, '--ui-smoke', '--seconds', '10',
                           '--audio-preferences', preferences], base)
            assert 'Desktop UI/map load smoke: PASS' in report, report
            saved = json.loads(preferences.read_text())
            assert saved['musicEnabled'] is expected_music and abs(saved['volume'] - expected_volume) < 1e-9, saved
            assert saved['songs'] == {'A': 'alpha'}, 'Map switching leaked the selection: ' + str(saved)
        first, report = capture(executable, root, preferences)
        assert abs(frequency(first, 2.5, 2.9) - 220) < 5, report
        other, report = capture(executable, second, preferences)
        assert abs(frequency(other, 2.5, 2.9) - 880) < 5, report
        saved['musicEnabled'] = False; write(preferences, saved)
        silent, report = capture(executable, root, preferences)
        assert rms(silent) == 0, 'Saved music-off still plays race music: ' + report
        write(root / 'Instances.json', authored_instances)
        effects, report = capture(executable, root, preferences, True)
        assert abs(frequency(effects, 2.5, 2.9) - 660) < 5 and rms(effects) > 100, 'Music mute suppressed the authored ambient effect: ' + report
        saved['volume'] = 0; write(preferences, saved)
        muted, report = capture(executable, root, preferences, True)
        assert rms(muted) == 0, 'Saved master-zero must be silent from the first PCM sample: ' + report
        saved['volume'] = .8; saved['musicEnabled'] = True; write(preferences, saved)
        menu = base / 'audio-menu.ppm'
        call([executable, '--map', root, '--on-foot', '--ui-audio', '--audio-preferences', preferences,
              '--capture', menu, '--seconds', '.1', '--no-audio'])
        _, dimensions, _, pixels = menu.read_bytes().split(b'\n', 3)
        w, h = map(int, dimensions.split())
        panel = [(i // 3 % w, i // 3 // w) for i in range(0, len(pixels), 3)
                 if pixels[i] < 15 and pixels[i + 1] < 20 and pixels[i + 2] < 30]
        assert max(x for x, y in panel) - min(x for x, y in panel) < w * .5
        assert max(y for x, y in panel) - min(y for x, y in panel) < h * .65
        if previews:
            previews.mkdir(parents=True, exist_ok=True); shutil.copy2(menu, previews / 'audio-menu.ppm')
    print('PASS: two live menu/map-switch processes and 906 production Vulkan/PCM frames verify saved volume/music, per-course song, effects independence, true master zero and compact audio menu')


if __name__ == '__main__':
    main()
