"""Compare actual-host full/culling submission on user-supplied Maps courses."""
import argparse
import json
from pathlib import Path
import re
import statistics
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', type=Path)
    parser.add_argument('maps', type=Path)
    parser.add_argument('output', type=Path, help='New directory; captures stay local')
    parser.add_argument('--courses', nargs='+', required=True)
    parser.add_argument('--ticks', type=int, default=180)
    parser.add_argument('--runs', type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.ticks <= 3600 or not 1 <= args.runs <= 10:
        parser.error('Ticks must be 1..3600 and runs 1..10')
    for name in args.courses:
        if name in ('.', '..') or '/' in name or '\\' in name or ':' in name:
            parser.error('Courses must be immediate Maps directory names')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    sequence = output / 'run.json'
    sequence.write_text(json.dumps(dict(Schema='openslope-replay/v1', Steps=[dict(Ticks=args.ticks)])))
    rows = []
    number = r'([-+eE\d.]+)'
    for course in args.courses:
        reference = None
        reference_state = None
        modes = [mode for run in range(args.runs) for mode in ([False, True] if run % 2 == 0 else [True, False])]
        for index, enabled in enumerate(modes):
            prefix = f'{course}-{index}'
            picture = output / (prefix + '.ppm')
            command = [str(args.executable.resolve()), '--map', str((args.maps / course).resolve()),
                       '--capture', str(picture), '--replay', str(sequence), '--msaa', '4']
            if not enabled:
                command.append('--no-terrain-culling')
            result = subprocess.run(command, capture_output=True, text=True, timeout=180)
            (output / (prefix + '.log')).write_text(result.stdout + result.stderr)
            if result.returncode:
                raise RuntimeError(result.stderr)
            timing = re.search(r'average simulation ' + number + r' ms; render wall ' + number + r' ms; GPU ' + number + r' ms', result.stdout)
            terrain = re.search(r'Terrain: (\d+)/(\d+) patches; (\d+)/(\d+) indices; (\d+) draws; (\d+) bounds tests; average visibility ' + number + r' ms; average submitted ' + number + r' indices', result.stdout)
            if not timing or not terrain:
                raise RuntimeError('Host diagnostics do not match the benchmark contract')
            state = next(line for line in result.stdout.splitlines() if line.startswith('Replay:')).split('; average simulation')[0]
            if reference_state is not None and state != reference_state:
                raise RuntimeError(course + ': final gameplay state differs across runs')
            reference_state = state
            row = dict(Course=course, Culling=enabled, SimulationMs=float(timing[1]), RenderWallMs=float(timing[2]),
                       GpuMs=float(timing[3]), VisiblePatches=int(terrain[1]), TotalPatches=int(terrain[2]),
                       Indices=int(terrain[3]), TotalIndices=int(terrain[4]), Draws=int(terrain[5]),
                       BoundsTests=int(terrain[6]), VisibilityMs=float(terrain[7]), AverageIndices=float(terrain[8]))
            rows.append(row)
            print(json.dumps(row), flush=True)
            pixels = picture.read_bytes()
            if reference is not None and pixels != reference:
                raise RuntimeError(course + ': final pixels differ across runs/submission modes')
            reference = pixels
        for key in ['GpuMs', 'RenderWallMs', 'VisibilityMs', 'AverageIndices']:
            values = {str(mode): statistics.median(row[key] for row in rows if row['Course'] == course and row['Culling'] == mode) for mode in [False, True]}
            print(course, key, values, flush=True)
    (output / 'results.json').write_text(json.dumps(rows, indent=2))
    print('PASS: matching final gameplay state/pixels and local CPU/GPU measurements', flush=True)


if __name__ == '__main__':
    main()
