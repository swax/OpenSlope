"""Authored On Tour catalogue/jukebox fixtures; no original soundtrack bytes."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import wave

from audio_container_test import stream, patch
from ealayer3_audio_test import stream as ealayer3_stream
from audio_import_test import archive
from import_test import run
from ontour_import_test import full_disc


def music_files(corrupt=None, index=4, unsupported=False, ambiguous=False, large=False, ealayer3=False):
    audio = bytearray(128)
    struct.pack_into('<I', audio, 0, 90)
    offsets = []
    for blocks in [1, 2]:
        offsets.append(len(audio))
        value = ealayer3_stream(channels=4 if blocks == 2 else 2, blocks=blocks) if ealayer3 else stream(blocks)
        if unsupported and blocks == 2:
            value = value.replace(patch(0xa0, 10), patch(0xa0, 4))
        audio += value + bytes(-len(value) % 128)
    if large:
        offsets.append(len(audio))
        audio += stream() + bytes(128 * 1024 * 1024)
    # Song sections deliberately choose the reverse of stream/sample order.
    nodes = [(0, 4, [1]), (2, 4, [2]), (-1, 4, []),
             (0, 5, [4]), (1, 5, [5]), (-1, 5, [])]
    data = bytearray(72 + len(nodes) * 2)
    data += bytes(-len(data) % 4)
    data[:6] = b'xDFP\x05\x01'
    data[13:16] = bytes([1, 6, 1])
    struct.pack_into('<H', data, 18, len(nodes))
    struct.pack_into('<II', data, 20, 72, len(data))
    for i, (sample, section, links) in enumerate(nodes):
        struct.pack_into('<H', data, 72 + i * 2, len(data) // 4)
        word = (sample & 65535) | section << 21 | (1 << 27 if sample == -1 else 0)
        data += struct.pack('<4I', word, len(links) << 12, 0, 0)
        data += b''.join(struct.pack('<bbh', 0, 127, target) for target in links)
    struct.pack_into('<I', data, 28, len(data))
    event = len(data) + 4
    data += struct.pack('<H', event // 4) + bytes(2) + bytes(16)
    struct.pack_into('<I', data, 48, len(data))
    data += struct.pack('<5I', 0, 0, 90, 0, 0)
    struct.pack_into('<I', data, 52, len(data))
    data += b''.join(struct.pack('<II', offset // 128, 4) for offset in offsets)
    struct.pack_into('<I', data, 56, len(data))
    if corrupt:
        corrupt(data)
    music = (f'[R&R]\nTITLE="First song"\nARTIST="Fixture artist"\nBPM=92\nPATHLEVEL=80\n'
             f'SONGINDEX=1\nJUKEBOXSONGINDEX={index}\n'
             '[Second]\nTITLE="Second song"\nBPM=130\nSONGINDEX=2\nJUKEBOXSONGINDEX=5\n')
    files = {'data/audio/jukebox.mpf': bytes(data), 'data/audio/tracks.mus': bytes(audio)}
    if ambiguous:
        files['second.mpf'] = bytes(data)
    return {'DATA/CONFIG/MUSIC.INF': music.encode(),
            'DATA/CONFIG/PLAYLIST.INF': b'[All]\nNAME="Collective"\nSONG="R&R"\nSONG="Second"\n',
            'DATA/AUDIO/FEMUSIC.BIG': archive(files)}


def fixture(**kwargs):
    return full_disc(fidelity=True, night_sky=True, music=music_files(**kwargs))


def main():
    importer = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-ontour-music-') as temporary:
        root = Path(temporary)
        source = root / 'music.iso'
        source.write_bytes(fixture())
        for course in ['SSXOT_ER1_DAY', 'SSXOT_ER1_NIGHT']:
            maps = root / course
            run(importer, 'extract', source, course, maps)
            music = maps / course / 'Audio/Music'
            assert json.loads((music / 'playlist.json').read_text()) == ['song_4', 'song_5']
            report = json.loads((music / 'MusicImport.json').read_text())
            assert report['Game'] == 'ssx-on-tour' and report['OriginalMusicScheduling'] == 'Deferred'
            assert 'gameplay-segmentation' in report['Deferred']
            for song, frames in [('song_4', 56), ('song_5', 28)]:
                folder = music / song
                graph = json.loads((folder / 'graph.json').read_text())
                assert graph['Fidelity'] == 'Approximate' and len(graph['Samples']) == 1
                assert len(graph['Nodes']) == 1 and graph['Nodes'][0]['Sample'] == 1
                with wave.open(str(folder / graph['Samples'][0]['Wav'])) as decoded:
                    assert decoded.getnframes() == frames and decoded.getframerate() == 8000
                    assert graph['Samples'][0]['Seconds'] == frames / 8000
                    assert struct.unpack('<4h', decoded.readframes(2)) == (1, 2, -8, 7)
                assert (folder / 'source.mpf').read_bytes()[:6] == b'xDFP\x05\x01'
            graph = json.loads((music / 'song_4/graph.json').read_text())
            assert graph['Song'] == 'First song - Fixture artist' and graph['Bpm'] == 92 and graph['Volume'] == .8
            assert json.loads((maps / course / 'Import.json').read_text())['MusicSongs'] == 2
        if len(sys.argv) > 2:
            run(Path(sys.argv[2]).resolve(), source, root / 'sessions', '2')
        source.write_bytes(fixture(ealayer3=True))
        run(importer, 'extract', source, 'SSXOT_ER1_DAY', root / 'ealayer3')
        music = root / 'ealayer3/SSXOT_ER1_DAY/Audio/Music'
        for song, frames, first in [('song_4', 4655, (4096, 6144)), ('song_5', 2351, (8192, -8192))]:
            graph = json.loads((music / song / 'graph.json').read_text())
            with wave.open(str(music / song / graph['Samples'][0]['Wav'])) as decoded:
                assert decoded.getnchannels() == 2 and decoded.getframerate() == 48000
                assert decoded.getnframes() == frames
                assert struct.unpack('<2h', decoded.readframes(1)) == first
        if len(sys.argv) > 2:
            run(Path(sys.argv[2]).resolve(), source, root / 'ealayer3-sessions', '2')
        source.write_bytes(fixture(unsupported=True))
        run(importer, 'extract', source, 'SSXOT_ER1_DAY', root / 'unsupported')
        music = root / 'unsupported/SSXOT_ER1_DAY/Audio/Music'
        assert json.loads((music / 'playlist.json').read_text()) == ['song_5']
        assert json.loads((music / 'MusicImport.json').read_text())['DeferredSongs'][0]['Song'] == 'song_4'
        assert not (music / 'song_4').exists()
        source.write_bytes(fixture(large=True))
        run(importer, 'extract', source, 'SSXOT_ER1_DAY', root / 'large')
        assert json.loads((root / 'large/SSXOT_ER1_DAY/Audio/Music/playlist.json').read_text()) == ['song_4', 'song_5'], \
            'A shared MUS over the generic whole-file limit must use bounded song reads'
        invalid = [
            {'index': 3}, {'index': 4.5}, {'ambiguous': True},
            {'corrupt': lambda b: b.__setitem__(5, 2)},
            {'corrupt': lambda b: b.__setitem__(13, 2)},
            {'corrupt': lambda b: struct.pack_into('<I', b, 20, 76)},
            {'corrupt': lambda b: struct.pack_into('<H', b, 72, 65535)},
            {'corrupt': lambda b: struct.pack_into('<I', b, 56, len(b) + 4)},
            {'corrupt': lambda b: struct.pack_into('<I', b, struct.unpack_from('<I', b, 48)[0] + 8, 91)},
            {'corrupt': lambda b: struct.pack_into('<I', b, struct.unpack_from('<I', b, 52)[0] + 8, 1)},
            {'corrupt': lambda b: struct.pack_into('<I', b, struct.unpack_from('<I', b, 52)[0] + 12, 0)},
            {'corrupt': lambda b: struct.pack_into('<h', b, struct.unpack_from('<H', b, 74)[0] * 4, 3)},
            {'corrupt': lambda b: struct.pack_into('<h', b, struct.unpack_from('<H', b, 72)[0] * 4, 1)},
            {'corrupt': lambda b: struct.pack_into('<h', b, struct.unpack_from('<H', b, 72)[0] * 4 + 18, 99)},
        ]
        for i, kwargs in enumerate(invalid):
            source.write_bytes(fixture(**kwargs))
            maps = root / f'invalid-{i}'
            run(importer, 'extract', source, 'SSXOT_ER1_DAY', maps, succeeds=False)
            assert not (maps / 'SSXOT_ER1_DAY').exists(), 'Failed music conversion published a partial map'
    print('PASS: On Tour song mapping, day/night soundtrack, PCM, codec deferral, shared cache and malformed input rejection')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        Path(sys.argv[2]).write_bytes(fixture(ealayer3=True))
    else:
        main()
