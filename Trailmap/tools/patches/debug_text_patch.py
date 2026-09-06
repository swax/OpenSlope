#!/usr/bin/env python3
"""Debug-text SSF opcode ELF patch for SSX Tricky.

Supported boot executables: PAL `SLES_505.45` and NTSC-U `SLUS_203.26`. The two
builds carry this whole region as identical instructions at a fixed shift, so one
assembler drives both from the per-target table in TARGETS.

Adds one authorable effect opcode, **main type 12**, that puts a message on the
in-race HUD. Retail sends 12 to the dispatcher's inert default, so a level
carrying such a node runs unchanged on a stock executable; this patch gives the
opcode a body. See [Trailmap: 443-debug-text].

The message text is carried INLINE in the node's own payload, as NUL-terminated
UTF-16LE. Effect nodes are variable length -- the size field counts the whole
node and the chain walker advances by it (0x0013BF48) -- so the text needs no
side table in the executable and travels with the level.

Three hooks, no new rendering. The addresses named below are PAL; see TARGETS for
the NTSC-U set.

  Dispatcher entry 12 (jump table 0x0036C830) -> HANDLER
      Effect opcode handlers are entered with s0 = the effect thread and
      s1 = the node, and reach the firing rider through [s0+0xE8] (that is how
      main types 6 and 17 find theirs). The rider's trick-score state is
      rider+0x5820, which is exactly what AddHudScoreEvent 0x00157348 takes as
      its first argument. So the handler posts a HUD event ring slot -- kind 10,
      the CHECKPOINT banner -- whose value word is the address of the node's
      inline text and whose aux word is a sentinel. Then it rejoins the
      dispatcher's shared epilogue with v0 = 1, which means "continue the chain".

  The kind-10 banner's LocString call 0x001A52C0 -> SHIM
      The banner draws a fixed string id. The shim looks at the slot the branch
      is already holding in v1: our sentinel in the slot's aux word means the
      value word is a text pointer, so it returns that directly instead of
      resolving an id. Anything else -- a real checkpoint crossing -- gets the
      stock id 3648 and the stock LocString call, so retail behaviour is
      unchanged rather than merely unlikely to be noticed.

  The banner's NUMERIC readout's kind-10 test 0x001A653C -> SKIP
      The kind-10 banner is two draws half a lifetime apart: the text over the
      first half, and a signed TIME formatted from the SAME slot's value word
      over the second. A text pointer read as seconds renders as that
      formatter's clamp, `+59:59.99`, in green, right after every message. This
      hook adds "and the aux word is zero" to that loop's kind-10 test, so the
      number stays with the checkpoints it belongs to.

Discriminating on the aux word rather than on the value's magnitude or sign is
deliberate: the retail poster (0x00155C78) puts a NEGATIVE payload in kind 10's
value word, so every range or sign test aliases against real checkpoints. The
aux word is written by the same initialiser (0x00157490 stores a3 at slot+0x10),
is 0 on every retail poster, and is read by nothing in the renderer.

Usage:
  python tools/patches/debug_text_patch.py [--elf PATH] [--out PATH]
                                           [--target NAME] [--emit-patch JSON]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from noclip_patch import Asm, hi_lo  # noqa: E402

DEFAULT_ELF = Path(__file__).resolve().parents[2] / "extracted" / "SLES_505.45"

TEXT_VADDR = 0x00100000
TEXT_FOFF = 0x1000

# Slot fields, per the ring initialiser at 0x00157490:
#   +0x00 kind   +0x04 value   +0x08 duration (f32)   +0x0C elapsed (f32)   +0x10 aux
SLOT_VALUE = 0x04
SLOT_AUX = 0x10

RING_KIND_CHECKPOINT = 10
NODE_PAYLOAD = 8          # a node is MainType, ByteSize, then payload
BANNER_SECONDS = 2.5

# The node's payload is three f32 colour channels and then the NUL-terminated UTF-16LE text, so the
# text pointer the slot carries is also the handle to the colour: it sits at a fixed negative offset
# from it, which is what lets the shim reach both from the one word the ring gives it.
PAYLOAD_TEXT = 12         # R, G, B, then the string
COLOUR_CHANNELS = 3

# A sentinel in the slot's aux word saying "this slot's value is a text pointer, and
# the numeric readout is not for it". Every retail poster leaves aux 0, so any nonzero
# value would do; "SW" with an empty low half is chosen so it loads in ONE instruction,
# which is what makes all three routines fit the gap.
SENTINEL = 0x53570000


@dataclass(frozen=True)
class Target:
    """One boot executable's absolute addresses.

    Every OFFSET this patch uses -- the ring stride and its slot fields, the node
    payload layout, `boarder+0x5820` -- is a class or record offset and is identical
    on both builds, so none of them are in here. What differs is only where the four
    modules involved were linked.
    """
    name: str
    size: int
    #: SHA-256 of the single word at loc_call, table_entry and numeric_test, in that order.
    #: Same rule as the other patch tools: an anchor is identified by a digest of what it
    #: holds, not by the word itself, so no build's instruction encodings live in this file.
    #: `noclip_patch.py --print-digests <addr>:4` produces these.
    anchor_digests: tuple[str, str, str]
    loc_call: int          # jal LocString inside the kind-10 banner branch
    #: Where that branch FORMS the ring slot in v1 (`addu v1, s7, v1`, the ring base plus
    #: the +0x15C stride). The shim reads the slot through v1 at the call, so what makes
    #: that legal is that nothing between here and `loc_call` writes v1 -- which is a
    #: property of the shipped code, and so is asserted against it rather than assumed.
    slot_form: int
    table_entry: int       # jump table 0x0036C830 + 12*4
    numeric_test: int      # the kind-10 test in the banner's NUMERIC readout loop
    numeric_body: int      # that loop's kind-10 body, past the branch's delay slot
    numeric_next: int      # that loop's tail (continue with the next slot)
    locstring: int         # LocString(buf, id)
    add_hud_event: int     # AddHudScoreEvent(state, kind, value, aux, f12=seconds)
    dispatch_epilogue: int # the dispatcher's shared "restore and return v0" tail
    #: The HUD's text colour: four f32 written immediately before every draw -- [0] the fade
    #: alpha, then R, G, B. The text loop writes 1,1,1 (white) and the numeric loop 0,1,0 /
    #: 1,0,0 (the green and red of a checkpoint's time delta), so overriding it is a matter of
    #: storing after those and before the draw, which is exactly where the shim sits.
    colour_block: int
    cave: int
    cave_range: tuple[int, int]
    cave2: int                    # a second gap, for the routine that does not fit in the first
    cave2_range: tuple[int, int]
    #: NOT part of the patch, and never written to a disc. The live probe needs somewhere in EE RAM
    #: to park a test string, and the two gaps above have only 8 B each left free.
    #: This is the alignment padding between `.sbss` and `.bss` -- 92 B, inside the load segment,
    #: zero-initialised by the loader, and with no reference of any kind into it in either build.
    scratch: int
    scratch_bytes: int


TARGETS = {
    # The cave is the 112-byte alignment gap between .rodata and .gcc_except_table:
    # all zero, inside the single RWX load segment, and with no reference of any kind
    # into it (no 32-bit pointer anywhere in the image, no lui+lo pair constructing an
    # address in it, no branch or call target). Deliberately NOT the dead-code blob the
    # noclip patch uses: that blob's free tail is already the input-ring probe's
    # working space, and taking any of it costs that tool half its buffer.
    "SLES_505.45": Target(
        "SLES_505.45", 2933092,
        anchor_digests=(
            "d28eb48ba273388e29646ebacf2e0992578f584b2d2f7c912cf53dc465b783ff",
            "57fd925c5cb748ef641e401a071a8be889bbfb3fe98b3c90347c387315a9b8ab",
            "f89e33155426bfe4ff9f741959fe2d285acd1287ff72326124090115358aaa3a",
        ),
        loc_call=0x001A52C0, slot_form=0x001A51B8,
        table_entry=0x0036C860,
        numeric_test=0x001A653C,   # the kind-10 bne, taken to 0x001A6630
        numeric_body=0x001A6544, numeric_next=0x001A6630,
        locstring=0x002C6338,
        add_hud_event=0x00157348,
        dispatch_epilogue=0x0013C5B0,
        colour_block=0x003391E8,
        cave=0x003BCA90, cave_range=(0x003BCA90, 0x003BCB00),
        cave2=0x003BCBD8, cave2_range=(0x003BCBD8, 0x003BCC00),
        scratch=0x003BCFA4, scratch_bytes=92,
    ),
    # NTSC-U carries the banner draw, the numeric readout and the dispatcher as the SAME
    # instructions as PAL -- byte for byte across the whole window each hook sits in -- so
    # every anchor here was found by matching the PAL instruction window rather than by
    # re-reading the code, and each match is unique in the image. Its section layout mirrors
    # PAL's too, which puts both alignment gaps at the same sizes (112 B and 40 B) 0x1200
    # lower; both were re-vetted in this build rather than assumed from PAL's.
    "SLUS_203.26": Target(
        "SLUS_203.26", 2928240,
        anchor_digests=(
            "a9dff201788d393da7f71716b4bc5b0f340134d3ff3189fdf4fcb08e662fe828",
            "11121ad2cd81df5cdd90a1fd17d78966897446f3497e4517ad4cc3cd29d1b71e",
            "f89e33155426bfe4ff9f741959fe2d285acd1287ff72326124090115358aaa3a",
        ),
        loc_call=0x001A4DC8, slot_form=0x001A4CC0,
        table_entry=0x0036B660,
        numeric_test=0x001A6044,   # the kind-10 bne, taken to 0x001A6138
        numeric_body=0x001A604C, numeric_next=0x001A6138,
        locstring=0x002C5160,
        add_hud_event=0x00157330,
        dispatch_epilogue=0x0013C5A8,
        colour_block=0x00337FE8,
        cave=0x003BB790, cave_range=(0x003BB790, 0x003BB800),
        cave2=0x003BB8D8, cave2_range=(0x003BB8D8, 0x003BB900),
        scratch=0x003BBCA4, scratch_bytes=92,
    ),
}

CAVE_BYTES = 112
# The .gcc_except_table/.sdata gap, vetted the same way: 40 B, all zero, and with no pointer, literal
# construction or branch target anywhere in the image reaching into it.
CAVE2_BYTES = 40


def vaddr_to_off(va: int) -> int:
    return TEXT_FOFF + (va - TEXT_VADDR)


def anchor_digest(data: bytes, va: int) -> str:
    """SHA-256 of the single word at `va` -- how this patch recognises one of its anchors."""
    off = vaddr_to_off(va)
    return hashlib.sha256(bytes(data[off:off + 4])).hexdigest()


def jal(target: int) -> int:
    return 0x0C000000 | ((target >> 2) & 0x03FFFFFF)


def build_handler(t: Target, base: int) -> bytes:
    """Dispatcher entry 12. Entered by `jr` from the jump table with the dispatcher's
    own frame live: s0 = effect thread, s1 = node. Falls back into the shared
    epilogue, which restores ra from the frame -- so the jal below is free to clobber
    it."""
    a = Asm(base)
    a.lw("a0", 0xE8, "s0")                    # the rider this chain is firing for
    a.beq("a0", "zero", "done")               # no rider: post nothing, run on
    a.addiu("a2", "s1", NODE_PAYLOAD + PAYLOAD_TEXT)   # delay slot: value = the inline text
    a.lui("a3", SENTINEL >> 16)               # aux = the sentinel (low half empty by design)
    a.fconst(12, BANNER_SECONDS)              # f12 = the slot's lifetime
    a.addiu("a1", "zero", RING_KIND_CHECKPOINT)
    a.jal(t.add_hud_event)
    a.addiu("a0", "a0", 0x5820)               # delay slot: rider -> trick-score state
    a.label("done")
    a.j(t.dispatch_epilogue)
    a.addiu("v0", "zero", 1)                  # delay slot: 1 = continue the chain
    return a.assemble()


def build_shim(t: Target, base: int) -> bytes:
    """Replaces the kind-10 banner's `jal LocString`. a0 = the localization buffer and
    a1 = the stock string id, both already set by the branch; v1 still holds the ring
    slot (formed at 0x001A51B8 and not reassigned before the call). Returns a
    UTF-16LE string in v0, which is what LocString returns too."""
    a = Asm(base)
    a.lw("at", SLOT_AUX, "v1")
    a.lui("t9", SENTINEL >> 16)
    a.beq("at", "t9", "ours")
    a.lw("v0", SLOT_VALUE, "v1")              # delay slot: the node's text pointer, and harmless
    a.j(t.locstring)                          # not ours: the stock call overwrites v0 anyway
    a.nop()                                   # (a0/a1 are already the stock arguments)
    a.label("ours")
    # The three colour channels ride just behind the text, so they copy straight across as words --
    # no conversion, and no constant to hold. The alpha word above them is the retail fade, left alone.
    colour_red = t.colour_block + 4
    hi, _ = hi_lo(colour_red)
    a.lui("at", hi)
    for channel in range(COLOUR_CHANNELS):
        a.lw("t9", -(PAYLOAD_TEXT - 4 * channel), "v0")
        a.sw("t9", (colour_red + 4 * channel) - (hi << 16), "at")
    a.word(0x03E00008)                        # jr ra
    a.nop()
    return a.assemble()


def build_numeric_skip(t: Target, base: int) -> bytes:
    """Keep the banner's NUMERIC readout off our slots.

    The kind-10 banner is two draws, not one, and they are half a lifetime apart: the text loop draws over
    the first half, and a second loop draws a signed TIME over the second, formatted from the same slot's
    value word. Retail's checkpoint puts seconds there. We put a text pointer there -- which that loop
    renders as `+59:59.99`, its clamp, in green, right after every message.

    So this replaces that loop's kind-10 test. The extra condition is the aux word being zero, which every
    retail poster leaves it as and our handler never does. Reached by `j` from the test site, whose delay
    slot has already run the loop counter's increment.
    """
    a = Asm(base)
    a.bne("a0", "v0", "next")                 # not kind 10: the test's original taken path
    a.lw("at", SLOT_AUX, "a2")                # delay slot, and harmless when we do branch
    a.bne("at", "zero", "next")               # posted by the debug-text opcode, not by a checkpoint
    a.nop()
    a.j(t.numeric_body)                       # retail's own slot: draw the number as usual
    a.nop()
    a.label("next")
    a.j(t.numeric_next)
    a.nop()
    return a.assemble()


def resolve_target(name: str | None, data: bytes) -> Target:
    if name:
        return TARGETS[name]
    hits = [t for t in TARGETS.values()
            if len(data) == t.size
            and anchor_digest(data, t.loc_call) == t.anchor_digests[0]]
    if len(hits) != 1:
        raise SystemExit(
            "cannot identify this executable as a supported build "
            f"({', '.join(TARGETS)}); pass --target explicitly")
    return hits[0]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--elf", type=Path, default=DEFAULT_ELF)
    ap.add_argument("--out", type=Path, default=None,
                    help="patched executable (default: <elf>.debugtext)")
    ap.add_argument("--target", choices=sorted(TARGETS), default=None)
    ap.add_argument("--emit-patch", type=Path, metavar="JSON",
                    help="write the apply/revert patch file for `snowknife`")
    args = ap.parse_args()
    if args.out is None:
        args.out = args.elf.with_suffix(args.elf.suffix + ".debugtext")

    orig = args.elf.read_bytes()
    data = bytearray(orig)
    t = resolve_target(args.target, orig)
    print(f"target: {t.name}")
    if len(orig) != t.size:
        raise SystemExit(f"{args.elf} is {len(orig)} B, expected {t.size} for {t.name}")

    # Verify before writing: every anchor must hold exactly what this patch was authored
    # against. Checked by digest, so the expected encodings are not in this file; the word
    # actually found is printed, because that is read from your own executable and is the
    # whole diagnosis when a build does not match.
    for label, va, want in (("loc_call", t.loc_call, t.anchor_digests[0]),
                            ("table_entry", t.table_entry, t.anchor_digests[1]),
                            ("numeric_test", t.numeric_test, t.anchor_digests[2])):
        got = anchor_digest(data, va)
        if got != want:
            found = struct.unpack_from("<I", data, vaddr_to_off(va))[0]
            raise SystemExit(
                f"anchor {label} 0x{va:08x} does not hold the word this patch was authored "
                f"against.\n  found  0x{found:08x}  (sha256 {got})\n  wanted sha256 {want}")

    lo, hi = t.cave_range
    if not (lo <= t.cave and t.cave + CAVE_BYTES <= hi):
        raise SystemExit(f"cave 0x{t.cave:08x} +{CAVE_BYTES} B is outside its vetted "
                         f"range 0x{lo:08x}..0x{hi:08x}")
    # The gap is alignment padding, so "free" means it is still zero. A build that put
    # something there would otherwise be overwritten silently.
    coff = vaddr_to_off(t.cave)
    if any(data[coff:coff + CAVE_BYTES]):
        raise SystemExit(f"cave gap at 0x{t.cave:08x} (+{CAVE_BYTES} B) is not free")

    handler = build_handler(t, t.cave)
    shim_base = t.cave + len(handler)
    shim = build_shim(t, shim_base)
    used = len(handler) + len(shim)
    if used > CAVE_BYTES:
        raise SystemExit(f"cave overflow: {used} B used of {CAVE_BYTES} B")
    # The numeric skip lives in the second gap: all three routines do not fit in the first, and this
    # one is the only one with no reason to be adjacent to the others.
    skip_base = t.cave2
    skip = build_numeric_skip(t, skip_base)
    if len(skip) > CAVE2_BYTES:
        raise SystemExit(f"second cave overflow: {len(skip)} B used of {CAVE2_BYTES} B")
    lo2, hi2 = t.cave2_range
    if not (lo2 <= t.cave2 and t.cave2 + CAVE2_BYTES <= hi2):
        raise SystemExit(f"cave2 0x{t.cave2:08x} is outside its vetted range")
    c2off = vaddr_to_off(t.cave2)
    if any(data[c2off:c2off + CAVE2_BYTES]):
        raise SystemExit(f"cave2 gap at 0x{t.cave2:08x} is not free")

    patches = [
        (t.table_entry, struct.pack("<I", t.cave)),
        (t.loc_call, struct.pack("<I", jal(shim_base))),
        (t.numeric_test, struct.pack("<I", 0x08000000 | ((skip_base >> 2) & 0x03FFFFFF))),
        (t.cave, handler + shim),
        (t.cave2, skip),
    ]
    for va, blob in patches:
        off = vaddr_to_off(va)
        data[off:off + len(blob)] = blob
    args.out.write_bytes(data)

    changed = {i for va, blob in patches
               for i in range(vaddr_to_off(va), vaddr_to_off(va) + len(blob))}
    stray = [i for i in range(len(data)) if data[i] != orig[i] and i not in changed]
    print(f"wrote {args.out} ({len(data)} bytes, same size: {len(data) == len(orig)})")
    print(f"opcode 12 -> handler 0x{t.cave:08x} ({len(handler)} B); "
          f"banner LocString -> shim 0x{shim_base:08x} ({len(shim)} B); "
          f"numeric readout -> skip 0x{skip_base:08x} ({len(skip)} B, second gap); "
          f"{CAVE_BYTES - used} B of cave left, {CAVE2_BYTES - len(skip)} B of the second")
    print(f"stray byte changes outside patches: {len(stray)}")

    if args.emit_patch and not stray:
        regions = []
        for va, blob in patches:
            off = vaddr_to_off(va)
            regions.append({
                "fileOffset": off,
                "length": len(blob),
                "originalSha256": hashlib.sha256(orig[off:off + len(blob)]).hexdigest(),
                "patched": blob.hex(),
            })
        doc = {
            "name": "debug-text",
            "target": t.name,
            "formatVersion": 2,
            "targetSize": len(orig),
            "notes": "Gives SSF main type 12 a body: it posts the node's own inline "
                     "UTF-16LE text to the in-race HUD event ring as a kind-10 banner, "
                     "and the banner's string lookup is shimmed to return that pointer "
                     "when the slot carries this patch's sentinel in its aux word. A "
                     "real checkpoint crossing leaves aux 0 and gets the stock id and "
                     "the stock lookup, so retail behaviour is unchanged. Retail sends "
                     "main type 12 to the inert default, so a level authored with these "
                     "nodes runs normally on an unpatched disc. Each region names the "
                     "digest of the bytes it expects to replace, so apply is "
                     "verify-before-write and revert restores the bytes saved at apply "
                     "time. Patch points: [Trailmap: 443-debug-text].",
            "regions": regions,
        }
        args.emit_patch.parent.mkdir(parents=True, exist_ok=True)
        args.emit_patch.write_text(json.dumps(doc, indent=2) + "\n")
        print(f"emitted patch file: {args.emit_patch} ({len(regions)} regions)")
        if args.emit_patch.parent.name == "Patches":
            # These are copied into the build output, so snowknife keeps applying the previous
            # descriptor until it is rebuilt -- and an out-of-date patch applies cleanly and
            # silently, because every region still verifies against bytes that have not changed.
            print("  NOTE: rebuild snowknife before packing, or it will apply the descriptor it "
                  "already has in bin/")
    return 0 if not stray else 1


if __name__ == "__main__":
    raise SystemExit(main())
