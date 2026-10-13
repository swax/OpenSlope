"""Compare the native importer stages to an existing reference Maps/<course>.

PNG compression and JSON whitespace differ; compare decoded pixels and values.
This does not claim parity for importer stages listed as deferred in Import.json.
"""
import argparse
import binascii
import json
from pathlib import Path
import struct
import zlib


def rgba(path):
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'Not a PNG: {path}')
    position, compressed, palette, alpha = 8, bytearray(), b'', b''
    width = height = colour = channels = 0
    while position < len(data):
        size, = struct.unpack_from('>I', data, position)
        kind = data[position + 4:position + 8]
        payload = data[position + 8:position + 8 + size]
        checksum, = struct.unpack_from('>I', data, position + 8 + size)
        if binascii.crc32(kind + payload) & 0xffffffff != checksum:
            raise ValueError(f'PNG checksum mismatch: {path}')
        if kind == b'IHDR':
            width, height, depth, colour, compression, filtering, interlace = struct.unpack('>IIBBBBB', payload)
            if depth != 8 or interlace or compression or filtering:
                raise ValueError(f'Unsupported PNG encoding: {path}')
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour]
        elif kind == b'IDAT':
            compressed += payload
        elif kind == b'PLTE':
            palette = payload
        elif kind == b'tRNS':
            alpha = payload
        position += size + 12
    raw = zlib.decompress(compressed)
    stride = width * channels
    if len(raw) != (stride + 1) * height:
        raise ValueError(f'PNG row size mismatch: {path}')
    previous, pixels = bytearray(stride), bytearray()
    for y in range(height):
        start = y * (stride + 1)
        mode = raw[start]
        row = bytearray(raw[start + 1:start + 1 + stride])
        for x in range(stride):
            a = row[x - channels] if x >= channels else 0
            b = previous[x]
            c = previous[x - channels] if x >= channels else 0
            if mode == 1:
                prediction = a
            elif mode == 2:
                prediction = b
            elif mode == 3:
                prediction = (a + b) // 2
            elif mode == 4:
                base = a + b - c
                distances = [abs(base - a), abs(base - b), abs(base - c)]
                prediction = [a, b, c][distances.index(min(distances))]
            elif mode == 0:
                prediction = 0
            else:
                raise ValueError(f'Invalid PNG filter: {path}')
            row[x] = (row[x] + prediction) & 255
        for x in range(width):
            value = row[x * channels:(x + 1) * channels]
            if colour == 6:
                pixels += value
            elif colour == 2:
                pixels += value + b'\xff'
            elif colour == 0:
                pixels += bytes([value[0]] * 3 + [255])
            elif colour == 4:
                pixels += bytes([value[0]] * 3 + [value[1]])
            else:
                index = value[0]
                pixels += palette[index * 3:index * 3 + 3] + bytes([alpha[index] if index < len(alpha) else 255])
        previous = row
    return width, height, pixels


def compare(native, reference, point_tolerance, allowed_texture_differences=()):
    actual = json.loads((native / 'Patches.json').read_text())['Patches']
    expected = json.loads((reference / 'Patches.json').read_text())['Patches']
    assert len(actual) == len(expected), 'Patch counts differ'
    maximum = 0.0
    for index, (a, b) in enumerate(zip(actual, expected)):
        assert a.keys() == b.keys(), f'Patch fields differ at {index}'
        for key in ['PatchName', 'SurfaceType', 'TrickOnlyPatch', 'TexturePath', 'LightmapID']:
            assert a[key] == b[key], f'{key} differs at patch {index}'
        for key in ['LightMapPoint', 'UVPoints']:
            aa = a[key] if key == 'LightMapPoint' else [v for pair in a[key] for v in pair]
            bb = b[key] if key == 'LightMapPoint' else [v for pair in b[key] for v in pair]
            assert len(aa) == len(bb) and all(struct.pack('<f', x) == struct.pack('<f', y) for x, y in zip(aa, bb)), f'{key} float32 values differ at patch {index}'
        assert len(a['Points']) == len(b['Points']) == 16
        for p, q in zip(a['Points'], b['Points']):
            assert len(p) == len(q) == 3
            difference = max(abs(x - y) for x, y in zip(p, q))
            maximum = max(maximum, difference)
            assert difference <= point_tolerance, f'Control point differs by {difference} cm at patch {index}'
    allowed = set(allowed_texture_differences)
    observed_differences = set()
    for directory in ['Textures', 'Lightmaps']:
        files = sorted((native / directory).glob('*.png'))
        assert files, f'No {directory} were imported'
        for file in files:
            if rgba(file) != rgba(reference / directory / file.name):
                assert directory == 'Textures' and file.name in allowed, f'Decoded pixels differ: {directory}/{file.name}'
                observed_differences.add(file.name)
        differences = len(observed_differences) if directory == 'Textures' else 0
        print(f'{directory}: {len(files) - differences}/{len(files)} PNGs match decoded RGBA; {differences} explicitly permitted policy differences')
    assert observed_differences == allowed, 'Expected texture-policy difference was not observed; remove stale permissions'
    actual_origin = json.loads((native / 'Origin.json').read_text())
    expected_origin = json.loads((reference / 'Origin.json').read_text())
    assert actual_origin == expected_origin, 'Provenance differs'
    print(f'Patches: {len(actual)}, fields match; maximum control-point difference {maximum:.6f} cm')
    print('Origin.json: exact semantic match')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('native', type=Path)
    parser.add_argument('reference', type=Path)
    parser.add_argument('--point-tolerance-cm', type=float, default=.01, help='Float32 basis conversion/JSON rounding tolerance in raw centimetres (default: 0.1 mm)')
    parser.add_argument('--allow-texture-difference', action='append', default=[], metavar='NAME.png', help='Explicitly permit one documented texture-policy difference; must actually differ')
    args = parser.parse_args()
    compare(args.native, args.reference, args.point_tolerance_cm, args.allow_texture_difference)
