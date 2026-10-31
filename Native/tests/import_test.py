"""Independent synthetic disc -> canonical map integration; no retail data or packages."""
import binascii
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import zlib


def le(value):
    return struct.pack('<I', value)


def both(value):
    return struct.pack('<I', value) + struct.pack('>I', value)


def record(name, sector, size, directory=False):
    name = name if isinstance(name, bytes) else name.encode('ascii')
    length = 33 + len(name) + (len(name) % 2 == 0)
    result = bytearray(length)
    result[0] = length
    result[2:10] = both(sector)
    result[10:18] = both(size)
    result[25] = 2 if directory else 0
    result[28:32] = b'\x01\x00\x00\x01'
    result[32] = len(name)
    result[33:33 + len(name)] = name
    return result


def ssh(lightmap=False, palette_override=None):
    pixel = b'\x07\x13\x31\x79' if lightmap else b'\x00\x01\x02\x03'
    image = bytes([5 if lightmap else 2]) + bytes(3) + struct.pack('<hhhhI', 2, 2, 0, 0, 0) + (pixel * 4 if lightmap else pixel)
    if not lightmap:
        palette = palette_override or bytes([10, 20, 30, 128, 128, 128, 128, 128, 200, 50, 0, 64, 0, 0, 0, 0])
        image += b'\x21\x00\x00\x00' + struct.pack('<hhhhI', 4, 1, 4, 0, 0) + palette
    # Long name has a compact 4-byte prefix, not the common 16-byte header.
    image += b'\x70\x00\x00\x00\x00'
    image += bytes((-len(image)) % 16)
    return b'SHPS' + le(32 + len(image)) + le(1) + b'TEST0000' + le(32) + bytes(8) + image


def crowd_bank():
    image = ssh()[32:]
    start = 16 + 16 * 8
    table = b''.join(f'cd{i:02d}'.encode() + le(start + i * len(image)) for i in range(16))
    return b'SHPS' + le(start + 16 * len(image)) + le(16) + b'TEST' + table + image * 16


def course_members():
    pbd = bytearray(136 + 448)
    pbd[:4] = b'\x00\x15\x1b\x01'
    pbd[8:12] = le(1)
    pbd[68:72] = le(136)
    # Known polynomial P(u,v) = (1000+900v,2000+1800u,3000-90u).
    coefficients = [(0., 0., 0.)] * 16
    coefficients[0] = (1000., 2000., 3000.)
    coefficients[1] = (900., 0., 0.)
    coefficients[4] = (0., 1800., -90.)
    for index, point in enumerate(reversed(coefficients)):
        struct.pack_into('<4f', pbd, 136 + 80 + index * 16, *point, 1.)
    struct.pack_into('<4f', pbd, 136, .25, .5, .125, .25)
    for index, uv in enumerate([(0., 0.), (1., 0.), (0., -1.), (1., -1.)]):
        struct.pack_into('<4f', pbd, 136 + 16 + index * 16, *uv, 0., 0.)
    struct.pack_into('<Ihhhh', pbd, 136 + 424, 5, 0x29, -1, 0, 0)
    manifest = '###\n### PATCHES BEGIN\n### names\n' + 'Fixture patch'.ljust(82) + '0'.ljust(10) * 3 + '\n\n### PATCHES END\n'
    return {'fixture.pbd': bytes(pbd), 'fixture.map': manifest.encode(), 'fixture.ssh': ssh(), 'fixture_L.ssh': ssh(True)}


def refpack(data):
    result = bytearray(b'\x10\xfb' + len(data).to_bytes(3, 'big'))
    position = 0
    while len(data) - position >= 4:
        size = min(112, ((len(data) - position) // 4) * 4)
        result.append(0xe0 + (size - 4) // 4)
        result += data[position:position + size]
        position += size
    result.append(0xfc + len(data) - position)
    result += data[position:]
    return bytes(result)


def big(members, compact=True):
    entries = [(('data/models/' + name).encode(), refpack(data)) for name, data in members.items()]
    header_size = (6 if compact else 16) + sum((6 if compact else 8) + len(name) + 1 for name, _ in entries)
    result = bytearray(b'\xc0\xfb' + struct.pack('>HH', header_size - 4, len(entries)) if compact else b'BIGF' + struct.pack('>III', header_size + sum(len(data) for _, data in entries), len(entries), header_size))
    offset = header_size
    for name, data in entries:
        width = 3 if compact else 4
        result += offset.to_bytes(width, 'big') + len(data).to_bytes(width, 'big') + name + b'\0'
        offset += len(data)
    for _, data in entries:
        result += data
    return bytes(result)


def iso(archive):
    sectors = 28 + (len(archive) + 2047) // 2048
    result = bytearray(sectors * 2048)
    pvd = bytearray(2048)
    pvd[:7] = b'\x01CD001\x01'
    pvd[80:88] = both(sectors)
    pvd[128:132] = b'\x00\x08\x08\x00'
    pvd[156:190] = record(b'\0', 24, 2048, True)
    result[16 * 2048:17 * 2048] = pvd
    result[17 * 2048:17 * 2048 + 7] = b'\xffCD001\x01'
    for sector, name, child_sector, size, directory in [(24, 'DATA', 25, 2048, True), (25, 'MODELS', 26, 2048, True), (26, 'FIXTURE.BIG;1', 28, len(archive), False)]:
        rows = record(b'\0', sector, 2048, True) + record(b'\1', sector, 2048, True) + record(name, child_sector, size, directory)
        result[sector * 2048:sector * 2048 + len(rows)] = rows
    result[28 * 2048:28 * 2048 + len(archive)] = archive
    return result


def png_pixels(path):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    cursor, compressed, width, height = 8, bytearray(), 0, 0
    while cursor < len(data):
        size, = struct.unpack_from('>I', data, cursor)
        kind = data[cursor + 4:cursor + 8]
        payload = data[cursor + 8:cursor + 8 + size]
        crc, = struct.unpack_from('>I', data, cursor + 8 + size)
        assert binascii.crc32(kind + payload) & 0xffffffff == crc
        if kind == b'IHDR':
            width, height = struct.unpack_from('>II', payload)
            assert payload[8:] == b'\x08\x06\x00\x00\x00'
        if kind == b'IDAT':
            compressed += payload
        cursor += size + 12
    rows = zlib.decompress(compressed)
    assert len(rows) == (width * 4 + 1) * height
    pixels = bytearray()
    for y in range(height):
        start = y * (width * 4 + 1)
        assert rows[start] == 0
        pixels += rows[start + 1:start + 1 + width * 4]
    return pixels


def run(executable, *args, succeeds=True):
    result = subprocess.run([str(executable), *map(str, args)], capture_output=True, text=True, timeout=30)
    assert (result.returncode == 0) == succeeds, result.stdout + result.stderr
    return result.stdout


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-import-test-') as temporary:
        root = Path(temporary)
        for compact in [True, False]:
            image = root / ('compact.iso' if compact else 'bigf.iso')
            image.write_bytes(iso(big(course_members(), compact)))
            assert run(executable, 'list', image).split('\t')[0] == 'TRICKY_FIXTURE'
            maps = root / ('Maps compact' if compact else 'Maps bigf')
            run(executable, 'extract', image, 'TRICKY_FIXTURE', maps)
            output = maps / 'TRICKY_FIXTURE'
            assert not (maps / 'FIXTURE').exists()
            assert json.loads((output / 'Import.json').read_text())['Course'] == 'TRICKY_FIXTURE'
            row, = json.loads((output / 'Patches.json').read_text())['Patches']
            assert row['PatchName'] == 'Fixture patch'
            assert row['SurfaceType'] == 5 and row['TrickOnlyPatch'] is True
            assert row['LightmapID'] == 0 and row['TexturePath'] == '0000.png'
            assert row['UVPoints'] == [[0, 0], [1, 0], [0, -1], [1, -1]]
            for index, point in enumerate(row['Points']):
                u, v = divmod(index, 4)
                expected = [1000 + v * 300, 2000 + u * 600, 3000 - u * 30]
                assert all(abs(a - b) < .001 for a, b in zip(point, expected))
            assert png_pixels(output / 'Textures/0000.png') == bytes([19, 39, 59, 255, 255, 255, 255, 255, 255, 99, 0, 128, 0, 0, 0, 0])
            assert png_pixels(output / 'Lightmaps/0000.png') == b'\x07\x13\x31\x79' * 4
            origin = json.loads((output / 'Origin.json').read_text())
            assert origin['RetailData'] and origin['Reasons'] == ['retail-extract']
            assert origin['Game'] == 'ssx-tricky'
            sentinel = output / 'custom.txt'; sentinel.write_text('keep me')
            run(executable, 'extract', image, 'TRICKY_FIXTURE', maps, succeeds=False)
            assert sentinel.read_text() == 'keep me'
            assert not list(maps.glob('.openslope-import-*'))
            # Older saved references keep their own folder and metadata IDs.
            run(executable, 'extract', image, 'FIXTURE', maps)
            assert json.loads((maps / 'FIXTURE/Import.json').read_text())['Course'] == 'FIXTURE'
        for name, mutate in [('truncated', lambda data: data[:20]), ('bad-sector', lambda data: data[:16 * 2048 + 128] + b'\x00\x04' + data[16 * 2048 + 130:]), ('unsupported', lambda data: data.replace(b'\x00\x15\x1b\x01', b'\x00\x15\x1b\x02'))]:
            image = root / (name + '.iso'); image.write_bytes(mutate(iso(big(course_members()))))
            run(executable, 'list', image, succeeds=False)
        bad = course_members(); bad['fixture.map'] = b'bad linker'
        image = root / 'bad-linker.iso'; image.write_bytes(iso(big(bad)))
        maps = root / 'failed Maps'
        run(executable, 'extract', image, 'FIXTURE', maps, succeeds=False)
        assert not list(maps.iterdir()), 'Failed import must leave no playable folder'
        bad = course_members(); bad['../fixture.pbd'] = bad.pop('fixture.pbd')
        image = root / 'unsafe.iso'; image.write_bytes(iso(big(bad)))
        run(executable, 'list', image, succeeds=False)
        duplicate = course_members()
        duplicate['other/FIXTURE.SSH'] = duplicate['fixture.ssh']
        image = root / 'duplicate-leaf.iso'; image.write_bytes(iso(big(duplicate)))
        run(executable, 'list', image, succeeds=False)
        if len(sys.argv) > 2:
            # Course selection must read the index/PBD without fetching unrelated
            # archive payloads. The benchmark counts actual production reads.
            files = course_members(); files['unused.bin'] = bytes(4 * 1024 * 1024)
            image = root / 'discovery-io.iso'; image.write_bytes(iso(big(files)))
            timing = json.loads(run(Path(sys.argv[2]).resolve(), image))
            assert timing['courses'] == ['TRICKY_FIXTURE'] and timing['read_bytes'] < 32768
        # Degree-three and mixed monomials distinguish the direct double tensor
        # identity from a staged float calculation, without a decoder reference.
        curved = course_members()
        coefficients = {(0, 0): (1000, 2000, 3000), (0, 1): (900, 0, 0), (1, 0): (0, 1800, -90), (2, 1): (90, 0, 0), (3, 3): (18, 0, 0), (1, 2): (0, 36, 0), (3, 0): (0, 0, 27), (0, 3): (0, 0, 81)}
        pbd = bytearray(curved['fixture.pbd'])
        for u in range(4):
            for v in range(4):
                struct.pack_into('<4f', pbd, 136 + 80 + (15 - u * 4 - v) * 16, *coefficients.get((u, v), (0, 0, 0)), 1)
        curved['fixture.pbd'] = bytes(pbd)
        image = root / 'mixed-polynomial.iso'; image.write_bytes(iso(big(curved)))
        maps = root / 'polynomial Maps'; run(executable, 'extract', image, 'FIXTURE', maps)
        controls = json.loads((maps / 'FIXTURE/Patches.json').read_text())['Patches'][0]['Points']
        for u, v in [(0, 0), (1, 1), (.37, .61), (.91, .23)]:
            basis_u = [math.comb(3, i) * u ** i * (1 - u) ** (3 - i) for i in range(4)]
            basis_v = [math.comb(3, i) * v ** i * (1 - v) ** (3 - i) for i in range(4)]
            actual = [sum(controls[r * 4 + c][axis] * basis_u[r] * basis_v[c] for r in range(4) for c in range(4)) for axis in range(3)]
            expected = [1000 + 900 * v + 90 * u ** 2 * v + 18 * u ** 3 * v ** 3, 2000 + 1800 * u + 36 * u * v ** 2, 3000 - 90 * u + 27 * u ** 3 + 81 * v ** 3]
            assert all(abs(a - b) < 1e-8 for a, b in zip(actual, expected)), 'Direct basis conversion must reproduce the declared polynomial'
        associated = course_members()
        associated['fixture.ssh'] = ssh(palette_override=bytes([120, 60, 30, 126]) * 4)
        image = root / 'associated-alpha.iso'; image.write_bytes(iso(big(associated)))
        maps = root / 'alpha Maps'; run(executable, 'extract', image, 'FIXTURE', maps)
        assert png_pixels(maps / 'FIXTURE/Textures/0000.png') == bytes([242, 120, 60, 252]) * 4, 'Fractional alpha near opaque still follows the normalized colour identity'
        # Worst-case Adler sums and multiple 65535-byte stored blocks, checked
        # independently by Python's zlib and CRC implementation.
        large = course_members()
        width, height = 257, 129
        pixels = b'\xff' * (width * height * 4)
        image = bytes([5, 0, 0, 0]) + struct.pack('<hhhhI', width, height, 0, 0, 0) + pixels
        large['fixture_L.ssh'] = b'SHPS' + le(32 + len(image)) + le(1) + b'TEST0000' + le(32) + bytes(8) + image
        image = root / 'large-lightmap.iso'; image.write_bytes(iso(big(large)))
        maps = root / 'large Maps'; run(executable, 'extract', image, 'FIXTURE', maps)
        assert png_pixels(maps / 'FIXTURE/Lightmaps/0000.png') == pixels
    print('Synthetic ISO import: C0FB/BIGF, RefPack, terrain, RGBA PNG, provenance, failures and existing-map protection PASS')


if __name__ == '__main__':
    main()
