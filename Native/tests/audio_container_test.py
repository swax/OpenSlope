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


def stream(blocks=1):
    header = b'PT\x05\0' + patch(0x82, 2) + patch(0x84, 8000) + patch(0xA0, 10) + b'\xff'
    frame_a, frame_b = bytes([12, 0x18]) + bytes(13), bytes([12, 0x27]) + bytes(13)
    payload = struct.pack('<3I', 28, 0, 19) + bytes(4) + frame_a + bytes(4) + frame_b
    def chunk(kind, data):
        return kind + struct.pack('<I', len(data) + 8) + data
    return chunk(b'SCHl', header) + chunk(b'SCCl', struct.pack('<I', blocks)) + chunk(b'SCDl', payload) * blocks + chunk(b'SCEl', b'')


def literal_bank():
    data = bytearray(bank()[:-3])
    marker = data.index(bytes([0xa0, 4]))
    struct.pack_into('>I', data, marker + 2, 10)
    marker = data.index(bytes([0x85, 4]))
    struct.pack_into('>I', data, marker + 2, 56)
    # One literal frame followed by a regular delta frame checks variable
    # frame strides and exact signed big-endian sample conversion.
    data += b'\xee' + struct.pack('>30h', 100, -100, *range(-14, 14))
    data += bytes([12, 0x18]) + bytes(13)
    return bytes(data)


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
        source.write_bytes(literal_bank())
        result = subprocess.run([str(executable), 'bank', str(source), str(root / 'literal')], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        with wave.open(str(root / 'literal/000.wav')) as decoded:
            assert struct.unpack('<56h', decoded.readframes(56)) == tuple(range(-14, 14)) + (1, -8) + (0,) * 26
        source.write_bytes(literal_bank()[:-30])
        result = subprocess.run([str(executable), 'bank', str(source), str(root / 'truncated')], capture_output=True, text=True)
        assert result.returncode != 0
        source = root / 'authored.stream'
        source.write_bytes(stream())
        result = subprocess.run([str(executable), 'stream', str(source), str(root / 'stream.wav')], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        with wave.open(str(root / 'stream.wav')) as decoded:
            assert decoded.getnchannels() == 2 and decoded.getnframes() == 28
            assert struct.unpack('<4h', decoded.readframes(2)) == (1, 2, -8, 7)
        # Cross many clip-capacity growth and WAV output-buffer boundaries.
        source.write_bytes(stream(blocks=1031))
        result = subprocess.run([str(executable), 'stream', str(source), str(root / 'long.wav')], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        expected_block = struct.pack('<4h', 1, 2, -8, 7) + bytes(26 * 4)
        with wave.open(str(root / 'long.wav')) as decoded:
            assert decoded.getnframes() == 28 * 1031
            assert decoded.readframes(decoded.getnframes()) == expected_block * 1031
        corrupt = bytearray(stream())
        start = corrupt.index(b'SCDl')
        struct.pack_into('<I', corrupt, start + 16, 0xffffffff)
        source.write_bytes(corrupt)
        result = subprocess.run([str(executable), 'stream', str(source), str(root / 'bad.wav')], capture_output=True, text=True)
        assert result.returncode != 0 and not (root / 'bad.wav').exists()
    print('PASS: authored self-relative bank entries, empty slots, loop slices, channel offsets and malformed-stream bounds')


if __name__ == '__main__':
    main()
