"""Ride complete timed runs through the production Windows/Vulkan player."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from desktop_collision_test import fixture, write


def paths(root, name, bonus):
    write(root / name, dict(StartPosList=[], AIPaths=[], RaceLines=[dict(
        DistanceToFinish=5000, PathPos=[0, 0, 0], PathPoints=[[0, 10000, 0]],
        PathEvents=[dict(EventType=11, EventValue=bonus, EventStart=1200, EventEnd=1200),
                    dict(EventType=9, EventValue=0, EventStart=5000, EventEnd=5000)])]))


def main():
    exe = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-run-render-') as temporary:
        base = Path(temporary)
        for name, mode, foot, steps, expected in [
            ('race', 'race', False, [dict(Ticks=500)], 'FINISHED'),
            ('showoff', 'showoff', False, [dict(Ticks=500)], 'FINISHED'),
            ('timeout', 'showoff', False, [dict(Ticks=260, Posture=-1)], 'TIME UP'),
            ('ready', 'showoff', True, [dict(Ticks=60)], 'READY'),
            ('mount-run', 'race', True, [dict(Ticks=1, Mount=True), dict(Ticks=500)], 'FINISHED'),
            ('restart-held', 'race', False, [dict(Ticks=500), dict(Ticks=1, RunRestart=True),
                                          dict(Ticks=30, RunRestart=True)], 'COUNTDOWN'),
        ]:
            root = base / name
            fixture(root, mass=0, draw=False)
            paths(root, 'AIP.json', 150)
            paths(root, 'SOP.json', 45)
            write(root / 'Slopesmith.json', dict(schema=1, kind='slopesmith-export',
                                                showoffSeconds=.5 if name == 'timeout' else 10))
            replay = root / 'replay.json'
            write(replay, dict(Schema='openslope-replay/v1',
                              Placement=dict(Position=[0, 0, 0], Forward=[0, 0, -1]), Steps=steps))
            command = [str(exe), '--map', str(root), '--mode', mode, '--replay', str(replay),
                       '--capture', str(root / 'frame.ppm'), '--no-audio']
            if foot:
                command.append('--on-foot')
            result = subprocess.run(command, text=True, capture_output=True, timeout=90)
            assert result.returncode == 0, result.stdout + result.stderr
            line = next(row for row in result.stdout.splitlines() if row.startswith('Run:'))
            assert f'; {expected};' in line, result.stdout
            if name in ('race', 'mount-run'):
                assert '; checkpoints 1;' in line and '; clock 0:' in line, line
            if name == 'showoff':
                assert '; checkpoints 1;' in line and '; clock 0:5' in line, line
            if name == 'timeout':
                assert '; clock 0:00.00;' in line and '; checkpoints 0;' in line, line
            if name == 'ready':
                assert '; clock 0:10.00;' in line and '; elapsed 0;' in line, line
            if name == 'restart-held':
                assert '; elapsed 0;' in line and '; checkpoints 0;' in line, line
            print(f'PASS: {name}, {sum(step["Ticks"] for step in steps)} rendered frames: {line}')


if __name__ == '__main__':
    main()
