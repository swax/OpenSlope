"""Production on-foot flight, crouch, unlimited boost sound and rendered sole trails."""
from pathlib import Path
import json
import re
import subprocess
import sys
import tempfile
import wave
import struct
from desktop_collision_test import fixture
from audio_scene_test import tone, write, rms


def main():
    exe = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    if output:
        output.mkdir(parents=True, exist_ok=True)
    activate = [dict(Ticks=1, Jump=True), dict(Ticks=1), dict(Ticks=1, Jump=True)]
    cases = [
        ('climb', activate + [dict(Ticks=90, Jump=True, Boost=True, FlightDirection=[0, 1, 0])], True, True, True),
        ('released', activate + [dict(Ticks=60, Boost=True, FlightDirection=[0, 1, 0]), dict(Ticks=24)], True, False, True),
        ('idle-boost', activate + [dict(Ticks=6, Boost=True)], True, False, False),
        ('takeoff-chord', [dict(Ticks=24, Jump=True, Boost=True, FlightDirection=[0, 1, 0])], True, True, True),
        ('crouch', [dict(Ticks=60, Posture=1, Crouch=True, WalkForward=[0, 0, -1])], False, False, False),
    ]
    with tempfile.TemporaryDirectory(prefix='openslope-foot-render-') as folder:
        for name, steps, flying, boosting, audible in cases:
            root = Path(folder) / name
            fixture(root, mass=0, draw=False)
            tone(root / 'Audio/SFX/main/120.wav', 600)
            tone(root / 'Audio/SFX/main/120.loop.wav', 600)
            write(root / 'Audio/SoundIndex.json', dict(Schema='openslope-sound-index/v1', Banks={'0': 'main'}, CollisionEvents={}))
            replay = root / 'input.json'
            write(replay, dict(Schema='openslope-replay/v1', Placement=dict(Position=[0, 0, 0], Forward=[0, 0, -1]), Steps=steps))
            capture = (output or root) / (name + '.ppm')
            sound = (output or root) / (name + '.wav')
            result = subprocess.run([str(exe), '--map', str(root), '--on-foot', '--replay', str(replay),
                                     '--capture', str(capture), '--audio-capture', str(sound)],
                                    capture_output=True, text=True, timeout=120)
            assert result.returncode == 0, result.stdout + result.stderr
            assert f'Foot flight: active {int(flying)}; boosting {int(boosting)}' in result.stdout, result.stdout
            assert 'Boarding: on foot 1' in result.stdout, result.stdout
            if name == 'climb':
                assert re.search(r'Boost trail: 7 records; 7 segments; 1 draws', result.stdout), result.stdout
                position = re.search(r'position \[([^]]+)\]; velocity', result.stdout)[1]
                assert float(position.split(',')[1]) > 10, result.stdout
            if name == 'crouch':
                assert 'crouch 1' in result.stdout, result.stdout
            with wave.open(str(sound)) as f:
                samples = struct.unpack('<' + str(f.getnframes() * 2) + 'h', f.readframes(f.getnframes()))
            assert (rms(samples) > 100) == audible, (name, rms(samples), result.stdout)
            if name == 'released':
                assert rms(samples[-6 * 800 * 2:]) < 1, 'Released directional boost must stop sounding'
            header = capture.read_bytes().split(b'\n', 3)
            assert header[:3] == [b'P6', b'1280 720', b'255'] and len(header[3]) == 1280 * 720 * 3
            if output:
                (output / (name + '.log')).write_text(result.stdout + result.stderr)
            print(f'PASS: {name} ({sum(s["Ticks"] for s in steps)} production Vulkan/PCM frames)')


if __name__ == '__main__':
    main()
