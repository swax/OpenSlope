"""Synthetic SSX 3 preview: duplicate world members and an earlier database version."""
import json
from pathlib import Path
import struct
import sys
import tempfile

from audio_import_test import disc as iso
from course_titles_test import boot_files, executable
from import_test import run
from ssx3_import_test import members


def preview_disc(conflicting=False):
    files = members(lambda rows: [(kind - 1 if kind >= 8 else kind,
                                  rid, payload) for kind, rid, payload in rows])
    database = bytearray(files['data/worlds/bam.sdb'])
    struct.pack_into('<I', database, 0, 0x01003600)
    database[168:184] = b'ARA1'.ljust(16, b'\0')
    files['data/worlds/bam.sdb'] = bytes(database)
    rows = []
    for name, payload in files.items():
        rows.append((name, payload))
        duplicate = payload
        if conflicting and name.endswith('.sdb'):
            duplicate = payload[:-1] + bytes([payload[-1] ^ 1])
        rows.append((name, duplicate))
    end = 16 + sum(9 + len(name) for name, _ in rows)
    archive = bytearray(b'BIGF' + bytes(4) + struct.pack('>II', len(rows), end))
    offset = end
    for name, payload in rows:
        archive += struct.pack('>II', offset, len(payload)) + name.encode() + b'\0'
        offset += len(payload)
    archive += b''.join(payload for _, payload in rows)
    boot = bytearray(executable(streamed=True))
    boot[560:576] = b'ARA1'.ljust(16, b'\0')
    return iso({'DATA/WORLDS/BAM.BIG': bytes(archive), **boot_files(bytes(boot))})


def main():
    importer = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-ssx3-beta-') as temporary:
        root = Path(temporary)
        source = root / 'preview.iso'
        source.write_bytes(preview_disc())
        courses = json.loads(run(importer, 'names', source))
        assert {row['Course'] for row in courses} == {'SSX3B_ARA1', 'SSX3B_C', 'SSX3B_E', 'SSX3B_PEAK1', 'SSX3B_PEAK2', 'SSX3B_PEAK3'}
        hub = next(row for row in courses if row['Course'] == 'SSX3B_ARA1')
        assert hub['DisplayName'] == 'Disc Snow Run'
        assert hub['WorldId'] == 'ssx-3-beta:bam' and hub['ParentMap'] == 'SSX3B_PEAK1'
        for course in ['SSX3B_ARA1', 'SSX3B_PEAK1']:
            run(importer, 'extract', source, course, root / 'Maps')
            out = root / 'Maps' / course
            metadata = json.loads((out / 'Import.json').read_text())
            origin = json.loads((out / 'Origin.json').read_text())
            effects = json.loads((out / 'Effects.json').read_text())
            assert metadata['Game'] == origin['Game'] == effects['target']['game'] == 'ssx-3-beta'
            assert metadata['Course'] == origin['Course'] == course
            assert metadata['WorldId'] == 'ssx-3-beta:bam'
            assert len(json.loads((out / 'Patches.json').read_text())['Patches']) == 1
            assert len(json.loads((out / 'Instances.json').read_text())['Instances']) == 2
            assert json.loads((out / 'SoundBindings.json').read_text())['Game'] == 'ssx-3-beta'
            if course == 'SSX3B_ARA1':
                assert json.loads((out / 'AIP.json').read_text())['StartPosList']
            source_bins = {row['Bin'] for row in json.loads((out / 'Source/Resources.json').read_text())}
            assert {7, 8, 9, 11, 13, 15} <= source_bins
            assert json.loads((out / 'Splines.json').read_text())['Splines']
        run(importer, 'extract', source, 'SSX3_ARA1', root / 'wrong-game', succeeds=False)
        assert not (root / 'wrong-game/SSX3_ARA1').exists()
        source.write_bytes(preview_disc(conflicting=True))
        run(importer, 'list', source, succeeds=False)
        run(importer, 'extract', source, 'SSX3B_ARA1', root / 'conflict', succeeds=False)
        assert not (root / 'conflict/SSX3B_ARA1').exists()
    print('SSX 3 beta discovery, titles, isolated identities, conversion and duplicate validation passed')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        Path(sys.argv[2]).write_bytes(preview_disc())
    else:
        main()
