#!/usr/bin/env python
"""
vu_disasm.py  -  PS2 VU1 microcode disassembler + DVP overlay parser for SSX Tricky.

Targets the PAL boot ELF (extracted/SLES_505.45). Two sub-commands:

    python tools/analysis/vu_disasm.py overlays
        Parse .DVP.ovlytab / .DVP.ovlystrtab and print the VU program inventory:
        the ~9 VU programs (groups whose micro-mem load offset resets to 0), their
        member overlays, names, source file-offsets, byte sizes and load addresses.

    python tools/analysis/vu_disasm.py disasm <program-index> [--count N] [--start VUADDR]
        Assemble the program's overlays into a micro-memory image at their correct
        load offsets and disassemble it, both pipes side by side, with resolved
        branch targets and I-bit float immediates.

Stdlib only. The tables below are the VU1 instruction set: opcode-to-mnemonic maps
using Sony's VU naming, plus the bitfield positions the ISA defines. PCSX2's VU
disassembler was consulted as a cross-reference while building them, and the two
disagree where PCSX2 mislabels the accumulator SUBA group (see UPPER_FD) — no PCSX2
code is included or adapted here. Word order was settled empirically rather than
taken from any reference: LOWER word first, then UPPER, giving a 100% valid decode
in both pipes against .vutext versus 44% reversed.
"""

import argparse
import os
import struct
import sys

# --------------------------------------------------------------------------
# ELF parsing
# --------------------------------------------------------------------------

DEFAULT_ELF = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "extracted", "SLES_505.45")


class Elf:
    def __init__(self, path):
        with open(path, "rb") as fh:
            self.data = fh.read()
        d = self.data
        if d[:4] != b"\x7fELF":
            raise ValueError("not an ELF: %s" % path)
        self.shoff = struct.unpack_from("<I", d, 0x20)[0]
        self.shentsize = struct.unpack_from("<H", d, 0x2e)[0]
        self.shnum = struct.unpack_from("<H", d, 0x30)[0]
        self.shstrndx = struct.unpack_from("<H", d, 0x32)[0]
        strtab_off = struct.unpack_from(
            "<I", d, self.shoff + self.shstrndx * self.shentsize + 0x10)[0]
        self.sections = []          # list of dicts in section order
        self.by_name = {}
        for i in range(self.shnum):
            base = self.shoff + i * self.shentsize
            nameo, typ, flags, addr, off, size = struct.unpack_from(
                "<IIIIII", d, base)
            end = d.index(b"\x00", strtab_off + nameo)
            name = d[strtab_off + nameo:end].decode("latin1")
            sec = dict(idx=i, name=name, type=typ, flags=flags,
                       addr=addr, off=off, size=size)
            self.sections.append(sec)
            # first definition wins (overlay sections share names rarely)
            self.by_name.setdefault(name, sec)

    def section(self, name):
        return self.by_name[name]

    def cstr_at_vaddr(self, sec, vaddr):
        """Read a NUL-terminated string from `sec` given a virtual address."""
        o = vaddr - sec["addr"] + sec["off"]
        end = self.data.index(b"\x00", o)
        return self.data[o:end].decode("latin1")


# --------------------------------------------------------------------------
# Overlay table  (.DVP.ovlytab = N x 12-byte [name_vaddr, src_vaddr, vu_mm_off])
# --------------------------------------------------------------------------

def load_overlays(elf):
    """Return a list of overlay dicts in table order."""
    tab = elf.section(".DVP.ovlytab")
    strt = elf.section(".DVP.ovlystrtab")
    vutext = elf.section(".vutext")
    # The 42 stripped .DVP.overlay..* sections carry the real *loaded* byte size
    # of each overlay (their own bytes are zero/filler in the shipped ELF; the
    # actual microcode lives in .vutext at src_vaddr).
    ovsecs = [s for s in elf.sections if s["name"].startswith(".DVP.overlay..")]

    n = tab["size"] // 12
    overlays = []
    for i in range(n):
        name_v, src_v, mm = struct.unpack_from("<III", elf.data,
                                               tab["off"] + i * 12)
        name = elf.cstr_at_vaddr(strt, name_v)
        size = ovsecs[i]["size"] if i < len(ovsecs) else 0
        file_off = src_v - vutext["addr"] + vutext["off"]
        overlays.append(dict(idx=i, name=name, name_vaddr=name_v, src_vaddr=src_v,
                             mm=mm, size=size, file_off=file_off))
    return overlays


def group_programs(overlays):
    """Group overlays into VU programs: a new program starts wherever mm == 0."""
    progs = []
    cur = None
    for ov in overlays:
        if ov["mm"] == 0:
            cur = []
            progs.append(cur)
        if cur is None:           # defensive: leading non-zero
            cur = []
            progs.append(cur)
        cur.append(ov)
    return progs


def program_image(elf, prog):
    """Assemble a program's overlays into a contiguous micro-memory image."""
    total = max(ov["mm"] + ov["size"] for ov in prog)
    buf = bytearray(total)
    for ov in prog:
        chunk = elf.data[ov["file_off"]:ov["file_off"] + ov["size"]]
        buf[ov["mm"]:ov["mm"] + ov["size"]] = chunk
    return bytes(buf)


# --------------------------------------------------------------------------
# VU1 instruction decode tables  (the ISA's own opcode map and Sony mnemonics)
# --------------------------------------------------------------------------

BC = ["x", "y", "z", "w"]

# Upper main table, indexed by (code & 0x3f). 0x30-0x3b are illegal; 0x3c-0x3f
# are the "special" (accumulator / conversion) groups handled separately.
UPPER_MAIN = {
    0x00: "ADDx", 0x01: "ADDy", 0x02: "ADDz", 0x03: "ADDw",
    0x04: "SUBx", 0x05: "SUBy", 0x06: "SUBz", 0x07: "SUBw",
    0x08: "MADDx", 0x09: "MADDy", 0x0a: "MADDz", 0x0b: "MADDw",
    0x0c: "MSUBx", 0x0d: "MSUBy", 0x0e: "MSUBz", 0x0f: "MSUBw",
    0x10: "MAXx", 0x11: "MAXy", 0x12: "MAXz", 0x13: "MAXw",
    0x14: "MINIx", 0x15: "MINIy", 0x16: "MINIz", 0x17: "MINIw",
    0x18: "MULx", 0x19: "MULy", 0x1a: "MULz", 0x1b: "MULw",
    0x1c: "MULq", 0x1d: "MAXi", 0x1e: "MULi", 0x1f: "MINIi",
    0x20: "ADDq", 0x21: "MADDq", 0x22: "ADDi", 0x23: "MADDi",
    0x24: "SUBq", 0x25: "MSUBq", 0x26: "SUBi", 0x27: "MSUBi",
    0x28: "ADD", 0x29: "MADD", 0x2a: "MUL", 0x2b: "MAX",
    0x2c: "SUB", 0x2d: "MSUB", 0x2e: "OPMSUB", 0x2f: "MINI",
}

# Special upper groups, indexed by the fd field = (code>>6)&0x1f.  Group = (code&0x3) =
# bc index (x/y/z/w).  Index 1 is the accumulator SUBA, named here by the
# canonical Sony VU mnemonic SUBA<bc> (PCSX2 labels it "SUBx").
UPPER_FD = [
    {0: "ADDAx", 1: "SUBAx", 2: "MADDAx", 3: "MSUBAx", 4: "ITOF0", 5: "FTOI0",
     6: "MULAx", 7: "MULAq", 8: "ADDAq", 9: "SUBAq", 10: "ADDA", 11: "SUBA"},
    {0: "ADDAy", 1: "SUBAy", 2: "MADDAy", 3: "MSUBAy", 4: "ITOF4", 5: "FTOI4",
     6: "MULAy", 7: "ABS", 8: "MADDAq", 9: "MSUBAq", 10: "MADDA", 11: "MSUBA"},
    {0: "ADDAz", 1: "SUBAz", 2: "MADDAz", 3: "MSUBAz", 4: "ITOF12", 5: "FTOI12",
     6: "MULAz", 7: "MULAi", 8: "ADDAi", 9: "SUBAi", 10: "MULA", 11: "OPMULA"},
    {0: "ADDAw", 1: "SUBAw", 2: "MADDAw", 3: "MSUBAw", 4: "ITOF15", 5: "FTOI15",
     6: "MULAw", 7: "CLIP", 8: "MADDAi", 9: "MSUBAi", 11: "NOP"},
]

# Lower top-level table, indexed by (code >> 25) (7 bits).
LOWER_TOP = {
    0x00: "LQ", 0x01: "SQ", 0x04: "ILW", 0x05: "ISW",
    0x08: "IADDIU", 0x09: "ISUBIU",
    0x10: "FCEQ", 0x11: "FCSET", 0x12: "FCAND", 0x13: "FCOR",
    0x14: "FSEQ", 0x15: "FSSET", 0x16: "FSAND", 0x17: "FSOR",
    0x18: "FMEQ", 0x1a: "FMAND", 0x1b: "FMOR", 0x1c: "FCGET",
    0x20: "B", 0x21: "BAL", 0x24: "JR", 0x25: "JALR",
    0x28: "IBEQ", 0x29: "IBNE",
    0x2c: "IBLTZ", 0x2d: "IBGTZ", 0x2e: "IBLEZ", 0x2f: "IBGEZ",
    # 0x40 -> LOWER_SPECIAL
}

# Lower special table (top==0x40), indexed by (code & 0x3f).
LOWER_SPECIAL = {
    0x30: "IADD", 0x31: "ISUB", 0x32: "IADDI", 0x34: "IAND", 0x35: "IOR",
    # 0x3c-0x3f -> LOWER_T3[*]
}

# Lower T3 sub-tables (special op 0x3c..0x3f), indexed by the fd field = (code>>6)&0x1f.
LOWER_T3 = [
    {12: "MOVE", 13: "LQI", 14: "DIV", 15: "MTIR", 16: "RNEXT", 25: "MFP",
     26: "XTOP", 27: "XGKICK", 28: "ESADD", 29: "EATANxy", 30: "ESQRT",
     31: "ESIN"},
    {12: "MR32", 13: "SQI", 14: "SQRT", 15: "MFIR", 16: "RGET", 26: "XITOP",
     28: "ERSADD", 29: "EATANxz", 30: "ERSQRT", 31: "EATAN"},
    {13: "LQD", 14: "RSQRT", 15: "ILWR", 16: "RINIT", 28: "ELENG", 29: "ESUM",
     30: "ERCPR", 31: "EEXP"},
    {13: "SQD", 14: "WAITQ", 15: "ISWR", 16: "RXOR", 28: "ERLENG", 30: "WAITP"},
]

# Upper instruction flag bits.
I_BIT = 1 << 31     # lower 32 bits are a 32-bit float immediate for the I reg
E_BIT = 1 << 30     # microprogram end (stop after the next instruction)
M_BIT = 1 << 29
D_BIT = 1 << 28
T_BIT = 1 << 27


# --------------------------------------------------------------------------
# Field extraction
# --------------------------------------------------------------------------

def _ft(c):  return (c >> 16) & 0x1f
def _fs(c):  return (c >> 11) & 0x1f
def _fd(c):  return (c >> 6) & 0x1f
def _it(c):  return (c >> 16) & 0x0f
def _is(c):  return (c >> 11) & 0x0f
def _id(c):  return (c >> 6) & 0x0f
def _fsf(c): return (c >> 21) & 0x03
def _ftf(c): return (c >> 23) & 0x03


def dest_str(c):
    s = ""
    if c & (1 << 24): s += "x"
    if c & (1 << 23): s += "y"
    if c & (1 << 22): s += "z"
    if c & (1 << 21): s += "w"
    return s


def imm5(c):
    v = (c >> 6) & 0x1f
    return v - 0x20 if v & 0x10 else v


def imm11(c):
    v = c & 0x7ff
    return v - 0x800 if v & 0x400 else v


def imm15(c):
    return ((c >> 10) & 0x7800) | (c & 0x7ff)


def vf(n):  return "vf%02d" % n
def vi(n):  return "vi%02d" % n


# --------------------------------------------------------------------------
# Upper pipe disassembly
# --------------------------------------------------------------------------

def disasm_upper(code):
    op = code & 0x3f
    d = dest_str(code)
    fd, fs, ft = _fd(code), _fs(code), _ft(code)

    if op < 0x30:
        name = UPPER_MAIN[op]
    elif op >= 0x3c:
        name = UPPER_FD[op & 0x3].get(fd)
        if name is None:
            return "(illegal upper %08x)" % code, ""
    else:
        return "(illegal upper %08x)" % code, ""

    # flags suffix (E end / M / D / T); I handled by caller
    flags = ""
    for bit, ch in ((E_BIT, "E"), (M_BIT, "M"), (D_BIT, "D"), (T_BIT, "T")):
        if code & bit:
            flags += ch

    text = _fmt_upper(name, code, d, fd, fs, ft)
    return text, flags


_ACC_OPS = ("ADDA", "SUBA", "MADDA", "MSUBA", "MULA", "OPMULA")


def _fmt_upper(name, code, d, fd, fs, ft):
    base = name.rstrip("xyzwiq")          # crude root for classification
    bc = name[-1] if name[-1] in "xyzw" and base in (
        "ADD", "SUB", "MUL", "MADD", "MSUB", "MAX", "MINI",
        "ADDA", "SUBA", "MULA", "MADDA", "MSUBA") else None
    dd = "." + d if d else ""

    if name == "NOP":
        return "NOP"
    if name in ("ABS",):
        return "ABS%s %s, %s" % (dd, vf(ft), vf(fs))
    if name.startswith("ITOF") or name.startswith("FTOI"):
        return "%s%s %s, %s" % (name, dd, vf(ft), vf(fs))
    if name == "CLIP":
        return "CLIP %s, %sw" % (vf(fs), vf(ft))
    if name == "OPMULA":
        return "OPMULA%s ACC, %s, %s" % (dd, vf(fs), vf(ft))
    if name == "OPMSUB":
        return "OPMSUB%s %s, %s, %s" % (dd, vf(fd), vf(fs), vf(ft))

    is_acc = any(name.startswith(p) for p in _ACC_OPS)
    target = "ACC" if is_acc else vf(fd)

    # third operand
    if name.endswith("i"):
        third = "I"
    elif name.endswith("q"):
        third = "Q"
    elif bc is not None:
        third = vf(ft) + bc
    else:
        third = vf(ft)

    return "%s%s %s, %s, %s" % (name, dd, target, vf(fs), third)


# --------------------------------------------------------------------------
# Lower pipe disassembly
# --------------------------------------------------------------------------

def lower_name(code):
    top = code >> 25
    if top == 0x40:
        op = code & 0x3f
        if op in LOWER_SPECIAL:
            return LOWER_SPECIAL[op]
        if op >= 0x3c:
            return LOWER_T3[op & 0x3].get(_fd(code))
        return None
    return LOWER_TOP.get(top)


def disasm_lower(code, idx):
    name = lower_name(code)
    if name is None:
        return "(illegal lower %08x)" % code
    fd, fs, ft = _fd(code), _fs(code), _ft(code)
    it, is_, id_ = _it(code), _is(code), _id(code)
    fsf, ftf = ".xyzw"[_fsf(code)], ".xyzw"[_ftf(code)]

    # NOP is encoded as MOVE vf00, vf00
    if name == "MOVE" and fs == 0 and ft == 0:
        return "NOP"

    if name == "LQ":
        return "LQ %s, %d(%s)" % (vf(ft), imm11(code), vi(is_))
    if name == "SQ":
        return "SQ %s, %d(%s)" % (vf(fs), imm11(code), vi(it))
    if name in ("LQD", "LQI"):
        return "%s %s, (%s%s)" % (name, vf(ft), vi(is_),
                                  "--" if name == "LQD" else "++")
    if name in ("SQD", "SQI"):
        return "%s %s, (%s%s)" % (name, vf(fs), vi(it),
                                  "--" if name == "SQD" else "++")
    if name in ("ILW",):
        return "ILW %s, %d(%s)" % (vi(it), imm11(code), vi(is_))
    if name in ("ISW",):
        return "ISW %s, %d(%s)" % (vi(it), imm11(code), vi(is_))
    if name in ("ILWR",):
        return "ILWR %s, (%s)" % (vi(it), vi(is_))
    if name in ("ISWR",):
        return "ISWR %s, (%s)" % (vi(it), vi(is_))
    if name in ("IADDIU", "ISUBIU"):
        return "%s %s, %s, %d" % (name, vi(it), vi(is_), imm15(code))
    if name == "IADDI":
        return "IADDI %s, %s, %d" % (vi(it), vi(is_), imm5(code))
    if name in ("IADD", "ISUB", "IAND", "IOR"):
        return "%s %s, %s, %s" % (name, vi(id_), vi(is_), vi(it))
    if name in ("MOVE", "MR32"):
        return "%s%s %s, %s" % (name, _du(code), vf(ft), vf(fs))
    if name == "MFIR":
        return "MFIR%s %s, %s" % (_du(code), vf(ft), vi(is_))
    if name == "MTIR":
        return "MTIR %s, %s%s" % (vi(it), vf(fs), fsf)
    if name == "DIV":
        return "DIV Q, %s%s, %s%s" % (vf(fs), fsf, vf(ft), ftf)
    if name in ("SQRT",):
        return "SQRT Q, %s%s" % (vf(ft), ftf)
    if name in ("RSQRT",):
        return "RSQRT Q, %s%s, %s%s" % (vf(fs), fsf, vf(ft), ftf)
    if name in ("WAITQ", "WAITP"):
        return name
    if name in ("RINIT", "RXOR"):
        return "%s R, %s%s" % (name, vf(fs), fsf)
    if name in ("RGET", "RNEXT"):
        return "%s%s %s, R" % (name, _du(code), vf(ft))
    if name == "MFP":
        return "MFP%s %s, P" % (_du(code), vf(ft))
    if name in ("XTOP", "XITOP"):
        return "%s %s" % (name, vi(it))
    if name == "XGKICK":
        return "XGKICK %s" % vi(is_)
    if name in ("ESADD", "ERSADD", "ELENG", "ERLENG", "EATANxy", "EATANxz",
                "ESUM"):
        return "%s P, %s" % (name, vf(fs))
    if name in ("ERCPR", "ESQRT", "ERSQRT", "ESIN", "EATAN", "EEXP"):
        return "%s P, %s%s" % (name, vf(fs), fsf)
    if name == "B":
        return "B %s" % _btarget(idx, code)
    if name == "BAL":
        return "BAL %s, %s" % (vi(it), _btarget(idx, code))
    if name == "JR":
        return "JR %s" % vi(is_)
    if name == "JALR":
        return "JALR %s, %s" % (vi(it), vi(is_))
    if name in ("IBEQ", "IBNE"):
        return "%s %s, %s, %s" % (name, vi(is_), vi(it), _btarget(idx, code))
    if name in ("IBLTZ", "IBGTZ", "IBLEZ", "IBGEZ"):
        return "%s %s, %s" % (name, vi(is_), _btarget(idx, code))
    if name.startswith("FC") or name.startswith("FS") or name.startswith("FM"):
        return "%s (%03x)" % (name, code & 0xffffff)
    return name


def _du(code):
    d = dest_str(code)
    return "." + d if d else ""


def _btarget(idx, code):
    # VU branch: target = (branchPC + 8 + Imm11*8); in instruction slots that is
    # idx + 1 + imm (relative to the delay slot).
    t = idx + 1 + imm11(code)
    return "0x%04x" % (t * 8)


# --------------------------------------------------------------------------
# Program disassembly
# --------------------------------------------------------------------------

def disasm_program(elf, prog_index, count=None, start=0):
    progs = group_programs(load_overlays(elf))
    if not (0 <= prog_index < len(progs)):
        raise SystemExit("program index out of range (0..%d)" % (len(progs) - 1))
    prog = progs[prog_index]
    img = program_image(elf, prog)
    n = len(img) // 8

    start_idx = start // 8
    end_idx = n if count is None else min(n, start_idx + count)

    print("; VU program %d  (%d instructions, micro-mem 0x000..0x%03x)"
          % (prog_index, n, n * 8))
    print("; overlays: " + ", ".join(
        "#%d %s@0x%05x[%d]" % (ov["idx"], _short(ov["name"]), ov["mm"], ov["size"])
        for ov in prog))
    print(";")
    print("; addr   slot | LOWER pipe                          "
          "| UPPER pipe")
    print("; " + "-" * 78)

    i = start_idx
    while i < end_idx:
        lo, up = struct.unpack_from("<II", img, i * 8)
        i_bit = bool(up & I_BIT)
        up_text, flags = disasm_upper(up)
        if i_bit:
            # The lower 32 bits are a float immediate loaded into the I register.
            fval = struct.unpack("<f", struct.pack("<I", lo))[0]
            lo_text = "<I = %.7g (0x%08x)>" % (fval, lo)
        else:
            lo_text = disasm_lower(lo, i)
        flagstr = (" [%s]" % flags) if flags else ""
        if i_bit:
            flagstr = (" [I%s]" % flags) if flags else " [I]"
        print("  0x%04x %4d | %-35s | %s%s"
              % (i * 8, i, lo_text, up_text, flagstr))
        i += 1


def _short(name):
    # ".DVP.overlay..0x0.377115683.30.0" -> "377115683.30.0"
    return name.replace(".DVP.overlay..", "")


# --------------------------------------------------------------------------
# Inventory
# --------------------------------------------------------------------------

def print_overlays(elf):
    overlays = load_overlays(elf)
    progs = group_programs(overlays)
    vutext = elf.section(".vutext")
    print("VU program inventory  (%d overlays in %d programs)  ELF=.vutext "
          "vaddr=0x%x off=0x%x size=0x%x"
          % (len(overlays), len(progs), vutext["addr"], vutext["off"],
             vutext["size"]))
    print("=" * 92)
    for pi, prog in enumerate(progs):
        total = max(ov["mm"] + ov["size"] for ov in prog)
        print("\nProgram %d : %d overlay(s), %d bytes = %d instr "
              "(micro-mem 0x000..0x%03x, slots 0..%d)"
              % (pi, len(prog), total, total // 8, total, total // 8 - 1))
        print("  %-3s %-34s %-10s %-8s %-8s %-10s"
              % ("ov", "name", "src_foff", "size", "mm", "mm_slot"))
        for ov in prog:
            print("  %-3d %-34s 0x%08x 0x%-6x 0x%-6x %d"
                  % (ov["idx"], _short(ov["name"]), ov["file_off"],
                     ov["size"], ov["mm"], ov["mm"] // 8))


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--elf", default=DEFAULT_ELF, help="path to the SSX ELF")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("overlays", help="print the VU program / overlay inventory")

    dp = sub.add_parser("disasm", help="disassemble a VU program")
    dp.add_argument("program", type=int, help="program index (see 'overlays')")
    dp.add_argument("--count", type=int, default=None,
                    help="number of instructions to print")
    dp.add_argument("--start", type=lambda s: int(s, 0), default=0,
                    help="start micro-mem byte address (default 0)")

    args = ap.parse_args(argv)
    elf = Elf(args.elf)

    if args.cmd == "overlays":
        print_overlays(elf)
    elif args.cmd == "disasm":
        disasm_program(elf, args.program, args.count, args.start)


if __name__ == "__main__":
    main()
