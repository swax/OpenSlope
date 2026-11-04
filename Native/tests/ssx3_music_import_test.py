"""Authored PathFinder-v4 main-track adaptation; no game bytes or decoder source."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import wave

from audio_container_test import stream
from audio_import_test import archive, disc
from import_test import run


def music_graph(offsets, edit=None):
    # Main path branches by intensity, exits a loop at count zero, then ends.
    # The last main sample and async bank node are event-only and must be pruned.
    nodes = [(0, 0, [(0, 63, 1), (64, 127, 2)]),
             (1, 0, [(0, 127, 3)]), (2, 0, [(0, 127, 3)]),
             (-1, 0, [(0, 0, 4), (1, 127, 1)]),
             (3, 0, [(0, 127, -1)]), (4, 0, []), (1, 1, [])]
    if edit:
        edit(nodes)
    data = bytearray(32 + len(nodes) * 2)
    data += bytes(-len(data) % 4)
    data[:4] = b'xDFP'
    struct.pack_into('<H', data, 4, 4)
    data[13:16] = bytes([2, 3, 1])
    struct.pack_into('<H', data, 18, len(nodes))
    for i, (sample, track, links) in enumerate(nodes):
        struct.pack_into('<H', data, 32 + i * 2, len(data) // 4)
        # A non-count flag above the count nibble catches an over-wide mask.
        data += struct.pack('<4I', (sample & 0xffff) | track << 16 | 1 << 21,
                            len(links) << 12 | (1 << 16 if i == 1 else 0), 0, 0)
        for lo, hi, target in links:
            data += struct.pack('<bbh', lo, hi, target)
    data += struct.pack('<H', (len(data) + 4) // 4) + bytes(2)
    data += bytes(32)  # Opaque authored event program, intentionally not interpreted.
    table = len(data) + 4
    first = table + 12
    data += struct.pack('<4I', table // 4, first // 4, (first + 32) // 4, (first + 40) // 4)
    for offset in offsets:
        data += struct.pack('<2I', offset // 128, 4)
    data += struct.pack('<2I', 0x1234, 4)  # A bank slot, NOT a streamed music position.
    return bytes(data)


def music_files(beta=False, edit=None, corrupt=None, unsupported=False, unsafe_placeholder=False):
    audio = bytearray()
    offsets = []
    for blocks in [1, 2, 3, 4]:
        offsets.append(len(audio))
        audio += stream(blocks)
        audio += bytes(-len(audio) % 128)
    graph = bytearray(music_graph(offsets, edit))
    if corrupt:
        corrupt(graph)
    placeholder = '..\\audio\\*.bnk' if unsafe_placeholder else 'data\\audio\\*.bnk'
    music = bytearray(archive({placeholder: b'', 'data/audio/first.mpf': graph,
                               'data/audio/first.mus': audio,
                               **({'other.mpf': graph, 'other.mus': audio} if beta else {})}))
    struct.pack_into('>2I', music, 16, 0, 0)  # Real-style empty wildcard placeholder.
    config = ('[First]\nTITLE="First song"\nARTIST="Fixture artist"\nPATHDATA="FIRST.MPF"\n'
              'MUSDATA="first.mus"\nLOOPDATA="unused.bnk"\nBPM=92\nPATHLEVEL=80\nSONGBIG=1\n'
              '[Alternate]\nTITLE="Other song"\nPATHDATA="other.mpf"\nMUSDATA="other.mus"\n'
              f'SONGBIG={1 if beta else 2}\nBPM=120\n')
    files = {'DATA/CONFIG/BANKS.INF': b'[WORLD]\n',
             'DATA/CONFIG/SNOW.INF': b'# Authored empty surface assignments\n',
             'DATA/AUDIO/AUDIO.BIG': archive({}),
             'DATA/CONFIG/MUSIC.INF': config.encode(),
             'DATA/CONFIG/PLAYLIST.INF': b'[Mastered Mix]\nSONG=Ignored\n[SSX Mix]\nSONG=Alternate\nSONG=First\n',
             'DATA/AUDIO/MUSIC.BIG': bytes(music)}
    if not beta:
        other_audio = bytes(audio)
        if unsupported:
            other_audio = other_audio.replace(b'\xa0\x04\0\0\0\x0a', b'\xa0\x04\0\0\0\x04', 1)
        files['DATA/AUDIO/MUSIC2.BIG'] = archive({'other.mpf': graph, 'other.mus': other_audio})
    return files


def fixture(beta=False, **kwargs):
    if beta:
        from ssx3_beta_import_test import preview_disc
        files = music_files(True, **kwargs)
        for path in ['DATA/CONFIG/BANKS.INF', 'DATA/CONFIG/SNOW.INF', 'DATA/AUDIO/AUDIO.BIG']:
            del files[path]
        return preview_disc(music=files, single_area=True)
    from ssx3_import_test import members
    files = members()
    database = bytearray(files['data/worlds/bam.sdb'][:80 + 2 * 88])
    struct.pack_into('<I', database, 8, 2)
    files['data/worlds/bam.sdb'] = bytes(database)
    return disc({'DATA/WORLDS/BAM.BIG': archive(files), **music_files(**kwargs)})


def main():
    importer = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-ssx3-music-') as temporary:
        root = Path(temporary)
        for beta in [False, True]:
            game = 'beta' if beta else 'retail'
            source = root / f'{game}.iso'
            source.write_bytes(fixture(beta))
            course = 'SSX3B_ARA1' if beta else 'SSX3_A'
            maps = root / game
            run(importer, 'extract', source, course, maps)
            music = maps / course / 'Audio/Music'
            assert json.loads((music / 'playlist.json').read_text()) == ['other', 'FIRST']
            report = json.loads((music / 'MusicImport.json').read_text())
            assert report['Game'] == ('ssx-3-beta' if beta else 'ssx-3')
            assert report['OriginalMusicScheduling'] == 'Deferred'
            graph = json.loads((music / 'FIRST/graph.json').read_text())
            assert graph['Song'] == 'First song - Fixture artist' and graph['Artist'] == 'Fixture artist'
            assert graph['Bpm'] == 92 and graph['Volume'] == .8 and graph['Fidelity'] == 'Approximate'
            assert len(graph['Nodes']) == 5 and len(graph['Samples']) == 3
            assert graph['Events'] == 0 and graph['Tracks'] == 1
            assert graph['Nodes'][3]['Sample'] == 0
            for i, sample in enumerate(graph['Samples']):
                with wave.open(str(music / 'FIRST' / sample['Wav'])) as decoded:
                    assert decoded.getnchannels() == 2 and decoded.getframerate() == 8000
                    assert decoded.getnframes() == (i + 1) * 28
                    assert sample['Seconds'] == decoded.getnframes() / decoded.getframerate()
                    assert struct.unpack('<4h', decoded.readframes(2)) == (1, 2, -8, 7)
            assert (music / 'FIRST/source.mpf').read_bytes()[:6] == b'xDFP\x04\x00'
            assert json.loads((maps / course / 'Import.json').read_text())['MusicSongs'] == 2
            if len(sys.argv) > 2:
                run(Path(sys.argv[2]).resolve(), source, root / f'{game}-sessions', '2')
        source = root / 'unsupported.iso'
        source.write_bytes(fixture(unsupported=True))
        run(importer, 'extract', source, 'SSX3_A', root / 'unsupported')
        music = root / 'unsupported/SSX3_A/Audio/Music'
        assert json.loads((music / 'playlist.json').read_text()) == ['FIRST']
        deferred = json.loads((music / 'MusicImport.json').read_text())['DeferredSongs']
        assert deferred[0]['Song'] == 'other' and deferred[0]['Reason'] == 'unsupported-audio-codec'
        assert not (music / 'other').exists()
        invalid = [
            {'unsafe_placeholder': True},
            {'edit': lambda n: n.__setitem__(0, (0, 1, n[0][2]))},
            {'edit': lambda n: n.__setitem__(1, (5, 0, n[1][2]))},
            {'edit': lambda n: n.__setitem__(0, (0, 0, [(0, 127, 0)]))},
            {'edit': lambda n: n.__setitem__(0, (0, 0, [(0, 127, 99)]))},
            {'corrupt': lambda b: b.__setitem__(slice(32, 34), b'\xff\xff')},
            {'corrupt': lambda b: b.__setitem__(slice(-4, None), b'\0' * 3)},
            {'corrupt': lambda b: struct.pack_into('<I', b, len(b) - 40, 0x7fffffff)},
        ]
        for i, kwargs in enumerate(invalid):
            source = root / f'invalid-{i}.iso'
            source.write_bytes(fixture(**kwargs))
            maps = root / f'invalid-{i}'
            run(importer, 'extract', source, 'SSX3_A', maps, succeeds=False)
            assert not (maps / 'SSX3_A').exists(), 'A rejected song must not publish a partial map'
    print('SSX 3/preview music playlist, split banks, playable paths, PCM, cache and rejection checks PASS')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        Path(sys.argv[2]).write_bytes(fixture(True))
    else:
        main()
