"""Authored AXYE-format ROM fixtures. Contains no retail program or media."""
from pathlib import Path
import json
import math
import struct
import subprocess
import sys
import tempfile
import wave
from import_test import png_pixels

ARCHIVE = 0x2905c
IDS = ['GARIBALDI', 'SNOWDREAM', 'ELYSIUM_ALPS', 'MESABLANCA', 'MERQURY_CITY', 'TOKYO_MEGAPLEX', 'ALOHA_ICE_JAM', 'ALASKA']
NAMES = ['GARIBALDI', 'MESABLANCA', 'SNOWDREAM', 'ELYSIUM ALPS', 'ALASKA', 'ALOHA ', 'MEGAPLEX', 'MERQURY']


def literal(data):
    return b''.join(bytes([(1 << len(data[i:i+8])) - 1]) + data[i:i+8] for i in range(0, len(data), 8))


def geometry(crease_height=None, unpaired=False, distant=False, separate=False, long_structure=False,
             hill_height=None, hill_seam=False, hill_split=False):
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
    if distant:
        first = len(vertices)
        vertices.extend([(4000, 0, 0), (4200, 0, 0), (4200, 100, 0), (4000, 100, 0)])
        records.extend([(0, first, first+1, first+2, first+3), (7, first, first+1, first+2, 3)])
    if separate:
        first = len(vertices)
        vertices.extend([(230, 20, 30), (250, 20, 30), (250, 40, 30), (230, 40, 30)])
        records.extend([(1 | 1 << 8 | 128, first, first+1, first+2, first+3),
                        (7, first, first+1, first+2, 3)])
    if long_structure:
        first = len(vertices)
        for x in range(1000, 4500, 500):
            vertices.extend([(x, 0, 300), (x, 100, 300)])
        for i in range(6):
            a = first + i * 2
            records.append((0, a, a+2, a+3, a+1))
    if hill_height is not None:
        first = len(vertices)
        vertices.extend([(300, 0, 300), (500, hill_height, 300), (300, 0, 500),
                         (500, hill_height, 500), (700, 0, 300), (700, 0, 500)])
        tris = [(first+1, first, first+2), (first+2, first+3, first+1),
                (first+4, first+1, first+3), (first+3, first+5, first+4)]
        for i, ids in enumerate(tris):
            tag = (4 | (1 if i < 2 else 2) << 8) if hill_seam else (2 if i % 2 == 0 else 3)
            records.append((tag, *ids, 4 if hill_split and i == 3 else 3))
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
    palette = [0x03e0, 0x7fff, 0x001f] + [0] * 189
    start = 44 + 16 + 384
    return (struct.pack('<11I', 0x54544558, 2, 44, 192, 60, start, 1024, len(a), start + len(a), 1024, len(b)) +
            struct.pack('<I4B', 0, 0, 1, 0, 0) + struct.pack('<I4B', 0, 0, 2, 0, 0) +
            struct.pack('<192H', *palette) + a + b)


def rom(crease_height=None, unpaired=False, distant=False, separate=False, long_structure=False,
        hill_height=None, hill_seam=False, hill_split=False):
    bodies = [b'\0'] * 215
    for i in range(17, 40):
        bodies[i] = bytes([0, 32, 224, 0])
    for i in range(117, 133, 2):
        bodies[i], bodies[i + 1] = geometry(crease_height, unpaired, distant, separate, long_structure,
                                          hill_height, hill_seam, hill_split), textures()
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
            assert metadata['Game'] == 'ssx-tricky-gba' and metadata['MetresPerSourceUnit'] == .15625
            assert metadata['Rails']['Splines'] == 1 and metadata['PairedTrianglePatches'] == 1
            assert math.isclose(metadata['Rails']['LengthMetres'], 25), 'Rail geometry uses the enlarged course scale'
            assert metadata['FlatColourQuadPatches'] == 1 and metadata['UnpairedTrianglePatches'] == 0
            assert metadata['TerrainPatches'] == 2
            terrain = json.loads((out / 'Patches.json').read_text())['Patches']
            assert sorted(record for p in terrain for record in p['SourceRecords']) == [0, 1, 2, 3]
            assert all(len(p['SourceRecords']) == 2 for p in terrain), 'Two source triangles produce one patch'
            assert all(len({tuple(p['Points'][i]) for i in (0, 12, 3, 15)}) == 4 for p in terrain)
            patch = json.loads((out / 'Patches.json').read_text())['Patches'][0]
            assert all(math.isclose(max(p[k] for p in patch['Points'])-min(p[k] for p in patch['Points']), 3125) for k in (0, 1)), 'A 200-unit source square spans 31.25 metres in both terrain axes'
            assert patch['UVPoints'][0] == [1.5 / 512, 1.5 / 64], 'Image-top UVs must sample inside the first tile gutter'
            opaque_path = out / 'Textures/gba-opaque.png'
            assert struct.unpack_from('>II', opaque_path.read_bytes(), 16) == (512, 64)
            opaque = png_pixels(opaque_path)
            keyed = png_pixels(out / 'Textures/gba-keyed.png')
            start = (512 + 1) * 4
            assert opaque[start:start + 8] == bytes([255, 255, 255, 255, 255, 0, 0, 255]), 'Atlas tiles retain source texels'
            palette_row = 63 * 512 * 4
            assert opaque[palette_row:palette_row + 12] == bytes([0, 255, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255])
            transparent = (512 + 35) * 4
            assert keyed[transparent:transparent + 4] == bytes([255, 255, 255, 0]), 'Transparent RGB follows the visible edge rather than the green key'
            assert opaque[transparent:transparent + 4] == bytes([0, 255, 0, 255]), 'Visible source green remains unchanged'
            for y in range(1, 33):
                assert [keyed[(y * 512 + x) * 4 + 3] for x in range(35, 67)] == [0, 255] * 16, 'RGB repair preserves every alpha value'
            assert opaque[(512 + 33) * 4:(512 + 34) * 4] == bytes([255, 0, 0, 255]), 'Right gutter repeats its own tile edge'
            assert keyed[(512 + 34) * 4:(512 + 35) * 4] == bytes([255, 255, 255, 0]), 'Neighbouring cutout gutter keeps the repaired RGB and alpha'
            assert keyed[palette_row:palette_row + 12] == opaque[palette_row:palette_row + 12], 'Flat palette colours remain opaque in both banks'
            palette_patch = json.loads((out / 'Patches.json').read_text())['Patches'][1]
            assert all(uv == [2.5 / 512, 63.5 / 64] for uv in palette_patch['UVPoints']), 'Solid faces sample the isolated palette row'
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
        assert len(extracted) == 3 and len({p['PatchName'] for p in extracted}) == 3
        assert sorted(record for p in extracted for record in p.get('SourceRecords', [p['SourceRecord']])) == [0, 1, 2, 3]
        for patch in extracted:
            cp = patch['Points']
            du = [cp[12][k] + cp[15][k] - cp[0][k] - cp[3][k] for k in range(2)]
            dv = [cp[3][k] + cp[15][k] - cp[0][k] - cp[12][k] for k in range(2)]
            assert du[0]*dv[1] - du[1]*dv[0] >= 0, 'Analytic GBA terrain must face skyward'
            assert len({tuple(cp[k]) for k in (0, 12, 3, 15)}) == (4 if 'SourceRecords' in patch else 3), 'Unmatched faces stay single triangular patches'
        for patch in (p for p in extracted if p['SourceRecord'] == 0):
            for control, uv in zip([0, 12, 3, 15], patch['UVPoints']):
                x, y, _ = patch['Points'][control]
                a, c = (x+1562.5)/3125, (y+1562.5)/3125
                expected = [(1.5+31*a)/512, (1.5+31*c)/64]
                assert all(math.isclose(v, w, abs_tol=1e-12) for v, w in zip(uv, expected)), 'Unmatched patches retain source texture mapping'
        # Solid-colour pairing must respect source seams, sharp creases and concave boundaries.
        for label in ('flat-crease', 'flat-material', 'flat-flags', 'flat-trapezoid', 'flat-concave'):
            changed = bytearray(original)
            at = ARCHIVE + struct.unpack_from('<I', changed, ARCHIVE+4+123*16+8)[0]
            vo, po = struct.unpack_from('<2I', changed, at+20)
            if label == 'flat-crease':
                struct.pack_into('<h', changed, at+vo+7*6+2, 9)
            elif label == 'flat-material':
                struct.pack_into('<H', changed, at+po+3*10, 4 | 1 << 8)
            elif label in ('flat-trapezoid', 'flat-concave'):
                struct.pack_into('<h', changed, at+vo+7*6, 102 if label == 'flat-trapezoid' else 99)
            else:
                struct.pack_into('<H', changed, at+po+3*10+8, 0x12)
            source.write_bytes(changed)
            run('extract', source, 'SSXGBA_GARIBALDI', root / label)
            metadata = json.loads((root / label / 'SSXGBA_GARIBALDI/Import.json').read_text())
            paired = label == 'flat-trapezoid'
            assert metadata['FlatColourQuadPatches'] == int(paired) and metadata['UnpairedTrianglePatches'] == (0 if paired else 2), label
            assert metadata['QuadSplitTriangles'] == 0, label
            if paired:
                quad = json.loads((root / label / 'SSXGBA_GARIBALDI/Patches.json').read_text())['Patches'][1]
                q = [quad['Points'][i] for i in (0, 12, 15, 3)]
                area = abs(sum(q[i][0]*q[(i+1)%4][1]-q[(i+1)%4][0]*q[i][1] for i in range(4))) / 2
                assert math.isclose(area, 58593.75, abs_tol=1e-6), 'Non-parallelogram flat quads preserve the enlarged source surface'
        for label in ('textured-trapezoid', 'duplicate-vertices', 'mixed-winding', 'uv-seam'):
            changed = bytearray(original)
            at = ARCHIVE + struct.unpack_from('<I', changed, ARCHIVE+4+123*16+8)[0]
            vo, po = struct.unpack_from('<2I', changed, at+20)
            if label == 'textured-trapezoid':
                struct.pack_into('<h', changed, at+vo+3*6, 230)
            elif label == 'duplicate-vertices':
                for target, old in ((8, 2), (9, 0)):
                    changed[at+vo+target*6:at+vo+(target+1)*6] = changed[at+vo+old*6:at+vo+(old+1)*6]
                struct.pack_into('<3H', changed, at+po+10+2, 8, 3, 9)
            elif label == 'mixed-winding':
                struct.pack_into('<3H', changed, at+po+3*10+2, 6, 7, 5)
            else:
                struct.pack_into('<H', changed, at+po+10, 2)
            source.write_bytes(changed)
            run('extract', source, 'SSXGBA_GARIBALDI', root / label)
            local = root / label / 'SSXGBA_GARIBALDI'
            metadata = json.loads((local / 'Import.json').read_text())
            assert metadata['TerrainPatches'] == (3 if label == 'uv-seam' else 2), label
            assert metadata['UnpairedTrianglePatches'] == (2 if label == 'uv-seam' else 0), label
            assert metadata['QuadSplitTriangles'] == 0, label
            patches = json.loads((local / 'Patches.json').read_text())['Patches']
            ids = sorted(record for p in patches for record in p.get('SourceRecords', [p['SourceRecord']]))
            assert ids == [0, 1, 2, 3], 'Every source triangle is represented exactly once'
        source.write_bytes(rom(distant=True))
        run('extract', source, 'SSXGBA_GARIBALDI', root / 'distant')
        local = root / 'distant/SSXGBA_GARIBALDI'
        models = json.loads((local / 'Models.json').read_text())['Models']
        instances = json.loads((local / 'Instances.json').read_text())['Instances']
        assert max(i['Location'][0] for i in instances) - min(i['Location'][0] for i in instances) >= 30000
        visible_faces = collision_faces = 0
        for instance in instances:
            vertices = []
            model = models[instance['ModelID']]
            for obj in model['ModelObjects']:
                for mesh in obj['MeshData']:
                    rows = (local / 'Meshes' / mesh['MeshPath']).read_text().splitlines()
                    vertices.extend(tuple(map(float, row.split()[1:4])) for row in rows if row.startswith('v '))
                    if instance['Visable']:
                        visible_faces += sum(row.startswith('f ') for row in rows)
            assert all(max(p[a] for p in vertices) - min(p[a] for p in vertices) <= 12000 for a in (0, 1)), 'Scenery bounds stay local to the spatial query'
            for name in instance['CollsionModelPaths']:
                collision_faces += sum(row.startswith('f ') for row in (local / 'Collision' / name).read_text().splitlines())
            assert instance['PlayerCollision'] == bool(instance['CollsionModelPaths'])
        assert visible_faces == 6, 'Partitioning preserves every source scenery triangle exactly once'
        assert collision_faces == 2, 'Local collision pieces preserve both source colliders'
        source.write_bytes(rom(separate=True))
        run('extract', source, 'SSXGBA_GARIBALDI', root / 'separate')
        local = root / 'separate/SSXGBA_GARIBALDI'
        models = json.loads((local / 'Models.json').read_text())['Models']
        visible = [i for i in json.loads((local / 'Instances.json').read_text())['Instances'] if i['Visable']]
        assert len(visible) == 2, 'Nearby disconnected objects become separate placeable props'
        assert len({i['ModelID'] for i in visible}) == 2
        assert max(i['Location'][0] for i in visible) - min(i['Location'][0] for i in visible) < 1000
        assert sorted(len(models[i['ModelID']]['ModelObjects'][0]['MeshData']) for i in visible) == [1, 2], 'Material seams stay within their connected prop'
        colliding = [i for i in visible if i['PlayerCollision']]
        assert len(colliding) == 1 and len(colliding[0]['CollsionModelPaths']) == 1, 'Matching hidden collision moves with its visible object'
        for instance in visible:
            points = []
            for mesh in models[instance['ModelID']]['ModelObjects'][0]['MeshData']:
                points.extend(tuple(map(float, row.split()[1:4])) for row in (local / 'Meshes' / mesh['MeshPath']).read_text().splitlines() if row.startswith('v '))
            assert min(p[2] for p in points) == 0, 'Each prop pivot sits at its base'
            for axis in (0, 1):
                assert abs(min(p[axis] for p in points) + max(p[axis] for p in points)) < 1e-6, 'Prop pivots are centred horizontally'
        source.write_bytes(rom(long_structure=True))
        run('extract', source, 'SSXGBA_GARIBALDI', root / 'long')
        local = root / 'long/SSXGBA_GARIBALDI'
        models = json.loads((local / 'Models.json').read_text())['Models']
        instances = json.loads((local / 'Instances.json').read_text())['Instances']
        pieces = [i for i in instances if ' part ' in i['InstanceName']]
        assert len(pieces) >= 3, 'Long connected structures retain local visibility bounds'
        faces = 0
        for instance in pieces:
            points = []
            for mesh in models[instance['ModelID']]['ModelObjects'][0]['MeshData']:
                rows = (local / 'Meshes' / mesh['MeshPath']).read_text().splitlines()
                points.extend(tuple(map(float, row.split()[1:4])) for row in rows if row.startswith('v '))
                faces += sum(row.startswith('f ') for row in rows)
            # Whole source panels can cross the 100-metre cell boundary; these are now 78.125 metres wide.
            assert max(p[0] for p in points) - min(p[0] for p in points) <= 10000 + 7812.5
        assert faces == 12, 'Splitting a long structure preserves its triangles exactly once'
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
