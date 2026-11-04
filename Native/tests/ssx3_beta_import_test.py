"""Synthetic SSX 3 preview: duplicate world members and an earlier database version."""
import json
from pathlib import Path
import struct
import sys
import tempfile

from audio_import_test import disc as iso, archive as audio_archive
from course_titles_test import boot_files, executable
from import_test import run, ssh
from riding_audio_import_test import encoded_bank
from ssx3_import_test import members, names, material_animation, check_materials


def preview_disc(conflicting=False, short_fog=False, music=None, single_area=False, world_edit=None,
                 model_name='mdl_ARA1_multia_1000'):
    def edit(rows):
        if world_edit:
            rows = world_edit(rows)
        return [(kind - 1 if kind >= 8 else kind, rid, payload) for kind, rid, payload in rows]
    files = members(edit)
    files['data/worlds/bam.phm'], files['data/worlds/bam.psm'] = names(model_rows=[(1, model_name)])
    database = bytearray(files['data/worlds/bam.sdb'])
    struct.pack_into('<I', database, 0, 0x01003600)
    database[168:184] = b'ARA1'.ljust(16, b'\0')
    if single_area:
        database = database[:80 + 2 * 88]
        struct.pack_into('<I', database, 8, 2)
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
    # The preview fog sprite includes a mip level inside its image chunk.
    image = b'\x02' + (20 if short_fog else 21).to_bytes(3, 'little') + struct.pack('<HHHHI', 2, 2, 0, 0, 1 << 28)
    image += bytes([0, 1, 2, 3, 0]) + ssh()[52:84]
    fog = b'SHPS' + struct.pack('<II', 24 + len(image), 1) + b'TESTfog0' + struct.pack('<I', 24) + image
    return iso({'DATA/WORLDS/BAM.BIG': bytes(archive), **boot_files(bytes(boot)),
                'DATA/TEXTURES/PARTICLE.SSH': bytes(fog),
                'DATA/CONFIG/BANKS.INF': b'[WORLD]\nBOARD = ride.bnk\nLAND = ride.bnk\n',
                'DATA/CONFIG/SNOW.INF': b'# synthetic preview configuration\n',
                'DATA/AUDIO/AUDIO.BIG': audio_archive({'data/audio/ride.bnk': encoded_bank()}), **(music or {})})


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
            board = json.loads((out / 'Audio/SFX/openslope_board/bank.json').read_text())['Slots']
            assert board[3] is not None and board[4] is not None
            assert (out / 'Audio/SFX/openslope_board/004.loop.wav').is_file()
            assert (out / 'Textures/Particles/fog0.png').read_bytes().startswith(b'\x89PNG')
            assert (out / 'Source/particle.ssh').is_file()
            pickup = json.loads((out / 'Models.json').read_text())['Models'][0]
            assert pickup['Pickup']['Kind'] == 'score-multiplier' and pickup['Pickup']['Value'] == 2
            assert pickup['ModelObjects'][0]['IncludeAnimation'] and pickup['AnimTime'] == 60
        for conditional in [False, True]:
            source.write_bytes(preview_disc(world_edit=lambda rows: material_animation(rows, conditional, preview=True),
                                            model_name='mdl_ARA1_fixture_1000'))
            label = 'conditional-material' if conditional else 'moving-material'
            run(importer, 'extract', source, 'SSX3B_ARA1', root / label)
            check_materials(root / label / 'SSX3B_ARA1', active=not conditional)
        source.write_bytes(preview_disc(short_fog=True))
        run(importer, 'extract', source, 'SSX3B_ARA1', root / 'short-fog', succeeds=False)
        assert not (root / 'short-fog/SSX3B_ARA1').exists()
        source.write_bytes(preview_disc())
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
