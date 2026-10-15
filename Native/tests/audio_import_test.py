"""Authored ISO -> playable Audio assets and variable-stride instance bindings."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import wave
from import_test import record, both, big, run, ssh, png_pixels, crowd_bank
from prop_import_test import members
from audio_container_test import bank, stream


def archive(files):
    # This helper retains exact member names; the terrain fixture's archive
    # helper separately exercises compressed, path-qualified course members.
    start = 16 + sum(9 + len(name.encode()) for name in files)
    result = bytearray(b'BIGF' + struct.pack('>3I', start + sum(map(len, files.values())), len(files), start))
    offset = start
    for name, data in files.items():
        result += struct.pack('>2I', offset, len(data)) + name.encode() + b'\0'
        offset += len(data)
    for data in files.values():
        result += data
    return bytes(result)


def disc(files):
    tree = {}
    for path, data in files.items():
        node = tree
        parts = path.split('/')
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = data
    allocation, cursor = {}, 24

    def allocate(path, node):
        nonlocal cursor
        size = 2048 if isinstance(node, dict) else len(node)
        allocation[path] = (cursor, size)
        cursor += max(1, (size + 2047) // 2048)
        if isinstance(node, dict):
            for name, child in node.items():
                allocate(path + '/' + name, child)
    allocate('', tree)
    data = bytearray(cursor * 2048)
    data[16 * 2048:16 * 2048 + 7] = b'\x01CD001\x01'
    data[16 * 2048 + 80:16 * 2048 + 88] = both(cursor)
    data[16 * 2048 + 128:16 * 2048 + 132] = b'\x00\x08\x08\x00'
    data[16 * 2048 + 156:16 * 2048 + 190] = record(b'\0', 24, 2048, True)
    data[17 * 2048:17 * 2048 + 7] = b'\xffCD001\x01'

    def emit(path, node):
        sector, size = allocation[path]
        if isinstance(node, dict):
            payload = record(b'\0', sector, size, True) + record(b'\1', 24, 2048, True)
            for name, child in node.items():
                location, length = allocation[path + '/' + name]
                payload += record(name if isinstance(child, dict) else name + ';1', location, length, isinstance(child, dict))
            assert len(payload) <= 2048
            for name, child in node.items():
                emit(path + '/' + name, child)
        else:
            payload = node
        data[sector * 2048:sector * 2048 + len(payload)] = payload
    emit('', tree)
    return data


def graph():
    data = bytearray(96)
    data[:6] = b'xDFP\x03\x01'
    struct.pack_into('<5BH', data, 13, 1, 1, 1, 1, 0, 2)
    struct.pack_into('<2H', data, 36, 10, 14)
    for offset, sample in [(40, 0), (56, 1)]:
        struct.pack_into('<hBB4B4B', data, offset, sample, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1)
        struct.pack_into('<BBH', data, offset + 12, 0, 127, 1)
    struct.pack_into('<I', data, 76, (1 << 16) | 1)
    struct.pack_into('<I', data, 80, 21)
    struct.pack_into('<2I', data, 88, 0, 4)
    return bytes(data)


def particle_bank():
    image = ssh()[32:]
    size = 48 + len(image) * 3
    return b'SHPS' + struct.pack('<II', size, 3) + b'TESTpart' + struct.pack('<I', 48) + b'tral' + struct.pack('<I', 48 + len(image)) + b'spry' + struct.pack('<I', 48 + len(image) * 2) + bytes(8) + image * 3


def fixture(course=None):
    course = dict(members() if course is None else course)
    text = course['fixture.map'].decode()
    for uid, name, hash_value in [(0, 'Visible prop', '123456'), (1, 'Hidden volume', 'abcdef')]:
        text = text.replace(name.ljust(82) + '0\n', name.ljust(82) + str(uid).ljust(10) + '0'.ljust(10) + hash_value.ljust(10) + '\n')
    course['fixture.map'] = text.encode()
    # Shared record tests deduplication; all four emitter shapes exercise strides.
    adl = bytearray(struct.pack('<IfI4I', 0, 1., 2, 0x123456, 28, 0xabcdef, 28))
    adl[1:4] = b'\xcc' * 3  # Padding is not a second signature/version field.
    adl += struct.pack('<2I', 17, 5)
    for kind, event, fields in [(0, 115, [1, 2, 3, 4000, 2]), (1, 97, [4, 5, 6, 2000, 3000, 4000, 0, 0, 1, 2]), (2, 68, [0, 0, 0, 6000, 0, 0, 1, 1, .5, 2]), (3, 102, [0, 0, 0, 3000]), (0, 16, [0, 0, 0, 1000, 2])]:
        adl += struct.pack('<2I', kind, event) + struct.pack('<' + 'f' * len(fields), *fields)
    course['fixture.adl'] = bytes(adl)
    return {
        'DATA/MODELS/FIXTURE.BIG': big(course),
        'DATA/CONFIG/BANKS.INF': b'[FIXTURE LONG]\nMAIN="tone.bnk"\nBOARD="tone.bnk"\nBANK="tone.bnk"\nCROWD="tone.bnk"\nSWAP="unused.bnk"\n',
        'DATA/CONFIG/SNOW.INF': b'[PACK]\nLoadBoard AssignVol\n',
        'DATA/CONFIG/MUSIC.INF': b'[Authored song]\nPATHDATA="song.mpf"\nMUSDATA="song.mus"\nLOOPDATA="loop.bnk"\nBPM=100\nPATHLEVEL=65\nEIGHTH\n',
        'DATA/CONFIG/MUSICMAP.INF': b'[FIXTURE LONG]\nSONG="Authored"\n[TRICK]\nSONG="Authored"\n',
        'DATA/CONFIG/INTROMUS.INF': b'[FIXTURE]\nSONG="intro.big"\n',
        'DATA/AUDIO/AUDIO.BIG': archive({'tone.bnk': bank(), 'Coyote.bnk': bank()}),
        'DATA/AUDIO/MUSIC.BIG': archive({'song.mpf': graph(), 'song.mus': stream(), 'loop.bnk': bank()}),
        'DATA/AUDIO/INTRO.BIG': archive({'Quiet-A': stream(), 'end': stream()}),
        'DATA/TEXTURES/PARTICLE.SSH': particle_bank(),
        'DATA/TEXTURES/CROWD.SSH': crowd_bank(),
    }


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-audio-import-') as temporary:
        root = Path(temporary)
        image = root / 'test.iso'
        image.write_bytes(disc(fixture()))
        run(executable, 'extract', image, 'FIXTURE', root / 'Maps')
        output = root / 'Maps/FIXTURE'
        audio = output / 'Audio'
        profile = json.loads((output / 'RidingEffects.json').read_text())
        assert profile['Puff'] == 'particle-part.png'
        assert len(profile['EmitterSprites']) == 38
        assert profile['EmitterSprites'][0] == 'particle-part.png'
        assert profile['EmitterSprites'][3] == 'particle-spry.png'
        assert profile['EmitterSprites'][23] == 'particle-tral.png'
        assert json.loads((output / 'RidingEffects.json').read_text())['Wake'] == 'particle-tral.png'
        assert (output / 'Textures/particle-tral.png').exists()
        assert json.loads((output / 'RidingEffects.json').read_text())['Sheet'] == 'particle-spry.png'
        assert (output / 'Textures/particle-spry.png').exists()
        assert (output / 'Textures/particle-part.png').exists()
        assert png_pixels(output / 'Textures/particle-part.png') == bytes([10,20,30,255,128,128,128,255,200,50,0,128,0,0,0,0]), 'Full-bright particle art uses its own colour profile'
        index = json.loads((audio / 'SoundIndex.json').read_text())
        assert index['Banks'] == {'0': 'tone', '1': 'tone', '2': 'tone', '3': 'tone'}
        assert index['CollisionEvents'] == {} and index['ResolverState'] == 'Deferred'
        assert sorted(p.name for p in (audio / 'SFX').iterdir()) == ['Coyote', 'tone']
        bindings = json.loads((output / 'Instances.json').read_text())['Instances']
        assert [r['Hash'] for r in bindings] == [0x123456, 0xabcdef]
        assert all(r['IncludeSound'] for r in bindings)
        assert bindings[0]['Sounds'] == bindings[1]['Sounds']
        assert [s['U0'] for s in bindings[0]['Sounds']['ExternalSounds']] == [0, 1, 2, 3, 0]
        routes = json.loads((audio / 'ExternalIndex.json').read_text())
        assert routes['Events']['115']['Clip'] == 'Audio/SFX/Coyote/000.wav'
        assert routes['Events']['97']['Clip'] == 'Audio/SFX/tone/000.wav'
        assert routes['Unresolved'] == [16, 68, 102]
        assert json.loads((audio / 'Music/playlist.json').read_text()) == ['song']
        info = json.loads((audio / 'Music/song/graph.json').read_text())
        assert info['Volume'] == .65 and info['Bpm'] == 100
        assert (audio / 'Music/song/loops/loop/000.loop.wav').exists()
        assert len(json.loads((audio / 'Intro/stems.json').read_text())) == 2
        with wave.open(str(audio / 'Music/song/chunk_000.wav')) as wav:
            assert wav.getnchannels() == 2 and wav.getnframes() == 28
        associated = fixture()
        associated['DATA/TEXTURES/PARTICLE.SSH'] = ssh(palette_override=bytes([15,15,15,16,200,200,200,220,0,0,0,0,250,250,250,255])).replace(b'TEST0000', b'TESTpart')
        image.write_bytes(disc(associated));run(executable, 'extract', image, 'FIXTURE', root / 'associated')
        assert png_pixels(root / 'associated/FIXTURE/Textures/particle-part.png') == bytes([239,239,239,16,232,232,232,220,0,0,0,0,250,250,250,255]), 'Associated full-range particle colour becomes straight alpha without a second brighten'
        # Audio errors must roll back the entire course, including terrain/props.
        for name, mutate in [
            ('ambiguous', lambda f: f.update({'DATA/CONFIG/BANKS.INF': f['DATA/CONFIG/BANKS.INF'] + b'[FIXTURE OTHER]\nBANK="tone.bnk"\n'})),
            ('missing-bank', lambda f: f.update({'DATA/AUDIO/AUDIO.BIG': archive({'Coyote.bnk': bank()})})),
            ('bad-graph', lambda f: f.update({'DATA/AUDIO/MUSIC.BIG': archive({'song.mpf': b'wrong', 'song.mus': stream()})})),
            ('bad-adl', lambda f: f.update({'DATA/MODELS/FIXTURE.BIG': big({**members(), 'fixture.adl': struct.pack('<IfI2I', 0, 1., 1, 42, 0xffffffff)})})),
        ]:
            files = fixture(); mutate(files); image.write_bytes(disc(files))
            maps = root / name
            run(executable, 'extract', image, 'FIXTURE', maps, succeeds=False)
            assert not list(maps.iterdir()), 'Audio failure left a playable partial import'
    print('PASS: ISO audio configs, bank reuse/loops, all ADL strides/hash joins, external routes, music triplets, intro stems and atomic failures')


if __name__ == '__main__':
    main()
