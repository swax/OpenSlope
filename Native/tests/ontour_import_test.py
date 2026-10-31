"""Original synthetic On Tour records; no retail data or external decoder."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile

from import_test import le, png_pixels, refpack, run
from ssx3_import_test import HELPER_CASES, check_lights, check_materials, check_sounds, disc, fog_fixture, light_fixture, material_program, model as ssx3_model, proxy, sound_attachments
from audio_container_test import bank, literal_bank
from audio_import_test import archive, disc as audio_disc


def resource(kind, rid, data, mask=3):
    return le(kind | (mask << 8) | (len(data) << 10)) + le(rid) + data


def compressed(data, carry=0):
    payload = refpack(data)
    assert len(payload) <= 32756
    return b'CEND' + le(32768) + le(3 | (carry << 8)) + payload + bytes(32756 - len(payload))


def texture(night=False, light=False):
    b = bytearray(128)
    b[0] = 5 if light else 1
    struct.pack_into('<II', b, 24, 2, 2)
    struct.pack_into('<I', b, 8, 128)
    if light:
        return bytes(b) + bytes([20, 40, 60, 100]) * 4
    struct.pack_into('<I', b, 4, 130)
    palette = bytearray(128 + 16 * 4)
    palette[0] = 33
    palette[128:132] = bytes([20, 30, 100, 128] if night else [80, 120, 200, 128])
    return bytes(b) + bytes(2) + bytes(palette)


def model():
    b = bytearray(ssx3_model())
    struct.pack_into('<I', b, 44, 0)  # A global material resource, including id zero.
    struct.pack_into('<II', b, 88, 1, 100)  # On Tour removed the extra object word.
    return bytes(b)


def placement():
    b = bytearray(256)
    struct.pack_into('<16f', b, 16, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 2000, 3000, 1)
    struct.pack_into('<If', b, 120, 0, 2)
    struct.pack_into('<4I', b, 144, 192, 1, 0, 0)
    struct.pack_into('<I', b, 192, 0x60000000)
    b[223] = 0x6f
    b[222] = 4
    struct.pack_into('<4H', b, 224, *([0xc210] * 4))
    return bytes(b)


def path():
    b = bytearray(92)
    struct.pack_into('<3I', b, 0, 0x69696923, 1, 3)
    for i, value in enumerate([46, 1, 128]):
        struct.pack_into('<3I', b, 12 + i * 12, 100 + i, 4, value)
    struct.pack_into('<2I3f', b, 48, 1, 1, 1000, 2000, 3000)
    return bytes(b) + bytes([0, 0, 127, 0]) + struct.pack('<4f', 1, 0, -.1, 100) + le(0) + struct.pack('<IIff', 300, 1, 0, 0)


def race_path(distances=(1000,)):
    rows = []
    for distance in distances:
        b = bytearray(60)
        struct.pack_into('<3IfII3f', b, 0, 1, 0, 4, distance, 1, 0, 1000, 2000, 3000)
        rows.append(bytes(b) + bytes([0, 0, 127, 0]) + struct.pack('<4f', 1, 0, -.1, 100) + le(0))
    return b'Biii' + le(len(rows)) + b''.join(rows)


def names(instance_names=None):
    ids = bytearray(le(0) + le(0) + le(8))
    strings = bytearray(ids)
    for array, rows in enumerate([
        [(2, 'patch_wr1_unused'), (3, 'patch_er1_synthetic')],
        [(3, instance_names[0] if instance_names else 'mdl_er1_rock'),
         (4, instance_names[1] if instance_names else 'mdl_er1_prop_without_terrain'), (600, 'mdl_er1_unstreamed_mission')],
        [(0, 'mdl_er1_model')], [(0, 'common_patches_snow er1')],
        [], [], [], [],
    ]):
        data = b''.join(le(0) + le(0) + le(rid) + le(0) for rid, _ in rows)
        text = b''.join(name.encode() + b'\0' for _, name in rows)
        ids += bytes([array]) + len(data).to_bytes(3, 'little') + le(len(rows)) + data
        strings += bytes([array]) + len(text).to_bytes(3, 'little') + le(len(rows)) + text
    return bytes(ids), bytes(strings)


def members(edit=None, instance_names=None):
    # Use an existing independently authored surface fixture for its coefficients.
    import ssx3_import_test
    captured = []
    ssx3_import_test.members(lambda rows: captured.extend(rows) or rows)
    patch = bytearray(next(data for kind, _, data in captured if kind == 1))
    patch[412:420] = bytes(8)
    material = struct.pack('<3h3H2HI', 0, -1, -1, 0, 0, 0, 1, 1, 0xffffffff)
    fog_model, fog_instance = fog_fixture()
    fog_instance = bytearray(fog_instance)
    struct.pack_into('<II', fog_instance, 96, 0, 65536)
    rows = [(22, 0, b'original synthetic world script' * 1400, 3),
            (0, 0, material, 3), (1, 3, bytes(patch), 1), (1, 3, bytes(patch), 2),
            (2, 0, model(), 3), (3, 3, placement(), 3), (12, 0, proxy(), 3),
            (9, 0, texture(), 1), (9, 0, texture(night=True), 2), (10, 3, texture(light=True), 3),
            (4, 65536, fog_model, 3), (5, 65539, bytes(fog_instance), 3),
            (14, 3, path(), 3)]
    if edit:
        rows = edit(rows)
    data = b''.join(resource(kind, rid, payload, mask) for kind, rid, payload, mask in rows)
    # A record straddles a raw continuing block and a compressed closing block.
    # Literal-only compression is intentionally authored independently of the decoder.
    split = 32756
    assert len(data) > split and len(data) - split < 30000
    carry = 8 + len(rows[0][2]) - split
    stream = compressed(resource(1, 2, bytes(patch)))
    stream += b'CBXS' + le(32768) + le(11) + data[:split]
    stream += compressed(data[split:], carry)
    props_only = resource(3, 4, placement())
    light = bytearray(112)
    struct.pack_into('<If', light, 16, 1, 1)
    struct.pack_into('<f3f', light, 28, 100, 1, 1, 1)
    struct.pack_into('<3f', light, 56, 1000, 2000, 3000)
    lights_only = resource(6, 5, bytes(light))
    stream += compressed(props_only) + compressed(lights_only)
    database = bytearray(328 + 4 * 108 + 40)
    struct.pack_into('<I', database, 0, 0x21004e00)
    struct.pack_into('<H', database, 10, 6)
    struct.pack_into('<H', database, 14, 1)
    struct.pack_into('<II', database, 48, 760, 800)
    for i, size in enumerate([440, len(data), len(props_only), len(lights_only)]):
        struct.pack_into('<H', database, 328 + i * 108 + 26, i + 2)
        struct.pack_into('<I', database, 328 + i * 108 + 36, size)
        bounds = (-1000, -1000, -1000, -900, -900, -900) if i == 0 else (900, 1900, 2900, 1100, 2100, 3100)
        struct.pack_into('<6f', database, 328 + i * 108, *bounds)
    database[760:767] = b'er1_sl1'
    struct.pack_into('<3f', database, 776, 1000, 2000, 3000)
    ids, strings = names(instance_names)
    return {'data/worlds/bam.sdb': bytes(database), 'data/worlds/bam.phm': ids,
            'data/worlds/bam.psm': strings, 'data/worlds/bam.ssb': stream,
            'data/worlds/er1d.tp': race_path(), 'data/worlds/er1n.tp': race_path(),
            'data/worlds/alld.tp': race_path()}


def material_animation(rows, conditional=False):
    result = []
    for kind, rid, payload, mask in rows:
        if kind == 0:
            payload = bytearray(payload); struct.pack_into('<I', payload, 16, 0)
            payload = bytes(payload) + struct.pack('<3I', 2, 0, 1)
        if kind == 22:
            payload = material_program(tour=True, conditional=conditional)
            # Keep the fixture's split-record exercise independent of script size.
            payload += bytes(42000 - len(payload))
        result.append((kind, rid, payload, mask))
    return result + [(9, 65536, texture(), 3), (21, 0, struct.pack('<7I', 0xffffffff, 0, *([0xffffffff] * 5)), 3)]


def full_disc(fidelity=False, night_sky=False):
    def wrapper(payload):
        b = bytearray(80)
        b[:4] = b'ABKC'
        struct.pack_into('<II', b, 20, 80 + len(payload), 80)
        struct.pack_into('<II', b, 32, 80, len(payload))
        return bytes(b) + payload
    unsupported = bytearray(bank())
    marker = unsupported.index(bytes([0xa0, 4]))
    struct.pack_into('>I', unsupported, marker + 2, 23)
    speech = bytearray(bank())
    marker = speech.index(bytes([0xa0, 4]))
    struct.pack_into('>I', speech, marker + 2, 4)
    ids = bytearray(le(0) + le(0) + le(4)); strings = bytearray(ids)
    for tag, rows in [(1, [(1, 'sky_instance')]), (2, [(1, 'sky_model')]), (6, [(0, 'sky_texture')]), (13, [])]:
        data = b''.join(le(0) + le(0) + le(rid) + le(0) for rid, _ in rows)
        text = b''.join(name.encode() + b'\0' for _, name in rows)
        ids += bytes([tag]) + len(data).to_bytes(3, 'little') + le(len(rows)) + data
        strings += bytes([tag]) + len(text).to_bytes(3, 'little') + le(len(rows)) + text
    instance = bytearray(placement()); struct.pack_into('<I', instance, 120, 1)
    sky = b''.join([resource(0, 0, struct.pack('<3h3H2HI', 0, -1, -1, 0, 0, 0, 1, 1, 0xffffffff)),
                    resource(2, 1, model()), resource(3, 1, bytes(instance)), resource(9, 0, texture())])
    sky_files = {'data/worlds/erskyd.phm': bytes(ids), 'data/worlds/erskyd.psm': bytes(strings),
                 'data/worlds/erskyd.ssb': compressed(sky)}
    if night_sky:
        night = b''.join([resource(0, 0, struct.pack('<3h3H2HI', 0, -1, -1, 0, 0, 0, 1, 1, 0xffffffff), 2),
                          resource(2, 1, model(), 2), resource(3, 1, bytes(instance), 2),
                          resource(9, 0, texture(night=True), 2)])
        sky_files.update({'data/worlds/erskyn.phm': bytes(ids), 'data/worlds/erskyn.psm': bytes(strings),
                          'data/worlds/erskyn.ssb': compressed(night)})
    sounds = {'data/audio/emtr_test.abk': wrapper(literal_bank()),
              'data/audio/emtr_deferred.abk': wrapper(bytes(unsupported)),
              'data/audio/emtr_speech.abk': wrapper(bytes(speech))}
    if fidelity:
        from riding_audio_import_test import encoded_bank
        for name in ['brd_pack', 'brd_pow', 'brd_ice', 'ski&brd_common', 'boost']:
            sounds[f'data/audio/{name}.abk'] = wrapper(encoded_bank())
    return bytes(audio_disc({
        'DATA/WORLDS/BAM.BIG': archive(members(
            (lambda rows: material_animation(rows) + [(6, 3, light_fixture(), 3), (7, 3, light_fixture(halo=True, tour=True), 3),
                                                    (13, 3, sound_attachments(tour=True), 3)]) if fidelity else None,
            ('mdl_er4_trg_fw_finish_final_9999', 'mdl_er1_ordinary') if fidelity else None)),
        'DATA/WORLDS/SKYBOX.BIG': archive(sky_files),
        'DATA/AUDIO/AUDIO.BIG': archive(sounds),
    }))


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-ontour-') as temporary:
        root = Path(temporary)
        files = members()
        image = disc(files)
        source = root / 'on-tour.iso'
        source.write_bytes(image)
        inventory = run(executable, 'list', source)
        assert 'SSXOT_ER1_DAY\t' in inventory and 'SSXOT_ER1_NIGHT\t' in inventory
        assert 'ALL' not in inventory and 'SSX3_' not in inventory
        for time in ['DAY', 'NIGHT']:
            course = 'SSXOT_ER1_' + time
            run(executable, 'extract', source, course, root / 'Maps')
            out = root / 'Maps' / course
            patches = json.loads((out / 'Patches.json').read_text())['Patches']
            assert len(patches) == 1 and patches[0]['Points'][0] == [1000, 2000, 3000]
            colour = [80, 120, 200, 255] if time == 'DAY' else [20, 30, 100, 255]
            assert png_pixels(out / 'Textures/0000_o.png') == bytes(colour) * 4
            instances = json.loads((out / 'Instances.json').read_text())['Instances']
            assert len(instances) == 2 and {i['SourceResource'] for i in instances} == {3, 4}
            assert '\nv -100 0 -100\n' in (out / 'Meshes/0_0_0.obj').read_text()
            instance = instances[0]
            assert instance['Scale'] == [2, 2, 2] and instance['VertexLighting']
            assert instance['PlayerCollision'] and instance['CollsionModelPaths'] == ['0_0.obj']
            fog, = json.loads((out / 'ParticleInstances.json').read_text())['Particles']
            assert fog['ParticleModelIndex'] == 0
            assert len(json.loads((out / 'Lights.json').read_text())['Lights']) == 1
            paths = json.loads((out / 'AIP.json').read_text())
            assert paths['StartPosList'] == [0] and paths['AIPaths'][0]['PathPoints'][0][0] == 100
            assert len(paths['RaceLines']) == 1 and paths['RaceLines'][0]['PathPoints'][0][0] == 100
            assert paths['AIPaths'][0]['PathEvents'] == [] and paths['AIPaths'][0]['SourceEvents'][0]['EventType'] == 300
            assert json.loads((out / 'Effects.json').read_text())['target']['game'] == 'ssx-on-tour'
            manifest = json.loads((out / 'Import.json').read_text())
            assert json.loads((out / 'Origin.json').read_text())['Game'] == 'ssx-on-tour'
            assert manifest['Sections'] == [3, 4, 5] and manifest['TimeOfDay'] == time.lower()
            original = json.loads((out / 'Source/Resources.json').read_text())
            script, = [r for r in original if r['Bin'] == 22]
            payload = (out / 'Source/Resources.bin').read_bytes()
            assert payload[script['Offset']:script['Offset'] + script['Bytes']].startswith(b'original synthetic world script')
            run(executable, 'extract', source, course, root / 'Maps', succeeds=False)
        for course in ['SSXOT_ALL', 'SSXOT_ALL_DAY', 'SSXOT_ER1', 'SSXOT_ER2_DAY', 'SSXOT_ER1_DUSK']:
            run(executable, 'extract', source, course, root / 'invalid', succeeds=False)
        for label, distances in [('mixed-race', (-1, 1000, 0)), ('unscored-race', (-1, -1))]:
            paths = members()
            paths['data/worlds/er1d.tp'] = race_path(distances)
            race_iso = root / (label + '.iso')
            race_iso.write_bytes(disc(paths))
            run(executable, 'extract', race_iso, 'SSXOT_ER1_DAY', root / label)
            out = root / label / 'SSXOT_ER1_DAY'
            races = json.loads((out / 'AIP.json').read_text())['RaceLines']
            assert [(row['Name'], row['DistanceToFinish']) for row in races] == [
                (f'Race Line {i}', value) for i, value in enumerate(distances) if value >= 0]
            assert (out / 'Source/er1d.tp').read_bytes() == paths['data/worlds/er1d.tp']
        invalid_paths = members()
        invalid_paths['data/worlds/er1d.tp'] = race_path((-2,))
        invalid_iso = root / 'invalid-race-distance.iso'
        invalid_iso.write_bytes(disc(invalid_paths))
        run(executable, 'extract', invalid_iso, 'SSXOT_ER1_DAY', root / 'invalid-race-distance', succeeds=False)
        assert not list((root / 'invalid-race-distance').iterdir())
        def helper_page(rows):
            result = []
            for kind, rid, payload, mask in rows:
                payload = bytearray(payload)
                if kind == 0:
                    struct.pack_into('<H', payload, 0, 36)
                elif kind == 1:
                    struct.pack_into('<H', payload, 412, 36)
                elif kind == 9:
                    rid = 36 << 16
                result.append((kind, rid, bytes(payload), mask))
            return result
        helpers = members(helper_page, ('mdl_er1_rock', 'mdl_er1_fence_100'))
        helper_iso = root / 'helpers.iso'
        helper_iso.write_bytes(disc(helpers))
        run(executable, 'extract', helper_iso, 'SSXOT_ER1_DAY', root / 'helpers')
        hidden = json.loads((root / 'helpers/SSXOT_ER1_DAY/Instances.json').read_text())['Instances']
        assert all(not i['Visable'] and i['CollsionModelPaths'] for i in hidden)
        assert all(i['PlayerCollision'] == ('fence' in i['InstanceName']) for i in hidden)
        assert any(i['PlayerCollision'] for i in hidden)
        for label, visible, solid in HELPER_CASES:
            helper_iso = root / (label + '.iso')
            helper_iso.write_bytes(disc(members(instance_names=('mdl_er1_' + label, 'mdl_er1_ordinary'))))
            destination = root / label
            run(executable, 'extract', helper_iso, 'SSXOT_ER1_DAY', destination)
            helper, ordinary = json.loads((destination / 'SSXOT_ER1_DAY/Instances.json').read_text())['Instances']
            blocking = helper['PlayerCollision'] and helper.get('PlayerBounce', True) and helper.get('U0', 1) != 0
            assert (helper['Visable'], blocking) == (visible, solid), label
            assert helper['CollsionModelPaths'] == ordinary['CollsionModelPaths'] == ['0_0.obj']
            assert ordinary['Visable'] and ordinary['PlayerCollision']
        for label, disabled in [('mdl_er4_impassableleft_17', True), ('MDL_WR1_IMPASSABLERIGHT_1009', True),
                                ('mdl_er4_trg_fw_archlights_4_1001', True), ('mdl_er4_trg_fw_finish_1000', True),
                                ('mdl_er4_trg_fw_finish_final_9999', True), ('mdl_er4_trg_fw_start_1000', True),
                                ('mdl_er4_trg_fw_finish_sign', False), ('mdl_er4_trg_fw_archlights_4_', False),
                                ('mdl_er4_impassableleft_sign', False)]:
            boundary_iso = root / 'boundary.iso'
            boundary_iso.write_bytes(disc(members(instance_names=(label, 'mdl_er1_ordinary'))))
            target = root / ('boundary-' + label)
            run(executable, 'extract', boundary_iso, 'SSXOT_ER1_DAY', target)
            helper, ordinary = json.loads((target / 'SSXOT_ER1_DAY/Instances.json').read_text())['Instances']
            assert helper['Visable'] is not disabled and helper['PlayerCollision']
            if disabled:
                assert helper['U0'] == 0 and helper['PlayerBounce'] is False and helper['SurfaceType'] == -1
            assert helper['CollsionModelPaths'] == ['0_0.obj'] and helper['EffectSlotIndex'] == -1
            assert ordinary['Visable'] and ordinary['PlayerCollision']
        light_files = members(lambda rows: rows + [(6, 3, light_fixture(), 3), (7, 3, light_fixture(halo=True, tour=True), 3)])
        light_iso = root / 'lights.iso'; light_iso.write_bytes(disc(light_files))
        run(executable, 'extract', light_iso, 'SSXOT_ER1_DAY', root / 'lights')
        check_lights(root / 'lights/SSXOT_ER1_DAY', count=3)
        for conditional in [False, True]:
            label = 'conditional-material' if conditional else 'moving-material'
            moving = root / (label + '.iso')
            moving.write_bytes(disc(members(lambda rows: material_animation(rows, conditional))))
            run(executable, 'extract', moving, 'SSXOT_ER1_DAY', root / label)
            check_materials(root / label / 'SSXOT_ER1_DAY', active=not conditional)
        sounds_iso = root / 'sounds.iso'
        sounds_iso.write_bytes(disc(members(lambda rows: rows + [(13, 3, sound_attachments(tour=True), 3)])))
        run(executable, 'extract', sounds_iso, 'SSXOT_ER1_DAY', root / 'sounds')
        check_sounds(root / 'sounds/SSXOT_ER1_DAY')
        for label, edit in [
            ('short-effect-slot', lambda rows: [(k, rid, data[:24] if k == 21 else data, mask)
                                                for k, rid, data, mask in material_animation(rows)]),
            ('sound-offset', lambda rows: rows + [(13, 3, sound_attachments(tour=True)[:112], 3)]),
            ('program-extent', lambda rows: [(k, rid, data[:4] + le(17) + data[8:] if k == 22 else data, mask)
                                              for k, rid, data, mask in material_animation(rows)]),
        ]:
            bad = root / (label + '.iso'); bad.write_bytes(disc(members(edit)))
            destination = root / label
            run(executable, 'extract', bad, 'SSXOT_ER1_DAY', destination, succeeds=False)
            assert not list(destination.iterdir()), 'partial map survived failed fidelity conversion'
        audio_source = root / 'sky-and-audio.iso'; audio_source.write_bytes(full_disc())
        run(executable, 'extract', audio_source, 'SSXOT_ER1_NIGHT', root / 'full')
        full = root / 'full/SSXOT_ER1_NIGHT'
        assert (full / 'Skybox/Models.json').exists() and (full / 'Skybox/Textures/0000_o.png').exists()
        assert len(json.loads((full / 'Skybox/Models.json').read_text())['Models']) == 1, 'Day fallback retains day-mask sky records'
        night_source = root / 'night-sky.iso'; night_source.write_bytes(full_disc(night_sky=True))
        run(executable, 'extract', night_source, 'SSXOT_ER1_NIGHT', root / 'night-sky')
        night = root / 'night-sky/SSXOT_ER1_NIGHT/Skybox'
        assert len(json.loads((night / 'Models.json').read_text())['Models']) == 1, 'Night-only sky records must not use the day filter'
        assert (night / 'Textures/0000_o.png').read_bytes() != (full / 'Skybox/Textures/0000_o.png').read_bytes()
        assert (full / 'Audio/SFX/EMTR_TEST/000.wav').exists()
        assert json.loads((full / 'Audio/SoundIndex.json').read_text())['Level'] == 'SSXOT_ER1_NIGHT'
        deferred = json.loads((full / 'Audio/SFX/EMTR_DEFERRED/bank.json').read_text())
        assert deferred['Slots'] == [None, None] and deferred['DeferredSlots'][0]['Codec'] == 23
        sources = json.loads((full / 'Source/AudioBanks.json').read_text())
        assert len(sources) == 3 and sources[-1]['Omitted'] == 'contains-speech'
        assert not list((full / 'Audio/SFX/EMTR_SPEECH').glob('*.wav'))
        for label, member, offset, value in [
            ('version', 'data/worlds/bam.sdb', 0, le(1)),
            ('sector-count', 'data/worlds/bam.sdb', 10, bytes([255, 255])),
            ('decoded-size', 'data/worlds/bam.sdb', 472, le(1)),
            ('block-size', 'data/worlds/bam.ssb', 32768 + 4, le(1)),
            ('flags', 'data/worlds/bam.ssb', 32768 + 8, le(0)),
            ('carry', 'data/worlds/bam.ssb', 65536 + 8, le(3 | (1 << 8))),
            ('names', 'data/worlds/bam.phm', 8, le(5)),
        ]:
            damaged = files.copy()
            data = bytearray(damaged[member]); data[offset:offset + len(value)] = value
            damaged[member] = bytes(data)
            bad = root / (label + '.iso'); bad.write_bytes(disc(damaged))
            destination = root / label
            run(executable, 'extract', bad, 'SSXOT_ER1_DAY', destination, succeeds=False)
            assert not list(destination.iterdir()), 'partial map survived failed import'
        assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(image).digest()
    print('PASS: On Tour track/day/night discovery, split raw/compressed records, geometry, texture variants, direct collision, paths and atomic failure')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        Path(sys.argv[2]).write_bytes(full_disc(fidelity=True, night_sky=True))
    else:
        main()
