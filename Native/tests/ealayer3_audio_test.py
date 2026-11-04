"""Authored silent MPEG granules and signed PCM patches; no game audio bytes."""
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import wave

from audio_container_test import patch


def chunk(kind, data):
    return kind + struct.pack('<I', len(data) + 8) + data


def granule(index, channels):
    # MPEG-1, 48 kHz, empty Huffman data and zero side information.
    bits = '00000000' + '11' + '01' + ('11' if channels == 1 else '01') + '00' + str(index)
    bits += '0' * ((4 * channels if index else 0) + 59 * channels)
    bits += '0' * (-len(bits) % 8)
    return int(bits, 2).to_bytes(len(bits) // 8, 'big')


def stream(channels=2, blocks=1):
    frames = 2351 + 2304 * (blocks - 1)
    header = b'PT\x05\0' + patch(0x82, channels) + patch(0x84, 48000)
    header += patch(0x85, frames) + patch(0xa0, 23) + patch(6, 101) + b'\xff'
    out = chunk(b'SCHl', header)
    for block in range(blocks):
        payloads = []
        widths = [1] * channels if channels != 2 else [2]
        for channel, width in enumerate(widths):
            values = [2048 * (channel + 1)] if width == 1 else [8192, -8192]
            data = b''
            for i in range(6 if block == 0 else 4):
                data += granule(i % 2, width)
                if block == 0 and i in (1, 2):
                    count, offset = (47, 47) if i == 1 else (53, 576)
                    values2 = values if i == 1 else [v * 2 for v in values]
                    data += b'\xee' + struct.pack('>HH', offset, count)
                    data += struct.pack('>' + 'h' * width, *values2) * count
            payloads.append(data)
        offsets, offset = [], 0
        for data in payloads:
            offsets.append(offset)
            offset += len(data)
        if channels == 2:
            offsets.append(0xffffffff)  # Unused slot of a stereo MPEG stream.
        payload = struct.pack('<I', 2351 if block == 0 else 2304)
        payload += struct.pack('<' + 'I' * channels, *offsets) + b''.join(payloads)
        out += chunk(b'SCDl', payload)
    return out + chunk(b'SCEl', b'')


def main():
    executable = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix='openslope-ealayer3-') as temporary:
        root = Path(temporary)
        source = root / 'authored.schl'

        def decode(data, name, valid=True):
            source.write_bytes(data)
            target = root / (name + '.wav')
            result = subprocess.run([executable, 'stream', str(source), str(target)], capture_output=True, text=True)
            assert (result.returncode == 0) == valid, (name, result.stdout, result.stderr)
            assert target.exists() == valid
            return target

        for channels in (1, 2, 4):
            path = decode(stream(channels, 2), str(channels))
            with wave.open(str(path)) as w:
                width = min(channels, 2)
                assert (w.getnchannels(), w.getframerate(), w.getnframes()) == (width, 48000, 4655)
                values = struct.unpack('<' + 'h' * (4655 * width), w.readframes(4655))
                first = (2048,) if channels == 1 else (8192, -8192) if channels == 2 else (4096, 6144)
                second = tuple(v * 2 for v in first)
                assert values[:47 * width] == first * 47
                assert values[47 * width:100 * width] == second * 53
                assert not any(values[100 * width:]), 'Silent MPEG payload remains silent across blocks'
        original = stream()
        payload = original.index(b'SCDl') + 8
        marker = original.index(b'\xee', payload)
        invalid = [original[:-8], original[:payload + 15],
                   original.replace(patch(0x85, 2351), patch(0x85, 2352)),
                   original.replace(patch(0x84, 48000), patch(0x84, 44100)),
                   original.replace(patch(0x82, 2), patch(0x82, 3))]
        bad = bytearray(original)
        struct.pack_into('<I', bad, payload + 4, len(original))
        invalid.append(bytes(bad))
        bad = bytearray(original)
        struct.pack_into('<I', bad, payload + 4, 0xffffffff)
        invalid.append(bytes(bad))
        bad = bytearray(original)
        struct.pack_into('>H', bad, marker + 1, 65535)
        invalid.append(bytes(bad))
        bad = bytearray(original)
        bad[payload + 12] = 1
        invalid.append(bytes(bad))
        for i, data in enumerate(invalid):
            decode(data, 'invalid-' + str(i), False)
    print('EA Layer 3 PASS: independent framing, PCM placement, mono/stereo/quad downmix, continuation and bounds')


if __name__ == '__main__':
    main()
