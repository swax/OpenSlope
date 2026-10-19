"""Independent streamed-mountain fixtures; no disc data or external converter."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile

from import_test import course_members, le, png_pixels, record, refpack, run, iso
from prop_import_test import packet
from audio_container_test import bank
from audio_import_test import disc as audio_disc
import wave


def resource(kind, rid, payload):
    return bytes([kind]) + len(payload).to_bytes(3, 'little') + le(rid) + payload


def texture(light=False):
    b = bytearray(128)
    b[0] = 5 if light else 2
    struct.pack_into('<HH', b, 4, 2, 2)
    if light:
        return bytes(b) + bytes([20, 40, 60, 100]) * 4
    b[1:4] = (132).to_bytes(3, 'little')
    palette = bytearray(128 + 244 * 4)
    palette[0] = 33
    struct.pack_into('<H', palette, 4, 236)
    palette[128 + 240 * 4:128 + 241 * 4] = bytes([80, 120, 200, 64])
    # Colour 232 resides past the declared count in the padded hardware CLUT.
    return bytes(b) + bytes([232]) * 4 + bytes(palette)


def model():
    mesh = bytearray(packet())
    mesh[224:248], mesh[272:296] = mesh[272:296], mesh[224:248]
    struct.pack_into('<H', mesh, 80, 4)  # SSX 3 strip counts are direct vertex counts.
    b = bytearray(144)
    struct.pack_into('<5I', b, 0, 1, 1, 48, 40, 1)
    struct.pack_into('<3fI', b, 24, 200, 200, 200, 112)
    struct.pack_into('<II', b, 40, 1, 1)
    struct.pack_into('<4i', b, 48, -1, 64, 0, -1)
    struct.pack_into('<6f3I', b, 64, -100, -100, -100, 100, 100, 100, 0, 1, 100)
    struct.pack_into('<3I', b, 100, 104, 0, 0)
    struct.pack_into('<II', b, 112, 0x30000000 | (len(mesh) // 16), 32)
    struct.pack_into('<I', b, 128, 0x60000000)
    return bytes(b) + bytes(mesh)


def patterned_texture(kind):
    # Sequential storage bytes and a numbered palette expose pixel ordering;
    # uniform-colour fixtures cannot distinguish a swizzled image from linear.
    width = 32 if kind == 1 else 16
    pixels = width * width // (2 if kind == 1 else 1)
    header = bytearray(128)
    header[0] = kind
    header[1:4] = (128 + pixels).to_bytes(3, 'little')
    struct.pack_into('<HH', header, 4, width, width)
    palette = bytearray(128 + (16 if kind == 1 else 256) * 4)
    palette[0] = 33
    struct.pack_into('<H', palette, 4, 16 if kind == 1 else 256)
    for index in range(16 if kind == 1 else 256):
        slot = index if kind == 1 else (index & 0xe7) | ((index & 8) << 1) | ((index & 16) >> 1)
        palette[128 + slot * 4:132 + slot * 4] = bytes([index, 0, 0, 128])
    return bytes(header) + bytes(range(256)) * (pixels // 256) + bytes(palette)


def placement(rid, x):
    b = bytearray(240)
    struct.pack_into('<16f', b, 16, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 2000, 3000, 1)
    struct.pack_into('<III', b, 120, rid, 1, 1)
    struct.pack_into('<f', b, 132, -2 if x == 2000 else 2)
    struct.pack_into('<I', b, 152, 160)
    struct.pack_into('<II', b, 160, 0x30000001, 0)
    struct.pack_into('<I', b, 176, 0x60000000)
    b[207] = 0x6f
    b[206] = 4
    struct.pack_into('<4H', b, 208, *([0xc210] * 4))
    return bytes(b)


def proxy():
    b = bytearray(16 + 20 + 12 + 3 * 16 + 16)
    struct.pack_into('<HHIII', b, 0, 1, 1, 16, len(b), len(b))
    struct.pack_into('<HH4I', b, 16, 1, 3, 20, 24, 32, 80)
    b[36:39] = bytes([0, 1, 2])
    for i, p in enumerate([(0, 0, 0), (100, 0, 0), (0, 100, 0)]):
        struct.pack_into('<4f', b, 48 + i * 16, *p, 1)
    struct.pack_into('<4f', b, 96, 0, 0, 1, 0)
    return bytes(b)


def paths_fixture():
    ai = bytearray(72)
    struct.pack_into('<9I3f', ai, 0, 2, 100, 4, 100000, 101, 4, 1, 1, 1, 1000, 2000, 3000)
    ai += struct.pack('<4fIIff', 1, 0, -.1, 100, 9, 1, 0, 100)
    race = bytearray(60)
    struct.pack_into('<3IfII3f', race, 0, 1, 100, 4, 1000, 1, 0, 1000, 2000, 3000)
    race += struct.pack('<4f', 1, 0, -.1, 100)
    grid = bytearray(96)
    struct.pack_into('<I', grid, 0, 6)
    struct.pack_into('<I', grid, 52, 1)
    struct.pack_into('<3f', grid, 64, 1000, 2000, 3000)
    return b'iiii' + le(1) + bytes(ai) + le(1) + bytes(race) + bytes(grid)


def spline_fixture():
    b = bytearray(192)
    struct.pack_into('<I', b, 0, 1)
    struct.pack_into('<I', b, 32, 1)
    for i, point in enumerate([(0, 0, 0), (0, 0, 0), (300, 0, 0), (1000, 2000, 3000)]):
        struct.pack_into('<4f', b, 64 + i * 16, *point, 1)
    struct.pack_into('<f', b, 180, 300)
    return bytes(b)


def fog_fixture():
    b = bytearray(112)
    struct.pack_into('<3I', b, 0, 1, 1, 32)
    struct.pack_into('<4i', b, 32, -1, 48, 0, -1)
    struct.pack_into('<6f3I', b, 48, -200, -200, -200, 200, 200, 200, 0, 1, 36)
    struct.pack_into('<7f', b, 84, 0, 0, 0, .5, .6, 1, 200)
    instance = bytearray(144)
    struct.pack_into('<16f', instance, 16, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 2000, 3000, 1)
    struct.pack_into('<2I6f', instance, 96, 1, 1, 800, 1800, 2800, 1200, 2200, 3200)
    return bytes(b), bytes(instance)


def names():
    ids = bytearray(le(0) + le(0) + le(5))
    strings = bytearray(ids)
    for tag, rows in [(0, [(1, 'Synthetic patch')]),
                      (1, [(1, 'Synthetic rock'), (257, 'Rock copy')]),
                      (2, [(1, 'Synthetic model')]), (8, [(1, 'Synthetic metal rail')]),
                      (11, [(1, 'Synthetic rock_CollideModel_ProgMesh')])]:
        payload = b''.join(le(0) + le(0) + le(rid) + le(0) for rid, _ in rows)
        ids += bytes([tag]) + len(payload).to_bytes(3, 'little') + le(len(rows)) + payload
        text = b''.join(name.encode() + b'\0' for _, name in rows)
        strings += bytes([tag]) + len(text).to_bytes(3, 'little') + le(len(rows)) + text
    return bytes(ids), bytes(strings)


def members(edit=None):
    database = bytearray(80 + 4 * 88)
    struct.pack_into('<I', database, 0, 0x01003800)
    struct.pack_into('<I', database, 8, 4)
    for i, name in enumerate(['TRANSP', 'A', 'C', 'E']):
        database[80 + i * 88:80 + i * 88 + len(name)] = name.encode()
    source = course_members()['fixture.pbd'][136:]
    patch = bytearray(432)
    patch[16:32] = source[:16]
    for i in range(4):
        patch[32 + i * 8:40 + i * 8] = source[16 + i * 16:24 + i * 16]
    patch[64:320] = source[80:336]
    struct.pack_into('<H', patch, 8, 2)
    material = struct.pack('<3h3H2HI', 0, -1, -1, 0, 0, 0, 1, 1, 0xffffffff)
    # An empty slot precedes the terrain, and the texture repeats identically.
    fog_model, fog_instance = fog_fixture()
    rows = [(0, 1, material), (14, 257, b''), (1, 1, bytes(patch)),
            (14, 1, paths_fixture()), (8, 1, spline_fixture()), (4, 1, fog_model), (5, 1, fog_instance),
            (2, 1, model()), (3, 1, placement(1, 1000)), (3, 257, placement(257, 2000)),
            (9, 255, texture()), (9, 255, texture()), (10, 255, texture(True)), (12, 1, proxy()),
            (16, 1, b'original synthetic script payload')]
    if edit:
        rows = edit(rows)
    data = b''.join(resource(*row) for row in rows)
    compressed = refpack(data)
    assert len(compressed) <= 32760
    stream = b'CEND' + le(32768) + compressed + bytes(32760 - len(compressed))
    ids, strings = names()
    return {'data/worlds/bam.sdb': bytes(database), 'data/worlds/bam.ssb': stream,
            'data/worlds/bam.phm': ids, 'data/worlds/bam.psm': strings}


def disc(files, audio=False):
    end = 16 + sum(8 + len(name) + 1 for name in files) + 6
    archive = bytearray(b'BIGF' + le(0) + struct.pack('>II', len(files), end))
    offset = end
    for name, payload in files.items():
        archive += struct.pack('>II', offset, len(payload)) + name.encode() + b'\0'
        offset += len(payload)
    archive += bytes(end - len(archive))
    for payload in files.values():
        archive += payload
    if audio:
        from audio_import_test import archive as sound_archive
        speech = bytearray(bank())
        marker = speech.index(bytes([0xa0, 4]))
        struct.pack_into('>I', speech, marker + 2, 4)
        return bytes(audio_disc({
            'DATA/WORLDS/BAM.BIG': bytes(archive),
            'DATA/CONFIG/BANKS.INF': b'[WORLD]\nMAIN = sound.bnk\nMOUNTAIN = speech.bnk\n',
            'DATA/CONFIG/SNOW.INF': b'# synthetic ride audio configuration\n',
            'DATA/AUDIO/AUDIO.BIG': sound_archive({'data/audio/sound.bnk': bank(), 'data/audio/speech.bnk': bytes(speech)}),
        }))
    result = bytearray(iso(bytes(archive)))
    for sector, name, child, size, directory in [(25, 'WORLDS', 26, 2048, True), (26, 'BAM.BIG;1', 28, len(archive), False)]:
        data = record(b'\0', sector, 2048, True) + record(b'\1', sector, 2048, True) + record(name, child, size, directory)
        result[sector * 2048:(sector + 1) * 2048] = data + bytes(2048 - len(data))
    return bytes(result)


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-ssx3-') as temporary:
        root = Path(temporary)
        files = members()
        image = disc(files)
        source = root / 'mountain.iso'
        source.write_bytes(image)
        assert 'SSX3_PEAK1\t' in run(executable, 'list', source)
        assert 'SSX3_ALL\t' not in run(executable, 'list', source)
        run(executable, 'extract', source, 'SSX3_A', root / 'Maps')
        out = root / 'Maps/SSX3_A'
        row, = json.loads((out / 'Patches.json').read_text())['Patches']
        assert row['Points'][0] == [1000, 2000, 3000] and row['SurfaceType'] == 3
        assert png_pixels(out / 'Textures/0000_o.png') == bytes([80, 120, 200, 255]) * 4
        instances = json.loads((out / 'Instances.json').read_text())['Instances']
        assert len(instances) == 2 and instances[0]['Scale'] == [2, 2, 2]
        assert instances[1]['Scale'][0] < 0 and instances[0]['VertexLighting']
        assert instances[0]['CollsionModelPaths'] == instances[1]['CollsionModelPaths'] == ['1_0.obj']
        assert all(row['PlayerCollision'] for row in instances)
        assert (out / 'Meshes/1_0_0.obj').read_text().count('\nf ') == 2
        assert '\nv -100 0 -100\n' in (out / 'Meshes/1_0_0.obj').read_text()
        assert '\nvn 0.999969482 0 0\n' in (out / 'Meshes/1_0_0.obj').read_text()
        for kind, expected in [(1, [0, 4, 8, 12, 0, 4, 8, 12, 1, 5, 9, 13, 1, 5, 9, 13]),
                               (2, [0, 4, 8, 12, 16, 20, 24, 28, 2, 6, 10, 14, 18, 22, 26, 30])]:
            patterned = members(lambda rows: [(k, rid, patterned_texture(kind) if k == 9 else payload)
                                               for k, rid, payload in rows])
            pattern_iso = root / ('pattern-' + str(kind) + '.iso')
            pattern_iso.write_bytes(disc(patterned))
            destination = root / ('pattern-' + str(kind))
            run(executable, 'extract', pattern_iso, 'SSX3_A', destination)
            decoded = png_pixels(destination / 'SSX3_A/Textures/0000_o.png')
            assert list(decoded[:64:4]) == expected, (kind, list(decoded[:64:4]))
        for state, mode in [(3, 'cutout'), (7, 'blend'), (65, 'glow')]:
            def material_state(rows):
                result = []
                for k, rid, payload in rows:
                    if k == 0:
                        payload = bytearray(payload)
                        struct.pack_into('<HH', payload, 12, 1, state)
                    result.append((k, rid, bytes(payload)))
                return result
            mode_iso = root / (mode + '.iso')
            mode_iso.write_bytes(disc(members(material_state)))
            destination = root / mode
            run(executable, 'extract', mode_iso, 'SSX3_A', destination)
            material, = json.loads((destination / 'SSX3_A/Materials.json').read_text())['Materials']
            assert material['AlphaMode'] == mode and material['TexturePath'] == '0000.png'
        paths = json.loads((out / 'AIP.json').read_text())
        assert paths['StartPosList'] == [0] and len(paths['RaceLines']) == 1
        assert paths['AIPaths'][0]['U3'] == 50 and paths['AIPaths'][0]['SourceRatingWord'] == 100000
        assert paths['AIPaths'][0]['PathPoints'][0][0] == 100
        rail, = json.loads((out / 'Splines.json').read_text())['Splines']
        assert rail['SplineStyle'] == 13 and rail['U1'] == 1
        assert rail['Segments'][0]['Points'][3] == [1300, 2000, 3000]
        fog, = json.loads((out / 'ParticleModels.json').read_text())['ParticlePrefabs']
        assert fog['ParticleObjectHeaders'][0]['ParticleObject']['AnimationFrames'][0]['Unknown'] == 200
        fog_instance, = json.loads((out / 'ParticleInstances.json').read_text())['Particles']
        assert fog_instance['ParticleModelIndex'] == 0
        assert not json.loads((out / 'Import.json').read_text())['Complete']
        source_row = next(row for row in json.loads((out / 'Source/Resources.json').read_text()) if row['Bin'] == 16)
        source_bytes = (out / 'Source/Resources.bin').read_bytes()
        assert source_bytes[source_row['Offset']:source_row['Offset'] + source_row['Bytes']] == b'original synthetic script payload'
        assert json.loads((out / 'Effects.json').read_text())['target']['game'] == 'ssx-3'
        audio_source = root / 'with-audio.iso'
        audio_source.write_bytes(disc(files, audio=True))
        run(executable, 'extract', audio_source, 'SSX3_A', root / 'audio')
        audio_out = root / 'audio/SSX3_A/Audio'
        sound_index = json.loads((audio_out / 'SoundIndex.json').read_text())
        assert sound_index['Level'] == 'SSX3_A' and sound_index['NamedBanks']['MAIN'] == 'sound'
        with wave.open(str(audio_out / 'SFX/sound/000.wav')) as decoded:
            assert decoded.getframerate() == 8000 and decoded.getnframes() == 3
        assert json.loads((audio_out / 'SFX/speech/bank.json').read_text())['Slots'] == [None, None]
        assert not list((audio_out / 'SFX/speech').glob('*.wav'))
        run(executable, 'extract', source, 'SSX3_A', root / 'Maps', succeeds=False)
        for label, member, offset, value in [
            ('database-version', 'data/worlds/bam.sdb', 0, le(12)),
            ('location-count', 'data/worlds/bam.sdb', 8, le(256)),
            ('chunk-size', 'data/worlds/bam.ssb', 4, le(16)),
            ('names-count', 'data/worlds/bam.phm', 8, le(10)),
        ]:
            damaged = files.copy()
            b = bytearray(damaged[member]); b[offset:offset + len(value)] = value
            damaged[member] = bytes(b)
            invalid = root / (label + '.iso'); invalid.write_bytes(disc(damaged))
            destination = root / label
            run(executable, 'extract', invalid, 'SSX3_A', destination, succeeds=False)
            assert not list(destination.iterdir()), 'failed import published partial files'
        run(executable, 'extract', source, 'SSX3_INVALID', root / 'unknown', succeeds=False)
        run(executable, 'extract', source, 'SSX3_ALL', root / 'all', succeeds=False)
        def altered(rows, kind, offset, value):
            result = []
            for k, rid, payload in rows:
                if k == kind:
                    data = bytearray(payload)
                    data[offset:offset + len(value)] = value
                    payload = bytes(data)
                result.append((k, rid, payload))
            return result
        for label, edit in [
            ('missing-texture', lambda rows: [row for row in rows if row[0] != 9]),
            ('nonfinite-terrain', lambda rows: altered(rows, 1, 64, struct.pack('<f', float('nan')))),
            ('model-reference', lambda rows: altered(rows, 3, 128, le(123456))),
            ('collision-reference', lambda rows: altered(rows, 12, 36, bytes([255]))),
            ('palette-extent', lambda rows: [(k, rid, data[:300] if k == 9 else data) for k, rid, data in rows]),
            ('duplicate-resource', lambda rows: rows + [(9, 255, b'conflicting texture')]),
        ]:
            invalid = root / (label + '.iso')
            invalid.write_bytes(disc(members(edit)))
            destination = root / label
            run(executable, 'extract', invalid, 'SSX3_A', destination, succeeds=False)
            assert not list(destination.iterdir()), 'failed import published partial files'
        assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(image).digest()
    print('PASS: streamed SSX3 discovery, empty slots, padded palette, geometry, lighting, shared collision, source preservation and atomic failure')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        Path(sys.argv[2]).write_bytes(disc(members()))
    else:
        main()
