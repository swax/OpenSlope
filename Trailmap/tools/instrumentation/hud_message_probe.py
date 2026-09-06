#!/usr/bin/env python3
"""Put arbitrary text on the in-race HUD, live, over PINE.

Either retail disc: the build is read from PCSX2 (`SLES-50545` / `SLUS-20326`) and
every address below follows from it. This drives the debug-text patch
(`tools/patches/debug_text_patch.py`, [Trailmap: 443-debug-text]) without building
an ISO: install it into EE RAM, post a banner by hand, watch it draw, revert.

The in-race HUD keeps a 12-slot x 20-byte event ring on the trick-score state
(``boarder + 0x5820``, ring at ``+0x15C``). ``AddHudScoreEvent`` (0x00157348 on PAL)
fills a slot and the HUD renderer walks it once per frame, one scan loop per event kind.
Kind 10 is the CHECKPOINT banner. The patch shims that branch's string lookup: a
slot carrying the patch's sentinel in its aux word draws the text its VALUE word
points at, and anything else draws the stock id through the stock lookup.

``post-text`` writes a string into the cave's spare tail and posts such a slot,
which exercises the shim exactly as the engine will -- the only difference in a
real run is that the effect-graph handler supplies the pointer instead of this.
That makes it the cheap half of validating the patch; the handler needs an
authored main-type-12 node, which means a built disc.

Usage (course loaded, VM paused for install/revert):

  python tools/instrumentation/hud_message_probe.py status
  python tools/instrumentation/hud_message_probe.py install
  python tools/instrumentation/hud_message_probe.py post-text --text "HELLO SLOPES"
  python tools/instrumentation/hud_message_probe.py post --loc 3570   # negative control
  python tools/instrumentation/hud_message_probe.py revert

``post`` leaves the aux word 0, so with the patch installed it must still read
CHECKPOINT rather than string 3570 -- that is the check that the shim leaves
retail behaviour alone rather than merely appearing to work.
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS / "patches"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pine_hooks import Pine  # noqa: E402
from debug_text_patch import TARGETS, SENTINEL  # noqa: E402
from noclip_patch import TARGETS as NOCLIP_TARGETS  # noqa: E402

EXTRACTED = TOOLS.parent / "extracted"

#: The disc serial PCSX2 reports -> the boot executable it is running. The registry pointer comes
#: from the noclip patch's table, which is where it is already maintained for both builds.
BUILDS = {"SLES-50545": "SLES_505.45", "SLUS-20326": "SLUS_203.26"}

# --- Engine anchors, all class offsets and so the same on both builds ----------
TRICK_SCORE_OFFSET = 0x5820        # boarder -> trick-score state
RING_OFFSET = 0x015C               # trick-score state -> event ring
RING_SLOTS = 12
RING_STRIDE = 0x14
KIND_CHECKPOINT = 10


def resolve_target(pine: Pine):
    """Which build this emulator is running, cached for the life of the connection."""
    cached = getattr(pine, "_ssx_target", None)
    if cached is not None:
        return cached
    serial = pine.game_id().strip().upper()
    name = BUILDS.get(serial)
    if name is None:
        raise SystemExit(f"PCSX2 is running disc {serial!r}; this patch is derived for "
                         f"{', '.join(sorted(BUILDS))}")
    pine._ssx_target = TARGETS[name]
    return pine._ssx_target


def elf_paths(target) -> tuple[Path, Path]:
    return EXTRACTED / target.name, EXTRACTED / f"{target.name}.debugtext"


def hook_sites(target) -> tuple[int, ...]:
    """The words that ARM the patch, as opposed to the cave bodies they point at.

    These go in last on install and come out first on revert, so a partial write never leaves a
    hook pointing at a cave that is not there yet.
    """
    return (target.table_entry, target.loc_call, target.numeric_test)


def f32(value: float) -> int:
    return struct.unpack("<I", struct.pack("<f", value))[0]


def require_vm_paused(pine: Pine, operation: str) -> None:
    status = pine.status()
    if status != 1:
        states = {0: "running", 1: "paused", 2: "shutdown"}
        raise RuntimeError(
            f"Refusing to {operation} while the PCSX2 VM is "
            f"{states.get(status, f'unknown:{status}')}. Pause emulation in PCSX2, then retry."
        )


def resolve_live(pine: Pine) -> dict[str, int]:
    """The same chain rider_telemetry.resolve_live walks, plus the ring."""
    registry = pine.r32(NOCLIP_TARGETS[resolve_target(pine).name].registry_ptr)
    if not registry:
        raise RuntimeError("SSX registry pointer is null; load into a course first.")
    world = pine.r32(registry + 0x730)
    if not world:
        raise RuntimeError("SSX world object is null; load into a course first.")
    boarder = pine.r32(world + 0xA4)
    if not boarder:
        raise RuntimeError("Local boarder pointer is null; load into a course first.")
    local = pine.r32(boarder + 0x41C)
    if local != 1:
        raise RuntimeError(f"Resolved boarder is not the local human (+0x41C={local}).")
    state = boarder + TRICK_SCORE_OFFSET
    return {"registry": registry, "world": world, "boarder": boarder,
            "trickScore": state, "ring": state + RING_OFFSET}


def patch_words(target) -> list[tuple[int, int, int]]:
    """(vaddr, stock, patched) for every word the patch changes."""
    elf_stock, elf_patched = elf_paths(target)
    if not elf_patched.is_file():
        raise SystemExit(
            f"{elf_patched} is missing. Build it first:\n"
            f"  python tools/patches/debug_text_patch.py --elf extracted/{target.name}")
    stock, patched = elf_stock.read_bytes(), elf_patched.read_bytes()
    if len(stock) != len(patched):
        raise SystemExit("stock and patched executables differ in size")
    out = []
    for off in range(0, len(stock), 4):
        if stock[off:off + 4] != patched[off:off + 4]:
            out.append((off - 0x1000 + 0x00100000,
                        struct.unpack_from("<I", stock, off)[0],
                        struct.unpack_from("<I", patched, off)[0]))
    return out


def installed_state(pine: Pine) -> str:
    words = patch_words(resolve_target(pine))
    live = [pine.r32(va) for va, _, _ in words]
    if all(got == new for got, (_, _, new) in zip(live, words)):
        return "installed"
    if all(got == old for got, (_, old, _) in zip(live, words)):
        return "stock"
    return "partial"


def cmd_status(pine: Pine, _args) -> int:
    target = resolve_target(pine)
    print(f"build: {target.name}")
    print(f"patch: {installed_state(pine)}  ({len(patch_words(target))} words)")
    print(f"scratch 0x{target.scratch:08x} ({target.scratch_bytes} B = "
          f"{target.scratch_bytes // 2 - 1} chars)")
    live = resolve_live(pine)
    for name in ("boarder", "trickScore", "ring"):
        print(f"  {name:11s} 0x{live[name]:08x}")
    print("  live ring slots (kind, value, duration, elapsed, aux):")
    for index, slot in enumerate(read_ring(pine, live["ring"])):
        if slot[0] == 0:
            continue
        duration = struct.unpack("<f", struct.pack("<I", slot[2]))[0]
        elapsed = struct.unpack("<f", struct.pack("<I", slot[3]))[0]
        ours = " <- ours" if slot[4] == SENTINEL else ""
        print(f"    [{index:2d}] kind={slot[0]:<3d} value=0x{slot[1]:08x}"
              f" dur={duration:.3f} elapsed={elapsed:.3f} aux=0x{slot[4]:08x}{ours}")
    return 0


def read_ring(pine: Pine, ring: int) -> list[tuple[int, ...]]:
    return [tuple(pine.r32(ring + slot * RING_STRIDE + word * 4) for word in range(5))
            for slot in range(RING_SLOTS)]


def write_verified(pine: Pine, addr: int, word: int) -> None:
    pine.w32(addr, word)
    got = pine.r32(addr)
    if got != word:
        raise RuntimeError(f"write to 0x{addr:08x} did not stick "
                           f"(wrote 0x{word:08x}, read 0x{got:08x}); is the VM paused?")


def cmd_install(pine: Pine, _args) -> int:
    require_vm_paused(pine, "install the patch")
    target = resolve_target(pine)
    state = installed_state(pine)
    if state == "installed":
        print("Already installed.")
        return 0
    if state != "stock":
        raise RuntimeError("EE RAM matches neither the stock nor the patched executable "
                           "at these addresses; refusing to write over an unknown state.")
    words = patch_words(target)
    sites = hook_sites(target)
    hooks = [w for w in words if w[0] in sites]
    body = [w for w in words if w[0] not in sites]
    for va, _, new in body + hooks:
        write_verified(pine, va, new)
    print(f"installed {len(words)} words ({len(body)} cave, {len(hooks)} hook) on {target.name}")
    return 0


def cmd_revert(pine: Pine, _args) -> int:
    require_vm_paused(pine, "revert the patch")
    target = resolve_target(pine)
    state = installed_state(pine)
    if state == "stock":
        print("Already stock.")
        return 0
    words = patch_words(target)
    sites = hook_sites(target)
    hooks = [w for w in words if w[0] in sites]
    body = [w for w in words if w[0] not in sites]
    for va, old, _ in hooks + body:
        write_verified(pine, va, old)
    print(f"reverted {len(words)} words")
    return 0


def post_slot(pine: Pine, ring: int, value: int, aux: int, seconds: float) -> int:
    slots = read_ring(pine, ring)
    free = next((i for i, slot in enumerate(slots) if slot[0] == 0), None)
    if free is None:
        free = 0
        print("warning: ring is full; overwriting slot 0")
    base = ring + free * RING_STRIDE
    # Written in the initialiser's own order (0x00157490), kind LAST, so the renderer
    # can never see a slot that claims to be kind 10 while its timers are still stale.
    pine.w32(base + 0x04, value & 0xFFFFFFFF)
    pine.w32(base + 0x08, f32(seconds))
    pine.w32(base + 0x0C, f32(0.0))
    pine.w32(base + 0x10, aux & 0xFFFFFFFF)
    pine.w32(base + 0x00, KIND_CHECKPOINT)
    return free


def cmd_post(pine: Pine, args) -> int:
    live = resolve_live(pine)
    free = post_slot(pine, live["ring"], args.loc, 0, args.seconds)
    print(f"slot [{free}] <- kind {KIND_CHECKPOINT}, value {args.loc}, aux 0, {args.seconds:.2f}s")
    print("aux is 0, so this must draw CHECKPOINT whether or not the patch is installed.")
    return 0


def cmd_post_text(pine: Pine, args) -> int:
    target = resolve_target(pine)
    # The colour block sits immediately BEFORE the text, exactly as an authored node lays it out,
    # so this exercises the shim's colour copy as well as its string return -- and a scratch buffer
    # laid out the other way round would leave that half of the shim untested here.
    colour = struct.pack("<3f", args.red, args.green, args.blue)
    encoded = colour + args.text.encode("utf-16-le") + b"\x00\x00"
    room = target.scratch_bytes
    if len(encoded) > room:
        raise SystemExit(f"{len(encoded)} B of colour+text does not fit the {room} B scratch; "
                         f"at most {(room - len(colour)) // 2 - 1} characters")
    if installed_state(pine) != "installed":
        print("NOTE: the patch is not installed, so the shim will not run and this will "
              "draw CHECKPOINT. Run `install` first.")
    for i in range(0, len(encoded), 4):
        chunk = encoded[i:i + 4].ljust(4, b"\x00")
        pine.w32(target.scratch + i, struct.unpack("<I", chunk)[0])

    scratch = target.scratch + len(colour)
    live = resolve_live(pine)
    free = post_slot(pine, live["ring"], scratch, SENTINEL, args.seconds)
    print(f"text at 0x{scratch:08x} ({len(encoded)} B): {args.text!r}")
    print(f"slot [{free}] <- kind {KIND_CHECKPOINT}, value 0x{scratch:08x}, "
          f"aux 0x{SENTINEL:08x}, {args.seconds:.2f}s")
    print("The banner draws over the FIRST HALF of its lifetime, so resume the VM to see it.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pine-slot", type=int, default=None,
                        help="PINE port, when PCSX2 is not on the default slot")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="report the patch state, the cave scratch and the live ring")
    sub.add_parser("install", help="write the debug-text patch into EE RAM")
    sub.add_parser("revert", help="restore the stock bytes")
    post = sub.add_parser("post", help="post a stock-shaped kind-10 slot (negative control)")
    post.add_argument("--loc", type=int, default=3570)
    post.add_argument("--seconds", type=float, default=10.0)
    text = sub.add_parser("post-text", help="park a coloured string in scratch and post it")
    text.add_argument("--text", default="AUTOTEST DEBUG TEXT")
    text.add_argument("--seconds", type=float, default=10.0)
    text.add_argument("--red", type=float, default=1.0)
    text.add_argument("--green", type=float, default=1.0)
    text.add_argument("--blue", type=float, default=1.0)

    args = parser.parse_args()
    pine = Pine(args.pine_slot) if args.pine_slot else Pine()
    handlers = {"status": cmd_status, "install": cmd_install, "revert": cmd_revert,
                "post": cmd_post, "post-text": cmd_post_text}
    return handlers[args.command](pine, args)


if __name__ == "__main__":
    raise SystemExit(main())
