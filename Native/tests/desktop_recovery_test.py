from gear_pixels import board_pixel
"""Crash, animated get-up and resumed riding through the production Vulkan host."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from desktop_collision_test import fixture, write


def state(output):
    position, velocity = re.search(r'position \[([^\]]+)\]; velocity \[([^\]]+)\]', output).groups()
    return tuple(map(float, position.split(','))), tuple(map(float, velocity.split(',')))


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-desktop-recovery-') as temporary:
        base = Path(temporary)
        for name in ('inverted', 'heavy', 'prop', 'missing-marker'):
            root = base / name
            fixture(root, mass=1 if name == 'prop' else 0)
            placement = dict(Position=[100,.1,0], Forward=[0,0,-1], Velocity=[0,-12,-12], Up=[0,-1,0])
            cause = 2
            if name == 'heavy': placement.update(Velocity=[0,-31,-5], Up=[0,1,0])
            if name == 'prop':
                placement = dict(Position=[-1.5,-.005,0], Forward=[1,0,0], Velocity=[27,0,0])
                cause = 1
            if name == 'missing-marker':
                write(root / 'RiderAnimations.json', dict(Schema='openslope-rider-animation/v1', GetUp=[
                    dict(Time=0,Standing=0,Crouch=1,Height=.35), dict(Time=.1,Standing=1,Crouch=0,Height=0)]))
            write(root / 'replay.json', dict(Schema='openslope-replay/v1', Placement=placement, Steps=[dict(Ticks=300)]))
            image = root / 'frame.ppm'
            result = subprocess.run([str(executable),'--map',str(root),'--replay',str(root/'replay.json'),
                                     '--capture',str(image),'--no-audio'],text=True,capture_output=True,timeout=90)
            assert result.returncode == 0, result.stdout + result.stderr
            assert 'Replay: 300 rendered frames' in result.stdout and 'launches 0' in result.stdout, result.stdout
            assert f'Recovery: 1 crashes; {0 if name == "missing-marker" else 1} get-ups; waiting {1 if name == "missing-marker" else 0}; standing 1; cause {cause}' in result.stdout, result.stdout
            assert 'grounded 1' in result.stdout, result.stdout
            position, velocity = state(result.stdout)
            if name == 'prop': assert position[0] < -2 and velocity[0] < 0, result.stdout
            else: assert position[0] > 90 and position[2] < -2, result.stdout
            pixels = image.read_bytes().split(b'\n',3)
            assert pixels[:3] == [b'P6',b'1280 720',b'255']
            board = sum(board_pixel(pixels[3][i:i+3]) for i in range(0,len(pixels[3]),3))
            assert board > 25, f'{name}: get-up board is not visible ({board} pixels)'
            print(f'PASS: desktop {name} recovery (300 rendered frames, {board} board pixels)')


if __name__ == '__main__':
    main()
