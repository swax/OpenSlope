#!/usr/bin/env python3
"""Reversible collision/effect-dispatch trace for SSX Tricky PAL via PCSX2 PINE.

The VM must be paused for install/uninstall. The probe temporarily borrows the vetted
noclip code cave, restores every overwritten word exactly, and records counters plus
registers for both collision entry paths, collision-thread construction, and SSF main
types 2 (particle), 7 (play effect on instance), and 17 (speed boost).

  python tools/instrumentation/effect_dispatch_probe.py install
  python tools/instrumentation/effect_dispatch_probe.py capture --seconds 30
  python tools/instrumentation/effect_dispatch_probe.py uninstall
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
from datetime import datetime, timezone
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
MAGIC = 0x44585030  # "0PXD" in little-endian memory
STATE_FILE = Path("temp/p0-effects/effect-dispatch-probe-state.json")

# Function-entry hooks execute and replace two known-safe prologue words: name -> (site, SHA-256 of
# that pair). The words are read out of the emulator at install and digest-checked; none is carried here.
CODE_PROBES = {
    "contact": (0x0013AB00, "05279cb88a44dcfe85b4fffe123a07e803907f39ab3f41cf931c7ae8dc274cba"),
    "construct": (0x0013B8C8, "05279cb88a44dcfe85b4fffe123a07e803907f39ab3f41cf931c7ae8dc274cba"),
    "getcreate": (0x0013BD48, "05279cb88a44dcfe85b4fffe123a07e803907f39ab3f41cf931c7ae8dc274cba"),
}

# Jump-table hooks replace a data pointer, log without displacing code, then jump to
# the exact original handler. Type 2's table arm is 0x13c05c; it later dispatches by subtype.
TABLE_BASE = 0x0036C830
TABLE_PROBES = {
    "type2": (TABLE_BASE + 2 * 4, 0x0013C05C),
    "type7": (TABLE_BASE + 7 * 4, 0x0013C2EC),
    "type17": (TABLE_BASE + 17 * 4, 0x0013C408),
}

PROBE_NAMES = tuple(CODE_PROBES) + tuple(TABLE_PROBES)
SLOT_WORDS = 10
SLOT_BASE = {
    name: DATA_BASE + 0x10 + i * SLOT_WORDS * 4 for i, name in enumerate(PROBE_NAMES)
}


def require_vm_paused(pine: Pine, operation: str):
    status = pine.status()
    if status != 1:
        states = {0: "running", 1: "paused", 2: "shutdown"}
        raise RuntimeError(
            f"Refusing to {operation} while the PCSX2 VM is {states.get(status, f'unknown:{status}')}. "
            "Pause emulation in PCSX2 itself (not only SSX's in-game pause menu), then retry."
        )


def read_words(pine: Pine, addr: int, count: int) -> list[int]:
    return [pine.r32(addr + i * 4) for i in range(count)]


def write_words(pine: Pine, addr: int, words: list[int]):
    for i, word in enumerate(words):
        pine.w32(addr + i * 4, word)


def emit_log(a: Asm, name: str):
    """Log with k0/k1 so the dispatcher handler sees its incoming registers unchanged."""
    hi, lo = hi_base(SLOT_BASE[name])
    a.lui("k0", hi)
    a.lw("k1", lo, "k0")
    a.addiu("k1", "k1", 1)
    a.sw("k1", lo, "k0")
    for index, reg in enumerate(("a0", "a1", "a2", "a3", "ra", "sp", "s0", "s1", "v0"), start=1):
        a.sw(reg, lo + index * 4, "k0")


def build_code_hook(name: str, base: int, original: list[int]) -> bytes:
    """`original` is the digest-checked prologue pair read from the site at install time."""
    site, _ = CODE_PROBES[name]
    a = Asm(base)
    a.word(original[0])
    a.word(original[1])
    emit_log(a, name)
    a.j(site + 8)
    a.nop()
    return a.assemble()


def build_table_hook(name: str, base: int) -> bytes:
    _, handler = TABLE_PROBES[name]
    a = Asm(base)
    emit_log(a, name)
    a.j(handler)
    a.nop()
    return a.assemble()


def build_hooks(originals: dict[str, list[int]]) -> tuple[dict[str, tuple[int, bytes]], int]:
    hooks: dict[str, tuple[int, bytes]] = {}
    cursor = CODE_BASE
    for name in PROBE_NAMES:
        blob = (build_code_hook(name, cursor, originals[name]) if name in CODE_PROBES
                else build_table_hook(name, cursor))
        hooks[name] = (cursor, blob)
        cursor = (cursor + len(blob) + 15) & ~15
    if cursor > CAVE_END:
        raise RuntimeError(f"Probe cave overflow: 0x{cursor:08x} > 0x{CAVE_END:08x}")
    return hooks, cursor


def install() -> int:
    if STATE_FILE.exists():
        raise RuntimeError(f"Probe state already exists ({STATE_FILE}); uninstall before installing again.")
    pine = Pine()
    require_vm_paused(pine, "install executable hooks")

    code_words: dict[str, list[int]] = {}
    for name, (site, digest) in CODE_PROBES.items():
        words = read_words(pine, site, 2)
        if not is_stock(words, digest):
            raise RuntimeError(f"Code site {name} @0x{site:08x} is not stock: {words_hex(words)}")
        code_words[name] = words

    table_words: dict[str, int] = {}
    for name, (entry, handler) in TABLE_PROBES.items():
        word = pine.r32(entry)
        if word != handler:
            raise RuntimeError(
                f"Jump-table entry {name} @0x{entry:08x} is 0x{word:08x}, expected 0x{handler:08x}"
            )
        table_words[name] = word

    noclip_words: dict[str, list[int]] = {}
    for name, (site, _, _) in NOCLIP_SITES.items():
        state = noclip_site_state(pine, name)
        if not (state == "stock" or state == "hooked"):
            raise RuntimeError(f"Noclip site {name} is {state}; refusing to overwrite its cave.")
        noclip_words[name] = read_words(pine, site, 2)

    cave_words = read_words(pine, CAVE_BASE, (CAVE_END - CAVE_BASE) // 4)
    hooks, cursor = build_hooks(code_words)
    saved_state = {
        "caveWords": cave_words,
        "codeSites": code_words,
        "tableEntries": table_words,
        "noclipSites": noclip_words,
    }
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(saved_state, indent=1) + "\n")

    try:
        # Stop all branches into the borrowed cave before replacing it. A detoured site gets its
        # stock words copied back from the operator's own executable.
        for name in NOCLIP_SITES:
            restore_stock(pine, name)
        write_words(pine, CAVE_BASE, [0] * ((CAVE_END - CAVE_BASE) // 4))
        pine.w32(DATA_BASE, MAGIC)
        pine.w32(DATA_BASE + 4, 1)
        for addr, blob in hooks.values():
            write_words(pine, addr, list(struct.unpack(f"<{len(blob) // 4}I", blob)))
        for name, (site, _) in CODE_PROBES.items():
            pine.w32(site, j_ins(hooks[name][0]))
            pine.w32(site + 4, 0)
        for name, (entry, _) in TABLE_PROBES.items():
            pine.w32(entry, hooks[name][0])

        if pine.r32(DATA_BASE) != MAGIC:
            raise RuntimeError("Probe data magic did not verify after install.")
        for name, (site, _) in CODE_PROBES.items():
            if read_words(pine, site, 2) != [j_ins(hooks[name][0]), 0]:
                raise RuntimeError(f"Code hook {name} failed install verification.")
        for name, (entry, _) in TABLE_PROBES.items():
            if pine.r32(entry) != hooks[name][0]:
                raise RuntimeError(f"Jump-table hook {name} failed install verification.")
    except Exception:
        try:
            for name, (site, _) in CODE_PROBES.items():
                write_words(pine, site, saved_state["codeSites"][name])
            for name, (entry, _) in TABLE_PROBES.items():
                pine.w32(entry, saved_state["tableEntries"][name])
            write_words(pine, CAVE_BASE, saved_state["caveWords"])
            for name, (site, _, _) in NOCLIP_SITES.items():
                write_words(pine, site, saved_state["noclipSites"][name])
            STATE_FILE.unlink()
        except Exception as rollback_error:
            raise RuntimeError(
                f"Probe install failed and rollback also failed; recover with uninstall using {STATE_FILE}"
            ) from rollback_error
        raise

    print(
        f"Effect-dispatch probe installed; cave 0x{CAVE_BASE:08x}..0x{cursor:08x}; "
        f"saved exact live state to {STATE_FILE}"
    )
    return 0


def uninstall() -> int:
    if not STATE_FILE.exists():
        raise RuntimeError(f"No saved probe state at {STATE_FILE}.")
    state = json.loads(STATE_FILE.read_text())
    pine = Pine()
    require_vm_paused(pine, "restore executable hooks")

    # Stop every probe entry before restoring its code cave and prior noclip state.
    for name, (site, _) in CODE_PROBES.items():
        write_words(pine, site, state["codeSites"][name])
    for name, (entry, _) in TABLE_PROBES.items():
        pine.w32(entry, state["tableEntries"][name])
    write_words(pine, CAVE_BASE, state["caveWords"])
    for name, (site, _, _) in NOCLIP_SITES.items():
        write_words(pine, site, state["noclipSites"][name])

    for name, (site, _) in CODE_PROBES.items():
        if read_words(pine, site, 2) != state["codeSites"][name]:
            raise RuntimeError(f"Code site {name} failed restore verification; recovery state retained.")
    for name, (entry, _) in TABLE_PROBES.items():
        if pine.r32(entry) != state["tableEntries"][name]:
            raise RuntimeError(f"Jump-table entry {name} failed restore verification; recovery state retained.")
    if read_words(pine, CAVE_BASE, len(state["caveWords"])) != state["caveWords"]:
        raise RuntimeError("Borrowed cave failed restore verification; recovery state retained.")
    for name, (site, _, _) in NOCLIP_SITES.items():
        if read_words(pine, site, 2) != state["noclipSites"][name]:
            raise RuntimeError(f"Noclip site {name} failed restore verification; recovery state retained.")
    STATE_FILE.unlink()
    print("Effect-dispatch probe removed; code, jump table, cave, and noclip state restored exactly.")
    return 0


def snapshot(pine: Pine) -> dict[str, dict[str, int]]:
    result: dict[str, dict[str, int]] = {}
    keys = ("count", "a0", "a1", "a2", "a3", "ra", "sp", "s0", "s1", "v0")
    for name, addr in SLOT_BASE.items():
        result[name] = dict(zip(keys, read_words(pine, addr, SLOT_WORDS)))
    return result


def capture(seconds: float, out: Path) -> int:
    pine = Pine()
    if pine.r32(DATA_BASE) != MAGIC:
        raise RuntimeError("Effect-dispatch probe is not installed.")
    started = time.monotonic()
    initial = snapshot(pine)
    previous = initial
    events: list[dict] = []
    while time.monotonic() - started < seconds:
        current = snapshot(pine)
        elapsed = time.monotonic() - started
        for name, item in current.items():
            if item["count"] != previous[name]["count"]:
                events.append(
                    {
                        "seconds": round(elapsed, 4),
                        "site": name,
                        "count": item["count"],
                        "delta": (item["count"] - previous[name]["count"]) & 0xFFFFFFFF,
                        "registers": item,
                    }
                )
        previous = current
        time.sleep(0.02)
    final = snapshot(pine)
    deltas = {
        name: (final[name]["count"] - initial[name]["count"]) & 0xFFFFFFFF for name in PROBE_NAMES
    }
    doc = {
        "kind": "ssx-tricky-effect-dispatch-runtime-capture",
        "capturedAtUtc": datetime.now(timezone.utc).isoformat(),
        "durationSeconds": seconds,
        "initial": initial,
        "final": final,
        "deltas": deltas,
        "events": events,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n")
    print("Capture deltas: " + ", ".join(f"{name}={value}" for name, value in deltas.items()))
    print(f"Saved {len(events)} sampled changes -> {out}")
    return 0


def status() -> int:
    pine = Pine()
    vm_status = pine.status()
    states = {0: "running", 1: "paused", 2: "shutdown"}
    print(f"VM status: {states.get(vm_status, f'unknown:{vm_status}')}")
    installed = pine.r32(DATA_BASE) == MAGIC
    print(f"probe: {'installed' if installed else 'not installed'}")
    if installed:
        for name, item in snapshot(pine).items():
            print(
                f"  {name:9s}: count={item['count']} a0=0x{item['a0']:08x} "
                f"a1=0x{item['a1']:08x} s0=0x{item['s0']:08x} s1=0x{item['s1']:08x}"
            )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install")
    sub.add_parser("uninstall")
    sub.add_parser("status")
    cap = sub.add_parser("capture")
    cap.add_argument("--seconds", type=float, default=30.0)
    cap.add_argument("--out", type=Path, default=Path("temp/p0-effects/effect-dispatch-capture.json"))
    args = parser.parse_args()
    if args.command == "install":
        return install()
    if args.command == "uninstall":
        return uninstall()
    if args.command == "capture":
        return capture(args.seconds, args.out)
    return status()


if __name__ == "__main__":
    raise SystemExit(main())
