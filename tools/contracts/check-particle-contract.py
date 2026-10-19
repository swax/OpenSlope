"""Check the short registration identifiers against data in a user-supplied ISO.

This reads ISO9660 directory records, an ELF container's inline registration
data, and the image bank's name directory. It does not disassemble code or use
another component's format reader. Clean Trailmap 180 supplies the anchor names.
"""

import collections
import json
from pathlib import Path
import struct
import sys


def read_at(file, offset, count, total):
    if offset < 0 or count < 0 or count > 64 * 1024 * 1024 or offset + count > total:
        raise ValueError("Extent outside image or reader limit")
    file.seek(offset)
    data = file.read(count)
    if len(data) != count:
        raise ValueError("Truncated image")
    return data


def directory(file, extent, size, total):
    data = read_at(file, extent * 2048, size, total)
    result = {}
    at = 0
    while at < len(data):
        length = data[at]
        if not length:
            at = (at // 2048 + 1) * 2048
            continue
        row = data[at : at + length]
        if len(row) < 34 or len(row) < 33 + row[32]:
            raise ValueError("Truncated ISO directory record")
        name = row[33 : 33 + row[32]].decode("ascii").split(";")[0]
        result[name] = (struct.unpack_from("<I", row, 2)[0], struct.unpack_from("<I", row, 10)[0])
        at += length
    return result


def registry(iso):
    with iso.open("rb") as file:
        total = iso.stat().st_size
        pvd = read_at(file, 16 * 2048, 2048, total)
        if pvd[:7] != b"\x01CD001\x01":
            raise ValueError("Expected primary ISO9660 volume")
        root = pvd[156:190]
        entries = directory(file, struct.unpack_from("<I", root, 2)[0], struct.unpack_from("<I", root, 10)[0], total)
        executables = []
        for extent, size in entries.values():
            if 52 <= size <= 64 * 1024 * 1024 and read_at(file, extent * 2048, 4, total) == b"\x7fELF":
                executables.append(read_at(file, extent * 2048, size, total))
        for component in ("DATA", "TEXTURES"):
            entries = directory(file, *entries[component], total)
        bank = read_at(file, entries["PARTICLE.SSH"][0] * 2048, entries["PARTICLE.SSH"][1], total)
        if bank[:4] != b"SHPS":
            raise ValueError("Expected shared sprite-bank directory")
        count = struct.unpack_from("<I", bank, 8)[0]
        if count > 256 or 16 + count * 8 > len(bank):
            raise ValueError("Invalid sprite-bank name directory")
        images = {bank[16 + i * 8 : 20 + i * 8].decode("ascii").rstrip("\0") for i in range(count)}
    candidates = []
    for executable in executables:
        at = 0
        while True:
            at = executable.find(b"part", at)
            if at < 0:
                break
            if at % 4 == 0 and all(
                executable[at + i * 12 : at + i * 12 + 4] == name
                for i, name in ((0, b"part"), (2, b"clod"), (19, b"str2"), (23, b"tral"))
            ):
                names = []
                for i in range(256):
                    raw = executable[at + i * 12 : at + i * 12 + 4]
                    try:
                        name = raw.decode("ascii").rstrip("\0")
                    except UnicodeDecodeError:
                        break
                    if name not in images:
                        break
                    names.append(name)
                candidates.append(names)
            at += 1
    if len(candidates) != 1:
        raise ValueError(f"Expected one anchored registration table, found {len(candidates)}")
    return candidates[0]


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python tools/contracts/check-particle-contract.py <user-supplied-iso>")
    expected = json.loads((Path(__file__).resolve().parents[2] / "Contracts/particle-sprites-v1.json").read_text())
    actual = registry(Path(sys.argv[1]))
    if actual != expected["sprites"]:
        raise SystemExit("Particle registration contract differs from the supplied image")
    duplicates = {name: count for name, count in collections.Counter(actual).items() if count > 1}
    print(
        f"PASS: {len(actual)} particle registrations; preserved duplicates {duplicates}; no addresses or media exported"
    )
