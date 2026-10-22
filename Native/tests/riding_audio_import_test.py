"""Authored common riding banks, source preservation and portable gameplay playback."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import wave

from audio_scene_test import tone, write
from import_test import run
from audio_container_test import patch
import math
import struct


def encoded_bank():
    b = bytearray(20 + 6 * 4)
    b[:4] = b'BNKl'
    struct.pack_into('<BBH', b, 4, 5, 0, 6)
    for slot in range(1, 6):
        struct.pack_into('<I', b, 20 + slot * 4, len(b) - (20 + slot * 4))
        header = b'PT\x05\0' + patch(0x82, 1) + patch(0x84, 8000) + patch(0x85, 64) + patch(0xa0, 9)
        header += patch(0x88, len(b) + len(header) + 19) + patch(0x86, 16) + patch(0x87, 60) + b'\xff'
        b += header + bytes(round(80 * math.sin(i / 4)) & 255 for i in range(64))
    struct.pack_into('<I', b, 8, len(b))
    return bytes(b)


def source_bank(root, name, slots):
    folder = root / 'Audio/SFX' / name
    rows = [None] * (max(slots) + 1)
    for slot, looping in slots.items():
        tone(folder / f'{slot:03}.wav', 220 + slot * 3, .2)
        rows[slot] = dict(Clip=f'{slot:03}.wav', Rate=8000, Channels=1, Frames=1600,
                          LoopStart=100 if looping else 0, LoopEnd=1500 if looping else 0)
    write(folder / 'bank.json', dict(Schema='openslope-audio-bank/v1', Slots=rows))


def fixture(root, tour):
    names = ({'BRD_PACK': 'packed', 'BRD_POW': 'powder', 'BRD_ICE': 'ice',
              'SKI_BRD_COMMON': 'common', 'BOOST': 'boost'} if tour else
             {'SPUBOARD': 'snow', 'BOARD': 'hard', 'LAND': 'land', 'MAIN': 'main'})
    write(root / 'Import.json', dict(Game='ssx-on-tour' if tour else 'ssx-3'))
    write(root / 'Audio/SoundIndex.json', dict(Schema='openslope-sound-index/v1', Level=root.name,
          Banks={'0': 'original', '1': 'original'}, NamedBanks=names, CollisionEvents={}, ResolverState='Deferred'))
    if tour:
        for name in ['packed', 'powder', 'ice']:
            source_bank(root, name, {1: True, 2: True})
        source_bank(root, 'common', {1: True, 4: False, 5: False})
        source_bank(root, 'boost', {2: False})
    else:
        source_bank(root, 'snow', {3: True, 4: True, 11: True, 12: True})
        source_bank(root, 'hard', {35: True, 36: False, 51: False, 52: False})
        source_bank(root, 'land', {1: False, 2: False, 9: False})
        source_bank(root, 'main', {32: True, 122: True})


def hashes(root):
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob('*') if path.is_file()}


def main():
    importer = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-riding-import-') as temporary:
        base = Path(temporary)
        for tour in [False, True]:
            root = base / ('SSXOT_SYNTHETIC' if tour else 'SSX3_SYNTHETIC')
            fixture(root, tour)
            before = hashes(root)
            report = json.loads(run(importer, 'adapt-riding-audio', root))
            assert report['Fidelity'] == 'Approximate' and len(report['Routes']) == 44
            index = json.loads((root / 'Audio/SoundIndex.json').read_text())
            assert index['Banks'] == {'0': 'openslope_rider', '1': 'openslope_board'}
            assert not index['CollisionEvents'] and index['ResolverState'] == 'Deferred'
            assert (root / 'Audio/SoundIndex.before-riding.json').read_bytes() != (root / 'Audio/SoundIndex.json').read_bytes()
            board = root / 'Audio/SFX/openslope_board'
            slots = json.loads((board / 'bank.json').read_text())['Slots']
            assert len(slots) == 80 and slots[3]['LoopStart'] == 100 and slots[3]['LoopEnd'] == 1500
            assert slots[1]['LoopEnd'] == slots[2]['LoopEnd'] == 0
            assert slots[52]['LoopEnd'] == 1500
            if not tour:
                rail = next(row for row in report['Routes'] if row['Bank'] == 'openslope_board' and row['Slot'] == 52)
                assert rail['SourceBank'] == 'hard' and rail['SourceSlot'] == 35 and rail['LoopPolicy'] == 'SourceRegion'
            with wave.open(str(board / '003.loop.wav')) as data:
                assert data.getnframes() == 1400 and data.getframerate() == 8000
            assert not (board / '001.loop.wav').exists()
            rider = json.loads((root / 'Audio/SFX/openslope_rider/bank.json').read_text())['Slots']
            assert rider[32]['LoopEnd'] == 1500 and rider[120]['LoopEnd'] == (1600 if tour else 1500)
            assert rider[114] is None, 'Unrelated legacy cue slots must not acquire arbitrary sounds'
            for file, digest in before.items():
                if file != 'Audio/SoundIndex.json':
                    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == digest, file
            after = hashes(root)
            run(importer, 'adapt-riding-audio', root)
            assert hashes(root) == after, 'Backfill must be idempotent'
            assert not (root / 'Audio/.openslope-riding-staging').exists()
        for label in ['conflict', 'bad-loop', 'unsupported']:
            root = base / label
            fixture(root, True)
            if label == 'conflict':
                write(root / 'Audio/SFX/openslope_board/bank.json', {'authored': True})
            elif label == 'unsupported':
                write(root / 'Import.json', {'Game': 'another-game'})
            else:
                path = root / 'Audio/SFX/packed/bank.json'
                document = json.loads(path.read_text()); document['Slots'][1]['LoopEnd'] = 999999
                write(path, document)
            before = hashes(root)
            run(importer, 'adapt-riding-audio', root, succeeds=False)
            assert hashes(root) == before, 'Failed adaptation changed source files'
    print('PASS: both common riding banks, loop regions, source preservation, approximate cue roles, idempotence and refusal without mutation')


if __name__ == '__main__':
    main()
