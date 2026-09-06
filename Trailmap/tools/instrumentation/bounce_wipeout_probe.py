#!/usr/bin/env python3
"""Reversible caller counter for SSX Tricky's prop-impact wipeout paths.

The VM must be paused for install/uninstall. The probe temporarily borrows the
vetted noclip code cave, restores every overwritten word exactly, and counts:

* the hard-impact branch in the player-bounce response;
* the SurfaceType 6/10 lateral-impact branch in ground motion; and
* all entries to Boarder_EnterWipeOut.

  python tools/instrumentation/bounce_wipeout_probe.py install
  python tools/instrumentation/bounce_wipeout_probe.py status
  python tools/instrumentation/bounce_wipeout_probe.py uninstall
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_DIR / "patches"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from noclip_patch import Asm, hi_base  # noqa: E402
from pine_hooks import (  # noqa: E402
    Pine, SITES as NOCLIP_SITES, is_stock, j_ins, noclip_site_state, restore_stock, words_hex,
)

CAVE_BASE = 0x002B4C40
CAVE_END = 0x002B50C0
DATA_BASE = CAVE_BASE
CODE_BASE = CAVE_BASE + 0x100
MAGIC = 0x42575030  # "0PWB" in little-endian memory
STATE_FILE = Path("temp/p0-bounce/bounce-wipeout-probe-state.json")

ENTER_WIPEOUT = 0x0011D838
# name -> (site, SHA-256 of the two stock words the hook displaces and replays). The words themselves
# are read out of the emulator at install and checked against the digest; this file does not carry them.
PROBES = {
    # Each call site holds a jal plus its delay slot.
    "bounce": (0x0012665C, "9255a806be275395483089aa0e2ae0458c43630f2d06998dbb714083c0b124a4"),
    "surface": (0x0010AC3C, "bcb2dc53773fa0696157dd5960e8eaddf3fa61a06a1eebd5bf49c759ece6f491"),
    # The function entry holds the first two prologue words.
    "total": (ENTER_WIPEOUT, "2289ebd31dcc61107e6ab58323ff9bf0e312dc076095573279bdc601df430d8d"),
}
SLOT_WORDS = 5
SLOT_BASE = {
    name: DATA_BASE + 0x10 + index * SLOT_WORDS * 4
    for index, name in enumerate(PROBES)
}


def require_vm_paused(pine: Pine, operation: str):
    status = pine.status()
    if status != 1:
        states = {0: "running", 1: "paused", 2: "shutdown"}
        raise RuntimeError(
            f"Refusing to {operation} while the PCSX2 VM is "
            f"{states.get(status, f'unknown:{status}')}. Pause emulation in PCSX2 itself first."
        )


def read_words(pine: Pine, addr: int, count: int) -> list[int]:
    return [pine.r32(addr + index * 4) for index in range(count)]


def write_words(pine: Pine, addr: int, words: list[int]):
    for index, word in enumerate(words):
        pine.w32(addr + index * 4, word)


def emit_log(a: Asm, name: str):
    """Increment and snapshot with k0/k1, preserving caller-visible registers."""
    hi, lo = hi_base(SLOT_BASE[name])
    a.lui("k0", hi)
    a.lw("k1", lo, "k0")
    a.addiu("k1", "k1", 1)
    a.sw("k1", lo, "k0")
    for index, register in enumerate(("a0", "a1", "a2", "ra"), start=1):
        a.sw(register, lo + index * 4, "k0")


def emit_expected_ra(a: Asm, return_address: int):
    # addiu sign-extends its immediate, so bias the high half when bit 15 is set.
    hi = ((return_address + 0x8000) >> 16) & 0xFFFF
    lo = return_address & 0xFFFF
    a.lui("ra", hi)
    a.addiu("ra", "ra", lo)


def build_hook(name: str, base: int, original: list[int]) -> bytes:
    """`original` is the digest-checked pair read from the site at install time."""
    site, _ = PROBES[name]
    a = Asm(base)
    if name == "total":
        # Replay the displaced Boarder_EnterWipeOut prologue before observing it.
        a.word(original[0])
        a.word(original[1])
        emit_log(a, name)
        a.j(site + 8)
        a.nop()
        return a.assemble()

    emit_log(a, name)
    a.jal(ENTER_WIPEOUT)
    a.word(original[1])
    # A real jal at the call site leaves ra equal to the instruction after its
    # delay slot. Restore that value after the detoured call returns.
    emit_expected_ra(a, site + 8)
    a.j(site + 8)
    a.nop()
    return a.assemble()


def build_hooks(originals: dict[str, list[int]]) -> tuple[dict[str, tuple[int, bytes]], int]:
    hooks: dict[str, tuple[int, bytes]] = {}
    cursor = CODE_BASE
    for name in PROBES:
        blob = build_hook(name, cursor, originals[name])
        hooks[name] = (cursor, blob)
        cursor = (cursor + len(blob) + 15) & ~15
    if cursor > CAVE_END:
        raise RuntimeError(f"Probe cave overflow: 0x{cursor:08x} > 0x{CAVE_END:08x}")
    return hooks, cursor


def install() -> int:
    if STATE_FILE.exists():
        raise RuntimeError(f"Probe state already exists ({STATE_FILE}); uninstall first.")
    pine = Pine()
    require_vm_paused(pine, "install executable hooks")

    probe_words: dict[str, list[int]] = {}
    for name, (site, digest) in PROBES.items():
        words = read_words(pine, site, 2)
        if not is_stock(words, digest):
            raise RuntimeError(f"Probe site {name} @0x{site:08x} is not stock: {words_hex(words)}")
        probe_words[name] = words

    noclip_words: dict[str, list[int]] = {}
    for name, (site, _, _) in NOCLIP_SITES.items():
        state = noclip_site_state(pine, name)
        if state not in ("stock", "hooked"):
            raise RuntimeError(f"Noclip site {name} is {state}; refusing to borrow its cave.")
        noclip_words[name] = read_words(pine, site, 2)

    cave_words = read_words(pine, CAVE_BASE, (CAVE_END - CAVE_BASE) // 4)
    hooks, cursor = build_hooks(probe_words)
    saved_state = {
        "caveWords": cave_words,
        "probeSites": probe_words,
        "noclipSites": noclip_words,
    }
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(saved_state, indent=1) + "\n")

    try:
        # Stop every branch into the shared cave before replacing it. A detoured site gets its
        # stock words copied back from the operator's own executable.
        for name in NOCLIP_SITES:
            restore_stock(pine, name)
        write_words(pine, CAVE_BASE, [0] * ((CAVE_END - CAVE_BASE) // 4))
        pine.w32(DATA_BASE, MAGIC)
        pine.w32(DATA_BASE + 4, 1)
        for address, blob in hooks.values():
            write_words(pine, address, list(struct.unpack(f"<{len(blob) // 4}I", blob)))
        for name, (site, _) in PROBES.items():
            pine.w32(site, j_ins(hooks[name][0]))
            pine.w32(site + 4, 0)

        if pine.r32(DATA_BASE) != MAGIC:
            raise RuntimeError("Probe data magic did not verify after install.")
        for name, (site, _) in PROBES.items():
            if read_words(pine, site, 2) != [j_ins(hooks[name][0]), 0]:
                raise RuntimeError(f"Probe hook {name} failed install verification.")
    except Exception:
        try:
            for name, (site, _) in PROBES.items():
                write_words(pine, site, saved_state["probeSites"][name])
            write_words(pine, CAVE_BASE, saved_state["caveWords"])
            for name, (site, _, _) in NOCLIP_SITES.items():
                write_words(pine, site, saved_state["noclipSites"][name])
            STATE_FILE.unlink()
        except Exception as rollback_error:
            raise RuntimeError(
                f"Install and rollback failed; recover with uninstall using {STATE_FILE}"
            ) from rollback_error
        raise

    print(
        f"Bounce-wipeout probe installed; cave 0x{CAVE_BASE:08x}..0x{cursor:08x}; "
        f"saved exact live state to {STATE_FILE}"
    )
    return 0


def uninstall() -> int:
    if not STATE_FILE.exists():
        raise RuntimeError(f"No saved probe state at {STATE_FILE}.")
    state = json.loads(STATE_FILE.read_text())
    pine = Pine()
    require_vm_paused(pine, "restore executable hooks")

    for name, (site, _) in PROBES.items():
        write_words(pine, site, state["probeSites"][name])
    write_words(pine, CAVE_BASE, state["caveWords"])
    for name, (site, _, _) in NOCLIP_SITES.items():
        write_words(pine, site, state["noclipSites"][name])

    for name, (site, _) in PROBES.items():
        if read_words(pine, site, 2) != state["probeSites"][name]:
            raise RuntimeError(f"Probe site {name} failed restore; recovery state retained.")
    if read_words(pine, CAVE_BASE, len(state["caveWords"])) != state["caveWords"]:
        raise RuntimeError("Borrowed cave failed restore; recovery state retained.")
    for name, (site, _, _) in NOCLIP_SITES.items():
        if read_words(pine, site, 2) != state["noclipSites"][name]:
            raise RuntimeError(f"Noclip site {name} failed restore; recovery state retained.")
    STATE_FILE.unlink()
    print("Bounce-wipeout probe removed; code, cave, and noclip state restored exactly.")
    return 0


def snapshot(pine: Pine) -> dict[str, dict[str, int]]:
    keys = ("count", "a0", "a1", "a2", "ra")
    return {
        name: dict(zip(keys, read_words(pine, address, SLOT_WORDS)))
        for name, address in SLOT_BASE.items()
    }


def status() -> int:
    pine = Pine()
    states = {0: "running", 1: "paused", 2: "shutdown"}
    vm_status = pine.status()
    print(f"VM status: {states.get(vm_status, f'unknown:{vm_status}')}")
    installed = pine.r32(DATA_BASE) == MAGIC
    print(f"probe: {'installed' if installed else 'not installed'}")
    if installed:
        for name, item in snapshot(pine).items():
            print(
                f"  {name:7s}: count={item['count']} a0=0x{item['a0']:08x} "
                f"a1=0x{item['a1']:08x} a2=0x{item['a2']:08x} ra=0x{item['ra']:08x}"
            )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "status", "uninstall"))
    args = parser.parse_args()
    if args.command == "install":
        return install()
    if args.command == "uninstall":
        return uninstall()
    return status()


if __name__ == "__main__":
    raise SystemExit(main())
