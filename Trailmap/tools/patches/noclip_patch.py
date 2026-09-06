#!/usr/bin/env python3
"""Noclip / fly-mode ELF patch for SSX Tricky.

Supported boot executables: PAL `SLES_505.45` and NTSC-U `SLUS_203.26`. The two
builds share their class layouts and cave shape; only absolute addresses differ, so
one assembler drives both from the per-target table in TARGETS.

Injects a four-hook code cave into a dead-code blob (three unnamed, unreferenced
library-area functions, 1152 B on both builds). The blob is vetted dead by a FULL
reference scan — j/jal targets, every branch form, lui+lo16 pairs, and 32-bit
pointer constants anywhere in the file — plus entry-unreachability (the run sits
behind an unconditional jr/j and no word in it is referenced, so no fall-through or
branch can enter it).

The scan matters: an earlier PAL cave at 0x00122c40 was picked on jump-target
absence alone, but its jr-ra stubs were default no-op VIRTUAL METHODS held
in ~32 boarder-motion vtables (.data pointer entries). Virtual calls landed
mid-cave at level start and crashed the game.

Hooks (addresses below are PAL; see TARGETS for the NTSC-U set):
  A) Pad decode (device state machine, sole scePadRead caller @0x0017b098):
     captures the raw held mask + left-stick bytes for pad port 0 into the
     cave data block every frame, even while paused.
  B) BoarderMotion_SharedUpdate @0x001171f4 (past the enable + pause gates):
     TRIANGLE+CIRCLE edge toggles noclip (raw mask bits 0x0010|0x0020).
     While active: velocity (+0x150) zeroed, position (+0x140) moved by
     stick relative to the active camera on the world XY plane,
     X (0x0040) ascends, SQUARE (0x0080) descends, R1 (0x0008) = 4x speed.
     Indication: the boost meter (+0x1C) is pinned to 1.0 while active (the
     same field the uber-tier infinite-boost pin writes) — full meter = on.
     Guard gates: the registry singleton and its +0x730 world object must be
     non-null, else noclip force-disarms (covers level load/teardown frames
     where SharedUpdate runs on half-built boarders); boarder+0x41C==1
     (local human). No calls are made from the cave: an earlier revision
     played the boost-pad cross sfx on toggle, but the effect singleton
     dangles at freed memory during level transitions and the
     enqueue scribbled the registry global -> load-time crash.
  C) Control-input feed @0x00117b7c (SharedUpdate stack input word before
     the control-state dispatch): zeroed while active so the
     stick no longer spins/jumps/boosts the boarder.
  D) Boarder_EnterWipeOut @0x0011d838: suppressed for the local human while
     active, so bumps and crashes do not interrupt the flight.

Raw held-mask layout (active-high, from the pad decode nor):
  low byte  L2=01 R2=02 L1=04 R1=08 TRI=10 CIR=20 X=40 SQ=80
  high byte SEL=01 L3=02 R3=04 START=08 UP=10 RIGHT=20 DOWN=40 LEFT=80

Usage:
  python tools/patches/noclip_patch.py [--elf PATH] [--out PATH]
                                          [--target NAME] [--emit-patch JSON]

With no --target the build is identified from the hook-site words in --elf.
"""

from __future__ import annotations

import argparse
import hashlib
import struct
from dataclasses import dataclass
from pathlib import Path

# Anchored to this file, not the cwd, so the default names the same executable
# whether the command is run from the repo root or from a parent workspace.
DEFAULT_ELF = Path(__file__).resolve().parents[2] / "extracted" / "SLES_505.45"

TEXT_VADDR = 0x00100000
TEXT_FOFF = 0x1000

#: The cave is the head of a run of unreferenced library-area functions. Its first word is
#: checked as a signature that this really is that blob, by digest for the same reason the
#: hook sites are: a digest pins the build without carrying the game's encoding.
CAVE_HEAD_SHA256 = "3090a4899de1f37b0f082809410e4f69f52b3a23245718d927b8dc592df10986"

# A hook site is identified by the SHA-256 of the two words it holds rather than by those
# words themselves: a digest pins the build just as exactly while keeping the game's own
# instruction encodings out of this file. Where a hook must re-execute what it displaced,
# the body below re-derives those words from mnemonics through this file's assembler and
# marks the window with `Asm.retail`, so `--emit-patch` can publish a
# copy-from-your-own-executable directive in place of the bytes.


@dataclass(frozen=True)
class Target:
    """One boot executable's absolute addresses. Class layouts (the +0x140/+0x150/
    +0x41C/+0x1C boarder fields, +0x730/+0x290 world fields, +0x3C/+0x18/+0x24 pad
    fields) are identical across both builds and so are not part of this table."""
    name: str
    size: int
    cave_base: int
    cave_end: int          # next referenced word (live function entry)
    site_a: int            # pad decode
    site_b: int            # BoarderMotion_SharedUpdate
    site_c: int            # control-input feed
    site_d: int            # Boarder_EnterWipeOut prologue
    registry_ptr: int      # world/registry singleton
    control_dispatch: int
    #: SHA-256 of the 8 B at sites a, b, c, d, in that order — what `resolve_target`
    #: identifies a build by. Sites a, b and d hold the same instructions on both
    #: builds; c differs, because its second word is the control-state dispatch jal
    #: and that operand is this build's own dispatch address.
    site_digests: tuple[str, str, str, str]
    #: SHA-256 of the 12 B at site c: the two words the hook overwrites plus the jal's delay
    #: slot, which the branch leaves in place but which must run again before a cave returns
    #: past it. The probes that hook site c re-execute all three, and this is how they check
    #: the words they read from the emulator without any of them being written down here.
    site_c_displaced_sha256: str

    @property
    def sites(self) -> tuple[tuple[int, str], ...]:
        return ((self.site_a, "a"), (self.site_b, "b"),
                (self.site_c, "c"), (self.site_d, "d"))


TARGETS = {
    "SLES_505.45": Target(
        name="SLES_505.45", size=2933092,
        cave_base=0x002B4C40, cave_end=0x002B50C0,
        site_a=0x0017B104, site_b=0x001171F4, site_c=0x00117B7C, site_d=0x0011D838,
        registry_ptr=0x00338E58, control_dispatch=0x0011C9A8,
        site_digests=(
            "21dc030946f54cc7f0b1866beee9a4bee73ef40d5834f6e66d6c9b276983ca43",
            "be60a8ba25e4bf6a1505674bac44d6d3573f038fbb9ac57a2588ba41015820d6",
            "1dadaa221a2c4be585f38e80d17c548d897799cd15a379aed269e95976ee6f91",
            "2289ebd31dcc61107e6ab58323ff9bf0e312dc076095573279bdc601df430d8d",
        ),
        site_c_displaced_sha256="9b5d396c3d154e19f18a369c9f1b9c44da5561c1efa54befce6b7da5780e5e2d"),
    "SLUS_203.26": Target(
        name="SLUS_203.26", size=2928240,
        cave_base=0x002B3A68, cave_end=0x002B3EE8,
        site_a=0x0017B0EC, site_b=0x001171EC, site_c=0x00117B74, site_d=0x0011D830,
        registry_ptr=0x00337C58, control_dispatch=0x0011C9A0,
        site_digests=(
            "21dc030946f54cc7f0b1866beee9a4bee73ef40d5834f6e66d6c9b276983ca43",
            "be60a8ba25e4bf6a1505674bac44d6d3573f038fbb9ac57a2588ba41015820d6",
            "2f9838ee37c84a62222a26bbc3416ca0ed88cb55e255c6a58fa9360602844510",
            "2289ebd31dcc61107e6ab58323ff9bf0e312dc076095573279bdc601df430d8d",
        ),
        site_c_displaced_sha256="f8229d66d4843da873d43ee59b9a3e146a65e195961b3b3d43c36433b7fb0196"),
}

# tunables (float hi16 halves, materialized via lui+mtc1)
F_MOVE_K = 0x4116  # 9.375 u/s per stick unit -> 1200 u/s (12 m/s) full stick
F_VERT = 0x4461  # 900.0 u/s vertical (9 m/s)
F_DEADZONE = 0x41D0  # 26.0 of 128 (~20% stick deadzone)
TURN_DEG_PER_SEC = 90.0  # stick left/right yaw rate (PAL 50fps)

# ---- register names --------------------------------------------------------
R = {n: i for i, n in enumerate(
    "zero at v0 v1 a0 a1 a2 a3 t0 t1 t2 t3 t4 t5 t6 t7 "
    "s0 s1 s2 s3 s4 s5 s6 s7 t8 t9 k0 k1 gp sp fp ra".split())}


class Asm:
    """Tiny two-pass MIPS assembler: list of (emit-fn) closures + labels."""

    def __init__(self, base: int):
        self.base = base
        self.items: list = []  # int word | ('label', name) | callable(addr, labels)->word
        self.labels: dict[str, int] = {}
        self.nwords = 0
        #: (byte offset into this blob, source virtual address, byte length) for each run of
        #: words that belongs to the game rather than to this project — see `retail`.
        self.grafts: list[tuple[int, int, int]] = []

    def __len__(self) -> int:
        """Assembled size in bytes. A builder returns the Asm rather than its bytes so callers can
        also read `grafts`, and consumers that only want to know how much space a fragment takes
        (input_ring's cave-reservation arithmetic) keep working unchanged."""
        return self.nwords * 4

    def word(self, w: int):
        self.items.append(w & 0xFFFFFFFF)
        self.nwords += 1

    def retail(self, source_va: int, count: int):
        """Declare that the NEXT `count` words are instructions displaced from `source_va`.

        A trampoline has to re-execute what its branch overwrote, so those words are the
        game's, not ours — even though the lines below re-derive them from mnemonics rather
        than copying an encoding. They are emitted normally, because `--out` has to produce a
        working executable. What this records is the window: `--emit-patch` blanks it and
        publishes a directive to copy those bytes out of the reader's own executable instead,
        so the manifest carries no retail instruction.
        """
        self.grafts.append((self.nwords * 4, source_va, count * 4))

    def label(self, name: str):
        self.items.append(("label", name))

    # -- fixed encodings --
    def nop(self): self.word(0)

    def lui(self, rt, imm): self.word(0x3C000000 | (R[rt] << 16) | (imm & 0xFFFF))

    def addiu(self, rt, rs, imm):
        self.word(0x24000000 | (R[rs] << 21) | (R[rt] << 16) | (imm & 0xFFFF))

    def andi(self, rt, rs, imm):
        self.word(0x30000000 | (R[rs] << 21) | (R[rt] << 16) | (imm & 0xFFFF))

    def xori(self, rt, rs, imm):
        self.word(0x38000000 | (R[rs] << 21) | (R[rt] << 16) | (imm & 0xFFFF))

    def ori(self, rt, rs, imm):
        self.word(0x34000000 | (R[rs] << 21) | (R[rt] << 16) | (imm & 0xFFFF))

    def _mem(self, op, rt, off, base):
        self.word((op << 26) | (R[base] << 21) | (R[rt] << 16) | (off & 0xFFFF))

    def lw(self, rt, off, base): self._mem(0x23, rt, off, base)
    def sw(self, rt, off, base): self._mem(0x2B, rt, off, base)
    def lhu(self, rt, off, base): self._mem(0x25, rt, off, base)
    def sh(self, rt, off, base): self._mem(0x29, rt, off, base)
    def lbu(self, rt, off, base): self._mem(0x24, rt, off, base)
    def sb(self, rt, off, base): self._mem(0x28, rt, off, base)
    def sd(self, rt, off, base): self._mem(0x3F, rt, off, base)

    def lwc1(self, ft, off, base):
        self.word(0xC4000000 | (R[base] << 21) | (ft << 16) | (off & 0xFFFF))

    def swc1(self, ft, off, base):
        self.word(0xE4000000 | (R[base] << 21) | (ft << 16) | (off & 0xFFFF))

    def daddu(self, rd, rs, rt):
        self.word((R[rs] << 21) | (R[rt] << 16) | (R[rd] << 11) | 0x2D)

    def jal(self, target): self.word(0x0C000000 | ((target >> 2) & 0x03FFFFFF))
    def j(self, target): self.word(0x08000000 | ((target >> 2) & 0x03FFFFFF))

    # -- branches to labels (relative) --
    def _branch(self, op_rs_rt: int, name: str):
        def fix(addr, labels):
            delta = (labels[name] - (addr + 4)) >> 2
            return op_rs_rt | (delta & 0xFFFF)
        self.items.append(fix)
        self.nwords += 1

    def beq(self, rs, rt, name):
        self._branch(0x10000000 | (R[rs] << 21) | (R[rt] << 16), name)

    def bne(self, rs, rt, name):
        self._branch(0x14000000 | (R[rs] << 21) | (R[rt] << 16), name)

    def bc1f(self, name): self._branch(0x45000000, name)
    def bc1t(self, name): self._branch(0x45010000, name)
    def bltz(self, rs, name): self._branch(0x04000000 | (R[rs] << 21), name)

    def sra(self, rd, rt, sa):
        self.word((R[rt] << 16) | (R[rd] << 11) | (sa << 6) | 0x03)

    def sll(self, rd, rt, sa):
        self.word((R[rt] << 16) | (R[rd] << 11) | (sa << 6) | 0x00)

    def addu(self, rd, rs, rt):
        self.word((R[rs] << 21) | (R[rt] << 16) | (R[rd] << 11) | 0x21)

    def xor_(self, rd, rs, rt):
        self.word((R[rs] << 21) | (R[rt] << 16) | (R[rd] << 11) | 0x26)

    def or_(self, rd, rs, rt):
        self.word((R[rs] << 21) | (R[rt] << 16) | (R[rd] << 11) | 0x25)

    def subu(self, rd, rs, rt):
        self.word((R[rs] << 21) | (R[rt] << 16) | (R[rd] << 11) | 0x23)

    def sltiu(self, rt, rs, imm):
        self.word(0x2C000000 | (R[rs] << 21) | (R[rt] << 16) | (imm & 0xFFFF))

    # -- COP1 float --
    def mtc1(self, rt, fs): self.word(0x44800000 | (R[rt] << 16) | (fs << 11))

    def _fpu(self, funct, fd, fs, ft=0):
        self.word(0x46000000 | (ft << 16) | (fs << 11) | (fd << 6) | funct)

    def add_s(self, fd, fs, ft): self._fpu(0x00, fd, fs, ft)
    def sub_s(self, fd, fs, ft): self._fpu(0x01, fd, fs, ft)
    def mul_s(self, fd, fs, ft): self._fpu(0x02, fd, fs, ft)
    def div_s(self, fd, fs, ft): self._fpu(0x03, fd, fs, ft)

    def sqrt_s(self, fd, ft):
        # R5900 quirk: SQRT.S sources from the FT field (fs must be 0),
        # unlike every other fd/fs unary op. Verified against the game's
        # own sqrt.s instructions (all 9 nonzero-source uses are in ft).
        self.word(0x46000004 | (ft << 16) | (fd << 6))
    def abs_s(self, fd, fs): self._fpu(0x05, fd, fs)
    def neg_s(self, fd, fs): self._fpu(0x07, fd, fs)
    def c_lt_s(self, fs, ft): self.word(0x46000034 | (ft << 16) | (fs << 11))
    def c_eq_s(self, fs, ft): self.word(0x46000032 | (ft << 16) | (fs << 11))

    def movn(self, rd, rs, rt):
        self.word((R[rs] << 21) | (R[rt] << 16) | (R[rd] << 11) | 0x0B)

    def cvt_s_w(self, fd, fs):
        self.word(0x46800020 | (fs << 11) | (fd << 6))

    def fconst(self, fd, value: float):
        """Load an arbitrary float constant via at (lui [+ori] + mtc1)."""
        bits = struct.unpack("<I", struct.pack("<f", value))[0]
        self.lui("at", bits >> 16)
        if bits & 0xFFFF:
            self.ori("at", "at", bits & 0xFFFF)
        self.mtc1("at", fd)

    # -- assemble --
    def assemble(self) -> bytes:
        addr = self.base
        for it in self.items:
            if isinstance(it, tuple):
                self.labels[it[1]] = addr
            else:
                addr += 4
        out, addr = [], self.base
        for it in self.items:
            if isinstance(it, tuple):
                continue
            w = it(addr, self.labels) if callable(it) else it
            out.append(w)
            addr += 4
        return struct.pack(f"<{len(out)}I", *out)


def assert_no_undeclared_retail(
    label: str,
    blob: bytes,
    grafts: list[tuple[int, int, int]],
    original: bytes,
    protected: list[tuple[int, int]],
) -> None:
    """Refuse to emit a payload that repeats a word from the code this patch displaces without
    declaring it as a graft.

    This is the check the CI scanner cannot do. `patch_hygiene.py` runs without an executable,
    so it can only see that declared windows hold `break` and that no `break` is undeclared --
    it cannot notice a hook that re-executes displaced words and never called `Asm.retail`. Here
    the executable IS in hand, so the invariant can be enforced directly: every word in `blob`
    that also appears in a `protected` range must lie inside a declared graft window.

    `protected` is the set of ranges whose contents belong to the game: the sites this patch
    overwrites, and any range a graft already reads from. Zero words are ignored -- padding and
    `nop` are nobody's expression, and matching them would flag every `nop` in a cave.

    A coincidence is possible in principle: a hook may legitimately want an instruction the site
    also happens to contain. The fix then is still to look, because the alternative -- shipping
    the word undeclared -- is the thing this exists to prevent.
    """
    retail_words = set()
    for va, length in protected:
        off = vaddr_to_off(va)
        for i in range(0, length, 4):
            (word,) = struct.unpack_from("<I", original, off + i)
            if word:
                retail_words.add(word)

    declared = {i for at, _, length in grafts for i in range(at, at + length)}
    leaked = []
    for i in range(0, len(blob) - 3, 4):
        (word,) = struct.unpack_from("<I", blob, i)
        if word in retail_words and i not in declared:
            leaked.append((i, word))

    if leaked:
        detail = "\n".join(f"    byte {i}: 0x{word:08x}" for i, word in leaked)
        raise SystemExit(
            f"{label}: {len(leaked)} word(s) of the code this patch displaces would be written into "
            f"the emitted manifest without being declared:\n{detail}\n"
            "  Wrap the run in `a.retail(<source virtual address>, <word count>)` so the manifest "
            "publishes a copy directive instead of the words. If the match is a coincidence -- your "
            "own hook happening to need the same instruction -- say so in a comment and reorder or "
            "rewrite it, because the emitted file cannot tell the two apart.")

    # A payload that is nothing but grafts has no fixed bytes, so `snowknife` could not tell an
    # applied region from a pristine one and would read it as already done. Keep at least one
    # word of our own in every region -- in practice the branch or the hook body always is.
    if declared and len(declared) == len(blob):
        raise SystemExit(
            f"{label}: every byte of this region is a graft window, so nothing in it identifies "
            "the patch. Split the region, or keep one authored word in it.")


def assert_grafts_match_source(
    label: str,
    blob: bytes,
    grafts: list[tuple[int, int, int]],
    original: bytes,
) -> None:
    """Require each declared window to hold exactly the bytes at the source it names.

    `Asm.retail` states two things at once -- *these words are displaced* and *they came from
    there* -- and only the first is self-checking. The words here are re-derived from mnemonics,
    so a correct instruction paired with a wrong source address assembles and runs fine locally
    while the emitted manifest tells `snowknife` to copy from somewhere else. The two would then
    disagree, and only on someone else's machine.

    Comparing them closes that, and it is also what verifies the words the site digest does not
    reach: site C's graft spans three words while `site_digests` covers two. The third -- the
    jal's delay slot -- is checked here, and by the three-word `site_c_displaced_sha256` the
    live probes use.
    """
    for at, source_va, length in grafts:
        off = vaddr_to_off(source_va)
        want = original[off:off + length]
        got = blob[at:at + length]
        if got != want:
            raise SystemExit(
                f"{label}: the graft at byte {at} says it copies {length} B from 0x{source_va:08x}, "
                f"but the words emitted there are not the words at that address.\n"
                f"    emitted   {' '.join(f'0x{w:08x}' for w in struct.unpack(f'<{length // 4}I', got))}\n"
                f"    at source {' '.join(f'0x{w:08x}' for w in struct.unpack(f'<{length // 4}I', want))}\n"
                "  Either the mnemonics or the source address in `a.retail(...)` is wrong.")


def hi_base(addr: int) -> tuple[int, int]:
    """lui half + positive low offset for cave data addressing."""
    hi = addr >> 16
    lo = addr & 0xFFFF
    assert lo < 0x8000, hex(addr)
    return hi, lo


def hi_lo(addr: int) -> tuple[int, int]:
    """lui half + signed low half for an arbitrary absolute address: when the low
    half has bit 15 set the following signed-immediate op subtracts 0x10000, so the
    lui half is pre-incremented to compensate."""
    lo = addr & 0xFFFF
    hi = ((addr >> 16) + (1 if lo & 0x8000 else 0)) & 0xFFFF
    return hi, lo


class Cave:
    """Addresses of the cave's data block and code fragments for one target."""

    def __init__(self, t: Target):
        self.t = t
        self.active = t.cave_base + 0x00
        self.prev = t.cave_base + 0x04
        self.mask = t.cave_base + 0x08
        self.lx = t.cave_base + 0x0C
        self.ly = t.cave_base + 0x10
        self.a = t.cave_base + 0x20
        self.b = t.cave_base + 0x50


def build_cave_a(t: Target, c: Cave) -> Asm:
    """Pad capture: runs in the device decode with s1=device, s2=out struct,
    v1=held mask (nor, upper bits set), v0=LX, a1=LY, a3=RX all live.
    Only port 0 (device+0x3C==0) is captured. Free regs: at, t9."""
    a = Asm(c.a)
    hi, _ = hi_base(c.mask)
    a.lw("t9", 0x3C, "s1")            # device port
    a.bne("t9", "zero", "skip")
    a.nop()
    a.lui("at", hi)
    a.sw("v1", c.mask & 0xFFFF, "at")  # held mask (andi consumers only)
    a.sw("v0", c.lx & 0xFFFF, "at")
    a.sw("a1", c.ly & 0xFFFF, "at")
    a.label("skip")
    a.retail(t.site_a, 2)             # re-exec displaced originals
    a.sh("v1", 0x18, "s2")
    a.sw("a3", 0x24, "s2")
    a.j(t.site_a + 8)
    a.nop()
    return a


def build_cave_b(t: Target, c: Cave) -> Asm:
    """Noclip main: runs in SharedUpdate with s1=boarder (s3/s4/gp/sp/ra and
    f20-f22 preserved; everything else is dead at the hook point).
    Makes NO calls — everything is register work + boarder/cave-data stores."""
    a = Asm(c.b)
    hi, _ = hi_base(c.mask)
    a.lui("t8", hi)

    # --- world-alive gates: registry and its +0x730 object must exist,
    #     else force noclip off (covers load/teardown half-built frames).
    #     Keep worldObj in t7 for the camera lookup below. ---
    reg_hi, reg_lo = hi_lo(t.registry_ptr)
    a.lui("v0", reg_hi)
    a.lw("v0", reg_lo, "v0")
    a.beq("v0", "zero", "auto_off")
    a.nop()
    a.lw("t7", 0x730, "v0")
    a.beq("t7", "zero", "auto_off")
    a.nop()

    a.lw("v0", 0x41C, "s1")           # local human only
    a.addiu("v1", "zero", 1)
    a.bne("v0", "v1", "exit")
    a.nop()

    # --- TRI+CIR edge toggle ---
    a.lw("t0", c.mask & 0xFFFF, "t8")
    a.andi("t1", "t0", 0x0030)
    a.lw("t2", c.prev & 0xFFFF, "t8")
    a.sw("t1", c.prev & 0xFFFF, "t8")
    a.xori("t3", "t1", 0x0030)
    a.bne("t3", "zero", "notoggle")   # not both held now
    a.nop()
    a.beq("t2", "t1", "notoggle")     # both were already held
    a.nop()
    a.lw("t5", c.active & 0xFFFF, "t8")
    a.xori("t5", "t5", 1)
    a.sw("t5", c.active & 0xFFFF, "t8")

    a.label("notoggle")
    a.lw("t5", c.active & 0xFFFF, "t8")
    a.beq("t5", "zero", "exit")
    a.nop()

    # --- indication: pin boost meter full while active ---
    a.lui("at", 0x3F80)               # 1.0f
    a.sw("at", 0x1C, "s1")

    # --- speed constants (R1 held = x4) ---
    a.lui("at", F_MOVE_K)
    a.mtc1("at", 6)                   # f6 = stick->velocity scale (u/s per stick unit)
    a.lui("at", F_VERT)
    a.mtc1("at", 16)                  # f16 = vertical speed (u/s)
    a.lw("t0", c.mask & 0xFFFF, "t8")
    a.andi("t1", "t0", 0x0008)
    a.beq("t1", "zero", "slow")
    a.nop()
    a.add_s(6, 6, 6)
    a.add_s(6, 6, 6)
    a.add_s(16, 16, 16)
    a.add_s(16, 16, 16)
    a.label("slow")

    # --- sticks -> centered floats, branchless integer deadzone ---
    a.lw("t3", c.ly & 0xFFFF, "t8")
    a.addiu("t3", "t3", -128)
    a.sra("t4", "t3", 31)
    a.xor_("t5", "t3", "t4")
    a.subu("t5", "t5", "t4")          # t5 = |t3|
    a.sltiu("t5", "t5", 26)
    a.movn("t3", "zero", "t5")        # inside deadzone -> 0
    a.mtc1("t3", 2)
    a.cvt_s_w(2, 2)                   # f2 = LY-128 (or 0)
    a.lw("t2", c.lx & 0xFFFF, "t8")
    a.addiu("t2", "t2", -128)
    a.sra("t4", "t2", 31)
    a.xor_("t5", "t2", "t4")
    a.subu("t5", "t5", "t4")
    a.sltiu("t5", "t5", 26)
    a.movn("t2", "zero", "t5")
    a.mtc1("t2", 1)
    a.cvt_s_w(1, 1)                   # f1 = LX-128 (or 0)

    # --- CAMERA-RELATIVE movement: forward = from the active camera toward
    # the boarder, horizontalized + normalized (fly into the screen);
    # left/right = the screen-horizontal perpendicular. Camera position =
    # worldObj + *(worldObj+0x290)*128 + 0xB0 (the camera-centred grid-query
    # record; verified live: sits behind/above the rider). Guard: if camera
    # and boarder coincide horizontally (n==0), no horizontal thrust. ---
    a.mtc1("zero", 13)
    a.mtc1("zero", 14)
    a.mtc1("zero", 15)
    a.lw("t6", 0x290, "t7")           # active camera index
    a.sll("t6", "t6", 7)
    a.addu("t6", "t6", "t7")
    a.lwc1(7, 0xB0, "t6")             # cam.x
    a.lwc1(8, 0xB4, "t6")             # cam.y
    a.lwc1(9, 0x140, "s1")            # boarder.x
    a.lwc1(10, 0x144, "s1")           # boarder.y
    a.sub_s(9, 9, 7)                  # dx
    a.sub_s(10, 10, 8)                # dy
    a.mul_s(7, 9, 9)
    a.mul_s(8, 10, 10)
    a.add_s(7, 7, 8)
    a.sqrt_s(7, 7)                    # n (R5900 ft-source encoding)
    a.c_eq_s(7, 15)                   # f15 is 0.0
    a.nop()
    a.bc1t("no_horiz")
    a.nop()
    a.div_s(9, 9, 7)                  # fwd.x
    a.div_s(10, 10, 7)                # fwd.y
    a.mul_s(2, 2, 6)                  # fwd amount = -(sy*k)
    a.neg_s(2, 2)
    a.mul_s(1, 1, 6)                  # strafe amount = sx*k
    a.mul_s(13, 9, 2)
    a.mul_s(14, 10, 2)
    a.mul_s(11, 10, 1)                # right = (fwd.y, -fwd.x)
    a.mul_s(12, 9, 1)
    a.add_s(13, 13, 11)
    a.sub_s(14, 14, 12)
    a.label("no_horiz")

    # --- vertical: SQUARE up, X down (world Z) ---
    a.andi("t4", "t0", 0x0080)
    a.beq("t4", "zero", "no_up")
    a.nop()
    a.add_s(15, 15, 16)
    a.label("no_up")
    a.andi("t4", "t0", 0x0040)
    a.beq("t4", "zero", "no_down")
    a.nop()
    a.sub_s(15, 15, 16)
    a.label("no_down")

    a.swc1(13, 0x150, "s1")
    a.swc1(14, 0x154, "s1")
    a.swc1(15, 0x158, "s1")
    a.beq("zero", "zero", "exit")
    a.nop()

    a.label("auto_off")
    a.sw("zero", c.active & 0xFFFF, "t8")

    a.label("exit")
    a.retail(t.site_b, 2)             # re-exec displaced originals
    a.lui("at", 0x4270)
    a.mtc1("at", 3)
    a.j(t.site_b + 8)
    a.nop()
    return a


def build_cave_c(t: Target, c: Cave, base: int) -> Asm:
    """Zero the boarder packed-input word (s0 = &word) while noclip active,
    then perform the displaced control dispatch."""
    a = Asm(base)
    hi, _ = hi_base(c.active)
    a.lui("at", hi)
    a.lw("at", c.active & 0xFFFF, "at")
    a.beq("at", "zero", "skip")
    a.nop()
    a.lw("v0", 0x41C, "s1")           # local human only
    a.addiu("v1", "zero", 1)
    a.bne("v0", "v1", "skip")
    a.nop()
    a.sw("zero", 0, "s0")
    a.label("skip")
    # THREE words, not two: the branch overwrites the load and the jal, and the jal's own
    # delay slot at site_c+8 has to run before the cave returns past it. All three are the
    # game's; the jump below lands at site_c+12 so none of them runs twice.
    a.retail(t.site_c, 3)             # re-exec displaced originals
    a.lw("a0", 0x5AE0, "s1")
    a.jal(t.control_dispatch)
    a.daddu("a1", "s0", "zero")       # original jal delay slot
    a.j(t.site_c + 12)
    a.nop()
    return a


def build_cave_d(t: Target, c: Cave, base: int) -> Asm:
    """Suppress Boarder_EnterWipeOut for the local human while noclip is
    active (object bumps, wall crashes, hard landings all funnel through
    this entry). AI riders' wipeouts proceed. a0 = boarder at entry."""
    a = Asm(base)
    hi, _ = hi_base(c.active)
    a.lui("at", hi)
    a.lw("at", c.active & 0xFFFF, "at")
    a.beq("at", "zero", "enter")
    a.nop()
    a.lw("v0", 0x41C, "a0")
    a.addiu("v1", "zero", 1)
    a.bne("v0", "v1", "enter")
    a.nop()
    a.word(0x03E00008)                # jr ra — no wipeout
    a.nop()
    a.label("enter")
    a.retail(t.site_d, 2)             # re-exec displaced originals
    a.addiu("sp", "sp", -0x50)
    a.sd("s0", 0, "sp")
    a.j(t.site_d + 8)
    a.nop()
    return a


def vaddr_to_off(va: int) -> int:
    return va - TEXT_VADDR + TEXT_FOFF


def site_digest(data: bytes, va: int) -> str | None:
    """SHA-256 of the two words at `va`, or None when the file is too short to hold them."""
    off = vaddr_to_off(va)
    return hashlib.sha256(data[off:off + 8]).hexdigest() if off + 8 <= len(data) else None


def site_is_stock(target: "Target", index: int, words) -> bool:
    """True when `words` are the two this hook site holds in a pristine build.

    The comparison a caller would otherwise write against a literal pair. Callers that read live
    emulator memory (tools/autotest, tools/instrumentation) use this so that only the digest
    table has to know what a stock site contains.
    """
    words = tuple(words)
    if len(words) != 2:
        return False
    return hashlib.sha256(struct.pack("<2I", *words)).hexdigest() == target.site_digests[index]


def site_c_displaced_is_stock(target: "Target", words) -> bool:
    """True when `words` are the three instructions a site-C hook must re-execute, as a pristine
    build holds them: the two the branch overwrites and the delay slot after them.

    The probes that hook site C read those words out of the emulator, check them here, and
    only then build a cave around them -- so no tool has to spell them out.
    """
    words = tuple(words)
    if len(words) != 3:
        return False
    return hashlib.sha256(struct.pack("<3I", *words)).hexdigest() == target.site_c_displaced_sha256


def words_at(data: bytes, va: int, count: int = 2) -> str:
    """The words at `va`, formatted for a diagnostic.

    Printing these is fine and printing them is the point: this tool reads the executable on
    the operator's own machine, and a build that does not match is exactly when you need to
    see what is actually there. It is the SOURCE that carries digests instead of words.
    """
    off = vaddr_to_off(va)
    if off + count * 4 > len(data):
        return "<past end of file>"
    return " ".join(f"0x{w:08x}" for w in struct.unpack_from(f"<{count}I", data, off))


def parse_digest_spec(spec: str) -> list[tuple[int, int]]:
    """`0x0017b104,0x002b4c40:4` -> [(0x0017b104, 8), (0x002b4c40, 4)]. Default width is a
    hook site's two words; `:4` is what a one-word signature like the cave head needs."""
    out = []
    for part in spec.split(","):
        address, _, width = part.strip().partition(":")
        out.append((int(address, 0), int(width) if width else 8))
    return out


def print_digest_block(data: bytes, spec: list[tuple[int, int]]) -> None:
    """Print a paste-ready digest table for the given addresses.

    This is how a new build gets added. Find its hook sites, then:

        python tools/patches/noclip_patch.py --elf NEW_ELF \\
            --print-digests 0x0017b104,0x001171f4,0x00117b7c,0x0011d838

    and paste the block into TARGETS. The words each digest covers are printed beside it so you
    can check them against your disassembler; they are diagnostics from your own file, not
    something to copy into the source.
    """
    print("        site_digests=(")
    for address, width in spec:
        off = vaddr_to_off(address)
        digest = hashlib.sha256(data[off:off + width]).hexdigest()
        print(f'            "{digest}",   # 0x{address:08x} +{width} B  is  '
              f"{words_at(data, address, width // 4)}")
    print("        ),")


def resolve_target(name: str | None, data: bytes) -> Target:
    """Pick the target profile. Named explicitly, or identified from the executable:
    a build is this target when its size matches and all four hook sites digest to the
    values in its profile, which no other supported build satisfies."""
    if name:
        if name not in TARGETS:
            raise SystemExit(f"unknown target {name}; supported: {', '.join(TARGETS)}")
        return TARGETS[name]

    def fits(t: Target) -> bool:
        return len(data) == t.size and all(
            site_digest(data, site) == want
            for (site, _), want in zip(t.sites, t.site_digests))

    hits = [t for t in TARGETS.values() if fits(t)]
    if len(hits) != 1:
        # Say which site diverged for each candidate, and what is actually there. Without this a
        # new build, a patched image and a mistyped address all fail the same way.
        report = [f"cannot identify this {len(data):,} B executable as a supported build:"]
        for t in TARGETS.values():
            report.append(f"  {t.name} ({t.size:,} B)"
                          + ("" if len(data) == t.size else "  <- size differs"))
            for (site, label), want in zip(t.sites, t.site_digests):
                got = site_digest(data, site)
                mark = "ok  " if got == want else "MISS"
                report.append(f"    {mark} site {label} @ 0x{site:08x}  {words_at(data, site)}")
        report.append("  Pass --target to force one, or --print-digests to build a table for a new one.")
        raise SystemExit("\n".join(report))
    return hits[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--elf", type=Path, default=DEFAULT_ELF)
    ap.add_argument("--out", type=Path, default=None,
                    help="patched executable (default: <elf>.noclip)")
    ap.add_argument("--target", choices=sorted(TARGETS), default=None,
                    help="boot executable to patch (default: identify from --elf)")
    ap.add_argument("--emit-patch", type=Path, metavar="JSON",
                    help="also write a portable apply/revert patch file "
                         "(offset + original-bytes digest + patched bytes per "
                         "region) for `snowknife noclip`")
    ap.add_argument("--print-digests", metavar="ADDRS",
                    help="print a paste-ready site_digests block for these comma-separated "
                         "addresses and exit, e.g. 0x0017b104,0x001171f4 (append :4 for a "
                         "one-word signature). How a build this tool does not know gets added.")
    args = ap.parse_args()
    if args.out is None:
        args.out = args.elf.with_suffix(args.elf.suffix + ".noclip")

    data = bytearray(args.elf.read_bytes())

    if args.print_digests:
        print_digest_block(bytes(data), parse_digest_spec(args.print_digests))
        return 0

    def read_words(va: int, n: int, buf=data):
        return struct.unpack_from(f"<{n}I", buf, vaddr_to_off(va))

    t = resolve_target(args.target, data)
    c = Cave(t)
    print(f"target: {t.name}")

    if len(data) != t.size:
        raise SystemExit(f"{args.elf} is {len(data)} B, expected {t.size} for {t.name}")

    # verify hook sites are pristine
    for (site, label), want in zip(t.sites, t.site_digests):
        got = site_digest(data, site)
        if got != want:
            raise SystemExit(
                f"hook site {label} 0x{site:08x} does not hold the words this patch was authored "
                f"against.\n  found  {words_at(data, site)}  (sha256 {got})\n"
                f"  wanted sha256 {want}\n"
                "  Already patched, wrong build, or the site moved. --print-digests regenerates "
                "the table for a build this tool does not yet know.")
    # verify the cave region is the known dead blob (first word of its first function)
    if hashlib.sha256(data[vaddr_to_off(t.cave_base):vaddr_to_off(t.cave_base) + 4]).hexdigest() != CAVE_HEAD_SHA256:
        raise SystemExit(
            f"cave sanity 0x{t.cave_base:08x}: not the vetted dead blob.\n"
            f"  found  {words_at(data, t.cave_base, 1)}")

    asm_a = build_cave_a(t, c)
    asm_b = build_cave_b(t, c)
    cave_a, cave_b = asm_a.assemble(), asm_b.assemble()
    cave_c_base = (c.b + len(cave_b) + 15) & ~15
    asm_c = build_cave_c(t, c, cave_c_base)
    cave_c = asm_c.assemble()
    cave_d_base = (cave_c_base + len(cave_c) + 15) & ~15
    asm_d = build_cave_d(t, c, cave_d_base)
    cave_d = asm_d.assemble()
    cave_top = cave_d_base + len(cave_d)
    if cave_top > t.cave_end:
        raise SystemExit(f"cave overflow: end 0x{cave_top:08x} > 0x{t.cave_end:08x}")

    # (virtual address, bytes to write, retail windows inside those bytes)
    patches: list[tuple[int, bytes, list[tuple[int, int, int]]]] = [
        # data block: active, prev, mask, LX, LY, heading (east)
        (t.cave_base, struct.pack("<7I", 0, 0, 0, 128, 128, 0x3F800000, 0), []),
        (c.a, cave_a, asm_a.grafts),
        (c.b, cave_b, asm_b.grafts),
        (cave_c_base, cave_c, asm_c.grafts),
        (cave_d_base, cave_d, asm_d.grafts),
        (t.site_a, struct.pack("<2I", 0x08000000 | (c.a >> 2), 0), []),
        (t.site_b, struct.pack("<2I", 0x08000000 | (c.b >> 2), 0), []),
        (t.site_c, struct.pack("<2I", 0x08000000 | (cave_c_base >> 2), 0), []),
        (t.site_d, struct.pack("<2I", 0x08000000 | (cave_d_base >> 2), 0), []),
    ]

    orig = args.elf.read_bytes()

    # Every range whose contents are the game's: the four sites this patch overwrites, and site C's
    # third word, which the cave re-runs without overwriting. Anything from here that reaches a
    # payload has to be a declared graft.
    protected = [(t.site_a, 8), (t.site_b, 8), (t.site_c, 12), (t.site_d, 8)]
    for (va, blob, grafts), name in zip(patches, (
            "cave data", "cave A", "cave B", "cave C", "cave D",
            "site A", "site B", "site C", "site D")):
        assert_no_undeclared_retail(name, blob, grafts, orig, protected)
        assert_grafts_match_source(name, blob, grafts, orig)

    for va, blob, _ in patches:
        off = vaddr_to_off(va)
        data[off:off + len(blob)] = blob

    args.out.write_bytes(data)
    diffs = [(i, len(b)) for i, b in
             ((vaddr_to_off(va), blob) for va, blob, _ in patches)]
    changed = {i for off, ln in diffs for i in range(off, off + ln)}
    stray = [i for i in range(len(data)) if data[i] != orig[i] and i not in changed]
    print(f"wrote {args.out} ({len(data)} bytes, same size: {len(data) == len(orig)})")
    print(f"cave: A@0x{c.a:08x}({len(cave_a)}B) B@0x{c.b:08x}({len(cave_b)}B) "
          f"C@0x{cave_c_base:08x}({len(cave_c)}B) D@0x{cave_d_base:08x}({len(cave_d)}B) "
          f"top=0x{cave_top:08x} (budget 0x{t.cave_end:08x})")
    print(f"stray byte changes outside patches: {len(stray)}")

    if args.emit_patch and not stray:
        import json
        regions = []
        for va, blob, grafts in patches:
            off = vaddr_to_off(va)
            # Blank every retail window and publish a copy directive in its place, so the
            # manifest carries this project's hook code and nothing of the game's. Apply
            # fills each window from the reader's own executable after verifying the site.
            published = bytearray(blob)
            for at, source_va, length in grafts:
                # `break`, not zero: a zero word is a nop, so a reader that ignored the
                # graft would write a hook that silently skipped the displaced work. This
                # one traps at the first instruction instead of misbehaving quietly.
                published[at:at + length] = struct.pack(f"<{length // 4}I", *([0x0000000D] * (length // 4)))
            region = {
                "fileOffset": off,
                "length": len(blob),
                "originalSha256": hashlib.sha256(
                    orig[off:off + len(blob)]).hexdigest(),
                "patched": bytes(published).hex(),
            }
            if grafts:
                region["graft"] = [
                    {"at": at, "fromFileOffset": vaddr_to_off(source_va), "length": length}
                    for at, source_va, length in grafts
                ]
            regions.append(region)
        doc = {
            "name": "noclip-fly-mode",
            "target": t.name,
            "targetSize": len(orig),
            "formatVersion": 3,
            "notes": "In-game fly mode, TRIANGLE+CIRCLE toggle. "
                     "Patch points: [Trailmap: 440-noclip-fly-mode]. "
                     "Generated by the authoring workspace; each region names "
                     "the digest of the bytes it expects to replace, so apply "
                     "is verify-before-write and revert restores the bytes "
                     "saved from the target at apply time. Every byte of "
                     "`patched` is this project's own hook code. Where a hook "
                     "must re-execute an instruction its branch displaced, the "
                     "region carries a `graft` directive naming where to copy "
                     "that word from in your executable rather than the word "
                     "itself; those windows read as `break` until apply fills "
                     "them, so a reader that ignores `graft` fails loudly.",
            "regions": regions,
        }
        args.emit_patch.parent.mkdir(parents=True, exist_ok=True)
        # newline="" so the file is written with the LF endings .gitattributes stores it under,
        # rather than the platform's - a regenerated manifest should diff only where it changed.
        args.emit_patch.write_text(json.dumps(doc, indent=1) + "\n", newline="")
        print(f"emitted patch file: {args.emit_patch} ({len(regions)} regions)")
    return 0 if not stray else 1


if __name__ == "__main__":
    raise SystemExit(main())
