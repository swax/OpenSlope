"""Exercise accepted/refused/manual/automatic path recovery in the Vulkan player."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def main():
    executable = str(Path(sys.argv[1]).resolve())
    frames = 0
    with tempfile.TemporaryDirectory(prefix='openslope-course-recovery-replay-') as temporary:
        root = Path(temporary)
        patch = dict(PatchName='Authored recovery replay floor', SurfaceType=1,
                     TrickOnlyPatch=False, TexturePath='', LightmapID=-1,
                     Points=[[(u/3-.5)*200000, (v/3-.5)*200000, 0]
                             for u in range(4) for v in range(4)],
                     UVPoints=[[0, 0], [0, 1], [1, 0], [1, 1]], LightMapPoint=[0, 0, 0, 0])
        (root/'Patches.json').write_text(json.dumps({'Patches': [patch]}))
        for name, blocked, height, manual, expected_x, expected_energy in [
            ('manual', False, -.005, True, 6, .13),
            ('refused', True, -.005, True, 25, .25),
            ('automatic', False, -100, False, 6, .25),
        ]:
            events = [dict(EventType=104, EventValue=0, EventStart=8000, EventEnd=12000)] if blocked else []
            path = dict(PathPos=[600, 0, 0], PathPoints=[[0, -20000, 0]],
                        Respawnable=True, PathEvents=events)
            (root/'AIP.json').write_text(json.dumps(dict(StartPosList=[], AIPaths=[path], RaceLines=[])))
            steps = [{'Ticks': 180}, {'Ticks': 1}]
            if manual:
                steps.append({'Ticks': 1, 'Reset': True})
            if not blocked:
                steps.append({'Ticks': 48})
            replay = root/(name+'.json')
            replay.write_text(json.dumps(dict(Schema='openslope-replay/v1',
                Placement=dict(Position=[25, height, 100], Forward=[0, 0, 1]), Steps=steps)))
            output = root/(name+'.ppm')
            result = subprocess.run([executable, '--map', str(root), '--mode', 'showoff',
                '--replay', str(replay), '--capture', str(output), '--no-audio'],
                capture_output=True, text=True, timeout=120)
            assert result.returncode == 0, result.stdout + result.stderr
            position = re.search(r'position \[([^,]+),([^,]+),([^\]]+)\]', result.stdout)
            assert position, result.stdout
            x, y, z = map(float, position.groups())
            assert abs(x-expected_x) < 1e-6 and abs(z-100) < 1e-6, result.stdout
            if not blocked:
                assert abs(y-1) < 1e-6, result.stdout
                assert 'Course recovery: pending 0; fade 1' in result.stdout, result.stdout
            score = re.search(r'Score:.*boost ([\d.]+)', result.stdout)
            assert score and abs(float(score[1])-expected_energy) < 1e-6, result.stdout
            pixels = output.read_bytes().split(b'\n', 3)
            assert pixels[:3] == [b'P6', b'1280 720', b'255'] and len(pixels[3]) == 1280*720*3
            if not blocked:
                assert set(pixels[3]) == {0}, 'Placement must render under a fully black fade'
            frames += sum(step['Ticks'] for step in steps)
    print(f'PASS: {frames} production Vulkan frames cover nearby manual/automatic recovery and no-reset refusal')


if __name__ == '__main__':
    main()
