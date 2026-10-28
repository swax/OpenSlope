"""Authored soundtrack package -> portable stereo chunks, without retail assets."""
from pathlib import Path
import json
import struct
import subprocess
import sys
import tempfile
import wave
from avalanche_import_test import be, course_packages, gcm, rvz, portable_uvs, TERRAIN_UVS


def sound_bank(rows):
    strings = bytearray()
    table = bytearray(be(len(rows)) + bytes(8))
    for title, artist, stem in rows:
        for value in (title, artist, stem):
            table.extend(be(12 + len(rows) * 20 + len(strings)) if value else be(0))
            if value:
                strings.extend(value.encode() + b'\0')
        table.extend(bytes(8))
    catalogue = table + strings
    return (b'SNDFILE\0' + be(1) + bytes(20) + b'bgmlist.dat'.ljust(32, b'\0') +
            be(96) + be(len(catalogue)) + bytes(24) + catalogue)


def music_files():
    # Predictor 1 sustains a constant exact value with a small residual.
    # More than four seconds forces predictor history across two output WAVs.
    block = bytes([0x1c, 0x1c, 0x1c, 0x1c]) + bytes([0xf1]) * 28
    return {
        '1080Data/sound/snddata.obj': sound_bank([
            ('Fixture song', 'Fixture artist', 'fixture'),
            ('Alternate name', 'Fixture artist', 'fixture'),
            ('Other song', 'Other artist', 'second'),
            ('', '', 'cue'),
            ('Music Off', ' ', '_INVALID'),
        ]),
        '1080Data/sound/fixture.adp': block * 7000,
        '1080Data/sound/second.adp': bytes([0x0c]) * 4 + bytes([0x87]) * 28,
        '1080Data/sound/cue.adp': bytes(32),
    }


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-avalanche-music-') as temporary:
        root = Path(temporary)
        source = root / 'authored.rvz'

        def run(operation, output, succeeds=True, course=None):
            args = [str(executable), operation, str(source)]
            if course:
                args.append(course)
            result = subprocess.run(args + [str(output)], capture_output=True, text=True, timeout=120)
            assert (result.returncode == 0) == succeeds, result.stdout + result.stderr
            return result.stdout + result.stderr

        source.write_bytes(rvz(gcm(music_files()), packing=True))
        output = root / 'music'
        run('extract-avalanche-music', output)
        music = output / 'Audio/Music'
        assert json.loads((music / 'playlist.json').read_text()) == ['fixture', 'second']
        report = json.loads((music / 'MusicImport.json').read_text())
        assert [s['Artist'] for s in report['Songs']] == ['Fixture artist', 'Other artist']
        assert report['OriginalMusicScheduling'] == 'Deferred'
        graph = json.loads((music / 'fixture/graph.json').read_text())
        assert len(graph['Samples']) == 2
        assert graph['Nodes'][-1]['Links'] == [1]
        assert graph['Nodes'][0]['Links'] == [1]
        assert graph['Song'] == 'Fixture song - Fixture artist'
        decoded = []
        for sample in graph['Samples']:
            with wave.open(str(music / 'fixture' / sample['Wav'])) as wav:
                assert wav.getframerate() == 48000 and wav.getnchannels() == 2 and wav.getsampwidth() == 2
                assert wav.getnframes() == sample['Samples']
                data = wav.readframes(wav.getnframes())
                decoded.extend(struct.unpack('<' + str(len(data) // 2) + 'h', data))
        assert len(decoded) == 7000 * 56
        assert decoded[:12] == [1, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6]
        assert decoded[-56:] == [15, -16] * 28
        with wave.open(str(music / 'second/chunk_000.wav')) as wav:
            assert struct.unpack('<56h', wav.readframes(28)) == (7, -8) * 28
        before = (music / 'playlist.json').read_bytes()
        run('extract-avalanche-music', output, succeeds=False)
        assert (music / 'playlist.json').read_bytes() == before

        # Full course extraction must use the same audio conversion.
        files = course_packages() | music_files()
        source.write_bytes(rvz(gcm(files), packing=True))
        run('extract', root / 'maps', course='AVALANCHE_CRS00_00')
        imported = root / 'maps/AVALANCHE_CRS00_00'
        assert (imported / 'Audio/Music/fixture/chunk_001.wav').read_bytes() == (music / 'fixture/chunk_001.wav').read_bytes()
        assert json.loads((imported / 'Import.json').read_text())['Music']['Songs'] == 2
        if len(sys.argv) > 2:
            expected_uv = root / 'uv.json'
            expected_uv.write_text(json.dumps([portable_uvs(TERRAIN_UVS[0])]))
            subprocess.run([str(Path(sys.argv[2]).resolve()), str(imported), str(expected_uv), str(source)],
                           check=True, timeout=120)

        for case in ('pointer', 'missing', 'truncated', 'predictor', 'header', 'overlap'):
            files = music_files()
            if case == 'pointer':
                bank = bytearray(files['1080Data/sound/snddata.obj'])
                struct.pack_into('>I', bank, 96 + 12, 0xffffffff)
                files['1080Data/sound/snddata.obj'] = bytes(bank)
            elif case == 'missing':
                del files['1080Data/sound/second.adp']
            elif case == 'truncated':
                files['1080Data/sound/second.adp'] = bytes(31)
            elif case == 'predictor':
                files['1080Data/sound/second.adp'] = bytes([0x40]) * 4 + bytes(28)
            elif case == 'header':
                files['1080Data/sound/second.adp'] = bytes([0, 0, 1, 0]) + bytes(28)
            else:
                bank = bytearray(files['1080Data/sound/snddata.obj'])
                struct.pack_into('>I', bank, 64, 32)
                files['1080Data/sound/snddata.obj'] = bytes(bank)
            source.write_bytes(rvz(gcm(files)))
            failed = root / case
            run('extract-avalanche-music', failed, succeeds=False)
            assert not (failed / 'Audio/Music').exists(), case
    print('PASS: Avalanche soundtrack metadata, duplicate/cue filtering, stereo PCM, chunk continuity, portable graph, course integration, bounds and rollback')


if __name__ == '__main__':
    main()
