"""Verify score outcomes through the production player, fixed clock and Vulkan host."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def main():
    executable = str(Path(sys.argv[1]).resolve())
    frames = 0
    held = dict(Relative=True, Head=[0, 1.65, 0], Grip=[False, True],
                Hands=[dict(Position=[0, 1.1, 0]) for _ in range(2)])
    with tempfile.TemporaryDirectory(prefix='openslope-score-replay-') as temporary:
        root = Path(temporary)
        patch = dict(PatchName='Authored score floor', SurfaceType=1, TrickOnlyPatch=False,
                     Points=[[(u / 3 - .5) * 200000, (v / 3 - .5) * 200000, 0]
                             for u in range(4) for v in range(4)],
                     UVPoints=[[0, 0], [1, 0], [0, 1], [1, 1]],
                     TexturePath='', LightmapID=-1, LightMapPoint=[0, 0, 0, 0])
        (root / 'Patches.json').write_text(json.dumps({'Patches': [patch]}))
        for name, seconds, steps, expected in [
            ('bank', 2.2, [{'Ticks': 80, 'Posture': 1}, {'Ticks': 80}], (1700, .42, 0)),
            ('crash', 2.2, [{'Ticks': 20, 'Posture': 1}, {'Ticks': 140}], (0, .15, 1)),
            ('reset', 2.2, [{'Ticks': 80, 'Posture': 1}, {'Ticks': 30},
                            {'Ticks': 1, 'Reset': True}, {'Ticks': 60}], (1700, .3, 0)),
            ('midair-finish', 2/3, [{'Ticks': 40, 'Steer': 1}, {'Ticks': 60}], (850, .25, 0)),
            ('grab', 2.2, [{'Ticks': 60, 'Equipment': held},
                          {'Ticks': 1, 'Equipment': {**held, 'Trigger': [False, True]}},
                          {'Ticks': 100}], (4590, .309, 0)),
            ('grab-release', 2.2, [{'Ticks': 60, 'Equipment': held}, {'Ticks': 100}], (0, .25, 1)),
            ('grab-time-up', .5, [{'Ticks': 60, 'Equipment': held},
                                 {'Ticks': 1, 'Equipment': {**held, 'Trigger': [False, True]}},
                                 {'Ticks': 60}], (440, .25, 0)),
        ]:
            (root / 'Slopesmith.json').write_text(json.dumps(
                dict(schema=1, kind='slopesmith-export', showoffSeconds=seconds)))
            sequence = root / (name + '.json')
            sequence.write_text(json.dumps(dict(Schema='openslope-replay/v1',
                Placement=dict(Position=[0, 20, 0], Forward=[0, 0, -1], Velocity=[0, 0, -12]),
                Steps=[{'Ticks': 180}] + steps)))
            output = root / (name + '.ppm')
            result = subprocess.run([executable, '--map', str(root), '--mode', 'showoff',
                '--capture', str(output), '--replay', str(sequence), '--no-audio',
                '--snow', '0', '--render-scale', '100', '--msaa', '1'],
                capture_output=True, text=True, timeout=120)
            assert result.returncode == 0, result.stdout + result.stderr
            assert 'Run: SHOWOFF; TIME UP;' in result.stdout, result.stdout
            score = re.search(r'Score: (\d+); banked (\d+); preview (\d+); boost ([\d.]+);.*active (\d); finished (\d);.*bailed (\d)', result.stdout)
            assert score, result.stdout
            total, banked, preview, meter, active, finished, bailed = score.groups()
            assert (int(total), int(banked), int(preview), int(active), int(finished), int(bailed)) == (
                expected[0], expected[0], 0, 0, 1, expected[2]), result.stdout
            assert abs(float(meter) - expected[1]) < 1e-6, result.stdout
            if name == 'midair-finish':
                assert 'landings 1; grounded 1;' in result.stdout, 'Time-up must let the airborne rider reach the ground'
                velocity = re.search(r'velocity \[([^]]+)\]', result.stdout)
                assert velocity and sum(float(v)**2 for v in velocity[1].split(',')) > 1, result.stdout
            if name == 'crash':
                assert 'wipeout 0;' in result.stdout, 'Score loss must not introduce a forced knockdown'
            image = output.read_bytes().split(b'\n', 3)
            assert image[:3] == [b'P6', b'1280 720', b'255'] and len(image[3]) == 1280*720*3
            assert len(set(image[3])) > 20, 'Rendered score replay has no scene'
            frames += sum(step['Ticks'] for step in steps) + 180
    print(f'PASS: {frames} production Vulkan frames cover banking, grab/remount/release, loss without knockdowns, '
          'meter and frozen results with continued riding')


if __name__ == '__main__':
    main()
