"""Start on foot, walk, mount and dismount through the production Vulkan host."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from desktop_collision_test import fixture, write


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-boarding-render-') as temporary:
        base = Path(temporary)
        for name, foot, placement, steps, expected in [
            ('spawn', True, dict(Position=[0, 0, 0], Forward=[0, 0, -1]), [dict(Ticks=2)], True),
            ('mount-held', True, dict(Position=[0, 0, 0], Forward=[0, 0, -1]), [dict(Ticks=1, Mount=True), dict(Ticks=3, Mount=True)], False),
            ('walk', True, dict(Position=[0, 0, 0], Forward=[0, 0, -1]), [dict(Ticks=120, Posture=1)], True),
            ('distant-mount', True, dict(Position=[0, 0, 0], Forward=[0, 0, -1]), [dict(Ticks=90, Posture=1), dict(Ticks=1, Mount=True)], True),
            ('air-dismount', False, dict(Position=[0, 8, 0], Forward=[0, 0, -1], Velocity=[0, 0, -12]), [dict(Ticks=1, Mount=True), dict(Ticks=6)], True),
        ]:
            root = base / name
            fixture(root, mass=0, draw=False)
            replay, frame = root / 'replay.json', root / 'frame.ppm'
            write(replay, dict(Schema='openslope-replay/v1', Placement=placement, Steps=steps))
            command = [str(executable), '--map', str(root), '--replay', str(replay), '--capture', str(frame), '--look-down']
            if foot:
                command.append('--on-foot')
            result = subprocess.run(command, capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stdout + result.stderr
            assert f'Boarding: on foot {int(expected)}' in result.stdout, result.stdout
            state = re.search(r'position \[([^\]]+)\]; velocity \[([^\]]+)\]', result.stdout)
            position, velocity = [list(map(float, value.split(','))) for value in state.groups()]
            board = list(map(float, re.search(r'; board \[([^\]]+)\]', result.stdout)[1].split(',')))
            if name in ('spawn', 'walk', 'distant-mount'):
                assert max(abs(x) for x in board) < .001, result.stdout
            if name == 'walk':
                assert position[2] < -4, result.stdout
            if name == 'air-dismount':
                assert position[1] > 7 and velocity[2] < -10 and board[1] < position[1], result.stdout
            data = frame.read_bytes().split(b'\n', 3)
            assert data[:3] == [b'P6', b'1280 720', b'255']
            pixels = data[3]
            landmarks = sum((g > r * 1.4 and g > b * 1.4 and g > 90) or
                            (r > g * 1.3 and g > b * 1.8 and r > 100)
                            for r, g, b in zip(pixels[0::3], pixels[1::3], pixels[2::3]))
            assert landmarks > 250, f'{name}: avatar landmarks missing ({landmarks})'
            print(f'PASS: desktop {name} ({sum(step["Ticks"] for step in steps)} rendered frames, {landmarks} body pixels)')


if __name__ == '__main__':
    main()
