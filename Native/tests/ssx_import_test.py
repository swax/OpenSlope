"""Independently authored SSX cells -> shared maps, through ISO and raw BIN inputs."""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import tempfile
from import_test import big, course_members, iso, le, run, ssh
from prop_import_test import packet


def raw_disc(image):
    result = bytearray()
    for p in range(0, len(image), 2048):
        # Mode 2 Form 1: sync, address/mode, duplicated subheader, data, parity.
        result += b'\0' + b'\xff' * 10 + b'\0' + b'\0\0\0\2' + b'\0' * 8
        result += image[p:p + 2048] + bytes(280)
    return result


def members():
    transfer = packet()
    model = bytearray(128) + transfer
    struct.pack_into('<III', model, 0, 1, 0, len(model))
    struct.pack_into('<3f', model, 16, 100, 100, 100)
    struct.pack_into('<I', model, 36, 48)
    struct.pack_into('<6f', model, 48, -50, -50, -50, 50, 50, 50)
    struct.pack_into('<I', model, 48 + 44, len(transfer))
    placement = bytearray(272)
    matrix = struct.pack('<16f', 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 2000, 3000, 1)
    placement[:64] = matrix
    placement[64:128] = matrix
    struct.pack_into('<4f', placement, 176, 64, 64, 64, 128)
    struct.pack_into('<Hfhhhhfhh', placement, 234, 1, 0, 0, -1, -1, -1, .5, 0, 5)
    patch = bytearray(course_members()['fixture.pbd'][136:])
    struct.pack_into('<4I', patch, 432, 0, 0, 5, 0xffffffff)
    cell = bytearray(48 + 16 * 48)
    struct.pack_into('<6H', cell, 36, 1, 1, 1, 0, 0, 65535)
    cell += placement + patch
    light = bytearray(88)
    struct.pack_into('<I2f', light, 0, 1, 9.5, 0)
    struct.pack_into('<3f', light, 12, 1, .5, .25)
    struct.pack_into('<3f', light, 24, 0, 0, -1)
    struct.pack_into('<3f', light, 36, 1000, 2000, 3000)
    struct.pack_into('<f', light, 72, .6875)
    cell += light
    index = bytearray(72)
    struct.pack_into('<ffI', index, 0, 9.71, .03, 11)
    struct.pack_into('<7I', index, 36, 10000, 1, 1, 1, 1, 0, 0)
    index += struct.pack('<4I', 0, len(model), 0, len(cell))
    index += struct.pack('<IhhI', 64, 0, -1, 0x80808080)
    path = struct.pack('<3I8I', 1, 1, 0, *([0] * 8))
    for _ in range(2):
        path += struct.pack('<fII9f', 100, 1, 1, *([0.] * 9))
        path += struct.pack('<4f', 1, 0, -.1, 100)
        path += struct.pack('<IIff', 9, 1, 0, 100)
    effects = bytearray(struct.pack('<ff8I', 1.01, .0003, 1, 40, 0, 68, 0, 68, 1, 68))
    effects += struct.pack('<7i', 0, -1, -1, -1, -1, -1, -1)
    effects += struct.pack('<2IHHI', 1, 0, 0, 8, 5)
    return {'world.wdx': bytes(index), 'world.wdf': bytes(cell), 'world.wdr': bytes(model),
            'world.wfx': bytes(effects), 'world.aip': path, 'world.ssh': ssh(), 'worldl.ssh': ssh(True)}


def gem_members(tier=2):
    files = members()
    original = files['world.wdr']
    # Move the object away from its usual offset: animation offsets are object-relative.
    object_at = 80
    model = bytearray(160) + original[128:]
    model[:48] = original[:48]
    model[object_at:object_at + 80] = original[48:128]
    struct.pack_into('<I', model, 36, object_at)
    model += bytes(-len(model) % 16)
    packet_at = len(model)
    block = bytearray(48 + 96 + 96)
    struct.pack_into('<16f', block, 48, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
    struct.pack_into('<II', block, 48 + 64, (2 << 16) | (1 << 0) | (1 << 4), 80)
    # Two tightly packed count/offset rows, then separately padded curve keys.
    struct.pack_into('<4I', block, 48 + 80, 1, 96, 2, 128)
    struct.pack_into('<6f', block, 48 + 96, 0, 0, .25, 0, 0, 60)
    # A half-turn over 60 source frames, in radians per frame.
    struct.pack_into('<6f', block, 48 + 128, 0, 0, 0, 0, 0, 1)
    struct.pack_into('<6f', block, 48 + 160, 0, 0, math.pi / 60, 0, 1, 60)
    model += block
    struct.pack_into('<If', model, 8, len(model), 60)
    struct.pack_into('<I', model, object_at + 28, packet_at + 48 - object_at)
    files['world.wdr'] = bytes(model)
    index = bytearray(files['world.wdx'])
    struct.pack_into('<I', index, 76, len(model))
    files['world.wdx'] = bytes(index)
    cell = bytearray(files['world.wdf'])
    struct.pack_into('<H', cell, 48 + 16 * 48 + 234, 33)
    struct.pack_into('<h', cell, 48 + 16 * 48 + 240, 2)
    files['world.wdf'] = bytes(cell)
    play = struct.pack('<HHII5fI', 0, 36, 256, (3 << 16) | 1, -1, -1, 1, 0, -1, 0)
    pickup = struct.pack('<HHfHHII', 13, 8, tier, 0, 12, 5, 2)
    header = struct.pack('<ff8I', 1.01, .0003, 1, 40, 0, 68, 0, 68, 2, 68)
    slots = struct.pack('<7i', 0, 1, -1, -1, -1, -1, -1)
    files['world.wfx'] = header + slots + struct.pack('<4I', 1, 0, 2, len(play)) + play + pickup
    return files


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-ssx-') as temporary:
        root = Path(temporary)
        files = members()
        image = iso(big(files, compact=False))
        for extension, data in [('iso', image), ('bin', raw_disc(image))]:
            source = root / ('SSX fixture.' + extension)
            source.write_bytes(data)
            digest = hashlib.sha256(data).digest()
            assert run(executable, 'list', source).startswith('SSX_FIXTURE\t')
            maps = root / extension
            run(executable, 'extract', source, 'SSX_FIXTURE', maps)
            course = maps / 'SSX_FIXTURE'
            patch = json.loads((course / 'Patches.json').read_text())['Patches'][0]
            assert patch['SurfaceType'] == 5 and patch['LightmapID'] == 0
            assert patch['Points'][0] == [1000, 2000, 3000]
            assert patch['TexturePath'] == '0000.png' and not patch['TrickOnlyPatch']
            instance = json.loads((course / 'Instances.json').read_text())['Instances'][0]
            assert instance['Location'] == [1000, 2000, 3000] and instance['Visable']
            assert instance['EffectSlotIndex'] == 0 and instance['SurfaceType'] == 5
            light = json.loads((course / 'Lights.json').read_text())['Lights'][0]
            assert light['Type'] == 1 and light['OuterConeCosine'] == light['UnknownFloat2'] == .6875
            assert (course / 'Meshes/0.obj').read_text().count('\nf ') == 2
            assert (course / 'Textures/0000.png').is_file() and (course / 'Lightmaps/0000.png').is_file()
            paths = json.loads((course / 'AIP.json').read_text())
            assert len(paths['StartPosList']) == 8 and len(paths['AIPaths']) == len(paths['RaceLines']) == 1
            assert all(math.isclose(a, b, abs_tol=1e-6) for a, b in zip(paths['AIPaths'][0]['PathPoints'][0], [100, 0, -10]))
            effects = json.loads((course / 'Effects.json').read_text())
            assert effects['graphs'][0]['nodes'] == []
            assert effects['graphs'][0]['extensions']['ssxUnresolvedNodes'][0]['nativeWords'] == [0x80000, 5]
            assert effects['objectProperties'][0]['references']['effectSlot'] == 'slot:0'
            assert json.loads((course / 'Origin.json').read_text())['RetailData']
            assert 'effects-node-semantics' in json.loads((course / 'Import.json').read_text())['Deferred']
            run(executable, 'extract', source, 'SSX_FIXTURE', maps, succeeds=False)
            assert hashlib.sha256(source.read_bytes()).digest() == digest
            # Identical shared contracts regardless of physical sector framing.
            if extension == 'bin':
                for name in ['Patches.json', 'Instances.json', 'Models.json', 'Lights.json', 'Effects.json']:
                    assert (course / name).read_bytes() == (root / 'iso/SSX_FIXTURE' / name).read_bytes()
        for name, member, offset, replacement in [
            ('version', 'world.wdx', 8, le(12)),
            ('grid', 'world.wdx', 40, le(0xffffffff)),
            ('cell', 'world.wdx', 84, le(0xffffffff)),
            ('texture', 'world.wdf', 816 + 272 + 432, le(12)),
            ('lightmap', 'world.wdf', 816 + 272 + 436, le(12)),
            ('material', 'world.wdr', 84, le(12)),
            ('start', 'world.aip', 12, le(12)),
            ('effects', 'world.wfx', 76 + 2, struct.pack('<H', 3)),
            ('cone', 'world.wdf', 816 + 272 + 448 + 72, struct.pack('<f', 2)),
        ]:
            broken = files.copy()
            payload = bytearray(broken[member]); payload[offset:offset + len(replacement)] = replacement
            broken[member] = bytes(payload)
            source = root / (name + '.iso'); source.write_bytes(iso(big(broken)))
            destination = root / name
            run(executable, 'extract', source, 'SSX_FIXTURE', destination, succeeds=False)
            assert not list(destination.iterdir()), 'Failed SSX import published partial files'
        damaged = raw_disc(image)
        damaged[16 * 2352 + 18] = 0x20
        source = root / 'form2.bin'; source.write_bytes(damaged)
        run(executable, 'list', source, succeeds=False)
        fallback = files.copy()
        world = bytearray(fallback['world.wdf'])
        struct.pack_into('<f', world, 816 + 80, float('nan'))
        struct.pack_into('<h', world, 816 + 240, -1)
        fallback['world.wdf'] = bytes(world)
        source = root / 'source-fallback.iso'; source.write_bytes(iso(big(fallback)))
        run(executable, 'extract', source, 'SSX_FIXTURE', root / 'fallback')
        output = root / 'fallback/SSX_FIXTURE'
        assert json.loads((output / 'Import.json').read_text())['Warnings']
        instance = json.loads((output / 'Instances.json').read_text())['Instances'][0]
        assert instance['CollsionMode'] == 0 and instance['AmbentLightColour'] == [128] * 4
        assert (output / 'Source/WORLD.WDF').read_bytes() == bytes(world)
    print('PASS: SSX ISO/BIN parity, shared map output, provenance, unresolved effects, malformed data and atomic failure')


if __name__ == '__main__':
    main()
