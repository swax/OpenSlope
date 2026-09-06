#!/usr/bin/env python3
"""Structural check on the shipped executable-patch definitions.

The rule these files exist under is that `patched` carries this project's own hook code and
nothing of the game's. One thing would otherwise break it: a trampoline has to re-execute the
instruction its branch displaced, and that instruction is retail. The format's answer is a
`graft` -- a window in the payload that names where to copy those bytes from in the reader's
own executable, and that reads as MIPS `break` until apply fills it in.

This checks the invariants that keep the rule true, without needing an executable:

  1. `formatVersion` is one the reader understands, and `graft` appears only in a version
     that defines it.
  2. Every graft window lies inside its region's payload.
  3. Every graft window reads as `break` in the published bytes -- so a window is never
     shipped holding a real instruction.
  4. No `break` appears OUTSIDE a graft window. A hook that re-executes displaced words
     without declaring them would leave the payload without its placeholder; this is the
     cheap half of catching that.

The other half needs the reader's own disc and lives in `../patches/verify_manifests.py`,
which regenerates every manifest from the boot executable in an image under `discs/` and
requires byte-equality with the tracked file. `npm run verify:full` runs it; the fast gate
cannot, having no disc.

    python Trailmap/tools/specs/patch_hygiene.py check
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

PATCHES = Path(__file__).resolve().parents[3] / "Snowknife" / "Snowknife" / "Patches"

BREAK = 0x0000000D
MIN_VERSION, MAX_VERSION = 2, 3


def words(blob: bytes):
    for i in range(0, len(blob) - 3, 4):
        yield i, struct.unpack_from("<I", blob, i)[0]


def check_manifest(path: Path) -> list[str]:
    problems: list[str] = []
    doc = json.loads(path.read_text())
    version = doc.get("formatVersion", 0)
    if not isinstance(version, int) or not MIN_VERSION <= version <= MAX_VERSION:
        problems.append(f"formatVersion {version!r} is outside the supported {MIN_VERSION}-{MAX_VERSION}")

    for region in doc.get("regions", []):
        offset = region["fileOffset"]
        where = f"region @0x{offset:x}"
        blob = bytes.fromhex(region["patched"])
        if len(blob) != region["length"]:
            problems.append(f"{where}: length {region['length']} but {len(blob)} B of payload")

        grafts = region.get("graft", [])
        if grafts and version < 3:
            problems.append(f"{where}: carries a graft, which formatVersion {version} does not define")

        covered: set[int] = set()
        for graft in grafts:
            at, length = graft["at"], graft["length"]
            if at < 0 or length <= 0 or at + length > len(blob):
                problems.append(f"{where}: graft window {at}+{length} is outside its {len(blob)} B payload")
                continue
            if at % 4 or length % 4:
                problems.append(f"{where}: graft window {at}+{length} is not instruction-aligned")
                continue
            covered.update(range(at, at + length))
            for i in range(at, at + length, 4):
                got = struct.unpack_from("<I", blob, i)[0]
                if got != BREAK:
                    problems.append(
                        f"{where}: graft window byte {i} publishes 0x{got:08x}, not `break` -- "
                        "a displaced instruction may have been written into the manifest")

        for i, word in words(blob):
            if word == BREAK and i not in covered:
                problems.append(f"{where}: `break` at byte {i} is outside every graft window")

    return problems


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] != "check":
        print(__doc__)
        return 2
    manifests = sorted(PATCHES.glob("*.json"))
    if not manifests:
        print(f"patch_hygiene: no manifests found under {PATCHES}", file=sys.stderr)
        return 1

    total = 0
    for path in manifests:
        problems = check_manifest(path)
        total += len(problems)
        for problem in problems:
            print(f"{path.name}: {problem}", file=sys.stderr)

    grafted = sum(
        len(r.get("graft", []))
        for p in manifests
        for r in json.loads(p.read_text()).get("regions", [])
    )
    if total:
        print(f"\npatch_hygiene: {total} problem(s) across {len(manifests)} manifest(s)", file=sys.stderr)
        return 1
    print(f"patch_hygiene: {len(manifests)} manifests clean, {grafted} graft window(s) declared")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
