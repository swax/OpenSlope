"""Repeat production ISO discovery/extraction, retaining timings and output hashes locally."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', type=Path)
    parser.add_argument('iso', type=Path)
    parser.add_argument('output', type=Path, help='New directory for private outputs and evidence')
    parser.add_argument('--courses', nargs='*', default=[])
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--reference-executable', type=Path, help='Alternate baseline and candidate runs and require identical output hashes')
    args = parser.parse_args()
    if not 1 <= args.runs <= 10:
        parser.error('Runs must be 1..10')
    if any(not name or name.startswith('.') or any(c in name for c in '/\\:') for name in args.courses):
        parser.error('Courses must be immediate map names')
    args.output.mkdir(parents=True, exist_ok=False)
    variants = [('candidate', args.executable)]
    if args.reference_executable:
        variants.insert(0, ('reference', args.reference_executable))
    rows = []
    for course in [None, *args.courses]:
        reference = None
        for index in range(args.runs):
            for variant, executable in (variants if index % 2 == 0 else variants[::-1]):
                label = f'{variant}-{course or "discovery"}-{index}'
                command = [str(executable.resolve()), str(args.iso.resolve())]
                if course:
                    command += [course, str((args.output / label).resolve())]
                process = subprocess.run(command, text=True, capture_output=True, timeout=1800)
                if process.returncode:
                    raise RuntimeError(process.stdout + process.stderr)
                row = json.loads(process.stdout)
                row['variant'] = variant
                rows.append(row)
                (args.output / (label + '.json')).write_text(json.dumps(row, indent=2) + '\n')
                if course:
                    folder = args.output / label
                    manifest = {file.relative_to(folder).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
                                for file in sorted(folder.rglob('*')) if file.is_file()}
                    (args.output / (label + '-hashes.json')).write_text(json.dumps(manifest, indent=2) + '\n')
                else:
                    manifest = row['courses']
                if reference is not None and reference != manifest:
                    raise RuntimeError(f'{course or "discovery"}: output differs between runs/variants')
                reference = manifest
                print(f'{label}: {row["elapsed_ms"]:.1f} ms, {row["read_bytes"]} ISO bytes', flush=True)
    summary = []
    for course in [None, *args.courses]:
        for variant, _ in variants:
            group = [row for row in rows if row.get('course') == course and row['variant'] == variant]
            summary.append(dict(operation=course or 'discovery', variant=variant,
                                median_ms=statistics.median(row['elapsed_ms'] for row in group),
                                min_ms=min(row['elapsed_ms'] for row in group),
                                max_ms=max(row['elapsed_ms'] for row in group)))
    (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
