#!/usr/bin/env python3
"""Reversible live emitter probe for SSX Tricky PAL via PCSX2 PINE.

The probe temporarily borrows the already-vetted dead-code cave used by the noclip patch. It saves
that cave and every affected hook word before installation, disables the noclip detours, and restores
the exact live state on uninstall. P6/P7 logging is filtered to the emitter call at 0x001d91e0, so
board-spray traffic does not overwrite the particle-emitter capture.

  # Pause the emulated VM in PCSX2 itself first (not the game's pause menu).
  python tools/instrumentation/emitter_probe.py install
  # Resume the VM and the game for capture, then pause the VM again before uninstall.
  python tools/instrumentation/emitter_probe.py status
  python tools/instrumentation/emitter_probe.py capture --seconds 15 --out temp/p0-effects/emitter-capture.json
  python tools/instrumentation/emitter_probe.py uninstall
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
MAGIC = 0x45585030  # "0PXE" in little-endian memory
STATE_FILE = Path("temp/p0-effects/emitter-probe-state.json")

# name: (entry, SHA-256 of the two displaced stock words, optional caller return-address filter).
# The words are read out of the emulator at install and digest-checked; none is carried here.
PROBES = {
    "read": (0x001D8988, "13386dc38931140db66f84c6d69cebb86dc1417cf1a4be20d4a9bb700ae4a579", None),
    "spawn": (0x001D90C0, "b2afe15c82c445ad278400f092f3159d0b9616229b98c7ad2cd9c67f3bfbc70a", None),
    "p6": (0x001E2F58, "a77149d867d88a4234c88910644109e98527cab630214b1ddc39b470fa1b32b9", 0x001D91E8),
    "p7": (0x001E3358, "a77149d867d88a4234c88910644109e98527cab630214b1ddc39b470fa1b32b9", 0x001D91E8),
}
SLOT_WORDS = 8
SLOT_BASE = {name: DATA_BASE + 0x10 + i * SLOT_WORDS * 4 for i, name in enumerate(PROBES)}


def require_vm_paused(pine: Pine, operation: str):
    status = pine.status()
    if status != 1:
        states = {0: "running", 1: "paused", 2: "shutdown"}
        raise RuntimeError(
            f"Refusing to {operation} while the PCSX2 VM is {states.get(status, f'unknown:{status}')}. "
            "Pause emulation in PCSX2 itself (not only SSX's in-game pause menu), then retry."
        )


def ori(a: Asm, rt: str, rs: str, imm: int):
    regs = {
        n: i for i, n in enumerate(
            "zero at v0 v1 a0 a1 a2 a3 t0 t1 t2 t3 t4 t5 t6 t7 "
            "s0 s1 s2 s3 s4 s5 s6 s7 t8 t9 k0 k1 gp sp fp ra".split()
        )
    }
    a.word(0x34000000 | (regs[rs] << 21) | (regs[rt] << 16) | (imm & 0xFFFF))


def build_hook(name: str, base: int, original: list[int]) -> bytes:
    """`original` is the digest-checked pair read from the site at install time."""
    site, _, caller = PROBES[name]
    data = SLOT_BASE[name]
    a = Asm(base)
    a.word(original[0])
    a.word(original[1])
    if caller is not None:
        a.lui("t8", caller >> 16)
        ori(a, "t8", "t8", caller & 0xFFFF)
        a.bne("ra", "t8", "done")
        a.nop()
    hi, lo = hi_base(data)
    a.lui("at", hi)
    a.lw("t8", lo, "at")
    a.addiu("t8", "t8", 1)
    a.sw("t8", lo, "at")
    for index, reg in enumerate(("a0", "a1", "a2", "a3", "ra", "sp"), start=1):
        a.sw(reg, lo + index * 4, "at")
    a.label("done")
    a.j(site + 8)
    a.nop()
    return a.assemble()


def read_words(pine: Pine, addr: int, count: int) -> list[int]:
    return [pine.r32(addr + i * 4) for i in range(count)]


def write_words(pine: Pine, addr: int, words: list[int]):
    for i, word in enumerate(words):
        pine.w32(addr + i * 4, word)


def install() -> int:
    if STATE_FILE.exists():
        raise RuntimeError(f"Probe state already exists ({STATE_FILE}); uninstall before installing again.")
    pine = Pine()
    require_vm_paused(pine, "install executable hooks")

    emitter_words: dict[str, list[int]] = {}
    for name, (site, digest, _) in PROBES.items():
        words = read_words(pine, site, 2)
        if not is_stock(words, digest):
            raise RuntimeError(f"Emitter site {name} @0x{site:08x} is not stock: {words_hex(words)}")
        emitter_words[name] = words

    noclip_words: dict[str, list[int]] = {}
    for name, (site, _, _) in NOCLIP_SITES.items():
        state = noclip_site_state(pine, name)
        if not (state == "stock" or state == "hooked"):
            raise RuntimeError(f"Noclip site {name} is {state}; refusing to overwrite its cave.")
        noclip_words[name] = read_words(pine, site, 2)

    cave_words = read_words(pine, CAVE_BASE, (CAVE_END - CAVE_BASE) // 4)
    hooks: dict[str, tuple[int, bytes]] = {}
    cursor = CODE_BASE
    for name in PROBES:
        blob = build_hook(name, cursor, emitter_words[name])
        hooks[name] = (cursor, blob)
        cursor = (cursor + len(blob) + 15) & ~15
    if cursor > CAVE_END:
        raise RuntimeError(f"Probe cave overflow: 0x{cursor:08x} > 0x{CAVE_END:08x}")

    saved_state = {
        "caveWords": cave_words,
        "emitterSites": emitter_words,
        "noclipSites": noclip_words,
    }
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(saved_state, indent=1) + "\n")

    try:
        # Stop every possible branch into the cave before replacing it. A detoured site gets its
        # stock words copied back from the operator's own executable.
        for name in NOCLIP_SITES:
            restore_stock(pine, name)

        write_words(pine, CAVE_BASE, [0] * ((CAVE_END - CAVE_BASE) // 4))
        pine.w32(DATA_BASE, MAGIC)
        pine.w32(DATA_BASE + 4, 1)
        for name, (addr, blob) in hooks.items():
            words = list(struct.unpack(f"<{len(blob) // 4}I", blob))
            write_words(pine, addr, words)
        for name, (site, _, _) in PROBES.items():
            cave = hooks[name][0]
            pine.w32(site, j_ins(cave))
            pine.w32(site + 4, 0)
        if pine.r32(DATA_BASE) != MAGIC:
            raise RuntimeError("Probe data magic did not verify after install.")
        for name, (site, _, _) in PROBES.items():
            expected = [j_ins(hooks[name][0]), 0]
            if read_words(pine, site, 2) != expected:
                raise RuntimeError(f"Probe hook {name} did not verify after install.")
    except Exception:
        # Keep the saved-state file if rollback itself fails so a later uninstall can recover it.
        try:
            for name, (site, _, _) in PROBES.items():
                write_words(pine, site, saved_state["emitterSites"][name])
            write_words(pine, CAVE_BASE, saved_state["caveWords"])
            for name, (site, _, _) in NOCLIP_SITES.items():
                write_words(pine, site, saved_state["noclipSites"][name])
            STATE_FILE.unlink()
        except Exception as rollback_error:
            raise RuntimeError(
                f"Probe install failed and rollback also failed; recover with uninstall using {STATE_FILE}"
            ) from rollback_error
        raise

    print(f"Emitter probe installed; cave 0x{CAVE_BASE:08x}..0x{cursor:08x}; saved live state to {STATE_FILE}")
    return 0


def uninstall() -> int:
    if not STATE_FILE.exists():
        raise RuntimeError(f"No saved probe state at {STATE_FILE}.")
    state = json.loads(STATE_FILE.read_text())
    pine = Pine()
    require_vm_paused(pine, "restore executable hooks")

    # Stop all probe entries, restore the borrowed cave, then restore the exact previous noclip state.
    for name, (site, _, _) in PROBES.items():
        write_words(pine, site, state["emitterSites"][name])
    write_words(pine, CAVE_BASE, state["caveWords"])
    for name, (site, _, _) in NOCLIP_SITES.items():
        write_words(pine, site, state["noclipSites"][name])
    for name, (site, _, _) in PROBES.items():
        if read_words(pine, site, 2) != state["emitterSites"][name]:
            raise RuntimeError(f"Emitter site {name} failed restore verification; recovery state retained.")
    if read_words(pine, CAVE_BASE, len(state["caveWords"])) != state["caveWords"]:
        raise RuntimeError("Borrowed cave failed restore verification; recovery state retained.")
    for name, (site, _, _) in NOCLIP_SITES.items():
        if read_words(pine, site, 2) != state["noclipSites"][name]:
            raise RuntimeError(f"Noclip site {name} failed restore verification; recovery state retained.")
    STATE_FILE.unlink()
    print("Emitter probe removed; emitter entries, noclip cave, and noclip hook states restored exactly.")
    return 0


def snapshot(pine: Pine) -> dict:
    result: dict[str, dict] = {}
    for name, addr in SLOT_BASE.items():
        words = read_words(pine, addr, SLOT_WORDS)
        result[name] = {
            "count": words[0],
            "a0": words[1],
            "a1": words[2],
            "a2": words[3],
            "a3": words[4],
            "ra": words[5],
            "sp": words[6],
        }
    return result


def pointer_dump(pine: Pine, name: str, item: dict) -> dict:
    try:
        if name == "read" and item["a2"]:
            raw = read_words(pine, item["a2"], 51)
            values: list[int | float] = []
            for i, word in enumerate(raw):
                if i in (0, 1, 49, 50):
                    values.append(word if word < 0x80000000 else word - 0x100000000)
                else:
                    values.append(struct.unpack("<f", struct.pack("<I", word))[0])
            return {"payloadAddress": item["a2"], "uWords": raw, "uValues": values}
        if name == "spawn" and item["a0"]:
            return {"nodeAddress": item["a0"], "nodeWords": read_words(pine, item["a0"], 100)}
        if name in ("p6", "p7") and item["a1"]:
            return {"templateAddress": item["a1"], "templateWords": read_words(pine, item["a1"], 100)}
    except Exception as exc:  # a pointer can expire between the hook and polling
        return {"dumpError": str(exc)}
    return {}


def capture(seconds: float, out: Path) -> int:
    pine = Pine()
    if pine.r32(DATA_BASE) != MAGIC:
        raise RuntimeError("Emitter probe is not installed.")
    start = time.monotonic()
    previous = snapshot(pine)
    events: list[dict] = []
    while time.monotonic() - start < seconds:
        current = snapshot(pine)
        elapsed = time.monotonic() - start
        for name, item in current.items():
            if item["count"] == previous[name]["count"]:
                continue
            event = {
                "seconds": round(elapsed, 4),
                "site": name,
                "count": item["count"],
                "delta": (item["count"] - previous[name]["count"]) & 0xFFFFFFFF,
                "args": item,
            }
            event.update(pointer_dump(pine, name, item))
            events.append(event)
        previous = current
        time.sleep(0.05)

    final = snapshot(pine)
    doc = {
        "kind": "ssx-tricky-emitter-runtime-capture",
        "capturedAtUtc": datetime.now(timezone.utc).isoformat(),
        "durationSeconds": seconds,
        "filter": {"p6P7CallerReturnAddress": "0x001d91e8"},
        "final": final,
        "events": events,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n")
    counts = ", ".join(f"{name}={item['count']}" for name, item in final.items())
    print(f"Captured {len(events)} changes over {seconds:g}s ({counts}) -> {out}")
    return 0


def status() -> int:
    pine = Pine()
    vm_status = pine.status()
    states = {0: "running", 1: "paused", 2: "shutdown"}
    print(f"VM status: {states.get(vm_status, f'unknown:{vm_status}')}")
    magic = pine.r32(DATA_BASE)
    print(f"probe magic: 0x{magic:08x} ({'installed' if magic == MAGIC else 'not installed'})")
    for name, (site, digest, _) in PROBES.items():
        words = read_words(pine, site, 2)
        state = "stock" if is_stock(words, digest) else "not stock"
        print(f"{name:5s} @0x{site:08x}: {words[0]:08x} {words[1]:08x} [{state}]")
    if magic == MAGIC:
        for name, item in snapshot(pine).items():
            print(f"  {name:5s}: count={item['count']} a0=0x{item['a0']:08x} a1=0x{item['a1']:08x} a2=0x{item['a2']:08x} ra=0x{item['ra']:08x}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install")
    sub.add_parser("uninstall")
    sub.add_parser("status")
    cap = sub.add_parser("capture")
    cap.add_argument("--seconds", type=float, default=15.0)
    cap.add_argument("--out", type=Path, default=Path("temp/p0-effects/emitter-capture.json"))
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
