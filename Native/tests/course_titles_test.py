"""Synthetic source titles and metadata migration; no retail strings or bytes."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

from audio_import_test import archive, disc
from import_test import big, course_members
from ssx_import_test import members as ssx_members
from ssx3_import_test import members as ssx3_members
from ontour_import_test import members as tour_members
from madtrix_import_test import iso as madtrix_disc, package, members as madtrix_members


def executable(stride=28, streamed=False, bad_pointer=False):
    data = bytearray(4096)
    data[:7] = b'\x7fELF\x01\x01\x01'
    struct.pack_into('<HHI', data, 16, 2, 8, 1)
    struct.pack_into('<I', data, 28, 52)
    struct.pack_into('<HHH', data, 40, 52, 32, 1)
    struct.pack_into('<8I', data, 52, 1, 256, 0x100000, 0, len(data)-256, len(data)-256, 4, 16)
    if streamed:
        for index, (key, title) in enumerate([('SNOW', 'Disc Snow Run'), ('A', 'Disc Village')]):
            at = 512 + index * 100
            data[at:at+32] = title.encode().ljust(32, b'\0')
            data[at+48:at+64] = key.encode().ljust(16, b'\0')
            data[at+64:at+80] = b'BAM'.ljust(16, b'\0')
    else:
        strings = 1536
        for index, key in enumerate(['FIXTURE', 'OTHER']):
            pointers = []
            for value in ['Disc Ridge ' + str(index), 'MENU_' + key, key]:
                encoded = value.encode() + b'\0'
                data[strings:strings+len(encoded)] = encoded
                pointers.append(0x100000 + strings - 256)
                strings += len(encoded)
            if bad_pointer:
                pointers[0] = 0xdead0000
            struct.pack_into('<6I', data, 512 + index * stride, index, pointers[0], pointers[1], 2500, 0, pointers[2])
    return bytes(data)


def boot_files(data):
    return {'SYSTEM.CNF': b'BOOT2 = cdrom0:\\FIXTURE.ELF;1\r\n', 'FIXTURE.ELF': data}


def locale_key(key):
    result = 0
    for char in key.encode():
        result = ((result << 4) + char) & 0xffffffff
        high = result & 0xf0000000
        result = (result ^ (high >> 23)) & ~high
    return result


def locale():
    rows = [('TRACK_NAME_er1', 'Disc Ridge \U0001f3c2'), ('MAP_FreerideDay', 'Freeride %s Dawn'),
            ('MAP_FreerideNight', 'Freeride %s Moon')]
    body = bytearray(b'LOCL' + bytes(12 + len(rows) * 4))
    struct.pack_into('<I', body, 12, len(rows))
    for index, (_, title) in enumerate(rows):
        struct.pack_into('<I', body, 16 + index * 4, len(body))
        body += title.encode('utf-16-le') + bytes(2)
    struct.pack_into('<I', body, 4, len(body))
    header = bytearray(b'LOCH' + bytes(16))
    struct.pack_into('<I', header, 16, 20)
    return header + body + b'LOCT' + struct.pack('<II', 12, len(rows)) + b''.join(
        struct.pack('<II', locale_key(key), index) for index, (key, _) in enumerate(rows))


def main():
    importer = Path(sys.argv[1]).resolve()
    def run(*args):
        result = subprocess.run([str(importer), *map(str, args)], capture_output=True, encoding='utf-8', timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout
    with tempfile.TemporaryDirectory(prefix='openslope-titles-') as temporary:
        root = Path(temporary)
        for stride, files, expected in [(24, ssx_members(), 'SSX_FIXTURE'), (28, course_members(), 'TRICKY_FIXTURE')]:
            image = root / f'descriptors-{stride}.iso'
            source = {'DATA/MODELS/FIXTURE.BIG': big(files, compact=False), **boot_files(executable(stride))}
            image.write_bytes(disc(source))
            assert json.loads(run('names', image))[0]['DisplayName'] == 'Disc Ridge 0'
            maps = root / f'Maps-{stride}'
            run('extract', image, expected, maps)
            metadata = json.loads((maps / expected / 'Import.json').read_text())
            assert metadata['DisplayName'] == 'Disc Ridge 0' and metadata['Course'] == expected
            if stride == 28:
                run('extract', image, 'FIXTURE', maps)
                legacy = maps / 'FIXTURE/Import.json'
                old = json.loads(legacy.read_text())
                assert old['DisplayName'] == 'Disc Ridge 0' and old['Course'] == 'FIXTURE'
                old.pop('DisplayName'); legacy.write_text(json.dumps(old))
                assert 'Updated 1 map title(s)' in run('refresh-names', image, maps)
                assert json.loads(legacy.read_text())['Course'] == 'FIXTURE'
                assert json.loads(legacy.read_text())['DisplayName'] == 'Disc Ridge 0'
            source.update(boot_files(executable(stride, bad_pointer=True)))
            image.write_bytes(disc(source))
            assert not json.loads(run('names', image))[0]['DisplayName'], 'Bad optional pointers retain the discovered course'
        streamed = root / 'streamed.iso'
        files = ssx3_members()
        database = bytearray(files['data/worlds/bam.sdb'])
        struct.pack_into('<I', database, 8, 5)
        database += b'A_SNOW'.ljust(88, b'\0')
        files['data/worlds/bam.sdb'] = bytes(database)
        streamed.write_bytes(disc({'DATA/WORLDS/BAM.BIG': archive(files), **boot_files(executable(streamed=True))}))
        names = {row['Course']: row.get('DisplayName') for row in json.loads(run('names', streamed))}
        assert names['SSX3_A'] == 'Disc Village'
        assert names['SSX3_A_SNOW'] == 'Disc Village / Disc Snow Run'
        assert names['SSX3_PEAK1'] == 'Peak 1'
        layouts = {row['Course']: row for row in json.loads(run('names', streamed))}
        assert layouts['SSX3_A']['MapType'] == 'hub'
        assert layouts['SSX3_A_SNOW']['MapType'] == 'connector'
        assert layouts['SSX3_A_SNOW']['Connects'] == ['SSX3_A', 'SSX3_SNOW']
        assert layouts['SSX3_PEAK1']['MapType'] == 'run-chain'
        assert layouts['SSX3_A']['WorldId'] == layouts['SSX3_PEAK1']['WorldId'] == 'ssx-3:bam'
        tour = root / 'tour.iso'
        tour_files = {'DATA/WORLDS/BAM.BIG': archive(tour_members()), 'DATA/LOCALE/FEAMER.LOC': locale()}
        tour.write_bytes(disc(tour_files))
        names = {row['Course']: row['DisplayName'] for row in json.loads(run('names', tour))}
        assert names == {'SSXOT_ER1_DAY': 'Disc Ridge \U0001f3c2 (Dawn)', 'SSXOT_ER1_NIGHT': 'Disc Ridge \U0001f3c2 (Moon)'}
        run('extract', tour, 'SSXOT_ER1_DAY', root / 'tour-maps')
        assert json.loads((root / 'tour-maps/SSXOT_ER1_DAY/Import.json').read_text(encoding='utf-8'))['DisplayName'] == names['SSXOT_ER1_DAY']
        tour_files['DATA/LOCALE/FEAMER.LOC'] = locale()[:-1]
        tour.write_bytes(disc(tour_files))
        assert all(not row['DisplayName'] for row in json.loads(run('names', tour))), 'Truncated locale data is optional'
        madtrix = root / 'madtrix.iso'
        madtrix.write_bytes(madtrix_disc(package(madtrix_members()), titles_csv=b'Unused,"multi\nline",x\r\nAA_fixture.pak,"Disc, ""Ridge""",x\r\n'))
        names = json.loads(run('names', madtrix))
        assert names[0]['DisplayName'] == 'Disc, "Ridge"'
        run('extract', madtrix, 'MADTRIX_AA_FIXTURE', root / 'madtrix-maps')
        sidecar = root / 'madtrix-maps/MADTRIX_AA_FIXTURE/Import.json'
        metadata = json.loads(sidecar.read_text())
        assert metadata.pop('DisplayName') == 'Disc, "Ridge"'
        metadata.pop('NameSource')
        metadata['Preserved'] = {'value': 42}
        sidecar.write_text(json.dumps(metadata))
        original = sidecar.read_bytes()
        assert 'Would update 1 map title(s)' in run('refresh-names', madtrix, sidecar.parent.parent, '--dry-run')
        assert sidecar.read_bytes() == original and not sidecar.with_name('Import.names-backup.json').exists()
        run('refresh-names', madtrix, sidecar.parent.parent)
        refreshed = json.loads(sidecar.read_text())
        assert refreshed['DisplayName'] == 'Disc, "Ridge"' and refreshed['Preserved'] == {'value': 42}
        assert sidecar.with_name('Import.names-backup.json').read_bytes() == original
        assert 'Updated 0 map title(s)' in run('refresh-names', madtrix, sidecar.parent.parent)
        sidecar.with_name('Slopesmith.json').write_text('{}')
        sidecar.write_text(json.dumps(metadata))
        assert 'Updated 0 map title(s)' in run('refresh-names', madtrix, sidecar.parent.parent), 'Authored maps are skipped'
    print('PASS: source descriptors, bounded locale Unicode, CSV quoting, import metadata and reversible refresh')


if __name__ == '__main__':
    main()
