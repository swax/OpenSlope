#!/usr/bin/env python3
"""Per-course sky-colour ELF patch for SSX Tricky.

Supported boot executables: PAL `SLES_505.45` and NTSC-U `SLUS_203.26`.

The executable carries 13 per-course WorldConf records built from code immediates.
Each holds that course's zenith colour as three integer channels at +0x48/+0x4C/+0x50;
the loader normalizes them to floats and the renderer fills the sky ring's open top
with the result. See [Trailmap: 442-sky-color].

This patch adds a 13x3-byte RGB table in an unreferenced alignment gap and hooks the
loader immediately after the course's record has been selected. The hook jumps to a
cave that indexes the table by the already-clamped course index, writes the entry into
that record's three colour fields, re-executes the displaced instruction and returns.
The stock normalization, runtime vector, graphics setter and renderer are untouched -
the patch changes the DATA the retail path reads, not the path.

repo-hygiene: allow[disassembly-listing] -- project-authored patch cave; no retail instruction listing
Cave (15 instructions, a0 = course index, v0 = selected record):
    sll   v1, a0, 1          v1 = index*2
    addu  a0, v1, a0         a0 = index*3
    lui   v1, hi(table)
    addiu v1, v1, lo(table)
    addu  v1, v1, a0         &table[index*3]
    lbu   a0, 0(v1) ; sw a0, 0x48(v0)      red
    lbu   a0, 1(v1) ; sw a0, 0x4C(v0)      green
    lbu   a0, 2(v1) ; sw a0, 0x50(v0)      blue
    j     hook+8
    lwc1  f2, 0x50(v0)       displaced from hook+4

On first application Snowknife derives the initial RGB entries from the user's own
executable. The public manifest contains a verified initializer recipe and result digest,
not a copy of the retail channel values.

Usage:
  python tools/patches/sky_color_patch.py [--elf PATH] [--out PATH]
                                          [--target NAME] [--emit-patch JSON]
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from noclip_patch import (  # noqa: E402
    assert_no_undeclared_retail, parse_digest_spec, print_digest_block, words_at,
)

# Anchored to this file, not the cwd, so the default names the same executable
# whether the command is run from the repo root or from a parent workspace.
DEFAULT_ELF = Path(__file__).resolve().parents[2] / "extracted" / "SLES_505.45"

TEXT_VADDR = 0x00100000
TEXT_FOFF = 0x1000

# The hook displaces two instructions: the record-address add, and the first float load of
# the stock normalization that follows it. Both have to run again — the add in the branch's
# delay slot, the load at the end of the cave — and both are the game's words, so neither is
# written down here. The site is identified by the digest of what it holds, and each place a
# displaced word has to reappear is marked as a GRAFT: an (offset, source, length) the
# emitted manifest publishes as a copy-from-your-own-executable directive.
HOOK_SHA256 = "b22a052604334b5a84d7e3ca45cd3c34c28a0c34b8fdda97a05e6fb7f5b48861"
BREAK = 0x0000000D   # placeholder in an unfilled graft window: traps rather than no-ops

CAVE_BYTES = 60
TABLE_BYTES = 48

SLOTS = ["GARI", "SNOW", "ELYSIUM", "MESA", "MERQUER", "ALOHA", "PIPE",
         "UNTRACK", "MEGAPLE", "BIGAIR", "TRICK", "ALASKA", "UNKNOWN12"]


@dataclass(frozen=True)
class Target:
    """One boot executable's addresses. The WorldConf field offsets (+0x48/+0x4C/+0x50)
    and the hook's register roles are the same on both builds."""
    name: str
    size: int
    hook: int                    # course loader, right after the record address is formed
    cave: int                    # 60 B of unreferenced, executable space
    table: int                   # 48 B of unreferenced space for the RGB table
    initializer: int             # straight-line WorldConf record initializer
    cave_range: tuple[int, int]  # the vetted-free run the cave must lie inside
    cave_zeros: bool             # True when that run is alignment padding (all zero)


TARGETS = {
    # PAL: the cave is inter-function code padding; the table is the .data/.rodata gap.
    "SLES_505.45": Target("SLES_505.45", 2933092,
                          hook=0x0017E6C0, cave=0x003075C4, table=0x003608D0,
                          initializer=0x002582F0,
                          cave_range=(0x003075C4, 0x00307602), cave_zeros=True),
    # NTSC-U: no code-padding run in this build is long enough, so the cave sits in the
    # tail of the same dead library-function blob the noclip cave is vetted against
    # (0x002B3A68..0x002B3EE8, dead by full reference scan + entry-unreachability).
    # noclip's fragments end at 0x002B3CE8, so the two patches stay byte-disjoint.
    # The table gap is the structural twin of PAL's, ahead of the "CircFIFOBuff" string.
    "SLUS_203.26": Target("SLUS_203.26", 2928240,
                          hook=0x0017E608, cave=0x002B3EA0, table=0x0035F6D0,
                          initializer=0x00257DC0,
                          cave_range=(0x002B3CE8, 0x002B3EE8), cave_zeros=False),
}


def vaddr_to_off(va: int) -> int:
    return va - TEXT_VADDR + TEXT_FOFF


def hi_lo(addr: int) -> tuple[int, int]:
    """lui half + signed low half: a low half with bit 15 set makes the following
    signed-immediate op subtract 0x10000, so the lui half compensates."""
    lo = addr & 0xFFFF
    hi = ((addr >> 16) + (1 if lo & 0x8000 else 0)) & 0xFFFF
    return hi, lo


def build_cave(t: Target) -> tuple[bytes, list[tuple[int, int, int]]]:
    """The cave body, and the retail windows inside it.

    The last executable word is the float load this hook displaced, running in the return
    jump's delay slot. It is the game's instruction, so the blob leaves a `break` there and
    reports the window; `--emit-patch` turns that into a directive to copy the word out of
    the reader's own executable, and Snowknife fills it in at apply time.
    """
    hi, lo = hi_lo(t.table)
    words = [
        0x00041840,                      # sll   v1, a0, 1
        0x00642021,                      # addu  a0, v1, a0
        0x3C030000 | hi,                 # lui   v1, hi(table)
        0x24630000 | (lo & 0xFFFF),      # addiu v1, v1, lo(table)
        0x00641821,                      # addu  v1, v1, a0
        0x90640000,                      # lbu   a0, 0(v1)
        0xAC440048,                      # sw    a0, 0x48(v0)
        0x90640001,                      # lbu   a0, 1(v1)
        0xAC44004C,                      # sw    a0, 0x4C(v0)
        0x90640002,                      # lbu   a0, 2(v1)
        0xAC440050,                      # sw    a0, 0x50(v0)
        0x08000000 | ((t.hook + 8) >> 2),  # j    hook+8
        BREAK,                           # <- graft: the displaced lwc1, in the delay slot
        0x00000000,
        0x00000000,
    ]
    blob = struct.pack(f"<{len(words)}I", *words)
    assert len(blob) == CAVE_BYTES, len(blob)
    # word 12 of the cave <- the SECOND word at the hook site
    return blob, [(12 * 4, t.hook + 4, 4)]


def derive_table(executable: bytes, target: Target) -> bytes:
    """Recover the byte fields materialized by the target's fp-relative WorldConf initializer.

    This mirrors Snowknife's deliberately small constant pass. Unwritten fields stay zero and
    the emitted manifest records a digest of the complete result, so an unsupported layout fails
    closed rather than producing a plausible-looking table.
    """
    count = 1178
    words = struct.unpack_from(f"<{count}I", executable, vaddr_to_off(target.initializer))
    regs: list[int | None] = [None] * 32
    regs[0] = 0
    frame: dict[int, int] = {}
    for word in words:
        op, rs, rt = word >> 26, (word >> 21) & 31, (word >> 16) & 31
        rd, shift, function = (word >> 11) & 31, (word >> 6) & 31, word & 63
        immediate = word & 0xFFFF
        signed = immediate if immediate < 0x8000 else immediate - 0x10000
        if op == 0:
            if function == 0 and regs[rt] is not None:
                regs[rd] = (regs[rt] << shift) & 0xFFFFFFFF
            elif function == 33 and regs[rs] is not None and regs[rt] is not None:
                regs[rd] = (regs[rs] + regs[rt]) & 0xFFFFFFFF
            elif function == 35 and regs[rs] is not None and regs[rt] is not None:
                regs[rd] = (regs[rs] - regs[rt]) & 0xFFFFFFFF
            elif function == 37 and regs[rs] is not None and regs[rt] is not None:
                regs[rd] = regs[rs] | regs[rt]
            elif function != 8:
                regs[rd] = None
        elif op == 9:
            regs[rt] = None if regs[rs] is None else (regs[rs] + signed) & 0xFFFFFFFF
        elif op == 13:
            regs[rt] = None if regs[rs] is None else regs[rs] | immediate
        elif op == 15:
            regs[rt] = immediate << 16
        elif op == 17:
            if rs in (0, 2):
                regs[rt] = None
        elif op in (35, 36, 37):
            regs[rt] = None
        elif op == 43 and rs == 30 and regs[rt] is not None:
            frame[signed] = regs[rt]
        elif op in (8, 10, 11, 12, 14, 24, 25, 26, 27, 32, 33, 34, 38, 39,
                    48, 52, 55, 56, 60):
            regs[rt] = None
        regs[0] = 0

    body = bytearray()
    for slot in range(len(SLOTS)):
        for field in (0x48, 0x4C, 0x50):
            value = frame.get(slot * 0x94 + field, 0)
            if not 0 <= value <= 0xFF:
                raise SystemExit(f"WorldConf initializer value {value} is not a byte")
            body.append(value)
    return bytes(body)


def build_table(executable: bytes, target: Target) -> bytes:
    body = derive_table(executable, target)
    return body + bytes(TABLE_BYTES - len(body))


def resolve_target(name: str | None, data: bytes) -> Target:
    if name:
        if name not in TARGETS:
            raise SystemExit(f"unknown target {name}; supported: {', '.join(TARGETS)}")
        return TARGETS[name]

    def fits(t: Target) -> bool:
        if len(data) != t.size:
            return False
        off = vaddr_to_off(t.hook)
        return hashlib.sha256(data[off:off + 8]).hexdigest() == HOOK_SHA256

    hits = [t for t in TARGETS.values() if fits(t)]
    if len(hits) != 1:
        report = [f"cannot identify this {len(data):,} B executable as a supported build:"]
        for t in TARGETS.values():
            off = vaddr_to_off(t.hook)
            matched = hashlib.sha256(data[off:off + 8]).hexdigest() == HOOK_SHA256
            report.append(f"  {t.name} ({t.size:,} B)"
                          + ("" if len(data) == t.size else "  <- size differs"))
            report.append(f"    {'ok  ' if matched else 'MISS'} hook @ 0x{t.hook:08x}  "
                          f"{words_at(data, t.hook)}")
        report.append("  Pass --target to force one, or --print-digests to build a value for a new one.")
        raise SystemExit("\n".join(report))
    return hits[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--elf", type=Path, default=DEFAULT_ELF)
    ap.add_argument("--out", type=Path, default=None,
                    help="patched executable (default: <elf>.skycolor)")
    ap.add_argument("--target", choices=sorted(TARGETS), default=None,
                    help="boot executable to patch (default: identify from --elf)")
    ap.add_argument("--emit-patch", type=Path, metavar="JSON",
                    help="write the apply/revert patch file for `snowknife skycolor`")
    ap.add_argument("--print-digests", metavar="ADDRS",
                    help="print a paste-ready digest block for these comma-separated addresses "
                         "and exit, e.g. 0x0017e6c0. How a build this tool does not know gets added.")
    args = ap.parse_args()
    if args.out is None:
        args.out = args.elf.with_suffix(args.elf.suffix + ".skycolor")

    orig = args.elf.read_bytes()
    data = bytearray(orig)

    if args.print_digests:
        print_digest_block(orig, parse_digest_spec(args.print_digests))
        return 0

    t = resolve_target(args.target, orig)
    print(f"target: {t.name}")
    if len(orig) != t.size:
        raise SystemExit(f"{args.elf} is {len(orig)} B, expected {t.size} for {t.name}")

    hoff = vaddr_to_off(t.hook)
    got = hashlib.sha256(data[hoff:hoff + 8]).hexdigest()
    if got != HOOK_SHA256:
        raise SystemExit(
            f"hook 0x{t.hook:08x} does not hold the words this patch was authored against.\n"
            f"  found  {words_at(bytes(data), t.hook)}  (sha256 {got})\n"
            f"  wanted sha256 {HOOK_SHA256}\n"
            "  Already patched, wrong build, or the site moved. --print-digests regenerates the "
            "value for a build this tool does not yet know.")
    # The cave must land inside the run this target was vetted against. That run is
    # either alignment padding (all zero) or a blob of dead library code, so "free"
    # is checked as containment plus, for padding, that it really is still zero.
    lo, hi = t.cave_range
    if not (lo <= t.cave and t.cave + CAVE_BYTES <= hi):
        raise SystemExit(f"cave 0x{t.cave:08x} +{CAVE_BYTES} B is outside its vetted "
                         f"range 0x{lo:08x}..0x{hi:08x}")
    if t.cave_zeros and any(data[vaddr_to_off(t.cave):vaddr_to_off(t.cave) + CAVE_BYTES]):
        raise SystemExit(f"cave padding at 0x{t.cave:08x} (+{CAVE_BYTES} B) is not free")
    toff = vaddr_to_off(t.table)
    if any(data[toff:toff + TABLE_BYTES]):
        raise SystemExit(f"table gap at 0x{t.table:08x} (+{TABLE_BYTES} B) is not free")

    # The branch takes the hook's first word; the record-address add it displaced moves into
    # the delay slot behind it. That add is the game's word, so it is grafted from the site's
    # own first word rather than written here.
    hook_blob = struct.pack("<2I", 0x08000000 | (t.cave >> 2), BREAK)
    cave_blob, cave_grafts = build_cave(t)
    patches = [
        (t.hook, hook_blob, [(4, t.hook, 4)]),
        (t.cave, cave_blob, cave_grafts),
        (t.table, build_table(orig, t), []),
    ]
    # The hook's own two words are the only game code this patch displaces; anything of theirs
    # that reaches a payload has to be a declared graft.
    for (va, blob, grafts), name in zip(patches, ("hook", "cave", "table")):
        assert_no_undeclared_retail(name, blob, grafts, orig, [(t.hook, 8)])
        # noclip cross-checks its graft windows against the source they name, because its words
        # are re-derived from mnemonics and could disagree with the address. Here they are copied
        # from that address, so the comparison is vacuous and the useful check is the other one:
        # every source must lie inside the window HOOK_SHA256 verified, or the copy is taken from
        # bytes nothing confirmed.
        for at, source_va, length in grafts:
            if not (t.hook <= source_va and source_va + length <= t.hook + 8):
                raise SystemExit(
                    f"{name}: the graft at byte {at} copies from 0x{source_va:08x}+{length}, which is "
                    f"outside the digest-verified hook window 0x{t.hook:08x}+8.")

    # `patches` is what the manifest publishes: `break` stands in every graft window. The
    # executable this run writes needs the real words, so they are copied out of the input
    # here — the same copy Snowknife performs at apply time, from the same source.
    for va, blob, grafts in patches:
        off = vaddr_to_off(va)
        filled = bytearray(blob)
        for at, source_va, length in grafts:
            soff = vaddr_to_off(source_va)
            filled[at:at + length] = orig[soff:soff + length]
        data[off:off + len(filled)] = filled
    args.out.write_bytes(data)

    changed = {i for va, blob, _ in patches
               for i in range(vaddr_to_off(va), vaddr_to_off(va) + len(blob))}
    stray = [i for i in range(len(data)) if data[i] != orig[i] and i not in changed]
    print(f"wrote {args.out} ({len(data)} bytes, same size: {len(data) == len(orig)})")
    print(f"hook 0x{t.hook:08x} -> cave 0x{t.cave:08x} ({CAVE_BYTES} B); "
          f"table 0x{t.table:08x} ({TABLE_BYTES} B)")
    print(f"stray byte changes outside patches: {len(stray)}")

    if args.emit_patch and not stray:
        import json
        regions = []
        for va, blob, grafts in patches:
            off = vaddr_to_off(va)
            # The RGB entries are reconstructed from the user's executable by Snowknife. Keep only
            # the table padding/template in the public operational manifest.
            manifest_blob = bytes(len(blob)) if va == t.table else blob
            region = {
                "fileOffset": off,
                "length": len(blob),
                "originalSha256": hashlib.sha256(orig[off:off + len(blob)]).hexdigest(),
                "patched": manifest_blob.hex(),
            }
            if grafts:
                region["graft"] = [
                    {"at": at, "fromFileOffset": vaddr_to_off(source_va), "length": length}
                    for at, source_va, length in grafts
                ]
            regions.append(region)
        seed = derive_table(orig, t)
        doc = {
            "name": "sky-color",
            "target": t.name,
            "targetSize": len(orig),
            "formatVersion": 3,
            "notes": "Overrides the 13 per-course WorldConf sky colours at load time. "
                     "The hook runs after the current course record is selected and "
                     "before its integer RGB fields are normalized. It indexes a "
                     "13x3-byte RGB table, updates the selected record, then returns to "
                     "the stock conversion and graphics setter. "
                     "On first application Snowknife reconstructs the table from the supported "
                     "executable's WorldConf initializer, so this manifest carries no retail "
                     "channel values and changing one slot leaves every other slot unchanged. "
                     "Each region names the digest of "
                     "the bytes it expects to replace, so apply is verify-before-write "
                     "and revert restores the bytes saved from the target at apply time. "
                     "Every byte of `patched` is this project's own hook code: the two "
                     "instructions this hook displaces and must re-run are named by "
                     "`graft` directives, which say where to copy each word from in your "
                     "own executable, and read as `break` until apply fills them. "
                     "Patch points: [Trailmap: 442-sky-color].",
            "table": {
                "region": 2,
                "entrySize": 3,
                "slots": SLOTS,
                "seed": {
                    "kind": "mips-worldconf-initializer",
                    "fileOffset": vaddr_to_off(t.initializer),
                    "instructionCount": 1178,
                    "recordStride": 0x94,
                    "channelOffsets": [0x48, 0x4C, 0x50],
                    "sha256": hashlib.sha256(seed).hexdigest(),
                },
            },
            "regions": regions,
        }
        args.emit_patch.parent.mkdir(parents=True, exist_ok=True)
        # newline="" so the file is written with the LF endings .gitattributes stores it under,
        # rather than the platform's - a regenerated manifest should diff only where it changed.
        args.emit_patch.write_text(json.dumps(doc, indent=2) + "\n", newline="")
        print(f"emitted patch file: {args.emit_patch} ({len(regions)} regions)")
    return 0 if not stray else 1


if __name__ == "__main__":
    raise SystemExit(main())
