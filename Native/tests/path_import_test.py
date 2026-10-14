"""Authored course-path byte oracle, independent of generated course data."""
import json
from pathlib import Path
import struct
import sys
import tempfile
from prop_import_test import members as prop_members
from import_test import big, iso, run


def path_file():
    def path(seed, reverse=False):
        header = struct.pack('<9I9f', 2, 100, 4, 50, 101, 4, 1, 2, 1, *seed, *seed, seed[0] + 100, seed[1] + 200, seed[2] + 50)
        points = struct.pack('<8f', 1, 0, .5, 100, 0, 1, -.25, 200)
        event = struct.pack('<2I2f', 100, 324, 100, 50 if reverse else 200)
        return header + points + event
    ai = struct.pack('<8I', 2, 6, 0, 1, 0, 1, 0, 1) + path((100, 200, 300)) + path((1000, 200, 300), True)
    race = struct.pack('<3If2I9f', 1, 0, 4, 500, 1, 2, 0, 0, 0, 0, 0, 0, 500, 0, 0)
    race += struct.pack('<4f', 1, 0, 0, 500)
    race += struct.pack('<2I2f', 11, 20, 200, 200) + struct.pack('<2I2f', 9, 0, 500, 500)
    section = struct.pack('<4I', 1, len(race) + 8, 1, 0) + race
    return struct.pack('<4I', 0x0a0a0a0a, 2, 0, len(ai)) + ai + section


def members():
    files = prop_members()
    files['fixture.aip'] = path_file()
    files['fixture.sop'] = path_file()
    return files


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-path-import-') as directory:
        root = Path(directory); image = root / 'authored.iso'; files = members()
        image.write_bytes(iso(big(files)))
        run(executable, 'extract', image, 'FIXTURE', root / 'Maps')
        output = root / 'Maps/FIXTURE'
        for kind in ['AIP', 'SOP']:
            data = json.loads((output / f'{kind}.json').read_text())
            assert data['StartPosList'] == [0, 1, 0, 1, 0, 1]
            assert len(data['AIPaths']) == 2 and len(data['RaceLines']) == 1
            assert data['AIPaths'][0]['PathPos'] == [100, 200, 300]
            assert data['AIPaths'][0]['PathPoints'] == [[100, 0, 50], [0, 200, -50]]
            assert data['AIPaths'][0]['PathEvents'] == [dict(EventType=100, EventValue=324, EventStart=100, EventEnd=200)]
            assert data['AIPaths'][1]['PathEvents'][0]['EventEnd'] == 50
            assert data['RaceLines'][0]['DistanceToFinish'] == 500
            assert data['RaceLines'][0]['PathEvents'][1]['EventType'] == 9
        report = json.loads((output / 'Import.json').read_text())
        assert 'AIP.json' in report['Outputs'] and 'SOP.json' in report['Outputs']
        for field, value in [(12, 0), (24, 1000), (16 + 32 + 28, 100001)]:
            bad = members(); payload = bytearray(bad['fixture.aip']); struct.pack_into('<I', payload, field, value)
            bad['fixture.aip'] = bytes(payload); image.write_bytes(iso(big(bad)))
            destination = root / f'bad-{field}'
            run(executable, 'extract', image, 'FIXTURE', destination, succeeds=False)
            assert not list(destination.iterdir())
    print('PASS: authored path sections, relative offsets, start slots, displacement expansion, events and corrupt-import cleanup')


if __name__ == '__main__':
    main()
