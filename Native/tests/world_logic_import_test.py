"""Independently authored counted effect frames -> portable Effects document."""
import json
from pathlib import Path
import struct
import sys
import tempfile

from collision_test import members as collision_members
from import_test import big, iso, run


def frame(main, layout='', *values):
    payload = struct.pack('<' + layout, *values)
    return struct.pack('<II', main, 8 + len(payload)) + payload


def members():
    files = collision_members()
    data = bytearray(76)

    def append(payload):
        at = len(data)
        data.extend(payload)
        return at

    slots = append(struct.pack('<14i', -1, 0, -1, -1, -1, -1, -1,
                               -1, 1, -1, -1, -1, -1, -1))
    functions = append(bytes(24))
    chains = append(bytes(4*8))
    base = len(data)
    bodies = [
        [frame(14, 'f', 2), frame(0, 'II', 5, 2)],
        [frame(13, 'f', 0)],
        [frame(4, 'f', .1), frame(8, 'I', 7), frame(99, 'I', 123), frame(14, 'f', 3)],
        [frame(0, 'II18f', 24, 1, *[float(i) for i in range(1, 19)]), frame(24, 'I', 1),
         frame(0, 'II9f', 20, 1, .03, 2., -1.5, .25, -2., 900., 800., 400., 1.)],
    ]
    for index, nodes in enumerate(bodies):
        at = append(b''.join(nodes))
        struct.pack_into('<II', data, chains+index*8, len(nodes), at-base)
    body = append(frame(21, 'I', 0))
    struct.pack_into('<II16s', data, functions, 1, body-base, b'ShowoffMode')
    properties = append(struct.pack('<2f2Hi4h', 0, .5, 0, 1 | 32, -1, 2, -1, 0, 0)
                        + struct.pack('<2f2Hi4h', 0, .5, 0, 32, -1, 2, -1, 1, 0))
    joins = append(struct.pack('<II', 0, 1))
    struct.pack_into('<I', data, 4, 0x00101500)
    for offset, pair in [(12, (2, slots)), (36, (4, chains)), (44, (1, functions)),
                         (52, (2, properties)), (60, (2, joins))]:
        struct.pack_into('<II', data, offset, *pair)
    files['fixture.ssf'] = bytes(data)
    return files


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-logic-import-') as temporary:
        root = Path(temporary)
        source = members()
        image = root/'authored.iso'
        image.write_bytes(iso(big(source)))
        run(executable, 'extract', image, 'FIXTURE', root/'Maps')
        folder = root/'Maps/FIXTURE'
        doc = json.loads((folder/'Effects.json').read_text())
        assert doc['kind'] == 'openslope-effects' and doc['version'] == 1
        assert doc['target']['level'] == 'FIXTURE'
        assert len(doc['graphs']) == 4 and len(doc['functions']) == 1
        assert doc['functions'][0]['name'] == 'ShowoffMode'
        assert doc['functions'][0]['nodes'][0]['references']['function'] == 'function:0'
        assert doc['slots'][0]['circumstances']['collision'] == 'graph:0'
        assert doc['instances'][1]['property'] == 'property:1'
        assert doc['objectProperties'][1]['references']['effectSlot'] == 'slot:1'
        pickup = doc['graphs'][0]['nodes']
        assert pickup[0]['payload']['MultiplierScore'] == 2
        assert pickup[1]['payload']['type0']['DeadNodeMode'] == 2
        assert doc['graphs'][1]['nodes'][0]['mainType'] == 13
        unknown = doc['graphs'][2]['nodes'][2]
        assert unknown['extensions']['nativeWords'] == [99, 12, 123]
        assert doc['graphs'][2]['nodes'][3]['payload']['MultiplierScore'] == 3
        tube = doc['graphs'][3]['nodes'][0]['payload']['type0']['type0Sub24']
        thrown = doc['graphs'][3]['nodes'][2]['payload']['type0']['type0Sub20']
        assert [thrown[f'U{i}'] for i in range(3,6)] == [-1.5,.25,-2.], 'mesh-throw direction is three float values'
        assert tube == {'U0': 1, **{f'U{i}': float(i) for i in range(1, 19)}}
        teleport = doc['graphs'][3]['nodes'][1]
        assert teleport['payload']['TeleportInstanceIndex'] == 1
        assert teleport['references']['instance'] == 'instance:1'
        assert 'Effects.json' in json.loads((folder/'Import.json').read_text())['Outputs']
        # Byte-size framing must fail before publishing a malformed course.
        bad = bytearray(source['fixture.ssf'])
        chain_table, = struct.unpack_from('<I', bad, 40)
        relative, = struct.unpack_from('<I', bad, chain_table+4)
        struct.pack_into('<I', bad, chain_table+4*8+relative+4, 4)
        source['fixture.ssf'] = bytes(bad)
        image.write_bytes(iso(big(source)))
        run(executable, 'extract', image, 'FIXTURE', root/'BadMaps', succeeds=False)
        assert not (root/'BadMaps/FIXTURE').exists()
    print('PASS: portable logic import preserves chain-relative frames, joins, unknown nodes and rejects malformed sizes')


if __name__ == '__main__':
    main()
