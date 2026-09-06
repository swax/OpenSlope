#!/usr/bin/env python3
"""Tests for patch_hygiene.check_manifest.

A scanner nobody has watched fail is a scanner that passes for the wrong reason, so each case
below builds a manifest that is wrong in exactly one way and asserts the check says so. The
words used as payload are invented for the test.

    python Trailmap/tools/specs/test_patch_hygiene.py
"""

from __future__ import annotations

import json
import struct
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from patch_hygiene import BREAK, check_manifest  # noqa: E402

FAILURES: list[str] = []


def manifest(regions, version=3) -> Path:
    doc = {"name": "test", "target": "TEST", "formatVersion": version, "regions": regions}
    path = Path(tempfile.mkdtemp()) / "test.TEST.json"
    path.write_text(json.dumps(doc))
    return path


def region(words, grafts=None, offset=0x100):
    blob = struct.pack(f"<{len(words)}I", *words)
    out = {
        "fileOffset": offset,
        "length": len(blob),
        "originalSha256": "0" * 64,
        "patched": blob.hex(),
    }
    if grafts is not None:
        out["graft"] = grafts
    return out


def check(condition, label):
    print(f"{'ok  ' if condition else 'FAIL'} {label}")
    if not condition:
        FAILURES.append(label)


def problems_for(*args, **kwargs) -> list[str]:
    return check_manifest(manifest(*args, **kwargs))


GRAFT = [{"at": 8, "fromFileOffset": 0x40, "length": 4}]


def run() -> int:
    check(problems_for([region([0x11111111, 0x22222222, BREAK], GRAFT)]) == [],
          "a well-formed grafted region passes")

    check(problems_for([region([0x11111111, 0x22222222])]) == [],
          "a region with no graft and no break passes")

    # The regression this whole check exists for: a displaced retail instruction written into
    # the window instead of a copy directive.
    found = problems_for([region([0x11111111, 0x22222222, 0x24020001], GRAFT)])   # any word but `break`
    check(any("not `break`" in p for p in found),
          "a real instruction inside a graft window is caught")

    # Half a change: the placeholder is there but nothing declares it, so apply never fills it.
    found = problems_for([region([0x11111111, 0x22222222, BREAK])])
    check(any("outside every graft window" in p for p in found),
          "a break with no graft covering it is caught")

    found = problems_for([region([0x11111111, BREAK], [{"at": 4, "fromFileOffset": 0x40, "length": 8}])])
    check(any("outside its" in p for p in found),
          "a graft window running past the payload is caught")

    found = problems_for([region([0x11111111, 0x22222222, BREAK], GRAFT)], version=2)
    check(any("does not define" in p for p in found),
          "a graft in formatVersion 2 is caught")

    found = problems_for([region([0x11111111, 0x22222222, BREAK], GRAFT)], version=9)
    check(any("outside the supported" in p for p in found),
          "an unknown formatVersion is caught")

    # Inside the payload, so it gets past the bounds check and reaches the alignment one.
    found = problems_for([region([0x11111111, BREAK, 0x33333333, 0x44444444],
                                 [{"at": 6, "fromFileOffset": 0x40, "length": 4}])])
    check(any("not instruction-aligned" in p for p in found),
          "an unaligned graft window is caught")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s)", file=sys.stderr)
        return 1
    print("patch_hygiene tests pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
