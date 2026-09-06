#!/usr/bin/env python3
"""Hot-install / revert the noclip patch in a running PCSX2 via PINE.

Writes every word that differs between the stock and patched ELF into EE RAM
(caves first, then the three hook sites), verifying each write by readback.
Best done while the VM is paused in-level.

  python tools/instrumentation/pine_install.py install    copy noclip patch bytes into RAM
  python tools/instrumentation/pine_install.py revert     restore stock bytes
"""

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from pine_hooks import Pine, SITES  # noqa: E402

# Anchored to this file, not the cwd, so both paths resolve the same way
# whether the command is run from the repo root or from a parent workspace.
EXTRACTED = Path(__file__).resolve().parents[2] / "extracted"
ELF_STOCK = EXTRACTED / "SLES_505.45"
ELF_PATCH = EXTRACTED / "SLES_505.45.noclip"
TEXT_VADDR, TEXT_FOFF = 0x00100000, 0x1000

HOOK_SITE_VADDRS = {site for site, _, _ in SITES.values()} | \
                   {site + 4 for site, _, _ in SITES.values()}


def diff_words():
    stock = ELF_STOCK.read_bytes()
    patch = ELF_PATCH.read_bytes()
    assert len(stock) == len(patch)
    out = []
    for off in range(0, len(stock), 4):
        if stock[off:off + 4] != patch[off:off + 4]:
            va = off - TEXT_FOFF + TEXT_VADDR
            s, = struct.unpack_from("<I", stock, off)
            n, = struct.unpack_from("<I", patch, off)
            out.append((va, s, n))
    return out


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("install", "revert"):
        print(__doc__)
        return 1

    words = diff_words()
    caves = [(va, s, n) for va, s, n in words if va not in HOOK_SITE_VADDRS]
    sites = [(va, s, n) for va, s, n in words if va in HOOK_SITE_VADDRS]
    print(f"{len(words)} differing words ({len(caves)} cave, {len(sites)} hook-site)")

    p = Pine()
    # install: caves before sites; revert: sites before caves
    order = caves + sites if mode == "install" else sites + caves
    fails = 0
    for va, s, n in order:
        val = n if mode == "install" else s
        p.w32(va, val)
        got = p.r32(va)
        if got != val:
            print(f"  VERIFY FAIL @0x{va:08x}: wrote 0x{val:08x} read 0x{got:08x}")
            fails += 1
    print(f"{mode} complete, {fails} verify failures")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
