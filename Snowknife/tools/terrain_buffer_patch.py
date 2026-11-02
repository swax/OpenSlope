#!/usr/bin/env python3
"""Reproduce the terrain-buffer descriptor from the owner's supported boot ELF."""

import argparse
import hashlib
import json
import struct
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--elf", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--emit-patch", type=Path, required=True)
    args = parser.parse_args()
    definition = (
        Path(__file__).resolve().parents[1]
        / "Snowknife/Patches"
        / f"terrain-buffer.{args.elf.name}.json"
    )
    if not definition.is_file():
        parser.error("Unsupported terrain-buffer target")
    doc = json.loads(definition.read_text())
    original = args.elf.read_bytes()
    if len(original) != doc["targetSize"] or original[:4] != b"\x7fELF":
        parser.error("Unsupported executable size or header")
    phoff = struct.unpack_from("<I", original, 28)[0]
    phsize, phcount = struct.unpack_from("<HH", original, 42)
    modified = bytearray(original)
    for region, address, register in zip(
        doc["regions"], doc["runtimeAddresses"], (5, 6), strict=True
    ):
        offset = region["fileOffset"]
        # Prove that PNACH and ISO writes refer to the same instruction in this ELF's load segments.
        matches = []
        for index in range(phcount):
            kind, start, virtual, _, length = struct.unpack_from(
                "<5I", original, phoff + index * phsize
            )
            if kind == 1 and virtual <= address < virtual + length:
                matches.append(start + address - virtual)
        if matches != [offset]:
            parser.error("Executable segment mapping does not match the patch address")
        region["originalSha256"] = hashlib.sha256(
            original[offset : offset + 4]
        ).hexdigest()
        # These two newly assembled instructions are the entire payload; no displaced game words are copied.
        payload = struct.pack("<I", 60 << 24 | register << 16 | 6)
        region["patched"] = payload.hex()
        modified[offset : offset + 4] = payload
    args.out.write_bytes(modified)
    args.emit_patch.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
