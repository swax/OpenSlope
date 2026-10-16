"""Original relocated scalar programs exercise the complete surface-data reader."""
import copy
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
from audio_import_test import disc
from world_import_fixture import boot_files, executable, float_word, ins, reg

ROOT = Path(__file__).resolve().parents[2]
LAYOUT = json.loads((ROOT / 'Contracts/surface-spray-layout-v1.json').read_text())
MOTION = json.loads((ROOT / 'Contracts/ride-v1.json').read_text())['surfaces']


def rows():
    output = []
    for i, motion in enumerate(MOTION):
        output.append(dict(type=i, rate=.02+i*.01, sizeUnits=1+i*.2,
                           fadeMin=.1, fadeMax=.3+i*.02, sprite=(i+7)%38, alpha=.2+i*.01))
    return output


def program(data, unknown=False):
    # Both register comparisons occur before the stores, including signed -1 < 1.
    code = [ins(9, 0, 10, -1), ins(9, 0, 11, 1), reg(42, 12, 10, 11), reg(43, 13, 10, 11)]
    checks = len(code)
    code += [0, 0, 0, 0]
    for i, row in enumerate(data):
        words = [0]*25
        for key, name, scale in [('stiffness', 'A', 1), ('damping', 'P', 1), ('bog', 'bog', 100),
                                 ('sink', 'budget', 100), ('target', 'target', 3.6)]:
            words[LAYOUT['motion'][key]//4] = float_word(MOTION[i][name]*scale)
        for name, at in LAYOUT['fields'].items():
            words[at//4] = row[name] if name == 'sprite' else float_word(row[name])
        for j, value in enumerate(words):
            code += [ins(15, rt=9, imm=value>>16), ins(13, 9, 9, value),
                     ins(43, 4, 5 if unknown and i == 19 and j == 24 else 9, i*100+j*4)]
    end = len(code)
    code[checks] = ins(4, 12, 0, end-checks-1)
    code[checks+2] = ins(5, 13, 0, end-(checks+2)-1)
    return code + [reg(8, rs=31), 0]


def main():
    importer, probe = (str(Path(p).resolve()) for p in sys.argv[1:3])
    checks = 0
    with tempfile.TemporaryDirectory(prefix='openslope-surface-data-') as temporary:
        folder = Path(temporary)
        def run(body, good=True):
            nonlocal checks
            image = folder/'authored.iso'
            image.write_bytes(disc(boot_files(body)))
            before = hashlib.sha256(image.read_bytes()).digest()
            result = subprocess.run([importer, 'surface-spray', str(image)], capture_output=True, text=True, timeout=20)
            assert (result.returncode == 0) == good, result.stdout+result.stderr
            assert hashlib.sha256(image.read_bytes()).digest() == before
            checks += 1
            return json.loads(result.stdout) if good else None
        authored = rows()
        expected = [{k: (v if k in ('type', 'sprite') else struct.unpack('<f',struct.pack('<f',v))[0])
                     for k,v in row.items()} for row in authored]
        for base, offset in [(0x200000,256), (0x700000,512), (0x1100000,4096)]:
            assert run(executable(program(authored), base=base, offset=offset))['rows'] == expected
        assert run(executable(program(authored)+program(authored)))['rows'] == expected
        changed = copy.deepcopy(authored)
        changed[3]['alpha'] += .1
        run(executable(program(authored)+program(changed)), good=False)
        run(executable(program(authored, unknown=True)), good=False)
        for key, value in [('rate', -1), ('sizeUnits', 200), ('fadeMin', 0), ('fadeMax', .01),
                           ('sprite', 38), ('alpha', 2), ('alpha', float('nan'))]:
            bad = copy.deepcopy(authored)
            bad[17][key] = value
            run(executable(program(bad)), good=False)
        run(executable(), good=False)  # A world-profile constructor cannot masquerade as surface data.
        fixture = folder/'surface.elf'
        fixture.write_bytes(executable(program(authored)))
        result = subprocess.run([probe, '--surface-spray', str(fixture)], capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stdout+result.stderr
        print(result.stdout.strip())
    print(f'PASS: {checks} authored surface-data relocation, register comparison, ambiguity, unknown-byte and typed-field cases')


if __name__ == '__main__':
    main()
