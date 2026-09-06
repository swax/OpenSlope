#!/usr/bin/env python3
"""Reversibly invoke one loaded collision-effect graph through the live SSX engine.

This PAL SLES-50545 probe borrows the vetted noclip cave while the VM is paused. On the
next BoarderMotion_SharedUpdate after ``fire``, it resolves the local boarder and target instance,
allocates a real 0xf0-byte collision thread from the engine pool, and calls
CollisionEffectNode_Construct with null optional contact matrices. Jump-table wrappers
count main types 2, 7, and 17 so the graph path is observable even off-camera.

The defaults target the current TEST_MTN_4 M7 fixture: graph 307, instance 3398.

  python tools/instrumentation/effect_invoke_probe.py install
  python tools/instrumentation/effect_invoke_probe.py fire
  # Resume PCSX2 briefly, then pause the VM again.
  python tools/instrumentation/effect_invoke_probe.py status
  python tools/instrumentation/effect_invoke_probe.py uninstall
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
from noclip_patch import Asm, R, hi_base  # noqa: E402
from pine_hooks import (  # noqa: E402
    Pine, SITES as NOCLIP_SITES, is_stock, j_ins, noclip_site_state, restore_stock, words_hex,
)

CAVE_BASE = 0x002B4C40
CAVE_END = 0x002B50C0
DATA_BASE = CAVE_BASE
CODE_BASE = CAVE_BASE + 0x100
MAGIC = 0x49585030  # "0PXI" in little-endian memory
STATE_FILE = Path("temp/p0-effects/effect-invoke-probe-state.json")

# Guaranteed once-per-frame local-rider entry, including air/fall states. Hooking the clean
# function prologue also means the injected engine calls cannot disturb live mid-function FPRs.
# The two prologue words the hook displaces are read out of the emulator at install and checked
# against this digest; this file does not carry them.
TICK_SITE = 0x001171A0
TICK_DIGEST = "e15d5d2137e1ae7d27792a4af5ebb58b359635123140a191ce1d6cc31ddb1439"
TABLE_BASE = 0x0036C830
TABLE_PROBES = {
    "type2": (TABLE_BASE + 2 * 4, 0x0013C05C),
    "type7": (TABLE_BASE + 7 * 4, 0x0013C2EC),
    "type17": (TABLE_BASE + 17 * 4, 0x0013C408),
}

REGISTRY_PTR = 0x00338E58
INSTANCE_TABLE = 0x00347688
EFFECT_POOL = 0x00347048
ALLOC = 0x0023D8D0
MEMSET32 = 0x002CD9E0
INSTANCE_RESOLVE = 0x00254F58
COLLISION_CONSTRUCT = 0x0013B8C8
ALLOC_TAG = 0x0036C800

COMMAND = DATA_BASE + 0x04
STATUS = DATA_BASE + 0x08
COUNTS = {
    "type2": DATA_BASE + 0x10,
    "type7": DATA_BASE + 0x14,
    "type17": DATA_BASE + 0x18,
}
SAVE_BASE = DATA_BASE + 0x40
TEMP_BOARDER = DATA_BASE + 0xA0
TEMP_ENTITY = DATA_BASE + 0xA4
TEMP_ALLOC = DATA_BASE + 0xA8

# Caller-saved state the injected engine calls may clobber. k0/k1 are dedicated probe scratch.
SAVE_REGS = ("at", "v0", "v1", "a0", "a1", "a2", "a3", "t0", "t1", "t2", "t3",
             "t4", "t5", "t6", "t7", "t8", "t9", "ra")


def require_vm_paused(pine: Pine, operation: str):
    status = pine.status()
    if status != 1:
        states = {0: "running", 1: "paused", 2: "shutdown"}
        raise RuntimeError(
            f"Refusing to {operation} while the PCSX2 VM is {states.get(status, f'unknown:{status}')}. "
            "Pause emulation in PCSX2 itself, then retry."
        )


def read_words(pine: Pine, addr: int, count: int) -> list[int]:
    return [pine.r32(addr + i * 4) for i in range(count)]


def write_words(pine: Pine, addr: int, words: list[int]):
    for i, word in enumerate(words):
        pine.w32(addr + i * 4, word)


def ori(a: Asm, rt: str, rs: str, imm: int):
    a.word(0x34000000 | (R[rs] << 21) | (R[rt] << 16) | (imm & 0xFFFF))


def load_addr(a: Asm, reg: str, address: int):
    # addiu/lw sign-extend the low half; carry bit 15 into the LUI half.
    hi = (address + 0x8000) >> 16
    lo = address & 0xFFFF
    a.lui(reg, hi)
    a.addiu(reg, reg, lo)


def data_base(a: Asm):
    hi, lo = hi_base(DATA_BASE)
    a.lui("k0", hi)
    return lo


def build_tick_hook(base: int, graph_index: int, instance_index: int, tick_words: list[int]) -> bytes:
    """`tick_words` is the digest-checked prologue pair read from TICK_SITE at install time."""
    a = Asm(base)
    lo = data_base(a)
    for index, reg in enumerate(SAVE_REGS):
        a.sw(reg, lo + (SAVE_BASE - DATA_BASE) + index * 4, "k0")
    a.lw("k1", lo + (COMMAND - DATA_BASE), "k0")
    a.beq("k1", "zero", "restore")
    a.nop()
    # Clear before calling the constructor so this remains strictly one-shot.
    a.sw("zero", lo + (COMMAND - DATA_BASE), "k0")
    a.sw("zero", lo + (STATUS - DATA_BASE), "k0")

    # local boarder = **(**REGISTRY_PTR + 0x730) + 0xa4
    hi = (REGISTRY_PTR + 0x8000) >> 16
    ptr_lo = REGISTRY_PTR & 0xFFFF
    a.lui("k0", hi)
    a.lw("k1", ptr_lo, "k0")
    a.beq("k1", "zero", "failed")
    a.nop()
    a.lw("k1", 0x730, "k1")
    a.beq("k1", "zero", "failed")
    a.nop()
    a.lw("k1", 0xA4, "k1")
    a.beq("k1", "zero", "failed")
    a.nop()
    lo = data_base(a)
    a.sw("k1", lo + (TEMP_BOARDER - DATA_BASE), "k0")

    # Resolve the target LevelInstance through the engine's own bounds-checked table helper.
    load_addr(a, "a0", INSTANCE_TABLE)
    a.addiu("a1", "zero", instance_index)
    a.jal(INSTANCE_RESOLVE)
    a.nop()
    a.beq("v0", "zero", "failed")
    a.nop()
    lo = data_base(a)
    a.sw("v0", lo + (TEMP_ENTITY - DATA_BASE), "k0")

    # Allocate and initialize the same 0xf0-byte pool object used by both contact paths.
    load_addr(a, "a0", EFFECT_POOL)
    a.addiu("a1", "zero", 0xF0)
    a.lui("a2", 0x4000)
    load_addr(a, "a3", ALLOC_TAG)
    a.daddu("t0", "zero", "zero")
    a.daddu("t1", "zero", "zero")
    a.jal(ALLOC)
    a.nop()
    a.beq("v0", "zero", "failed")
    a.nop()
    lo = data_base(a)
    a.sw("v0", lo + (TEMP_ALLOC - DATA_BASE), "k0")
    a.daddu("a0", "v0", "zero")
    a.lui("a1", 0xDEAD)
    ori(a, "a1", "a1", 0xC0DE)
    a.addiu("a2", "zero", 0xF0)
    a.jal(MEMSET32)
    a.nop()

    # CollisionEffectNode_Construct(node, 3, graph, entity; t0=boarder, t1=t2=null).
    lo = data_base(a)
    a.lw("a0", lo + (TEMP_ALLOC - DATA_BASE), "k0")
    a.addiu("a1", "zero", 3)
    a.addiu("a2", "zero", graph_index)
    a.lw("a3", lo + (TEMP_ENTITY - DATA_BASE), "k0")
    a.lw("t0", lo + (TEMP_BOARDER - DATA_BASE), "k0")
    a.daddu("t1", "zero", "zero")
    a.daddu("t2", "zero", "zero")
    a.jal(COLLISION_CONSTRUCT)
    a.nop()
    lo = data_base(a)
    a.addiu("k1", "zero", 2)
    a.sw("k1", lo + (STATUS - DATA_BASE), "k0")
    a.beq("zero", "zero", "restore")
    a.nop()

    a.label("failed")
    lo = data_base(a)
    a.addiu("k1", "zero", -1)
    a.sw("k1", lo + (STATUS - DATA_BASE), "k0")

    a.label("restore")
    lo = data_base(a)
    for index, reg in enumerate(SAVE_REGS):
        a.lw(reg, lo + (SAVE_BASE - DATA_BASE) + index * 4, "k0")
    # Run the two displaced stock instructions and continue after the patched pair.
    a.word(tick_words[0])
    a.word(tick_words[1])
    a.j(TICK_SITE + 8)
    a.nop()
    return a.assemble()


def build_table_hook(name: str, base: int) -> bytes:
    _, handler = TABLE_PROBES[name]
    a = Asm(base)
    hi, lo = hi_base(COUNTS[name])
    a.lui("k0", hi)
    a.lw("k1", lo, "k0")
    a.addiu("k1", "k1", 1)
    a.sw("k1", lo, "k0")
    a.j(handler)
    a.nop()
    return a.assemble()


def build_hooks(graph_index: int, instance_index: int,
                tick_words: list[int]) -> tuple[dict[str, tuple[int, bytes]], int]:
    hooks: dict[str, tuple[int, bytes]] = {}
    tick = build_tick_hook(CODE_BASE, graph_index, instance_index, tick_words)
    hooks["tick"] = (CODE_BASE, tick)
    cursor = (CODE_BASE + len(tick) + 15) & ~15
    for name in TABLE_PROBES:
        blob = build_table_hook(name, cursor)
        hooks[name] = (cursor, blob)
        cursor = (cursor + len(blob) + 15) & ~15
    if cursor > CAVE_END:
        raise RuntimeError(f"Probe cave overflow: 0x{cursor:08x} > 0x{CAVE_END:08x}")
    return hooks, cursor


def install(graph_index: int, instance_index: int) -> int:
    if STATE_FILE.exists():
        raise RuntimeError(f"Probe state already exists ({STATE_FILE}); uninstall first.")
    pine = Pine()
    require_vm_paused(pine, "install invocation probe")
    tick_words = read_words(pine, TICK_SITE, 2)
    if not is_stock(tick_words, TICK_DIGEST):
        raise RuntimeError(
            f"BoarderMotion_SharedUpdate @0x{TICK_SITE:08x} is not stock: {words_hex(tick_words)}")
    table_words: dict[str, int] = {}
    for name, (entry, handler) in TABLE_PROBES.items():
        word = pine.r32(entry)
        if word != handler:
            raise RuntimeError(f"Jump-table entry {name} is 0x{word:08x}, expected 0x{handler:08x}")
        table_words[name] = word
    noclip_words: dict[str, list[int]] = {}
    for name, (site, _, _) in NOCLIP_SITES.items():
        state = noclip_site_state(pine, name)
        if state not in ("stock", "hooked"):
            raise RuntimeError(f"Noclip site {name} is {state}; refusing to borrow its cave.")
        noclip_words[name] = read_words(pine, site, 2)
    cave_words = read_words(pine, CAVE_BASE, (CAVE_END - CAVE_BASE) // 4)
    hooks, cursor = build_hooks(graph_index, instance_index, tick_words)
    saved = {
        "tickSite": tick_words,
        "tableEntries": table_words,
        "noclipSites": noclip_words,
        "caveWords": cave_words,
        "graphIndex": graph_index,
        "instanceIndex": instance_index,
    }
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(saved, indent=1) + "\n")
    try:
        # Stop every branch into the shared cave before replacing it. A detoured site gets its
        # stock words copied back from the operator's own executable.
        for name in NOCLIP_SITES:
            restore_stock(pine, name)
        write_words(pine, CAVE_BASE, [0] * ((CAVE_END - CAVE_BASE) // 4))
        pine.w32(DATA_BASE, MAGIC)
        for addr, blob in hooks.values():
            write_words(pine, addr, list(struct.unpack(f"<{len(blob) // 4}I", blob)))
        pine.w32(TICK_SITE, j_ins(hooks["tick"][0]))
        pine.w32(TICK_SITE + 4, 0)
        for name, (entry, _) in TABLE_PROBES.items():
            pine.w32(entry, hooks[name][0])
        if read_words(pine, TICK_SITE, 2) != [j_ins(hooks["tick"][0]), 0]:
            raise RuntimeError("Tick hook failed install verification.")
        for name, (entry, _) in TABLE_PROBES.items():
            if pine.r32(entry) != hooks[name][0]:
                raise RuntimeError(f"Jump-table hook {name} failed install verification.")
    except Exception:
        try:
            write_words(pine, TICK_SITE, saved["tickSite"])
            for name, (entry, _) in TABLE_PROBES.items():
                pine.w32(entry, saved["tableEntries"][name])
            write_words(pine, CAVE_BASE, saved["caveWords"])
            for name, (site, _, _) in NOCLIP_SITES.items():
                write_words(pine, site, saved["noclipSites"][name])
            STATE_FILE.unlink()
        except Exception as rollback_error:
            raise RuntimeError(f"Install and rollback failed; recover using {STATE_FILE}") from rollback_error
        raise
    print(
        f"Invocation probe installed for graph {graph_index}, instance {instance_index}; "
        f"cave ends 0x{cursor:08x}; state saved to {STATE_FILE}"
    )
    return 0


def fire() -> int:
    pine = Pine()
    require_vm_paused(pine, "arm one-shot invocation")
    if pine.r32(DATA_BASE) != MAGIC:
        raise RuntimeError("Invocation probe is not installed.")
    pine.w32(COMMAND, 0)
    pine.w32(STATUS, 0)
    for addr in COUNTS.values():
        pine.w32(addr, 0)
    pine.w32(COMMAND, 1)
    print("One-shot graph invocation armed; resume PCSX2 briefly, then pause it again.")
    return 0


def status() -> int:
    pine = Pine()
    states = {0: "running", 1: "paused", 2: "shutdown"}
    print(f"VM status: {states.get(pine.status(), 'unknown')}")
    installed = pine.r32(DATA_BASE) == MAGIC
    print(f"probe: {'installed' if installed else 'not installed'}")
    if installed:
        raw_status = pine.r32(STATUS)
        signed_status = raw_status if raw_status < 0x80000000 else raw_status - 0x100000000
        print(f"command={pine.r32(COMMAND)} status={signed_status}")
        print("counts: " + ", ".join(f"{name}={pine.r32(addr)}" for name, addr in COUNTS.items()))
        print(
            f"boarder=0x{pine.r32(TEMP_BOARDER):08x} entity=0x{pine.r32(TEMP_ENTITY):08x} "
            f"allocation=0x{pine.r32(TEMP_ALLOC):08x}"
        )
    return 0


def uninstall() -> int:
    if not STATE_FILE.exists():
        raise RuntimeError(f"No saved probe state at {STATE_FILE}.")
    state = json.loads(STATE_FILE.read_text())
    pine = Pine()
    require_vm_paused(pine, "uninstall invocation probe")
    write_words(pine, TICK_SITE, state["tickSite"])
    for name, (entry, _) in TABLE_PROBES.items():
        pine.w32(entry, state["tableEntries"][name])
    write_words(pine, CAVE_BASE, state["caveWords"])
    for name, (site, _, _) in NOCLIP_SITES.items():
        write_words(pine, site, state["noclipSites"][name])
    if read_words(pine, TICK_SITE, 2) != state["tickSite"]:
        raise RuntimeError("Tick site failed restore verification; recovery state retained.")
    for name, (entry, _) in TABLE_PROBES.items():
        if pine.r32(entry) != state["tableEntries"][name]:
            raise RuntimeError(f"Jump-table entry {name} failed restore verification; state retained.")
    if read_words(pine, CAVE_BASE, len(state["caveWords"])) != state["caveWords"]:
        raise RuntimeError("Borrowed cave failed restore verification; state retained.")
    for name, (site, _, _) in NOCLIP_SITES.items():
        if read_words(pine, site, 2) != state["noclipSites"][name]:
            raise RuntimeError(f"Noclip site {name} failed restore verification; state retained.")
    STATE_FILE.unlink()
    print("Invocation probe removed; tick site, jump table, cave, and noclip state restored exactly.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    ins = sub.add_parser("install")
    ins.add_argument("--graph", type=int, default=307)
    ins.add_argument("--instance", type=int, default=3398)
    sub.add_parser("fire")
    sub.add_parser("status")
    sub.add_parser("uninstall")
    args = parser.parse_args()
    if args.command == "install":
        return install(args.graph, args.instance)
    if args.command == "fire":
        return fire()
    if args.command == "uninstall":
        return uninstall()
    return status()


if __name__ == "__main__":
    raise SystemExit(main())
