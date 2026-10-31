"""Authored ISO/BIN -> Mad Trix terrain; no retail files or external packages."""
from pathlib import Path
import json
import struct
import subprocess
import sys
import tempfile
import zlib
import wave

from import_test import both, png_pixels, record


COURSE = 'MADTRIX_AA_FIXTURE'
BOOT = 'SLUS_202.29'  # repo-hygiene: allow[boot-elf] -- disc identity fixture


def name_hash(name):
    return zlib.crc32(bytes(c & 0xdf for c in name.encode('ascii')), 0xffffffff) ^ 0xffffffff


def compressed(data):
    # Literal groups exercise framing independently of the production decoder.
    return b''.join(bytes([(1 << len(data[p:p+8])) - 1]) + data[p:p+8] for p in range(0, len(data), 8))


def package(files, mutate=None):
    payload = bytearray()
    rows = bytearray(b'PGRP' + bytes(4) + struct.pack('<I', len(files)) + bytes(4))
    for name, data in files.items():
        chunks = (len(data) + 65535) // 65536
        for chunk in range(chunks):
            part = data[chunk * 65536:(chunk+1) * 65536]
            packed = compressed(part)
            if part == bytes(len(part)):
                tokens = []
                left = len(part)
                while left >= 3:
                    length = min(66, left)
                    tokens.append((False, bytes([0, length - 3])))
                    left -= length
                tokens.extend((True, b'\0') for _ in range(left))
                packed = b''.join(bytes([sum(int(literal) << i for i, (literal, _) in enumerate(tokens[p:p+8]))]) +
                                  b''.join(value for _, value in tokens[p:p+8]) for p in range(0, len(tokens), 8))
            row = bytearray(100)
            row[:4] = b'PFIL'
            struct.pack_into('<HHI', row, 12, chunk, chunks, name_hash(name))
            struct.pack_into('<5I', row, 48, len(part), chunk * 65536, len(packed), len(payload), len(data))
            row[72:76] = b'\x91\x20\x42\0'
            struct.pack_into('<H', row, 76, 512)
            struct.pack_into('<II', row, 80, len(part), len(packed))
            if name.endswith('.ps2_palette'):
                packed = part
                struct.pack_into('<I', row, 56, len(packed))
                struct.pack_into('<I', row, 84, 0)
            if mutate:
                mutate(name, chunk, row, packed)
            rows.extend(row)
            payload.extend(packed)
    return bytes(payload + rows + struct.pack('<3I', len(rows), 0, len(payload)))


def members(roof=False, staging=False, sky=False, keyed=False, audio=False, rails=False, signs=False, waterfalls=False):
    roof = roof or staging
    geo = bytearray(256 * (4 if roof else 3))
    struct.pack_into('<f', geo, 0, 5)
    struct.pack_into('<I', geo, 12, 2 if staging else 1)
    struct.pack_into('<4I', geo, 16, 3 if roof else 2, 256, 20, len(geo))
    at = 512
    struct.pack_into('<3i', geo, at + 4, -24576, 0, 12288)
    for r in range(4):
        for c in range(4):
            struct.pack_into('<3H', geo, at + 28 + (r * 4 + c) * 6, c * 16384, r * 16384, (3-r) * 4096)
            struct.pack_into('<3h', geo, at + 132 + (r * 4 + c) * 6, 512 + c * 64, 1024 + r * 128, 2048)
    struct.pack_into('<I', geo, at + 128, 0x79108033)
    # Mixed, source-U, source-V, offset. Deliberately include a nonzero mixed
    # coefficient and signed/repeated UVs; these are not four literal corners.
    struct.pack_into('<8h', geo, at + 232, 0, -8192, -8192, 8192, -4096, 4096, 8192, -4096)
    if roof:
        geo[768:1024] = geo[512:768]
        struct.pack_into('<i', geo, 768 + 12, 28672)
        for j in range(16):
            struct.pack_into('<H', geo, 768 + 28 + j * 6 + 4, 0)
        if staging:
            struct.pack_into('<H', geo, 768 + 248, 32)
    table = b'fixture_snow\0'.ljust(256, b'\0')
    if staging:
        table += b'fixture_metal\0'.ljust(256, b'\0')
    tex = bytearray(80)
    tex[:4] = b'TEX1'
    struct.pack_into('<3HI', tex, 10, 2, 2, 8, 80)
    pal = bytearray(48)
    pal[:4] = b'PAL1'
    struct.pack_into('<HII', pal, 10, 4, 32, 48)
    pal.extend(bytes([10, 20, 30, 128, 200, 80, 40, 64, 0, 0, 0, 0, 255, 100, 50, 128]))
    if keyed:
        pal[48:52] = bytes([255, 0, 255, 128])
    xml = b'<ObjectInstance position_v1="5" objClass="ObjClass_SkierStart" position_v2="29" position_v0="0" />\0'
    if staging:
        xml = xml.replace(b'position_v2="29"', b'position_v2="36"')
    result = {'TerrainGroup/patch.bin': bytes(geo), 'TerrainGroup/table.bin': table,
            'TerrainGroup/fixture_snow.ps2_texture': bytes(tex) + bytes(range(4)),
            'TerrainGroup/fixture_snow.ps2_palette': bytes(pal), 'xml_0007.xml': xml,
            'unused.bin': bytes(65536) + b'XYZ'}
    if staging:
        result['TerrainGroup/fixture_metal.ps2_texture'] = result['TerrainGroup/fixture_snow.ps2_texture']
        result['TerrainGroup/fixture_metal.ps2_palette'] = result['TerrainGroup/fixture_snow.ps2_palette']
    if sky:
        dome = bytearray(768)
        struct.pack_into('<f', dome, 0, 5)
        struct.pack_into('<I', dome, 12, 0x12345)  # Unused dome header word is not a texture count.
        struct.pack_into('<4I', dome, 16, 2, 256, 1, len(dome))
        struct.pack_into('<3i', dome, 516, -12288, 40960, -12288)
        for r in range(4):
            for c in range(4):
                struct.pack_into('<3H', dome, 512 + 28 + (r * 4 + c) * 6,
                                 r * 8192, 8192 if (r, c) == (1, 1) else 0, c * 8192)
                struct.pack_into('<3h', dome, 512 + 132 + (r * 4 + c) * 6, 2048, 2048, 2048)
        struct.pack_into('<I', dome, 512 + 128, 0x79108033)
        struct.pack_into('<8h', dome, 512 + 232, 0, 0, -4096, 0, 0, -4096, 4096, 4096)
        result['TerrainGroup/domepatch.bin'] = bytes(dome)
    if audio:
        for table, prefix in [('normvocdef.bin', 'glide'), ('edgevocdef.bin', 'edge'), ('landvocdef.bin', 'land')]:
            definition = bytearray(264)
            definition[:4] = b'LOAD'
            definition[36:40] = b'VDEF'
            definition[40:44] = b'VDEF'
            struct.pack_into('<II', definition, 44, 216, 10)
            for i in range(10):
                name = f'{prefix}{i}.vag'
                definition[52+i*16:68+i*16] = name.encode().ljust(16, b'\0')
                vag = bytearray(48)
                struct.pack_into('>II', vag, 12, 32, 12000)
                nibble = i+1
                vag.extend(bytes([12, 6]) + bytes([nibble | nibble << 4])*14)
                vag.extend(bytes([12, 3]) + bytes([nibble | nibble << 4])*14)
                result[name] = bytes(vag)
            result[table] = bytes(definition)
    if rails:
        assert not roof
        geometry = bytearray(result['TerrainGroup/patch.bin'])
        geometry.extend(geometry[512:768])
        struct.pack_into('<I', geometry, 12, 2)
        struct.pack_into('<I', geometry, 16, 3)
        struct.pack_into('<I', geometry, 28, len(geometry))
        struct.pack_into('<3i', geometry, 772, -24576, 16384, 28672)
        for r in range(4):
            for c in range(4):
                struct.pack_into('<3H', geometry, 768+28+(r*4+c)*6, c*5461, r*137, 0)
        struct.pack_into('<8h', geometry, 768+232, 0, 0, -4096, 0, 0, -4096, 4096, 4096)
        struct.pack_into('<H', geometry, 768+248, 32)
        result['TerrainGroup/patch.bin'] = bytes(geometry)
        result['TerrainGroup/table.bin'] += b'fixture_metal\0'.ljust(256, b'\0')
        for suffix in ['ps2_texture', 'ps2_palette']:
            result[f'TerrainGroup/fixture_metal.{suffix}'] = result[f'TerrainGroup/fixture_snow.{suffix}']
        prop = bytearray(tex)
        prop[80:] = bytes(4)
        palette = bytearray(pal)
        palette[48:52] = bytes([0, 0, 153, 128])
        result['PropertyGroup/fixture_metal.ps2_texture'] = bytes(prop)
        result['PropertyGroup/fixture_metal.ps2_palette'] = bytes(palette)
    if signs:
        panel = bytearray(400)
        panel[:4] = b'MDL0'
        struct.pack_into('<HH', panel, 40, 1, 1)
        struct.pack_into('<I', panel, 140, 0x75050000)
        struct.pack_into('<I', panel, 224, 0x78050000)
        for i, (point, uv) in enumerate(zip([(-1, 0, 0), (1, 0, 0), (-1, 0, 0), (1, 0, 2), (-1, 0, 2)],
                                           [(0, 1), (1, 1), (0, 1), (1, 0), (0, 0)])):
            struct.pack_into('<3f', panel, 228+i*12, *point)
            struct.pack_into('<2h', panel, 144+i*4, *(int(v*4096) for v in uv))
        hierarchy = bytearray(80)
        hierarchy[:4] = b'HIR4'
        struct.pack_into('<I', hierarchy, 8, 1)
        struct.pack_into('<f', hierarchy, 60, 1)
        result.update({'model_SS_marquee_sign_left.b': bytes(panel), 'hierarchy_SS_marquee_sign_left.b': bytes(hierarchy),
                       'texture_SS_Marquee_tga.b': result['TerrainGroup/fixture_snow.ps2_texture'],
                       'palette_SS_Marquee_tga.b': result['TerrainGroup/fixture_snow.ps2_palette'],
                       'xml_0000.xml': b'<ParameterClass class_name="FixtureSign" s_model_name="SS_marquee_sign_left.log" />',
                       'xml_0001.xml': b'<ObjectInstance objParamClass="FixtureSign" objectName="FixtureSign0" position_v0="5" position_v1="5" position_v2="40" rotation_v0="0" rotation_v1="0" rotation_v2="1.5707963267948966" />'})
    if waterfalls:
        # Two disconnected triangles: ignoring ADC would manufacture two bridge faces.
        count = 6
        model = bytearray(512)
        model[:4] = b'MDL0'
        struct.pack_into('<HH', model, 40, 1, 1)
        struct.pack_into('<I', model, 140, 0x75000000 | count << 16)
        position_at = 184 + count * 8
        struct.pack_into('<I', model, position_at, 0x78000000 | count << 16)
        points = [(0, 0, 4), (2, 0, 4), (0, 0, 0), (10, 0, 4), (10, 0, 0), (12, 0, 4)]
        for i, point in enumerate(points):
            struct.pack_into('<3f', model, position_at+4+i*12, *point)
            u = (4-point[2])/4 if i < 3 else point[2]/4  # The second section has mirrored source U.
            v = (point[0] - (10 if i >= 3 else 0))/2
            struct.pack_into('<2h', model, 144+i*4, int(u*4096), int(v*4096))
        adc_at = position_at + 20 + count * 12
        struct.pack_into('<I', model, adc_at-4, 0x71000000 | count << 16)
        struct.pack_into('<6H', model, adc_at, 0x8000, 0x8000, 0, 0x8000, 0x8000, 0)
        hierarchy = bytearray(80)
        hierarchy[:4] = b'HIR4'
        struct.pack_into('<I', hierarchy, 8, 1)
        struct.pack_into('<f', hierarchy, 60, 1)
        result.update({'model_LV_Waterfall.b': bytes(model), 'hierarchy_LV_Waterfall.b': bytes(hierarchy),
                       'texture_LV_water_tga.b': result['TerrainGroup/fixture_snow.ps2_texture'],
                       'palette_LV_water_tga.b': result['TerrainGroup/fixture_snow.ps2_palette'],
                       'xml_0002.xml': b'<ParameterClass class_name="LV_Waterfall" s_model_name="LV_Waterfall.log" />',
                       'xml_0003.xml': b'<ObjectInstance objParamClass="LV_Waterfall" objectName="FixtureWaterfall" position_v0="8" position_v1="5" position_v2="40" rotation_v0="0" rotation_v1="0" rotation_v2="0" />'})
    return result


def music_bank():
    resources = [b'LOAD' + bytes(32) + b'LIST' + bytes(8)]
    for i in range(2):
        descriptor = bytearray(156)
        descriptor[:8] = b'LOAD' + struct.pack('<I', 20)
        descriptor[28:48] = b'TYPE' + struct.pack('<I', 4) + b'SVAGSVAG' + struct.pack('<I', 108)
        voice = f'MUS_SNG{i+1}'.encode()
        descriptor[64:64+len(voice)] = voice
        reference = f'MUSIC.MET[{i+3}]'.encode()
        descriptor[136:136+len(reference)] = reference
        resources.append(bytes(descriptor))
    for track, rate, blocks in [(1, 8000, 8000*9//28), (9, 44100, 100)]:
        data = bytearray(48)
        data[:8] = b'VAGp' + struct.pack('>I', 32)
        struct.pack_into('>II', data, 12, blocks*16, rate)
        label = f'track{track}'.encode()
        data[32:32+len(label)] = label
        data.extend((bytes([0x18, 0]) + bytes([0x33])*14) * blocks)
        resources.append(bytes(data))
    toc = bytearray(b'tTOC' + bytes(4) + struct.pack('<II', 16, len(resources)*16))
    at = 16 + len(resources)*16
    payload = bytearray()
    for resource in resources:
        toc.extend(b'tXXX' + bytes(4) + struct.pack('<II', at+len(payload), len(resource)))
        payload.extend(resource)
    return bytes(toc + payload)


def iso(pak, recognized=True, manifest_mutation=None, music=None, titles_csv=None):
    name = 'AA_fixture.pak'
    filename = f'{name_hash(name):X}.DAT'
    index_size, strings_size, data_size = struct.unpack_from('<3I', pak, len(pak)-12)
    manifest = bytearray(name.encode().ljust(64, b'\0') + struct.pack('<4I', name_hash(name), data_size, index_size, strings_size))
    if manifest_mutation:
        manifest_mutation(manifest)
    files = [('E942715C.DAT', bytes(manifest)), (filename, pak)]
    if titles_csv is not None:
        config = package({'Text/strings.csv': titles_csv})
        index_size, strings_size, data_size = struct.unpack_from('<3I', config, len(config)-12)
        manifest += b'config.pak'.ljust(64, b'\0') + struct.pack('<4I', name_hash('config.pak'), data_size, index_size, strings_size)
        files[0] = ('E942715C.DAT', bytes(manifest))
        files.append((f'{name_hash("config.pak"):X}.DAT', config))
    image = bytearray(28 * 2048)
    rows = record(b'\0', 25, 2048, True) + record(b'\1', 24, 2048, True)
    for leaf, data in files:
        sector = len(image) // 2048
        rows += record(leaf + ';1', sector, len(data))
        image.extend(data)
        image.extend(bytes((-len(image)) % 2048))
    image[25*2048:25*2048+len(rows)] = rows
    rows = record(b'\0', 24, 2048, True) + record(b'\1', 24, 2048, True) + record('DATA', 25, 2048, True)
    rows += record(BOOT if recognized else 'OTHER.ELF', 26, 4)
    if music is not None:
        sector = len(image) // 2048
        image.extend(music)
        image.extend(bytes((-len(image)) % 2048))
        music_rows = record(b'\0', 27, 2048, True) + record(b'\1', 24, 2048, True)
        music_rows += record('MUSIC.MET;1', sector, len(music))
        image[27*2048:27*2048+len(music_rows)] = music_rows
        rows += record('MUSIC', 27, 2048, True)
    image[24*2048:24*2048+len(rows)] = rows
    image[16*2048:16*2048+7] = b'\x01CD001\x01'
    image[16*2048+80:16*2048+88] = both(len(image)//2048)
    image[16*2048+128:16*2048+132] = b'\x00\x08\x08\x00'
    image[16*2048+156:16*2048+190] = record(b'\0', 24, 2048, True)
    return bytes(image)


def raw_bin(image):
    result = bytearray()
    for at in range(0, len(image), 2048):
        result.extend(b'\0' + b'\xff' * 10 + b'\0\0\0\0\2' + bytes(8))
        result.extend(image[at:at+2048])
        result.extend(bytes(280))
    return result


def main():
    executable, queries = map(lambda value: Path(value).resolve(), sys.argv[1:3])

    def run(*args, succeeds=True):
        result = subprocess.run([str(executable), *map(str, args)], capture_output=True, text=True, timeout=45)
        assert (result.returncode == 0) == succeeds, result.stdout + result.stderr
        return result.stdout + result.stderr

    with tempfile.TemporaryDirectory(prefix='openslope-madtrix-') as temporary:
        root = Path(temporary)
        pak = package(members())
        for raw in (False, True):
            source = root / ('fixture.bin' if raw else 'fixture.iso')
            source.write_bytes(raw_bin(iso(pak)) if raw else iso(pak))
            assert run('list', source) == f'{COURSE}\t{len(pak)}\n'
            maps = root / ('raw' if raw else 'plain')
            run('extract', source, COURSE.lower(), maps)
            output = maps / COURSE.lower()
            row, = json.loads((output/'Patches.json').read_text())['Patches']
            assert row['SurfaceType'] == 1 and row['LightmapID'] == -1
            assert row['UVPoints'] == [[-1, 0], [0, 1], [1, 0], [2, -1]]
            for j, point in enumerate(row['Points']):
                r, c = divmod(j, 4)
                assert point == [-3000 + r * 2000, c * 2000, 3000 - c * 500]
                assert row['LightColorPoints'][j] == [(512 + r * 64)/2048, (1024 + c * 128)/2048, 1]
            assert png_pixels(output/'Textures/fixture_snow.png') == bytes([10, 20, 30, 255, 200, 80, 40, 128,
                                                                         0, 0, 0, 0, 255, 100, 50, 255])
            info = json.loads((output/'Import.json').read_text())
            assert not info['Complete'] and info['Game'] == 'jonny-moseley-mad-trix'
            for name in ['Models', 'Instances', 'Materials']:
                assert json.loads((output/f'{name}.json').read_text()) == {name: []}
            assert not info['Environment']['Available'] and not (output/'Skybox').exists()
            subprocess.run([str(queries), str(output), str(source)], check=True, timeout=45)
            (output/'keep.txt').write_text('keep')
            run('extract', source, COURSE.lower(), maps, succeeds=False)
            assert (output/'keep.txt').read_text() == 'keep'
        # Source bank -> portable streamed playlist, with predictor history
        # retained across the two four-second WAV boundaries.
        source = root/'music.iso'
        source.write_bytes(iso(package(members()), music=music_bank()))
        run('extract', source, COURSE, root/'music')
        output = root/'music'/COURSE
        audio = output/'Audio/Music'
        assert json.loads((audio/'playlist.json').read_text()) == ['track1', 'track9']
        graph = json.loads((audio/'track1/graph.json').read_text())
        assert graph['Events'] == 0 and len(graph['Samples']) == 3 and len(graph['Nodes']) == 4
        assert graph['Nodes'][0]['Sample'] == 0 and graph['Nodes'][-1]['Links'] == [1]
        decoded = []
        for sample in graph['Samples']:
            with wave.open(str(audio/'track1'/sample['Wav'])) as w:
                assert w.getframerate() == 8000 and w.getnchannels() == 1
                assert w.getnframes() == sample['Samples'] and sample['Seconds'] <= 4
                decoded.extend(struct.unpack(f'<{w.getnframes()}h', w.readframes(w.getnframes())))
        assert len(decoded) == 8000*9//28*28
        previous = 0
        for sample in decoded:
            previous = 48 + previous*60//64
            assert sample == previous, 'Predictor history and PCM must survive WAV boundaries'
        assert json.loads((audio/'track9/graph.json').read_text())['Samples'][0]['Rate'] == 44100
        assert json.loads((output/'Import.json').read_text())['Music']['Songs'] == 2
        subprocess.run([str(queries), str(output), str(source)], check=True, timeout=45)
        for fault in ['toc', 'overlap', 'reference', 'rate', 'frame', 'extent', 'name']:
            bank = bytearray(music_bank())
            if fault == 'toc': struct.pack_into('<I', bank, 12, 4097)
            elif fault == 'overlap': struct.pack_into('<I', bank, 16+16+8, 96)
            elif fault == 'reference': bank[144+136:144+152] = b'MUSIC.MET[255]\0\0'
            else:
                stream = struct.unpack_from('<I', bank, 16+3*16+8)[0]
                if fault == 'rate': struct.pack_into('>I', bank, stream+16, 7999)
                elif fault == 'frame': bank[stream+48] = 0xf0
                elif fault == 'extent': struct.pack_into('>I', bank, stream+12, 16)
                elif fault == 'name': bank[stream+32:stream+48] = b'../escape\0'.ljust(16, b'\0')
            broken = root/f'music-{fault}.iso'
            broken.write_bytes(iso(package(members()), music=bytes(bank)))
            run('extract', broken, COURSE, root/f'music-{fault}', succeeds=False)
            assert not (root/f'music-{fault}'/COURSE).exists()
        # Exact magenta is a source cutout key in indexed and direct pixels.
        # Nearby pinks must stay visible, and ordinary partial alpha stays scaled.
        colours = bytes([255, 0, 255, 128, 254, 0, 255, 128, 255, 1, 255, 128, 200, 80, 40, 64])
        for depth in (4, 8, 32):
            files = members(sky=True)
            tex = bytearray(files['TerrainGroup/fixture_snow.ps2_texture'][:80])
            struct.pack_into('<H', tex, 14, depth)
            tex.extend(colours if depth == 32 else bytes([0x10, 0x32]) if depth == 4 else bytes(range(4)))
            files['TerrainGroup/fixture_snow.ps2_texture'] = bytes(tex)
            files['TerrainGroup/fixture_snow.ps2_palette'] = files['TerrainGroup/fixture_snow.ps2_palette'][:48] + colours
            source = root/f'keyed-{depth}.iso'
            source.write_bytes(iso(package(files)))
            run('extract', source, COURSE, root/f'keyed-{depth}')
            output = root/f'keyed-{depth}'/COURSE
            expected = bytes([255, 0, 255, 0, 254, 0, 255, 255, 255, 1, 255, 255, 200, 80, 40, 128])
            assert png_pixels(output/'Textures/fixture_snow.png') == expected
            assert png_pixels(output/'Skybox/Textures/madtrix-sky-0.png') == expected
        source = root/'audio.iso'
        files = members(audio=True)
        source.write_bytes(iso(package(files)))
        run('extract', source, COURSE, root/'audio')
        output = root/'audio'/COURSE/'Audio'
        index = json.loads((output/'SoundIndex.json').read_text())
        assert index['Banks']['1'] == 'openslope_board' and index['RidingFallback'] == 'ssx-tricky'
        routes = json.loads((output/'RidingImport.json').read_text())['Routes']
        assert len(routes) == 30 and next(r for r in routes if r['Slot'] == 4)['SourceMember'] == 'glide2.vag'
        assert next(r for r in routes if r['Slot'] == 52)['SourceMember'] == 'glide6.vag'
        for stem, expected in [('004.wav', 3), ('004.loop.wav', 3), ('003.wav', 3), ('001.wav', 3)]:
            with wave.open(str(output/'SFX/openslope_board'/stem), 'rb') as wav:
                assert wav.getframerate() == 12000 and wav.getnframes() == 56 and wav.getnchannels() == 1
                assert struct.unpack('<h', wav.readframes(1))[0] == expected
        assert not (output/'SFX/openslope_board/001.loop.wav').exists(), 'Land is a one-shot, even if its VAG loops'
        for bad in ['rate', 'extent', 'families']:
            broken = dict(files)
            name = 'normvocdef.bin' if bad == 'families' else 'glide2.vag'
            value = bytearray(broken[name])
            if bad == 'families': struct.pack_into('<I', value, 48, 11)
            elif bad == 'rate': struct.pack_into('>I', value, 16, 0)
            else: value.pop()
            broken[name] = bytes(value)
            source = root/f'audio-bad-{bad}.iso'
            source.write_bytes(iso(package(broken)))
            run('extract', source, COURSE, root/f'audio-bad-{bad}', succeeds=False)
            assert not (root/f'audio-bad-{bad}'/COURSE).exists()
        source = root/'rails-signs.iso'
        source.write_bytes(iso(package(members(rails=True, signs=True, sky=True, audio=True))))
        run('extract', source, COURSE, root/'rails-signs')
        output = root/'rails-signs'/COURSE
        splines = json.loads((output/'Splines.json').read_text())['Splines']
        assert len(splines) == 1 and splines[0]['SplineStyle'] == 13 and len(splines[0]['Segments']) == 1
        instances = json.loads((output/'Instances.json').read_text())['Instances']
        assert len(instances) == 1 and instances[0]['Location'] == [500, 500, 4000]
        assert not instances[0]['PlayerCollision'] and instances[0]['EffectSlotIndex'] == 0
        materials = json.loads((output/'Materials.json').read_text())['Materials']
        assert len(materials[0]['TextureFlipbook']) == 2
        assert png_pixels(output/'Textures/madtrix-sign-0-on.png') != png_pixels(output/'Textures/madtrix-sign-0-off.png')
        subprocess.run([str(queries), str(output)], check=True, timeout=45)
        # A visibly identical rail without the authored blue property mark must not become grindable.
        files = members(rails=True)
        files['PropertyGroup/fixture_metal.ps2_palette'] = files['TerrainGroup/fixture_snow.ps2_palette']
        source = root/'unmarked.iso'
        source.write_bytes(iso(package(files)))
        run('extract', source, COURSE, root/'unmarked')
        assert json.loads((root/'unmarked'/COURSE/'Splines.json').read_text())['Splines'] == []
        for with_sign in [False, True]:
            source = root/f'waterfall-{with_sign}.iso'
            files = members(rails=True, waterfalls=True, signs=with_sign)
            if with_sign:
                # A quarter-turn exercises V-aligned source sections too.
                model = bytearray(files['model_LV_Waterfall.b'])
                for i in range(6):
                    u, v = struct.unpack_from('<2h', model, 144+i*4)
                    struct.pack_into('<2h', model, 144+i*4, v, u)
                files['model_LV_Waterfall.b'] = bytes(model)
            source.write_bytes(iso(package(files)))
            run('extract', source, COURSE, root/f'waterfall-{with_sign}')
            output = root/f'waterfall-{with_sign}'/COURSE
            info = json.loads((output/'Import.json').read_text())
            assert info['Waterfalls']['Instances'] == 1 and info['Signs']['Instances'] == int(with_sign)
            instances = json.loads((output/'Instances.json').read_text())['Instances']
            water = next(i for i in instances if i['InstanceName'] == 'FixtureWaterfall')
            assert water['EffectSlotIndex'] == 1 and not water['PlayerCollision']
            model_id = water['ModelID']
            mesh = (output/f'Meshes/madtrix-waterfall-{model_id}.obj').read_text()
            assert [line for line in mesh.splitlines() if line.startswith('f ')] == ['f 1/1 2/2 3/3', 'f 5/4 4/5 6/6']
            uv = [list(map(float, line.split()[1:])) for line in mesh.splitlines() if line.startswith('vt ')]
            assert uv[2][0] > uv[0][0] and uv[3][0] > uv[4][0], 'Both sections must flow downhill despite mirrored source U'
            materials = json.loads((output/'Materials.json').read_text())['Materials']
            assert materials[model_id]['RepeatTexture'] and 'TextureFlipbook' not in materials[model_id]
            assert png_pixels(output/f'Textures/madtrix-waterfall-{model_id}.png') == png_pixels(output/'Textures/fixture_snow.png')
            graph = json.loads((output/'Effects.json').read_text())['graphs'][1]
            scroll = graph['nodes'][0]['payload']['type0']['UVScroll']
            assert scroll['U1'] == -.5/60 and scroll['U2'] == 0
            subprocess.run([str(queries), str(output)], check=True, timeout=45)
        for bad in ['strip-mask', 'vertex', 'count', 'extent']:
            files = members(waterfalls=True)
            model = bytearray(files['model_LV_Waterfall.b'])
            if bad == 'strip-mask': struct.pack_into('<H', model, 324, 1)
            if bad == 'vertex': struct.pack_into('<f', model, 236, float('nan'))
            if bad == 'count': model[142] = 129
            if bad == 'extent': model = model[:326]
            files['model_LV_Waterfall.b'] = bytes(model)
            source = root/f'waterfall-bad-{bad}.iso'
            source.write_bytes(iso(package(files)))
            run('extract', source, COURSE, root/f'waterfall-bad-{bad}', succeeds=False)
            assert not (root/f'waterfall-bad-{bad}'/COURSE).exists()
        for variant in ['identical', 'different']:
            files = members(signs=True)
            files['duplicate-sign.b'] = files['texture_SS_Marquee_tga.b']
            if variant == 'different':
                data = bytearray(files['duplicate-sign.b']); data[80] ^= 1
                files['duplicate-sign.b'] = bytes(data)
            def alias(name, chunk, row, packed):
                if name == 'duplicate-sign.b': struct.pack_into('<I', row, 16, name_hash('texture_SS_Marquee_tga.b'))
            source = root/f'sign-{variant}.iso'
            source.write_bytes(iso(package(files, alias)))
            run('extract', source, COURSE, root/f'sign-{variant}', succeeds=variant == 'identical')
        for shape in ['welcome', 'neon']:
            files = members(rails=True, signs=True)
            source_name = 'LV_neonsign_welcome' if shape == 'welcome' else 'LV_neonsign1'
            model = bytearray(files.pop('model_SS_marquee_sign_left.b'))
            if shape == 'welcome':
                old = bytes(model); model = model[:384]
                struct.pack_into('<I', model, 140, 0x75040000)
                struct.pack_into('<I', model, 216, 0x78040000)
                for i, source_vertex in enumerate([1, 0, 3, 4]):
                    model[144+i*4:148+i*4] = old[144+source_vertex*4:148+source_vertex*4]
                    model[220+i*12:232+i*12] = old[228+source_vertex*12:240+source_vertex*12]
            files[f'model_{source_name}.b'] = bytes(model)
            files[f'hierarchy_{source_name}.b'] = files.pop('hierarchy_SS_marquee_sign_left.b')
            files['xml_0000.xml'] = files['xml_0000.xml'].replace(b'SS_marquee_sign_left', source_name.encode())
            for frame in range(4 if shape == 'neon' else 1):
                name = f'LV_neonsign1_P{frame}' if shape == 'neon' else 'LV_TI_sign_welcome'
                files[f'texture_{name}_tga.b'] = files['texture_SS_Marquee_tga.b']
                palette = bytearray(files['palette_SS_Marquee_tga.b']); palette[48] += frame
                files[f'palette_{name}_tga.b'] = bytes(palette)
            source = root/f'sign-{shape}.iso'
            source.write_bytes(iso(package(files)))
            run('extract', source, COURSE, root/f'sign-{shape}')
            output = root/f'sign-{shape}'/COURSE
            book = json.loads((output/'Materials.json').read_text())['Materials'][0]['TextureFlipbook']
            assert len(book) == (4 if shape == 'neon' else 2)
            if shape == 'neon':
                assert [png_pixels(output/'Textures'/name)[0] for name in book] == [10, 11, 12, 13]
            subprocess.run([str(queries), str(output)], check=True, timeout=45)
        source = root/'roof.iso'
        source.write_bytes(iso(package(members(roof=True))))
        run('extract', source, COURSE, root/'roof')
        output = root/'roof'/COURSE
        start = json.loads((output/'AIP.json').read_text())['AIPaths'][0]['PathPos']
        assert abs(start[2] - 2875) < .01, 'Authored start must stay below an overhead shelter'
        subprocess.run([str(queries), str(output)], check=True, timeout=45)
        source = root/'sky.iso'
        source.write_bytes(iso(package(members(sky=True))))
        run('extract', source, COURSE, root/'sky')
        output = root/'sky'/COURSE
        info = json.loads((output/'Import.json').read_text())
        assert info['Environment']['SkyPatches'] == 1 and info['Environment']['SkyTriangles'] == 128
        assert 'sky' not in info['Deferred'] and 'Skybox' in info['Outputs']
        assert len(json.loads((output/'Patches.json').read_text())['Patches']) == 1, 'Sky must not become colliding terrain'
        materials = json.loads((output/'Skybox/Materials.json').read_text())['Materials']
        assert materials == [{'TexturePath': 'madtrix-sky-0.png', 'AlphaMode': 'blend', 'RepeatTexture': False}]
        assert png_pixels(output/'Skybox/Textures/madtrix-sky-0.png') == png_pixels(output/'Textures/fixture_snow.png')
        obj = (output/'Skybox/Meshes/madtrix-sky-0.obj').read_text().splitlines()
        vertices = [list(map(float, line.split()[1:])) for line in obj if line.startswith('v ')]
        uv = [list(map(float, line.split()[1:])) for line in obj if line.startswith('vt ')]
        assert len(vertices) == 81 and sum(line.startswith('f ') for line in obj) == 128
        assert vertices[0] == [-1500, 5000, -1500] and vertices[40] == [0, 5140.625, 0]
        assert uv[0] == [0, 1] and uv[1] == [.125, 1] and uv[9] == [0, .875] and uv[-1] == [1, 0]
        subprocess.run([str(queries), str(output), str(source)], check=True, timeout=45)
        source = root/'staging.iso'
        source.write_bytes(iso(package(members(staging=True))))
        run('extract', source, COURSE, root/'staging')
        output = root/'staging'/COURSE
        start = json.loads((output/'AIP.json').read_text())['AIPaths'][0]['PathPos']
        assert start[2] < 3000, 'Scripted metal staging must relocate to clear snow'
        subprocess.run([str(queries), str(output)], check=True, timeout=45)
        source = root/'bad.iso'

        def failed(image, label, expected):
            source.write_bytes(image)
            maps = root/label
            message = run('extract', source, COURSE, maps, succeeds=False)
            assert expected in message, (label, expected, message)
            assert not list(maps.iterdir()), 'Failed extraction must remove its staging directory'

        failed(iso(pak, recognized=False), 'foreign', 'No supported game')
        failed(iso(pak, manifest_mutation=lambda b: struct.pack_into('<I', b, 68, 1)), 'manifest', 'size disagrees')
        for field, value, expected in [(60, 0xffffffff, 'chunk bounds'), (14, 2, 'Truncated'),
                                       (52, 1, 'chunk bounds'), (76, 513, 'compression window')]:
            def mutate(name, chunk, row, packed):
                if name == 'TerrainGroup/patch.bin':
                    struct.pack_into('<H' if field in (14, 76) else '<I', row, field, value)
            failed(iso(package(members(), mutate)), f'bad-{field}', expected)
        bad = members()
        geo = bytearray(bad['TerrainGroup/patch.bin'])
        struct.pack_into('<I', geo, 512 + 128, 0)
        bad['TerrainGroup/patch.bin'] = bytes(geo)
        failed(iso(package(bad)), 'lighting-packet', 'lighting packet')
        bad = members()
        bad['TERRAINGROUP/TABLE.BIN'] = bad['TerrainGroup/table.bin']
        failed(iso(package(bad)), 'ambiguous', 'ambiguous')
        bad = members()
        geo = bytearray(bad['TerrainGroup/patch.bin'])
        struct.pack_into('<H', geo, 512 + 248, 32)
        bad['TerrainGroup/patch.bin'] = bytes(geo)
        failed(iso(package(bad)), 'material', 'missing material')
        bad = members()
        bad['xml_0007.xml'] = b'<ObjectInstance objClass="ObjClass_SkierStart" position_v0="nan" position_v1="0" position_v2="0" />'
        failed(iso(package(bad)), 'start', 'start coordinate')
        bad = members()
        bad.pop('TerrainGroup/fixture_snow.ps2_palette')
        failed(iso(package(bad)), 'palette', 'PAK has no')
        for field, value, expected in [(16, 100001, 'quilt header'), (248 + 512, 32, 'sky references missing material')]:
            bad = members(sky=True)
            dome = bytearray(bad['TerrainGroup/domepatch.bin'])
            struct.pack_into('<I' if field == 16 else '<H', dome, field, value)
            bad['TerrainGroup/domepatch.bin'] = bytes(dome)
            failed(iso(package(bad)), f'sky-{field}', expected)
    print('PASS: Mad Trix ISO/BIN catalogue, terrain/pixels, animated props/audio, riding/reset, cancellation and malformed cleanup')


if __name__ == '__main__':
    main()
