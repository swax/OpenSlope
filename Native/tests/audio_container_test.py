"""Authored audio-container byte oracles: no retail files or external decoder."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import wave


def patch(tag, value):
    return bytes([tag, 4]) + struct.pack('>I', value)


def bank():
    header = b'PT\x05\0' + patch(0x82, 1) + patch(0x84, 8000) + patch(0x85, 3) + patch(0xA0, 9) + patch(0x88, 0) + patch(0x86, 1) + patch(0x87, 3) + b'\xff'
    data = bytearray(28 + len(header) + 3)
    data[:4] = b'BNKl'
    struct.pack_into('<BBH3I', data, 4, 5, 0, 2, len(data), 0, 0)
    struct.pack_into('<2I', data, 20, 8, 0)
    data[28:28 + len(header)] = header
    offset = 28 + len(header)
    marker = data.index(bytes([0x88, 4]))
    struct.pack_into('>I', data, marker + 2, offset)
    data[offset:] = bytes([0, 127, 128])
    return bytes(data)


def stream():
    header = b'PT\x05\0' + patch(0x82, 2) + patch(0x84, 8000) + patch(0xA0, 10) + b'\xff'
    frame_a, frame_b = bytes([12, 0x18]) + bytes(13), bytes([12, 0x27]) + bytes(13)
    payload = struct.pack('<3I', 28, 0, 19) + bytes(4) + frame_a + bytes(4) + frame_b
    def chunk(kind, data):
        return kind + struct.pack('<I', len(data) + 8) + data
    return chunk(b'SCHl', header) + chunk(b'SCCl', struct.pack('<I', 1)) + chunk(b'SCDl', payload) + chunk(b'SCEl', b'')


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-audio-containers-') as temporary:
        root = Path(temporary)
        source = root / 'authored.bnk'
        source.write_bytes(bank())
        result = subprocess.run([str(executable), 'bank', str(source), str(root / 'bank')], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        metadata = json.loads((root / 'bank/bank.json').read_text())
        assert metadata['Slots'][1] is None
        assert metadata['Slots'][0]['LoopStart'] == 1 and metadata['Slots'][0]['LoopEnd'] == 3
        with wave.open(str(root / 'bank/000.wav')) as decoded:
            assert decoded.getnchannels() == 1 and decoded.getframerate() == 8000
            assert struct.unpack('<3h', decoded.readframes(3)) == (0, 32512, -32768)
        with wave.open(str(root / 'bank/000.loop.wav')) as decoded:
            assert struct.unpack('<2h', decoded.readframes(2)) == (32512, -32768)
        source = root / 'authored.stream'
        source.write_bytes(stream())
        result = subprocess.run([str(executable), 'stream', str(source), str(root / 'stream.wav')], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        with wave.open(str(root / 'stream.wav')) as decoded:
            assert decoded.getnchannels() == 2 and decoded.getnframes() == 28
            assert struct.unpack('<4h', decoded.readframes(2)) == (1, 2, -8, 7)
        corrupt = bytearray(stream())
        start = corrupt.index(b'SCDl')
        struct.pack_into('<I', corrupt, start + 16, 0xffffffff)
        source.write_bytes(corrupt)
        result = subprocess.run([str(executable), 'stream', str(source), str(root / 'bad.wav')], capture_output=True, text=True)
        assert result.returncode != 0 and not (root / 'bad.wav').exists()
    print('PASS: authored self-relative bank entries, empty slots, loop slices, channel offsets and malformed-stream bounds')


if __name__ == '__main__':
    main()
