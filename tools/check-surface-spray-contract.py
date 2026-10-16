"""Read functional spray data through the independent native importer; never writes the image."""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso', type=Path)
    parser.add_argument('--importer', type=Path, default=Path('temp/native/Release/openslope_import.exe'))
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    expected = json.loads((root/'Contracts/surface-spray-v1.json').read_text())
    result = subprocess.run([str(arguments.importer.resolve()),'surface-spray',str(arguments.iso.resolve())],
                            capture_output=True,text=True,timeout=60)
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)
    actual = json.loads(result.stdout)
    if actual['schema'] != expected['schema'] or actual['version'] != expected['version']:
        raise SystemExit('Surface profile schema/version mismatch')
    if actual['rows'] != expected['rows']:
        raise SystemExit('Supplied executable does not match the tracked functional surface profile')
    print('PASS: all 20 surface rows / 140 typed effect fields match independent executable recovery')


if __name__ == '__main__':
    main()
