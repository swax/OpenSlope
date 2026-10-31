"""Authored AXYE-format ROM fixtures. Contains no retail program or media."""
from pathlib import Path
import json
import struct
import subprocess
import sys
import tempfile
import wave

ARCHIVE = 0x2905c
IDS = ['GARIBALDI', 'SNOWDREAM', 'ELYSIUM_ALPS', 'MESABLANCA', 'MERQURY_CITY', 'TOKYO_MEGAPLEX', 'ALOHA_ICE_JAM', 'ALASKA']
NAMES = ['GARIBALDI', 'MESABLANCA', 'SNOWDREAM', 'ELYSIUM ALPS', 'ALASKA', 'ALOHA ', 'MEGAPLEX', 'MERQURY']


def literal(data):
    return b''.join(bytes([(1 << len(data[i:i+8])) - 1]) + data[i:i+8] for i in range(0, len(data), 8))


def geometry(crease_height=None, unpaired=False):
    # Two snow triangles, an elevated narrow rail, a keyed sign, a flat quad and hidden collision.
    vertices = [(200, 0, 0), (0, 0, 0), (0, 0, 200), (200, 0, 200),
                (100, 8, 20), (101, 8, 20), (100, 8, 180), (101, 8, 180),
                (180, 20, 30), (200, 20, 30), (200, 40, 30), (180, 40, 30)]
    records = [(2, 0, 1, 2, 3), (3, 2, 3, 0, 3), (4 | 2 << 8, 4, 5, 6, 0x13),
               (4 | 2 << 8, 5, 7, 6, 0x13), (1 | 1 << 8 | 128, 8, 9, 10, 11),
               (5 | 2 << 8, 8, 9, 10, 11), (7, 0, 1, 2, 3), (6, 8, 9, 65535, 65535)]
    if unpaired:
        records[1] = (3, 2, 3, 0, 1)  # Different surface flags prevent the smooth pair merge.
    if crease_height is not None:
        first = len(vertices)
        vertices.extend([(300, 0, 0), (304, 0, 0), (300, 0, 4), (304, crease_height, 4)])
        records.extend([(2, first+1, first, first+2, 3), (3, first+2, first+3, first+1, 3)])
    sections = [(0,) * 10, (0, 0, 0, 0, 0, 130, 0, 30, 0, 0),
                (0, 0, 0, 0, 0, 130, 0, 150, 0, 0), (0, 0, 0, 0, 0, 130, 0, 210, 0, 0)]
    vo = 36 + len(sections) * 20
    po = (vo + len(vertices) * 6 + 3) & ~3
    header = struct.pack('<9I', 0x4754524b, len(sections), len(vertices), len(records), 36, vo, po, len(records) * 10, len(records) * 10)
    result = bytearray(header + b''.join(struct.pack('<10h', *r) for r in sections) + b''.join(struct.pack('<3h', *v) for v in vertices))
    result.extend(bytes(po - len(result)))
    result.extend(b''.join(struct.pack('<5H', *r) for r in records))
    return bytes(result)


def textures():
    pixels = bytes([1, 2] * 512)
    a, b = literal(pixels), literal(bytes([0, 1] * 512))
    palette = [0, 0x7fff, 0x001f] + [0] * 189
    start = 44 + 16 + 384
    return (struct.pack('<11I', 0x54544558, 2, 44, 192, 60, start, 1024, len(a), start + len(a), 1024, len(b)) +
            struct.pack('<I4B', 0, 0, 1, 0, 0) + struct.pack('<I4B', 0, 0, 2, 0, 0) +
            struct.pack('<192H', *palette) + a + b)


def rom(crease_height=None, unpaired=False):
    bodies = [b'\0'] * 215
    for i in range(17, 40):
        bodies[i] = bytes([0, 32, 224, 0])
    for i in range(117, 133, 2):
        bodies[i], bodies[i + 1] = geometry(crease_height, unpaired), textures()
    sky = struct.pack('<256H', 0, 0x7c00, *([0] * 254)) + bytes([0x11] * 8192)
    for i in range(133, 141):
        bodies[i] = struct.pack('<I', 0x01234567) + literal(sky)
    for i in range(142, 209):
        bodies[i] = struct.pack('<I', 1) + bytes([0, 0x11, 0, 0])
    bodies[142] = struct.pack('<I', 2) + bytes([0, 0x18, 0x7f, 0, 0])
    result = bytearray(ARCHIVE + 4 + 215 * 16)
    result[0xa0:0xac] = b'SSX_TRICKY\0\0'
    result[0xac:0xb0] = b'AXYE'
    result[0xb2] = 0x96
    result[0xbd] = (-0x19 - sum(result[0xa0:0xbd])) & 255
    lookup = [0, 2, 3, 1, 7, 6, 5, 4]
    for i, name in enumerate(NAMES):
        result[0x28646+i*16:0x28646+(i+1)*16] = name.encode().ljust(16, b'\0')
    result[0x28b64:0x28b6c] = bytes(lookup)
    result[0x21170:0x21170+920] = bytes([32] * 920)
    for i, (geo, sky) in enumerate(zip([123,119,121,117,125,127,129,131], [133,134,135,137,138,136,139,140])):
        struct.pack_into('<4H', result, 0x28606+i*8, geo, geo+1, sky, 0)
    struct.pack_into('<I', result, ARCHIVE, 215)
    for i, body in enumerate(bodies):
        struct.pack_into('<4I', result, ARCHIVE + 4 + i * 16, 1, len(body), len(result) - ARCHIVE, 0)
        result.extend(body)
    return result


def main():
    executable = sys.argv[1]
    def run(*args, good=True):
        p = subprocess.run([executable, *map(str, args)], capture_output=True, text=True)
        assert (p.returncode == 0) == good, p.stdout + p.stderr
        return p.stdout
    with tempfile.TemporaryDirectory(prefix='openslope-gba-') as work:
        root = Path(work)
        source = root / 'fixture.gba'
        original = rom()
        source.write_bytes(original)
        catalogue = json.loads(run('names', source))
        # The CLI exposes a row array, independent of physical directory order.
        rows = catalogue if isinstance(catalogue, list) else catalogue.get('Courses', catalogue.get('courses'))
        assert [r.get('Course', r.get('name', r.get('Name'))) for r in rows] == ['SSXGBA_' + n for n in IDS], rows
        for name in IDS:
            run('extract', source, 'SSXGBA_' + name, root / 'Maps')
            out = root / 'Maps' / ('SSXGBA_' + name)
            metadata = json.loads((out / 'Import.json').read_text())
            assert metadata['Game'] == 'ssx-tricky-gba' and metadata['MetresPerSourceUnit'] == .1
            assert metadata['Rails']['Splines'] == 1 and metadata['PairedTrianglePatches'] == 1
            patch = json.loads((out / 'Patches.json').read_text())['Patches'][0]
            assert patch['UVPoints'][0] == [.5 / 512, .5 / 33], 'Image-top UVs must sample the first atlas row'
            assert (out / 'Skybox/Textures/gba-horizon.png').is_file()
            assert len(json.loads((out / 'Audio/Music/playlist.json').read_text())) == 10
            graph = json.loads((out / 'Audio/Music/gba_mix_01/graph.json').read_text())
            assert graph['Nodes'][1]['Sample'] == 1, 'Portable music graph samples are one-based'
            with wave.open(str(out / 'Audio/Music/gba_mix_01/chunk_000.wav')) as music:
                assert music.getnframes() == 276, 'Absolute DPCM escapes must consume their payload nibbles'
                assert max(struct.unpack('<276h', music.readframes(276))) > 32000
            with wave.open(str(out / 'Audio/SFX/gba_effects/001.wav')) as audio:
                assert audio.getframerate() == 10512
            if len(sys.argv) > 2:
                subprocess.run([sys.argv[2], str(out), str(source)], check=True)
            run('extract', source, 'SSXGBA_' + name, root / 'Maps', good=False)
        for label, offset, value in [('header', 0xbd, 0), ('lookup', 0x28b64, 9), ('resource', ARCHIVE+12, 0xff)]:
            bad = bytearray(original)
            bad[offset] = value if bad[offset] != value else value ^ 1
            source.write_bytes(bad)
            run('list', source, good=False)
        source.write_bytes(original[:ARCHIVE+50])
        run('list', source, good=False)
        source.write_bytes(original)
        run('extract', source, 'SSXGBA_NOPE', root / 'bad', good=False)
        assert not list((root / 'bad').iterdir())
        for height, pairs in [(1, 2), (2, 1)]:
            source.write_bytes(rom(height))
            target = root / f'crease-{height}'
            run('extract', source, 'SSXGBA_GARIBALDI', target)
            metadata = json.loads((target / 'SSXGBA_GARIBALDI/Import.json').read_text())
            assert metadata['PairedTrianglePatches'] == pairs, '20 degree creases must remain split'
        source.write_bytes(rom(unpaired=True))
        run('extract', source, 'SSXGBA_GARIBALDI', root / 'unpaired')
        extracted = json.loads((root / 'unpaired/SSXGBA_GARIBALDI/Patches.json').read_text())['Patches']
        for patch in extracted:
            cp = patch['Points']
            du = [cp[12][k] + cp[15][k] - cp[0][k] - cp[3][k] for k in range(2)]
            dv = [cp[3][k] + cp[15][k] - cp[0][k] - cp[12][k] for k in range(2)]
            assert du[0]*dv[1] - du[1]*dv[0] >= 0, 'Analytic GBA terrain must face skyward'
        first = extracted[0]
        expected_uv = {(1000, -1000, -200): [31.5/512, .5/33],
                       (-1000, -1000, -200): [.5/512, .5/33],
                       (-1000, 1000, -200): [.5/512, 31.5/33]}
        for control, uv in zip([0, 12, 3, 15], first['UVPoints']):
            assert uv == expected_uv[tuple(first['Points'][control])], 'Winding repair keeps each texture corner attached'
        for label, resource, member_offset, value in [('vertex', 123, None, 65535), ('lzss', 124, 28, 1), ('music', 142, 0, 0xffffffff)]:
            bad = bytearray(original)
            at = ARCHIVE + struct.unpack_from('<I', bad, ARCHIVE + 4 + resource * 16 + 8)[0]
            if label == 'vertex':
                po = struct.unpack_from('<I', bad, at + 24)[0]
                struct.pack_into('<H', bad, at + po + 2, value)
            else:
                struct.pack_into('<I', bad, at + member_offset, value)
            source.write_bytes(bad)
            target = root / label
            run('extract', source, 'SSXGBA_GARIBALDI', target, good=False)
            assert not list(target.iterdir()), 'Malformed source must leave no partial map'
    print('GBA catalogue, corrected names, eight conversions, terrain pairs, rails, media, bounds and cleanup PASS')


if __name__ == '__main__':
    main()
