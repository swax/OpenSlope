#!/usr/bin/env python3
"""Small SSX Tricky PS2 ELF analysis helper (tools/analysis/ssx_analyze.py).

This intentionally stays lightweight: no Capstone/Ghidra dependency, just enough
ELF parsing, MIPS disassembly, string extraction and pointer scanning to anchor
manual reverse engineering around the boarder motion/control code.
"""

from __future__ import annotations

import argparse
import collections
import dataclasses
import json
import re
import sqlite3
import struct
from pathlib import Path

SEED_DATA_PATH = Path(__file__).with_name("ssx_seed_data.py")
HAVE_SEED_DATA = SEED_DATA_PATH.exists()

if HAVE_SEED_DATA:
    from ssx_seed_data import (
        KNOWN_COMMENTS,
        KNOWN_FIELDS,
        KNOWN_LABELS,
        KNOWN_OBSERVATIONS,
        KNOWN_RETRACTED_COMMENTS,
        KNOWN_RETRACTED_OBSERVATIONS,
    )
else:
    # The seed data is the durable form of what the analysis db holds — labels,
    # observations and field notes read off your own boot ELF — so like the db
    # it is generated locally and stays out of version control. Every command
    # except `seed-known` works without it; existence is checked rather than
    # catching ImportError so a real error inside the module still surfaces.
    KNOWN_COMMENTS = KNOWN_FIELDS = KNOWN_LABELS = KNOWN_OBSERVATIONS = ()
    KNOWN_RETRACTED_COMMENTS = KNOWN_RETRACTED_OBSERVATIONS = ()


REGS = [
    "zero", "at", "v0", "v1", "a0", "a1", "a2", "a3",
    "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7",
    "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
    "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra",
]

FREGS = [f"f{i}" for i in range(32)]
# Anchored to this file, not the cwd: the defaults must name the same db and ELF
# whether the command is run from the repo root or from a parent workspace.
BASE = Path(__file__).resolve().parents[2]  # Trailmap/
DEFAULT_DB = BASE / "analysis.sqlite"
DEFAULT_ELF = BASE / "extracted" / "SLES_505.45"
SURFACE_MATERIAL_INIT_ADDR = 0x002566B8
SURFACE_MATERIAL_INIT_END_ADDR = 0x00257AD8
SURFACE_MATERIAL_RECORD_SIZE = 100
SURFACE_MATERIAL_RECORD_COUNT = 20
SURFACE_MATERIAL_TABLE_SIZE = SURFACE_MATERIAL_RECORD_SIZE * SURFACE_MATERIAL_RECORD_COUNT
SURFACE_MATERIAL_EMU_BASE = 0x10000000
SURFACE_MATERIAL_EMU_SP = 0x20000000

SURFACE_TYPE_NAMES = {
    0: "reset / out of bounds",
    1: "standard snow",
    2: "standard off track",
    3: "powdered snow",
    4: "slow powdered snow",
    5: "ice standard",
    6: "bounce / unskiable",
    7: "ice / water no trail",
    8: "glidy snow particles",
    9: "rock / off track",
    10: "wall",
    11: "ice crunch no trail",
    12: "no sound small wake",
    13: "off-track metal",
    14: "speed / grinding",
    15: "standard unknown",
    16: "sand",
    17: "no collision",
    18: "show-off ramp / metal",
    19: "unknown",
}

SURFACE_MATERIAL_FIELDS = [
    (0x00, "contact_accel_response", "float"),
    (0x04, "turn_response_x", "float"),
    (0x08, "turn_response_y", "float"),
    (0x0C, "turn_response_z", "float"),
    (0x10, "carve_drag_response", "float"),
    (0x14, "motion_scalar_14", "float"),
    (0x18, "ground_threshold", "float"),
    (0x1C, "boarder_294_target", "float"),
    (0x20, "boarder_298_target", "float"),
    (0x24, "paired_accel_response", "float"),
    (0x28, "boarder_308_state2_target", "float"),
    (0x2C, "speed_response_gain", "float"),
    (0x30, "speed_response_multiplier", "float"),
    (0x34, "spray_emit_rate", "float"),
    (0x38, "spray_lifetime_base", "float"),
    (0x3C, "spray_size_min", "float"),
    (0x40, "spray_size_max", "float"),
    (0x44, "spray_asset_index", "s32"),
    (0x48, "spray_color_spread", "float"),
    (0x4C, "spray_color_bias", "float"),
    (0x50, "spray_alpha_scalar", "float"),
    (0x54, "spray_render_variant", "s32"),
    (0x58, "trail_emit_intensity", "float"),
    (0x5C, "trail_side_offset", "float"),
    (0x60, "trail_motion_scale", "float"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
    addr INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'unknown',
    confidence TEXT NOT NULL DEFAULT 'medium',
    source TEXT NOT NULL DEFAULT 'manual',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    addr INTEGER NOT NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'note',
    confidence TEXT NOT NULL DEFAULT 'medium',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_addr ON comments(addr);

CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    addr INTEGER,
    confidence TEXT NOT NULL DEFAULT 'medium',
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_observations_topic ON observations(topic);
CREATE INDEX IF NOT EXISTS idx_observations_addr ON observations(addr);

CREATE TABLE IF NOT EXISTS xrefs (
    from_addr INTEGER NOT NULL,
    to_addr INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    note TEXT,
    PRIMARY KEY (from_addr, to_addr, kind, source)
);

CREATE INDEX IF NOT EXISTS idx_xrefs_from_addr ON xrefs(from_addr);
CREATE INDEX IF NOT EXISTS idx_xrefs_to_addr ON xrefs(to_addr);

CREATE TABLE IF NOT EXISTS strings (
    addr INTEGER PRIMARY KEY,
    file_off INTEGER NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'scan'
);

CREATE INDEX IF NOT EXISTS idx_strings_text ON strings(text);

CREATE TABLE IF NOT EXISTS functions (
    addr INTEGER PRIMARY KEY,
    end_addr INTEGER,
    size INTEGER,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'auto',
    source TEXT NOT NULL DEFAULT 'prologue_scan',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_functions_end_addr ON functions(end_addr);
CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);

CREATE TABLE IF NOT EXISTS struct_fields (
    struct_name TEXT NOT NULL,
    offset INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'unknown',
    size INTEGER,
    confidence TEXT NOT NULL DEFAULT 'medium',
    source TEXT NOT NULL DEFAULT 'manual',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (struct_name, offset)
);

CREATE INDEX IF NOT EXISTS idx_struct_fields_name ON struct_fields(name);
CREATE INDEX IF NOT EXISTS idx_struct_fields_struct ON struct_fields(struct_name);
"""

@dataclasses.dataclass
class Section:
    name: str
    typ: int
    flags: int
    addr: int
    off: int
    size: int
    link: int
    info: int
    align: int
    entsize: int

    def contains_addr(self, addr: int) -> bool:
        return self.addr <= addr < self.addr + self.size

    def contains_off(self, off: int) -> bool:
        return self.off <= off < self.off + self.size


class Elf:
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        hdr = struct.unpack_from("<16sHHIIIIIHHHHHH", self.data, 0)
        (
            self.ident,
            self.etype,
            self.emachine,
            self.eversion,
            self.entry,
            self.phoff,
            self.shoff,
            self.flags,
            self.ehsize,
            self.phentsize,
            self.phnum,
            self.shentsize,
            self.shnum,
            self.shstrndx,
        ) = hdr

        raw = []
        for i in range(self.shnum):
            off = self.shoff + i * self.shentsize
            raw.append(struct.unpack_from("<IIIIIIIIII", self.data, off))

        shstr = raw[self.shstrndx]
        names = self.data[shstr[4] : shstr[4] + shstr[5]]

        def read_name(pos: int) -> str:
            end = names.find(b"\0", pos)
            return names[pos:end].decode("ascii", "replace")

        self.sections = [
            Section(read_name(x[0]), x[1], x[2], x[3], x[4], x[5], x[6], x[7], x[8], x[9])
            for x in raw
        ]

    def section(self, name: str) -> Section:
        for sec in self.sections:
            if sec.name == name:
                return sec
        raise KeyError(name)

    def section_for_addr(self, addr: int) -> Section | None:
        for sec in self.sections:
            if sec.size and sec.contains_addr(addr):
                return sec
        return None

    def section_for_off(self, off: int) -> Section | None:
        for sec in self.sections:
            if sec.size and sec.contains_off(off):
                return sec
        return None

    def addr_to_off(self, addr: int) -> int:
        sec = self.section_for_addr(addr)
        if sec is None:
            raise ValueError(f"address not mapped by a section: 0x{addr:08x}")
        return sec.off + (addr - sec.addr)

    def off_to_addr(self, off: int) -> int:
        sec = self.section_for_off(off)
        if sec is None:
            raise ValueError(f"offset not mapped by a section: 0x{off:08x}")
        return sec.addr + (off - sec.off)

    def u32_off(self, off: int) -> int:
        return struct.unpack_from("<I", self.data, off)[0]

    def u32_addr(self, addr: int) -> int:
        return self.u32_off(self.addr_to_off(addr))

    def bytes_addr(self, addr: int, size: int) -> bytes:
        off = self.addr_to_off(addr)
        return self.data[off : off + size]


def s16(x: int) -> int:
    return x - 0x10000 if x & 0x8000 else x


def u32(x: int) -> int:
    return x & 0xFFFFFFFF


def parse_int(text: str) -> int:
    return int(text, 0)


def open_db(path: Path, init: bool = False) -> sqlite3.Connection:
    if init:
        path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    # Some sandboxes permit file creation but reject SQLite's journal
    # rename/delete cleanup. The DB is an analysis notebook, so avoid rollback
    # journals and keep writes simple.
    con.execute("PRAGMA journal_mode=OFF")
    con.execute("PRAGMA synchronous=OFF")
    if init:
        con.executescript(SCHEMA)
        con.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3')"
        )
        con.commit()
    return con


def load_marks(path: Path):
    symbols = {}
    comments = collections.defaultdict(list)
    if not path.exists():
        return symbols, comments
    con = open_db(path)
    try:
        for row in con.execute("SELECT addr, name, kind, confidence, note FROM symbols"):
            symbols[row["addr"]] = row
        for row in con.execute(
            "SELECT addr, text, kind, confidence FROM comments ORDER BY id"
        ):
            comments[row["addr"]].append(row)
    finally:
        con.close()
    return symbols, comments


def reg(i: int) -> str:
    return REGS[i]


def freg(i: int) -> str:
    return FREGS[i]


def branch_target(pc: int, imm: int) -> int:
    return u32(pc + 4 + (s16(imm) << 2))


def jump_target(pc: int, target: int) -> int:
    return u32(((pc + 4) & 0xF0000000) | (target << 2))


def memop(name: str, rt: int, imm: int, rs: int) -> str:
    dst = freg(rt) if name in ("lwc1", "ldc1", "swc1", "sdc1") else reg(rt)
    return f"{name:<8} {dst}, {s16(imm)}({reg(rs)})"


def cop1_fmt(fmt: int) -> str:
    return {16: "s", 17: "d", 20: "w", 21: "l"}.get(fmt, f"fmt{fmt}")


def decode_cop1(w: int, pc: int) -> str:
    fmt = (w >> 21) & 0x1F
    ft = (w >> 16) & 0x1F
    fs = (w >> 11) & 0x1F
    fd = (w >> 6) & 0x1F
    fn = w & 0x3F
    if fmt == 0:
        return f"mfc1     {reg(ft)}, {freg(fs)}"
    if fmt == 2:
        return f"cfc1     {reg(ft)}, ${fs}"
    if fmt == 4:
        return f"mtc1     {reg(ft)}, {freg(fs)}"
    if fmt == 6:
        return f"ctc1     {reg(ft)}, ${fs}"
    if fmt == 8:
        cc = (w >> 18) & 7
        target = branch_target(pc, w & 0xFFFF)
        names = {0: "bc1f", 1: "bc1t", 2: "bc1fl", 3: "bc1tl"}
        return f"{names.get(ft & 3, 'bc1?'):<8} {cc}, 0x{target:08x}"

    suffix = cop1_fmt(fmt)
    tri = {
        0x00: "add", 0x01: "sub", 0x02: "mul", 0x03: "div",
        0x04: "sqrt", 0x05: "abs", 0x06: "mov", 0x07: "neg",
        0x0C: "round.w", 0x0D: "trunc.w", 0x0E: "ceil.w", 0x0F: "floor.w",
        0x20: "cvt.s", 0x21: "cvt.d", 0x24: "cvt.w", 0x25: "cvt.l",
    }
    if fn in (0x04, 0x05, 0x06, 0x07, 0x0C, 0x0D, 0x0E, 0x0F, 0x20, 0x21, 0x24, 0x25):
        return f"{tri.get(fn, 'cop1')}.{suffix:<2} {freg(fd)}, {freg(fs)}"
    if fn in tri:
        return f"{tri[fn]}.{suffix:<4} {freg(fd)}, {freg(fs)}, {freg(ft)}"
    if 0x30 <= fn <= 0x3F:
        cond = {
            0x0: "f", 0x1: "un", 0x2: "eq", 0x3: "ueq",
            0x4: "olt", 0x5: "ult", 0x6: "ole", 0x7: "ule",
            0x8: "sf", 0x9: "ngle", 0xA: "seq", 0xB: "ngl",
            0xC: "lt", 0xD: "nge", 0xE: "le", 0xF: "ngt",
        }[fn & 0x0F]
        return f"c.{cond}.{suffix:<5} {freg(fs)}, {freg(ft)}"
    return f"cop1     0x{w:08x}"


def decode(w: int, pc: int) -> str:
    if w == 0:
        return "nop"

    op = (w >> 26) & 0x3F
    rs = (w >> 21) & 0x1F
    rt = (w >> 16) & 0x1F
    rd = (w >> 11) & 0x1F
    sa = (w >> 6) & 0x1F
    fn = w & 0x3F
    imm = w & 0xFFFF
    target = w & 0x03FFFFFF

    if op == 0:
        if fn == 0x00:
            return f"sll      {reg(rd)}, {reg(rt)}, {sa}"
        if fn == 0x02:
            return f"srl      {reg(rd)}, {reg(rt)}, {sa}"
        if fn == 0x03:
            return f"sra      {reg(rd)}, {reg(rt)}, {sa}"
        if fn == 0x04:
            return f"sllv     {reg(rd)}, {reg(rt)}, {reg(rs)}"
        if fn == 0x06:
            return f"srlv     {reg(rd)}, {reg(rt)}, {reg(rs)}"
        if fn == 0x07:
            return f"srav     {reg(rd)}, {reg(rt)}, {reg(rs)}"
        if fn == 0x08:
            return f"jr       {reg(rs)}"
        if fn == 0x09:
            return f"jalr     {reg(rd)}, {reg(rs)}"
        if fn in (0x0A, 0x0B):
            return f"{['movz','movn'][fn-0x0A]:<8} {reg(rd)}, {reg(rs)}, {reg(rt)}"
        if fn == 0x0C:
            return "syscall"
        if fn == 0x0D:
            return "break"
        if fn == 0x0F:
            return "sync"
        if fn == 0x10:
            return f"mfhi     {reg(rd)}"
        if fn == 0x11:
            return f"mthi     {reg(rs)}"
        if fn == 0x12:
            return f"mflo     {reg(rd)}"
        if fn == 0x13:
            return f"mtlo     {reg(rs)}"
        if fn in (0x18, 0x19, 0x1A, 0x1B):
            return f"{['mult','multu','div','divu'][fn-0x18]:<8} {reg(rs)}, {reg(rt)}"
        rnames = {
            0x20: "add", 0x21: "addu", 0x22: "sub", 0x23: "subu",
            0x24: "and", 0x25: "or", 0x26: "xor", 0x27: "nor",
            0x2A: "slt", 0x2B: "sltu",
            0x2C: "dadd", 0x2D: "daddu", 0x2E: "dsub", 0x2F: "dsubu",
        }
        if fn in rnames:
            return f"{rnames[fn]:<8} {reg(rd)}, {reg(rs)}, {reg(rt)}"
        if fn in (0x38, 0x3A, 0x3B):
            return f"{ {0x38:'dsll',0x3A:'dsrl',0x3B:'dsra'}[fn]:<8} {reg(rd)}, {reg(rt)}, {sa}"
        return f"special  0x{w:08x}"

    if op == 1:
        names = {
            0x00: "bltz", 0x01: "bgez", 0x02: "bltzl", 0x03: "bgezl",
            0x10: "bltzal", 0x11: "bgezal", 0x12: "bltzall", 0x13: "bgezall",
        }
        name = names.get(rt, "regimm")
        return f"{name:<8} {reg(rs)}, 0x{branch_target(pc, imm):08x}"
    if op == 2:
        return f"j        0x{jump_target(pc, target):08x}"
    if op == 3:
        return f"jal      0x{jump_target(pc, target):08x}"
    if op in (4, 5):
        return f"{['beq','bne'][op-4]:<8} {reg(rs)}, {reg(rt)}, 0x{branch_target(pc, imm):08x}"
    if op in (6, 7):
        return f"{['blez','bgtz'][op-6]:<8} {reg(rs)}, 0x{branch_target(pc, imm):08x}"
    if op in (8, 9, 10, 11):
        name = ["addi", "addiu", "slti", "sltiu"][op - 8]
        return f"{name:<8} {reg(rt)}, {reg(rs)}, {s16(imm)}"
    if op in (12, 13, 14):
        name = ["andi", "ori", "xori"][op - 12]
        return f"{name:<8} {reg(rt)}, {reg(rs)}, 0x{imm:04x}"
    if op == 15:
        return f"lui      {reg(rt)}, 0x{imm:04x}"
    if op == 16:
        return f"cop0     0x{w:08x}"
    if op == 17:
        return decode_cop1(w, pc)
    if op == 18:
        return f"cop2     0x{w:08x}"
    if op in (20, 21):
        return f"{['beql','bnel'][op-20]:<8} {reg(rs)}, {reg(rt)}, 0x{branch_target(pc, imm):08x}"
    if op in (22, 23):
        return f"{['blezl','bgtzl'][op-22]:<8} {reg(rs)}, 0x{branch_target(pc, imm):08x}"
    if op in (24, 25):
        return f"{['daddi','daddiu'][op-24]:<8} {reg(rt)}, {reg(rs)}, {s16(imm)}"
    if op == 28:
        return f"mmi      0x{w:08x}"

    mem = {
        0x20: "lb", 0x21: "lh", 0x22: "lwl", 0x23: "lw", 0x24: "lbu", 0x25: "lhu",
        0x26: "lwr", 0x27: "lwu", 0x28: "sb", 0x29: "sh", 0x2A: "swl", 0x2B: "sw",
        0x2C: "sdl", 0x2D: "sdr", 0x2E: "swr", 0x2F: "cache", 0x30: "ll",
        0x31: "lwc1", 0x32: "lwc2", 0x33: "pref", 0x35: "ldc1", 0x36: "ldc2",
        0x37: "ld", 0x38: "sc", 0x39: "swc1", 0x3A: "swc2", 0x3D: "sdc1",
        0x3E: "sdc2", 0x3F: "sd",
    }
    if op in mem:
        return memop(mem[op], rt, imm, rs)
    return f".word    0x{w:08x}"


def iter_strings(data: bytes, min_len: int = 4):
    pat = re.compile(rb"[\x20-\x7e]{%d,}" % min_len)
    for m in pat.finditer(data):
        yield m.start(), m.group().decode("ascii", "replace")


def is_text_ptr(elf: Elf, w: int) -> bool:
    sec = elf.section_for_addr(w)
    return sec is not None and sec.name in (".text", ".vutext") and w % 4 == 0


def annotate_word(elf: Elf, w: int) -> str:
    sec = elf.section_for_addr(w)
    if sec is None:
        return ""
    out = f" -> {sec.name}+0x{w - sec.addr:x}"
    if sec.name in (".rodata", ".data"):
        off = elf.addr_to_off(w)
        raw = elf.data[off : off + 48].split(b"\0", 1)[0]
        if len(raw) >= 4 and all(32 <= c < 127 for c in raw):
            out += f' "{raw[:40].decode("ascii", "replace")}"'
    return out


def interesting_addr_section(elf: Elf, addr: int) -> str | None:
    sec = elf.section_for_addr(addr)
    if sec is None:
        return None
    if sec.name in (".text", ".vutext", ".rodata", ".data", ".sdata", ".bss", ".sbss"):
        return sec.name
    return None


def iter_possible_prologues(elf: Elf):
    text = elf.section(".text")
    for off in range(text.off, text.off + text.size - 12, 4):
        w = elf.u32_off(off)
        # addiu/daddiu sp,sp,-N
        if (w >> 26) in (0x09, 0x19) and ((w >> 21) & 31) == 29 and ((w >> 16) & 31) == 29 and (w & 0x8000):
            yield elf.off_to_addr(off)


@dataclasses.dataclass
class ControlInfo:
    kind: str
    targets: tuple[int, ...] = ()
    fallthrough: bool = True
    delay_slot: bool = False
    is_call: bool = False
    is_terminator: bool = False
    indirect: bool = False


@dataclasses.dataclass
class BasicBlock:
    start: int
    end: int
    instrs: list[int]
    successors: list[int]
    calls: list[tuple[int, int | None, str]]
    terminator: ControlInfo | None


def control_info(w: int, pc: int) -> ControlInfo:
    op = (w >> 26) & 0x3F
    rs = (w >> 21) & 0x1F
    rt = (w >> 16) & 0x1F
    fn = w & 0x3F
    imm = w & 0xFFFF
    target = w & 0x03FFFFFF

    if op == 0:
        if fn == 0x08:
            if rs == 31:
                return ControlInfo("return", fallthrough=False, delay_slot=True, is_terminator=True)
            return ControlInfo(
                "indirect_jump",
                fallthrough=False,
                delay_slot=True,
                is_terminator=True,
                indirect=True,
            )
        if fn == 0x09:
            return ControlInfo(
                "indirect_call",
                fallthrough=True,
                delay_slot=True,
                is_call=True,
                indirect=True,
            )
        return ControlInfo("normal")

    if op == 1 and rt in (0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13):
        return ControlInfo(
            "branch",
            targets=(branch_target(pc, imm),),
            fallthrough=True,
            delay_slot=True,
            is_terminator=True,
        )
    if op == 2:
        return ControlInfo(
            "jump",
            targets=(jump_target(pc, target),),
            fallthrough=False,
            delay_slot=True,
            is_terminator=True,
        )
    if op == 3:
        return ControlInfo(
            "call",
            targets=(jump_target(pc, target),),
            fallthrough=True,
            delay_slot=True,
            is_call=True,
        )
    if op in (4, 5, 6, 7, 20, 21, 22, 23):
        return ControlInfo(
            "branch",
            targets=(branch_target(pc, imm),),
            fallthrough=True,
            delay_slot=True,
            is_terminator=True,
        )
    if op == 17 and ((w >> 21) & 0x1F) == 8:
        return ControlInfo(
            "branch",
            targets=(branch_target(pc, imm),),
            fallthrough=True,
            delay_slot=True,
            is_terminator=True,
        )
    return ControlInfo("normal")


MEM_OPS = {
    0x20: "lb", 0x21: "lh", 0x22: "lwl", 0x23: "lw", 0x24: "lbu", 0x25: "lhu",
    0x26: "lwr", 0x27: "lwu", 0x28: "sb", 0x29: "sh", 0x2A: "swl", 0x2B: "sw",
    0x2C: "sdl", 0x2D: "sdr", 0x2E: "swr", 0x2F: "cache", 0x30: "ll",
    0x31: "lwc1", 0x32: "lwc2", 0x33: "pref", 0x35: "ldc1", 0x36: "ldc2",
    0x37: "ld", 0x38: "sc", 0x39: "swc1", 0x3A: "swc2", 0x3D: "sdc1",
    0x3E: "sdc2", 0x3F: "sd",
}


@dataclasses.dataclass
class MemoryAccess:
    name: str
    rt: int
    base: int
    offset: int


def memory_access(w: int) -> MemoryAccess | None:
    op = (w >> 26) & 0x3F
    if op not in MEM_OPS:
        return None
    return MemoryAccess(
        MEM_OPS[op],
        (w >> 16) & 0x1F,
        (w >> 21) & 0x1F,
        s16(w & 0xFFFF),
    )


def addr_in_range(addr: int, start: int, end: int) -> bool:
    return start <= addr < end


def function_range_for_cfg(con: sqlite3.Connection, elf: Elf, target: int, args):
    fn = db_function_for_addr(con, target)
    if args.end:
        start = target
        end = parse_int(args.end)
        name = db_symbol_name(con, start) or f"range_{start:08x}"
        return start, end, name
    if fn is not None:
        start = fn["addr"]
        end = fn["end_addr"] if fn["end_addr"] is not None else fn["addr"] + (fn["size"] or 0)
        if end > start:
            name = fn["name"] or db_symbol_name(con, start) or f"sub_{start:08x}"
            return start, end, name
    if args.count:
        start = target
        end = start + args.count * 4
        name = db_symbol_name(con, start) or f"range_{start:08x}"
        return start, end, name
    sec = elf.section_for_addr(target)
    sec_end = sec.addr + sec.size if sec is not None else target + 0x400
    start = target
    end = min(start + args.max_bytes, sec_end)
    name = db_symbol_name(con, start) or f"range_{start:08x}"
    return start, end, name


def discover_basic_blocks(elf: Elf, start: int, end: int):
    leaders = {start}
    pc = start
    while pc < end:
        try:
            w = elf.u32_addr(pc)
        except ValueError:
            break
        info = control_info(w, pc)
        next_after_delay = pc + (8 if info.delay_slot else 4)
        if info.is_terminator:
            for target in info.targets:
                if addr_in_range(target, start, end):
                    leaders.add(target)
            if info.fallthrough and addr_in_range(next_after_delay, start, end):
                leaders.add(next_after_delay)
            pc = next_after_delay
        else:
            pc += 4

    blocks = []
    sorted_leaders = sorted(leaders)
    leader_set = set(sorted_leaders)
    for leader in sorted_leaders:
        pc = leader
        instrs = []
        terminator = None
        while pc < end:
            if pc != leader and pc in leader_set:
                break
            try:
                w = elf.u32_addr(pc)
            except ValueError:
                break
            info = control_info(w, pc)
            instrs.append(pc)
            if info.is_terminator:
                terminator = info
                delay_pc = pc + 4
                if info.delay_slot and delay_pc < end:
                    instrs.append(delay_pc)
                pc += 8 if info.delay_slot else 4
                break
            pc += 4
        if not instrs:
            continue

        end_addr = pc
        successors = []
        last_control_pc = instrs[-2] if terminator and terminator.delay_slot and len(instrs) >= 2 else instrs[-1]
        if terminator is not None:
            next_after_delay = last_control_pc + (8 if terminator.delay_slot else 4)
            for target in terminator.targets:
                if addr_in_range(target, start, end):
                    successors.append(target)
            if terminator.fallthrough and addr_in_range(next_after_delay, start, end):
                successors.append(next_after_delay)
        elif addr_in_range(end_addr, start, end):
            successors.append(end_addr)

        calls = []
        for call_pc in instrs:
            try:
                ci = control_info(elf.u32_addr(call_pc), call_pc)
            except ValueError:
                continue
            if ci.is_call:
                target = ci.targets[0] if ci.targets else None
                calls.append((call_pc, target, ci.kind))
        blocks.append(BasicBlock(leader, end_addr, instrs, successors, calls, terminator))
    return blocks


def db_function_for_addr(con: sqlite3.Connection, addr: int):
    exact = con.execute(
        """
        SELECT addr, end_addr, size, name, status, source, note
        FROM functions
        WHERE addr = ?
        LIMIT 1
        """,
        (addr,),
    ).fetchone()
    if exact is not None:
        return exact
    return con.execute(
        """
        SELECT addr, end_addr, size, name, status, source, note
        FROM functions
        WHERE addr <= ? AND (end_addr IS NULL OR end_addr > ?)
        ORDER BY (status = 'manual') DESC, addr DESC
        LIMIT 1
        """,
        (addr, addr),
    ).fetchone()


def resolve_db_addr(con: sqlite3.Connection, text: str) -> int:
    try:
        return parse_int(text)
    except ValueError:
        pass
    row = con.execute("SELECT addr FROM symbols WHERE name = ?", (text,)).fetchone()
    if row is not None:
        return row["addr"]
    row = con.execute(
        "SELECT addr, name FROM symbols WHERE lower(name) LIKE ? ORDER BY addr LIMIT 1",
        (f"%{text.lower()}%",),
    ).fetchone()
    if row is not None:
        return row["addr"]
    raise SystemExit(f"could not resolve address/label: {text}")


def resolve_addr_arg(db_path: Path, text: str) -> int:
    try:
        return parse_int(text)
    except ValueError:
        pass
    if not db_path.exists():
        raise SystemExit(f"database does not exist, cannot resolve label: {db_path}")
    con = open_db(db_path)
    try:
        return resolve_db_addr(con, text)
    finally:
        con.close()


def db_symbol_name(con: sqlite3.Connection, addr: int) -> str | None:
    row = con.execute("SELECT name FROM symbols WHERE addr = ?", (addr,)).fetchone()
    return row["name"] if row else None


def cmd_elf(args):
    elf = Elf(args.elf)
    print(f"path={elf.path}")
    print(f"entry=0x{elf.entry:08x} machine={elf.emachine} flags=0x{elf.flags:08x}")
    print(f"phoff=0x{elf.phoff:x} shoff=0x{elf.shoff:x} sections={len(elf.sections)}")
    for i, sec in enumerate(elf.sections):
        if sec.name or sec.size:
            print(
                f"{i:02d} {sec.name:24s} addr=0x{sec.addr:08x} "
                f"off=0x{sec.off:08x} size=0x{sec.size:08x} flags=0x{sec.flags:x}"
            )


def cmd_strings(args):
    elf = Elf(args.elf)
    terms = [t.lower() for t in args.term]
    for off, text in iter_strings(elf.data, args.min):
        if terms and not any(t in text.lower() for t in terms):
            continue
        try:
            addr = elf.off_to_addr(off)
            loc = f"0x{addr:08x}"
        except ValueError:
            loc = "unmapped"
        print(f"{off:08x} {loc} {text[:args.width]}")


def cmd_scan_ptrs(args):
    elf = Elf(args.elf)
    sec = elf.section(args.section)
    data = elf.data
    off = sec.off
    end = sec.off + sec.size
    runs = []
    while off <= end - 4:
        w = elf.u32_off(off)
        if is_text_ptr(elf, w):
            start = off
            vals = []
            while off <= end - 4 and is_text_ptr(elf, elf.u32_off(off)):
                vals.append(elf.u32_off(off))
                off += 4
            if len(vals) >= args.min_run:
                runs.append((start, vals))
        else:
            off += 4

    terms = [t.lower() for t in args.near]
    for start, vals in runs:
        nearby = []
        lo = max(sec.off, start - args.window)
        hi = min(end, start + args.window)
        for so, s in iter_strings(data[lo:hi], 4):
            if not terms or any(t in s.lower() for t in terms):
                nearby.append((lo + so, s))
        if terms and not nearby:
            continue
        near = "; ".join(f"0x{elf.off_to_addr(o):08x}:{s[:32]}" for o, s in nearby[-6:])
        print(
            f"off=0x{start:08x} addr=0x{elf.off_to_addr(start):08x} "
            f"n={len(vals):3d} ptrs={','.join(hex(v) for v in vals[:args.show])}"
        )
        if near:
            print(f"  nearby: {near}")


def cmd_disasm(args):
    elf = Elf(args.elf)
    symbols, comments = load_marks(args.db) if args.labels else ({}, {})
    addr = resolve_addr_arg(args.db, args.addr)
    count = args.count
    for i in range(count):
        pc = addr + i * 4
        try:
            w = elf.u32_addr(pc)
        except ValueError as exc:
            print(exc)
            break
        if pc in symbols:
            sym = symbols[pc]
            print(
                f"\n{sym['name']}:  # 0x{pc:08x} {sym['kind']} "
                f"confidence={sym['confidence']}"
            )
            if sym["note"]:
                print(f"# {sym['note']}")
        line = f"0x{pc:08x}: {w:08x}  {decode(w, pc)}"
        if pc in comments:
            line += "  # " + " | ".join(row["text"] for row in comments[pc])
        print(line)


def cmd_words(args):
    elf = Elf(args.elf)
    addr = resolve_addr_arg(args.db, args.addr)
    count = args.count
    for i in range(count):
        a = addr + i * 4
        w = elf.u32_addr(a)
        raw = elf.bytes_addr(a, 4)
        asc = "".join(chr(c) if 32 <= c < 127 else "." for c in raw)
        print(f"0x{a:08x}: {w:08x} {asc}{annotate_word(elf, w)}")


def f32_from_bits(bits: int) -> float:
    return struct.unpack("<f", struct.pack("<I", bits & 0xFFFFFFFF))[0]


def fmt_float(value: float) -> str:
    if abs(value) < 0.0000005:
        return "0"
    text = f"{value:.9g}"
    if "e" not in text and "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def signed32(value: int) -> int:
    value &= 0xFFFFFFFF
    return value if value < 0x80000000 else value - 0x100000000


class SurfaceTableInitEmulator:
    """Tiny EE/MIPS subset for the straight-line SnowCache initializer."""

    def __init__(self, elf: Elf, base: int = SURFACE_MATERIAL_EMU_BASE):
        self.elf = elf
        self.base = base
        self.regs = [0] * 32
        self.fregs = [0] * 32
        self.mem: dict[int, int] = {}
        self.regs[REGS.index("a0")] = base
        self.regs[REGS.index("sp")] = SURFACE_MATERIAL_EMU_SP
        self.lo = 0
        self.steps = 0

    def _get_byte(self, addr: int) -> int:
        return self.mem.get(addr & 0xFFFFFFFF, 0)

    def _set_byte(self, addr: int, value: int) -> None:
        self.mem[addr & 0xFFFFFFFF] = value & 0xFF

    def _load32(self, addr: int) -> int:
        return struct.unpack(
            "<I", bytes(self._get_byte(addr + i) for i in range(4))
        )[0]

    def _store32(self, addr: int, value: int) -> None:
        for i, byte in enumerate(struct.pack("<I", value & 0xFFFFFFFF)):
            self._set_byte(addr + i, byte)

    def _load64(self, addr: int) -> int:
        return struct.unpack(
            "<Q", bytes(self._get_byte(addr + i) for i in range(8))
        )[0]

    def _store64(self, addr: int, value: int) -> None:
        for i, byte in enumerate(struct.pack("<Q", value & 0xFFFFFFFFFFFFFFFF)):
            self._set_byte(addr + i, byte)

    def _exec(self, w: int, pc: int) -> tuple[int | None, bool]:
        op = (w >> 26) & 0x3F
        rs = (w >> 21) & 0x1F
        rt = (w >> 16) & 0x1F
        rd = (w >> 11) & 0x1F
        imm = w & 0xFFFF
        fn = w & 0x3F
        branch: int | None = None
        stop = False

        if w == 0:
            pass
        elif op == 0:
            if fn == 0x08:  # jr
                stop = True
            elif fn in (0x21, 0x2D):  # addu / daddu
                self.regs[rd] = u32(self.regs[rs] + self.regs[rt])
            elif fn == 0x18:
                # EE code in this initializer uses rd as a low-product
                # destination; the local disassembler prints it as 2-arg mult.
                product = signed32(self.regs[rs]) * signed32(self.regs[rt])
                self.lo = u32(product)
                self.regs[rd] = self.lo
            elif fn == 0x2A:  # slt
                self.regs[rd] = int(signed32(self.regs[rs]) < signed32(self.regs[rt]))
            else:
                raise RuntimeError(f"unsupported special at 0x{pc:08x}: {decode(w, pc)}")
        elif op == 4:  # beq
            if self.regs[rs] == self.regs[rt]:
                branch = branch_target(pc, imm)
        elif op == 5:  # bne
            if self.regs[rs] != self.regs[rt]:
                branch = branch_target(pc, imm)
        elif op in (8, 9):  # addi / addiu
            self.regs[rt] = u32(self.regs[rs] + s16(imm))
        elif op == 10:  # slti
            self.regs[rt] = int(signed32(self.regs[rs]) < s16(imm))
        elif op == 13:  # ori
            self.regs[rt] = u32(self.regs[rs] | imm)
        elif op == 15:  # lui
            self.regs[rt] = u32(imm << 16)
        elif op == 17:  # cop1
            fmt = (w >> 21) & 0x1F
            ft = (w >> 16) & 0x1F
            fs = (w >> 11) & 0x1F
            if fmt == 0:  # mfc1
                self.regs[ft] = self.fregs[fs]
            elif fmt == 4:  # mtc1
                self.fregs[fs] = self.regs[ft]
            else:
                raise RuntimeError(f"unsupported cop1 at 0x{pc:08x}: {decode(w, pc)}")
        elif op == 35:  # lw
            self.regs[rt] = self._load32(u32(self.regs[rs] + s16(imm)))
        elif op == 43:  # sw
            self._store32(u32(self.regs[rs] + s16(imm)), self.regs[rt])
        elif op == 49:  # lwc1
            self.fregs[rt] = self._load32(u32(self.regs[rs] + s16(imm)))
        elif op == 55:  # ld
            self.regs[rt] = self._load64(u32(self.regs[rs] + s16(imm))) & 0xFFFFFFFF
        elif op == 57:  # swc1
            self._store32(u32(self.regs[rs] + s16(imm)), self.fregs[rt])
        elif op == 63:  # sd
            self._store64(u32(self.regs[rs] + s16(imm)), self.regs[rt])
        else:
            raise RuntimeError(f"unsupported instruction at 0x{pc:08x}: {decode(w, pc)}")

        self.regs[0] = 0
        return branch, stop

    def run(self, start: int = SURFACE_MATERIAL_INIT_ADDR) -> bytes:
        pc = start
        while True:
            w = self.elf.u32_addr(pc)
            branch, stop = self._exec(w, pc)
            if branch is not None or stop:
                self._exec(self.elf.u32_addr(pc + 4), pc + 4)
                if stop:
                    break
                pc = branch
            else:
                pc += 4
            self.steps += 1
            if self.steps > 20000:
                raise RuntimeError("surface table initializer emulation did not terminate")
            if pc >= SURFACE_MATERIAL_INIT_END_ADDR:
                break
        return bytes(
            self._get_byte(self.base + i) for i in range(SURFACE_MATERIAL_TABLE_SIZE)
        )


def surface_table_records(raw: bytes, all_fields: bool) -> list[dict[str, object]]:
    fields = SURFACE_MATERIAL_FIELDS if all_fields else SURFACE_MATERIAL_FIELDS[:13]
    records: list[dict[str, object]] = []
    for surface_type in range(SURFACE_MATERIAL_RECORD_COUNT):
        start = surface_type * SURFACE_MATERIAL_RECORD_SIZE
        row: dict[str, object] = {
            "surface_type": surface_type,
            "surface_name": SURFACE_TYPE_NAMES.get(surface_type, ""),
        }
        for offset, name, kind in fields:
            bits = struct.unpack_from("<I", raw, start + offset)[0]
            row[name] = signed32(bits) if kind == "s32" else f32_from_bits(bits)
        records.append(row)
    return records


def cmd_surface_table(args):
    elf = Elf(args.elf)
    emu = SurfaceTableInitEmulator(elf)
    raw = emu.run()
    records = surface_table_records(raw, args.all)
    fields = SURFACE_MATERIAL_FIELDS if args.all else SURFACE_MATERIAL_FIELDS[:13]
    headers = ["surface_type", "surface_name"] + [name for _, name, _ in fields]

    if args.format == "json":
        print(json.dumps(records, indent=2))
        return

    if args.format == "csv":
        print(",".join(headers))
        for record in records:
            values = []
            for header in headers:
                value = record[header]
                if isinstance(value, float):
                    values.append(fmt_float(value))
                    continue
                text = str(value)
                if "," in text or '"' in text:
                    text = '"' + text.replace('"', '""') + '"'
                values.append(text)
            print(",".join(values))
        return

    print(
        f"Surface material table: {SURFACE_MATERIAL_RECORD_COUNT} records, "
        f"{SURFACE_MATERIAL_RECORD_SIZE}-byte stride"
    )
    print(
        "loader: 0x0017e5a0 allocates SnowCache (2000 bytes), "
        "0x0017e5c8 stores course+0x24, 0x002566b8 initializes constants"
    )
    print(f"initializer emulation steps: {emu.steps}")
    print()
    print("| " + " | ".join(headers) + " |")
    print("| " + " | ".join(["---:" if h == "surface_type" else "---" for h in headers]) + " |")
    for record in records:
        cells = []
        for header in headers:
            value = record[header]
            cells.append(fmt_float(value) if isinstance(value, float) else str(value))
        print("| " + " | ".join(cells) + " |")


def _sym_const(value: int) -> str:
    return f"const:{u32(value)}"


def _sym_const_value(sym: str) -> int | None:
    if not sym.startswith("const:"):
        return None
    return int(sym[6:])


def _surface_record_symbols_for_function(name: str | None) -> list[str]:
    regs = [""] * 32
    if name and name.startswith("SurfaceMaterial_"):
        regs[5] = "surface_record"  # a1
    return regs


def _update_surface_record_symbols(regs: list[str], w: int):
    op = (w >> 26) & 0x3F
    rs = (w >> 21) & 31
    rt = (w >> 16) & 31
    rd = (w >> 11) & 31
    imm = w & 0xFFFF
    fn = w & 0x3F

    def set_reg(reg_i: int, sym: str):
        if reg_i:
            regs[reg_i] = sym

    def clear(reg_i: int):
        if reg_i:
            regs[reg_i] = ""

    if op == 0 and fn in (0x21, 0x2D):  # addu / daddu
        left = regs[rs]
        right = regs[rt]
        if rt == 0:
            set_reg(rd, left)
        elif rs == 0:
            set_reg(rd, right)
        elif {left, right} == {"surface_table", "surface_index"}:
            set_reg(rd, "surface_record")
        else:
            clear(rd)
    elif op == 0 and fn == 0x18:  # EE low-product destination in rd field
        left = regs[rs]
        right = regs[rt]
        left_const = _sym_const_value(left)
        right_const = _sym_const_value(right)
        if (left == "surface_type" and right_const == SURFACE_MATERIAL_RECORD_SIZE) or (
            right == "surface_type" and left_const == SURFACE_MATERIAL_RECORD_SIZE
        ):
            set_reg(rd, "surface_index")
        else:
            clear(rd)
    elif op in (8, 9):  # addi / addiu
        base_const = _sym_const_value(regs[rs])
        if rs == 0:
            set_reg(rt, _sym_const(s16(imm)))
        elif base_const is not None:
            set_reg(rt, _sym_const(base_const + s16(imm)))
        elif s16(imm) == 0:
            set_reg(rt, regs[rs])
        else:
            clear(rt)
    elif op == 13:  # ori
        base_const = _sym_const_value(regs[rs])
        if base_const is not None:
            set_reg(rt, _sym_const(base_const | imm))
        else:
            clear(rt)
    elif op == 15:  # lui
        set_reg(rt, _sym_const(imm << 16))
    elif op == 35:  # lw
        base_const = _sym_const_value(regs[rs])
        addr = None if base_const is None else u32(base_const + s16(imm))
        if addr == 0x00338E58:
            set_reg(rt, "global_game_state")
        elif regs[rs] == "global_game_state" and s16(imm) == 0x730:
            set_reg(rt, "course_runtime")
        elif regs[rs] == "course_runtime" and s16(imm) == 0x24:
            set_reg(rt, "surface_table")
        elif s16(imm) == 0x290:
            set_reg(rt, "surface_type")
        else:
            clear(rt)
    elif op in (17, 49, 55):
        pass
    elif op in (43, 57, 63):
        pass
    elif op == 3:
        pass

    regs[0] = ""


def cmd_surface_record_refs(args):
    elf = Elf(args.elf)
    con = open_db(args.db, init=args.init)
    field_names = {offset: name for offset, name, _kind in SURFACE_MATERIAL_FIELDS}
    min_offset = 0x34 if args.tail else 0
    try:
        rows = con.execute(
            """
            SELECT addr, end_addr, size, name
            FROM functions
            WHERE end_addr IS NOT NULL AND end_addr > addr
            ORDER BY addr
            """
        ).fetchall()
        shown = 0
        for row in rows:
            start = row["addr"]
            end = row["end_addr"]
            name = row["name"] or db_symbol_name(con, start) or f"sub_{start:08x}"
            regs = _surface_record_symbols_for_function(name)
            hits = []
            for pc in range(start, end, 4):
                try:
                    w = elf.u32_addr(pc)
                except ValueError:
                    break
                access = memory_access(w)
                if (
                    access is not None
                    and regs[access.base] == "surface_record"
                    and min_offset <= access.offset < SURFACE_MATERIAL_RECORD_SIZE
                    and access.offset in field_names
                ):
                    hits.append((pc, access, decode(w, pc)))
                _update_surface_record_symbols(regs, w)

            if not hits:
                continue

            print(f"{name} 0x{start:08x}-0x{end:08x}")
            for pc, access, text in hits:
                print(
                    f"  0x{pc:08x}: {text:<32s} "
                    f"SurfaceMaterialRecord+0x{access.offset:02x} {field_names[access.offset]}"
                )
                shown += 1
                if shown >= args.limit:
                    return
    finally:
        con.close()


def cfg_target_text(con: sqlite3.Connection, addr: int | None) -> str:
    if addr is None:
        return "indirect"
    sym = db_symbol_name(con, addr)
    if sym:
        return f"0x{addr:08x} {sym}"
    fn = db_function_for_addr(con, addr)
    if fn is not None:
        fn_name = fn["name"] or f"sub_{fn['addr']:08x}"
        return f"0x{addr:08x} {fn_name}+0x{addr - fn['addr']:x}"
    return f"0x{addr:08x}"


def cmd_cfg(args):
    elf = Elf(args.elf)
    con = open_db(args.db, init=args.init)
    try:
        target = resolve_db_addr(con, args.target)
        start, end, name = function_range_for_cfg(con, elf, target, args)
        if end <= start:
            raise SystemExit(f"invalid CFG range: 0x{start:08x}-0x{end:08x}")
        blocks = discover_basic_blocks(elf, start, end)
        edge_count = sum(len(block.successors) for block in blocks)
        print(
            f"CFG {name}: 0x{start:08x}-0x{end:08x} "
            f"blocks={len(blocks)} edges={edge_count}"
        )
        for idx, block in enumerate(blocks[: args.max_blocks]):
            sym = db_symbol_name(con, block.start)
            label = f" {sym}" if sym else ""
            succ = ", ".join(f"0x{x:08x}" for x in block.successors) or "-"
            calls = ", ".join(
                f"0x{pc:08x}->{cfg_target_text(con, call_target)}"
                for pc, call_target, _kind in block.calls
            ) or "-"
            term = "-"
            if block.terminator is not None:
                term_pc = block.instrs[-2] if block.terminator.delay_slot and len(block.instrs) >= 2 else block.instrs[-1]
                term = f"{block.terminator.kind}@0x{term_pc:08x}"
            print(
                f"B{idx:03d} 0x{block.start:08x}-0x{block.end:08x}{label} "
                f"succ=[{succ}] calls=[{calls}] term={term}"
            )
            if args.disasm:
                for pc in block.instrs:
                    try:
                        w = elf.u32_addr(pc)
                    except ValueError:
                        continue
                    print(f"    0x{pc:08x}: {w:08x}  {decode(w, pc)}")
        if len(blocks) > args.max_blocks:
            print(f"... {len(blocks) - args.max_blocks} more blocks")
    finally:
        con.close()


def parse_reg_name(text: str) -> int:
    name = text.lower().lstrip("$")
    if name not in REGS:
        raise SystemExit(f"unknown register: {text}")
    return REGS.index(name)


def cmd_field_refs(args):
    elf = Elf(args.elf)
    offsets = {s16(parse_int(x) & 0xFFFF) for x in args.offset}
    bases = {parse_reg_name(x) for x in args.base} if args.base else None
    ops = {x.lower() for x in args.op} if args.op else None
    con = open_db(args.db, init=args.init)
    shown = 0
    try:
        text = elf.section(".text")
        for off in range(text.off, text.off + text.size - 4, 4):
            pc = elf.off_to_addr(off)
            access = memory_access(elf.u32_off(off))
            if access is None:
                continue
            if access.offset not in offsets:
                continue
            if bases is not None and access.base not in bases:
                continue
            if ops is not None and access.name.lower() not in ops:
                continue
            fn = db_function_for_addr(con, pc)
            fn_text = ""
            if fn is not None:
                fn_name = fn["name"] or db_symbol_name(con, fn["addr"]) or f"sub_{fn['addr']:08x}"
                fn_text = f" in {fn_name}+0x{pc - fn['addr']:x}"
            print(f"0x{pc:08x}: {decode(elf.u32_off(off), pc)}{fn_text}")
            shown += 1
            if shown >= args.limit:
                break
    finally:
        con.close()
    print(f"# shown {shown} field refs for {', '.join(hex(x) for x in sorted(offsets))}")


def cmd_xrefs(args):
    elf = Elf(args.elf)
    target = resolve_addr_arg(args.db, args.target)
    raw_hits = []
    needle = struct.pack("<I", target)
    pos = 0
    while True:
        pos = elf.data.find(needle, pos)
        if pos < 0:
            break
        raw_hits.append(pos)
        pos += 1

    print(f"raw pointer hits to 0x{target:08x}: {len(raw_hits)}")
    for off in raw_hits[: args.show]:
        try:
            addr = elf.off_to_addr(off)
            loc = f"0x{addr:08x}"
        except ValueError:
            loc = f"off=0x{off:08x}"
        print(f"  {loc}")

    # Literal construction hits: lui reg,hi followed shortly by addiu/ori/mem using same reg.
    text = elf.section(".text")
    hits = []
    for off in range(text.off, text.off + text.size - 8, 4):
        w1 = elf.u32_off(off)
        if (w1 >> 26) != 0x0F:
            continue
        base_reg = (w1 >> 16) & 31
        hi = w1 & 0xFFFF
        for look in range(1, args.lookahead + 1):
            w2 = elf.u32_off(off + look * 4)
            op2 = (w2 >> 26) & 0x3F
            rs = (w2 >> 21) & 31
            imm = w2 & 0xFFFF
            if rs != base_reg:
                continue
            formed = None
            if op2 in (0x08, 0x09, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x2B, 0x31, 0x35, 0x37, 0x39, 0x3D, 0x3F):
                formed = u32((hi << 16) + s16(imm))
            elif op2 == 0x0D:
                formed = (hi << 16) | imm
            if formed == target:
                hits.append((elf.off_to_addr(off), look))
                break
    print(f"literal construction hits in .text: {len(hits)}")
    for addr, look in hits[: args.show]:
        print(f"  0x{addr:08x} (within +{look * 4} bytes)")

    if args.save:
        con = open_db(args.db, init=True)
        try:
            for off in raw_hits:
                try:
                    from_addr = elf.off_to_addr(off)
                except ValueError:
                    continue
                con.execute(
                    "INSERT OR IGNORE INTO xrefs(from_addr, to_addr, kind, source) "
                    "VALUES (?, ?, 'raw_pointer', 'xrefs')",
                    (from_addr, target),
                )
            for from_addr, _look in hits:
                con.execute(
                    "INSERT OR IGNORE INTO xrefs(from_addr, to_addr, kind, source) "
                    "VALUES (?, ?, 'literal_load', 'xrefs')",
                    (from_addr, target),
                )
            con.commit()
        finally:
            con.close()
        print(f"saved xrefs to {args.db}")


def cmd_prologues(args):
    elf = Elf(args.elf)
    hits = list(iter_possible_prologues(elf))
    for addr in hits:
        if args.start and addr < int(args.start, 0):
            continue
        if args.end and addr >= int(args.end, 0):
            continue
        print(f"0x{addr:08x}")
    print(f"# {len(hits)} possible prologues")


def cmd_init_db(args):
    con = open_db(args.db, init=True)
    con.close()
    print(f"initialized {args.db}")


def cmd_schema(args):
    con = open_db(args.db, init=args.init)
    try:
        for row in con.execute(
            """
            SELECT type, name, sql
            FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%'
            ORDER BY type, name
            """
        ):
            print(f"-- {row['type']} {row['name']}")
            if row["sql"]:
                print(row["sql"] + ";")
    finally:
        con.close()


def cmd_label(args):
    addr = parse_int(args.addr)
    con = open_db(args.db, init=True)
    try:
        con.execute(
            """
            INSERT INTO symbols(addr, name, kind, confidence, source, note)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(addr) DO UPDATE SET
                name=excluded.name,
                kind=excluded.kind,
                confidence=excluded.confidence,
                source=excluded.source,
                note=excluded.note,
                updated_at=CURRENT_TIMESTAMP
            """,
            (addr, args.name, args.kind, args.confidence, args.source, args.note),
        )
        con.commit()
    finally:
        con.close()
    print(f"0x{addr:08x} {args.name}")


def cmd_note(args):
    addr = parse_int(args.addr)
    con = open_db(args.db, init=True)
    try:
        con.execute(
            "INSERT INTO comments(addr, text, kind, confidence) VALUES (?, ?, ?, ?)",
            (addr, args.text, args.kind, args.confidence),
        )
        con.commit()
    finally:
        con.close()
    print(f"noted 0x{addr:08x}")


def cmd_observe(args):
    addr = parse_int(args.addr) if args.addr else None
    con = open_db(args.db, init=True)
    try:
        con.execute(
            "INSERT INTO observations(topic, addr, confidence, text) VALUES (?, ?, ?, ?)",
            (args.topic, addr, args.confidence, args.text),
        )
        con.commit()
    finally:
        con.close()
    loc = f"0x{addr:08x}" if addr is not None else "global"
    print(f"observed {args.topic} at {loc}")


def cmd_field(args):
    offset = parse_int(args.offset)
    con = open_db(args.db, init=True)
    try:
        con.execute(
            """
            INSERT INTO struct_fields(struct_name, offset, name, kind, size, confidence, source, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(struct_name, offset) DO UPDATE SET
                name=excluded.name,
                kind=excluded.kind,
                size=excluded.size,
                confidence=excluded.confidence,
                source=excluded.source,
                note=excluded.note,
                updated_at=CURRENT_TIMESTAMP
            """,
            (
                args.struct,
                offset,
                args.name,
                args.kind,
                args.size,
                args.confidence,
                args.source,
                args.note,
            ),
        )
        con.commit()
    finally:
        con.close()
    print(f"{args.struct}+0x{offset:x} {args.name}")


def cmd_fields(args):
    con = open_db(args.db, init=args.init)
    term = f"%{args.term.lower()}%" if args.term else None
    try:
        if term:
            rows = con.execute(
                """
                SELECT struct_name, offset, name, kind, size, confidence, source, note
                FROM struct_fields
                WHERE lower(struct_name) LIKE ?
                   OR lower(name) LIKE ?
                   OR lower(coalesce(note, '')) LIKE ?
                ORDER BY struct_name, offset
                LIMIT ?
                """,
                (term, term, term, args.limit),
            )
        else:
            rows = con.execute(
                """
                SELECT struct_name, offset, name, kind, size, confidence, source, note
                FROM struct_fields
                ORDER BY struct_name, offset
                LIMIT ?
                """,
                (args.limit,),
            )
        for row in rows:
            size = "" if row["size"] is None else f" size={row['size']}"
            note = f"  # {row['note']}" if row["note"] else ""
            print(
                f"{row['struct_name']}+0x{row['offset']:04x} "
                f"{row['name']:32s} {row['kind']:8s}{size} "
                f"{row['confidence']:7s} {row['source']}{note}"
            )
    finally:
        con.close()


def cmd_forget(args):
    addr = parse_int(args.addr) if args.addr else None
    con = open_db(args.db, init=args.init)
    try:
        if args.table == "comments":
            sql = "DELETE FROM comments WHERE text = ?"
            params = [args.text]
            if addr is not None:
                sql += " AND addr = ?"
                params.append(addr)
        else:
            sql = "DELETE FROM observations WHERE text = ?"
            params = [args.text]
            if addr is not None:
                sql += " AND coalesce(addr, -1) = coalesce(?, -1)"
                params.append(addr)
        cur = con.execute(sql, params)
        con.commit()
    finally:
        con.close()
    print(f"deleted {cur.rowcount} {args.table} rows")


def cmd_labels(args):
    con = open_db(args.db, init=args.init)
    term = f"%{args.term.lower()}%" if args.term else None
    try:
        if term:
            rows = con.execute(
                """
                SELECT addr, name, kind, confidence, source, note
                FROM symbols
                WHERE lower(name) LIKE ? OR lower(coalesce(note, '')) LIKE ?
                ORDER BY addr
                LIMIT ?
                """,
                (term, term, args.limit),
            )
        else:
            rows = con.execute(
                """
                SELECT addr, name, kind, confidence, source, note
                FROM symbols
                ORDER BY addr
                LIMIT ?
                """,
                (args.limit,),
            )
        for row in rows:
            note = f"  # {row['note']}" if row["note"] else ""
            print(
                f"0x{row['addr']:08x} {row['name']:36s} "
                f"{row['kind']:12s} {row['confidence']:7s} {row['source']}{note}"
            )
    finally:
        con.close()


def cmd_import_strings(args):
    elf = Elf(args.elf)
    con = open_db(args.db, init=True)
    count = 0
    try:
        for off, text in iter_strings(elf.data, args.min):
            try:
                addr = elf.off_to_addr(off)
            except ValueError:
                continue
            con.execute(
                """
                INSERT INTO strings(addr, file_off, text, source)
                VALUES (?, ?, ?, 'scan')
                ON CONFLICT(addr) DO UPDATE SET
                    file_off=excluded.file_off,
                    text=excluded.text,
                    source=excluded.source
                """,
                (addr, off, text),
            )
            count += 1
        con.commit()
    finally:
        con.close()
    print(f"imported {count} strings into {args.db}")


def cmd_db_strings(args):
    con = open_db(args.db, init=args.init)
    term = f"%{args.term.lower()}%" if args.term else None
    try:
        if term:
            rows = con.execute(
                """
                SELECT addr, file_off, text
                FROM strings
                WHERE lower(text) LIKE ?
                ORDER BY addr
                LIMIT ?
                """,
                (term, args.limit),
            )
        else:
            rows = con.execute(
                "SELECT addr, file_off, text FROM strings ORDER BY addr LIMIT ?",
                (args.limit,),
            )
        for row in rows:
            print(f"0x{row['addr']:08x} off=0x{row['file_off']:08x} {row['text'][:args.width]}")
    finally:
        con.close()


def cmd_import_functions(args):
    elf = Elf(args.elf)
    text = elf.section(".text")
    prologues = [
        addr for addr in iter_possible_prologues(elf)
        if (args.start is None or addr >= parse_int(args.start))
        and (args.end is None or addr < parse_int(args.end))
    ]
    prologues.sort()
    con = open_db(args.db, init=True)
    count = 0
    try:
        for i, addr in enumerate(prologues):
            end_addr = prologues[i + 1] if i + 1 < len(prologues) else text.addr + text.size
            size = end_addr - addr
            if size < args.min_size:
                continue
            sym = con.execute(
                "SELECT name FROM symbols WHERE addr = ? AND kind = 'function'",
                (addr,),
            ).fetchone()
            name = sym["name"] if sym else None
            con.execute(
                """
                INSERT INTO functions(addr, end_addr, size, name, status, source)
                VALUES (?, ?, ?, ?, 'auto', 'prologue_scan')
                ON CONFLICT(addr) DO UPDATE SET
                    end_addr=CASE
                        WHEN functions.status = 'manual' THEN functions.end_addr
                        ELSE excluded.end_addr
                    END,
                    size=CASE
                        WHEN functions.status = 'manual' THEN functions.size
                        ELSE excluded.size
                    END,
                    name=coalesce(functions.name, excluded.name),
                    updated_at=CURRENT_TIMESTAMP
                """,
                (addr, end_addr, size, name),
            )
            count += 1
        con.commit()
    finally:
        con.close()
    print(f"imported/updated {count} function candidates into {args.db}")


def infer_manual_function_end(
    con: sqlite3.Connection,
    elf: Elf,
    addr: int,
    explicit_end: str | None,
    near_auto,
) -> int:
    if explicit_end:
        return parse_int(explicit_end)
    if near_auto is not None and near_auto["end_addr"] and near_auto["end_addr"] > addr:
        return near_auto["end_addr"]
    row = con.execute(
        "SELECT addr FROM functions WHERE addr > ? ORDER BY addr LIMIT 1",
        (addr,),
    ).fetchone()
    if row is not None:
        return row["addr"]
    sec = elf.section_for_addr(addr)
    if sec is None:
        raise SystemExit(f"address is not inside an ELF section: 0x{addr:08x}")
    return sec.addr + sec.size


def cmd_mark_function(args):
    addr = parse_int(args.addr)
    elf = Elf(args.elf)
    con = open_db(args.db, init=True)
    try:
        near_auto = con.execute(
            """
            SELECT addr, end_addr
            FROM functions
            WHERE addr > ?
              AND addr <= ?
              AND status = 'auto'
              AND source = 'prologue_scan'
            ORDER BY addr
            LIMIT 1
            """,
            (addr, addr + args.near),
        ).fetchone()
        end_addr = infer_manual_function_end(con, elf, addr, args.end, near_auto)
        if end_addr <= addr:
            raise SystemExit(
                f"function end must be greater than start: 0x{addr:08x}-0x{end_addr:08x}"
            )
        sym = con.execute(
            "SELECT name FROM symbols WHERE addr = ? AND kind = 'function'",
            (addr,),
        ).fetchone()
        name = args.name or (sym["name"] if sym else f"sub_{addr:08x}")
        size = end_addr - addr
        note = args.note or "Manual function boundary."
        con.execute(
            """
            INSERT INTO symbols(addr, name, kind, confidence, source, note)
            VALUES (?, ?, 'function', ?, ?, ?)
            ON CONFLICT(addr) DO UPDATE SET
                name=excluded.name,
                kind='function',
                confidence=excluded.confidence,
                source=excluded.source,
                note=coalesce(excluded.note, symbols.note),
                updated_at=CURRENT_TIMESTAMP
            """,
            (addr, name, args.confidence, args.source, args.note),
        )
        con.execute(
            """
            INSERT INTO functions(addr, end_addr, size, name, status, source, note)
            VALUES (?, ?, ?, ?, 'manual', ?, ?)
            ON CONFLICT(addr) DO UPDATE SET
                end_addr=excluded.end_addr,
                size=excluded.size,
                name=excluded.name,
                status='manual',
                source=excluded.source,
                note=excluded.note,
                updated_at=CURRENT_TIMESTAMP
            """,
            (addr, end_addr, size, name, args.source, note),
        )
        folded = None
        if near_auto is not None and not args.keep_near_auto:
            con.execute(
                """
                DELETE FROM functions
                WHERE addr = ? AND status = 'auto' AND source = 'prologue_scan'
                """,
                (near_auto["addr"],),
            )
            folded = near_auto["addr"]
        con.commit()
    finally:
        con.close()
    extra = f"; folded auto prologue 0x{folded:08x}" if folded is not None else ""
    print(f"{name}: 0x{addr:08x}-0x{end_addr:08x} size=0x{size:x}{extra}")


def cmd_import_xrefs(args):
    elf = Elf(args.elf)
    con = open_db(args.db, init=True)
    counts = collections.Counter()
    try:
        text = elf.section(".text")
        for off in range(text.off, text.off + text.size - 4, 4):
            pc = elf.off_to_addr(off)
            w = elf.u32_off(off)
            op = (w >> 26) & 0x3F
            target = w & 0x03FFFFFF
            if op in (0x02, 0x03):
                to_addr = jump_target(pc, target)
                if interesting_addr_section(elf, to_addr) in (".text", ".vutext"):
                    kind = "call" if op == 0x03 else "jump"
                    con.execute(
                        "INSERT OR IGNORE INTO xrefs(from_addr, to_addr, kind, source) VALUES (?, ?, ?, 'scan')",
                        (pc, to_addr, kind),
                    )
                    counts[kind] += 1
            elif args.branches and op in (0x01, 0x04, 0x05, 0x06, 0x07, 0x14, 0x15, 0x16, 0x17):
                to_addr = branch_target(pc, w & 0xFFFF)
                if interesting_addr_section(elf, to_addr) in (".text", ".vutext"):
                    con.execute(
                        "INSERT OR IGNORE INTO xrefs(from_addr, to_addr, kind, source) VALUES (?, ?, 'branch', 'scan')",
                        (pc, to_addr),
                    )
                    counts["branch"] += 1

            if op == 0x0F:
                base_reg = (w >> 16) & 31
                hi = w & 0xFFFF
                for look in range(1, args.lookahead + 1):
                    if off + look * 4 >= text.off + text.size:
                        break
                    w2 = elf.u32_off(off + look * 4)
                    op2 = (w2 >> 26) & 0x3F
                    rs = (w2 >> 21) & 31
                    imm = w2 & 0xFFFF
                    if rs != base_reg:
                        continue
                    formed = None
                    if op2 == 0x0D:
                        formed = (hi << 16) | imm
                    elif op2 in (
                        0x08, 0x09, 0x18, 0x19,
                        0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
                        0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E,
                        0x31, 0x35, 0x37, 0x39, 0x3D, 0x3F,
                    ):
                        formed = u32((hi << 16) + s16(imm))
                    if formed is None:
                        continue
                    sec_name = interesting_addr_section(elf, formed)
                    if sec_name is None:
                        continue
                    con.execute(
                        "INSERT OR IGNORE INTO xrefs(from_addr, to_addr, kind, source) VALUES (?, ?, ?, 'scan')",
                        (pc, formed, f"literal:{sec_name}"),
                    )
                    counts[f"literal:{sec_name}"] += 1
                    break

        if args.data_ptrs:
            for sec_name in (".rodata", ".data", ".sdata"):
                sec = elf.section(sec_name)
                for off in range(sec.off, sec.off + sec.size - 4, 4):
                    ptr_addr = elf.off_to_addr(off)
                    to_addr = elf.u32_off(off)
                    target_sec = interesting_addr_section(elf, to_addr)
                    if target_sec is None:
                        continue
                    con.execute(
                        "INSERT OR IGNORE INTO xrefs(from_addr, to_addr, kind, source) VALUES (?, ?, ?, 'scan')",
                        (ptr_addr, to_addr, f"data_ptr:{target_sec}"),
                    )
                    counts[f"data_ptr:{target_sec}"] += 1
        con.commit()
    finally:
        con.close()
    for kind, count in sorted(counts.items()):
        print(f"{kind}: {count}")
    print(f"saved xrefs to {args.db}")


def cmd_refs(args):
    con = open_db(args.db, init=args.init)
    try:
        addr = resolve_db_addr(con, args.target)
        direction = "from_addr" if args.out else "to_addr"
        other = "to_addr" if args.out else "from_addr"
        rows = con.execute(
            f"""
            SELECT from_addr, to_addr, kind, source, note
            FROM xrefs
            WHERE {direction} = ?
            ORDER BY kind, {other}
            LIMIT ?
            """,
            (addr, args.limit),
        ).fetchall()
        print(f"{'outgoing' if args.out else 'incoming'} refs for 0x{addr:08x} {db_symbol_name(con, addr) or ''}")
        for row in rows:
            focus = row["to_addr"] if args.out else row["from_addr"]
            sym = db_symbol_name(con, focus)
            fn = db_function_for_addr(con, focus)
            fn_text = ""
            if fn is not None:
                fn_name = fn["name"] or f"sub_{fn['addr']:08x}"
                fn_text = f" in {fn_name}+0x{focus - fn['addr']:x}"
            note = f" # {row['note']}" if row["note"] else ""
            label = f" {sym}" if sym else ""
            print(
                f"0x{row['from_addr']:08x} -> 0x{row['to_addr']:08x} "
                f"{row['kind']:18s} {row['source']:6s}{label}{fn_text}{note}"
            )
    finally:
        con.close()


def cmd_func(args):
    con = open_db(args.db, init=args.init)
    try:
        addr = resolve_db_addr(con, args.target)
        fn = db_function_for_addr(con, addr)
        if fn is None:
            print(f"no imported function contains 0x{addr:08x}; run import-functions first")
            return
        name = fn["name"] or db_symbol_name(con, fn["addr"]) or f"sub_{fn['addr']:08x}"
        end_addr = fn["end_addr"] if fn["end_addr"] is not None else fn["addr"] + (fn["size"] or 0)
        size = fn["size"] if fn["size"] is not None else end_addr - fn["addr"]
        print(
            f"{name}: 0x{fn['addr']:08x}-0x{end_addr:08x} "
            f"size=0x{size:x} status={fn['status']} source={fn['source']}"
        )
        if fn["note"]:
            print(f"note: {fn['note']}")

        print("labels:")
        for row in con.execute(
            """
            SELECT addr, name, kind, confidence, note
            FROM symbols
            WHERE addr >= ? AND addr < ?
            ORDER BY addr
            """,
            (fn["addr"], end_addr),
        ):
            note = f" # {row['note']}" if row["note"] else ""
            print(f"  +0x{row['addr'] - fn['addr']:04x} {row['name']} ({row['kind']}, {row['confidence']}){note}")

        print("comments:")
        for row in con.execute(
            "SELECT addr, text FROM comments WHERE addr >= ? AND addr < ? ORDER BY addr, id",
            (fn["addr"], end_addr),
        ):
            print(f"  +0x{row['addr'] - fn['addr']:04x} {row['text']}")

        print("outgoing refs:")
        for row in con.execute(
            """
            SELECT from_addr, to_addr, kind
            FROM xrefs
            WHERE from_addr >= ? AND from_addr < ?
            ORDER BY from_addr
            LIMIT ?
            """,
            (fn["addr"], end_addr, args.limit),
        ):
            sym = db_symbol_name(con, row["to_addr"])
            label = f" {sym}" if sym else ""
            print(f"  +0x{row['from_addr'] - fn['addr']:04x} -> 0x{row['to_addr']:08x} {row['kind']}{label}")
    finally:
        con.close()


def cmd_observations(args):
    con = open_db(args.db, init=args.init)
    term = f"%{args.term.lower()}%" if args.term else None
    try:
        if term:
            rows = con.execute(
                """
                SELECT topic, addr, confidence, text
                FROM observations
                WHERE lower(topic) LIKE ? OR lower(text) LIKE ?
                ORDER BY id
                LIMIT ?
                """,
                (term, term, args.limit),
            )
        else:
            rows = con.execute(
                "SELECT topic, addr, confidence, text FROM observations ORDER BY id LIMIT ?",
                (args.limit,),
            )
        for row in rows:
            loc = f"0x{row['addr']:08x}" if row["addr"] is not None else "global"
            print(f"[{row['topic']}] {loc} {row['confidence']}: {row['text']}")
    finally:
        con.close()


def cmd_seed_known(args):
    if not HAVE_SEED_DATA:
        raise SystemExit(
            f"{SEED_DATA_PATH} is not present. The seed data is generated from "
            "your own copy of the game alongside analysis.sqlite and is not "
            "committed; see README 'Local-only inputs'. Every other "
            "command works without it."
        )
    con = open_db(args.db, init=True)
    function_count = 0
    try:
        for addr, text, kind in KNOWN_RETRACTED_COMMENTS:
            con.execute(
                """
                DELETE FROM comments
                WHERE addr = ? AND text = ? AND kind = ?
                """,
                (addr, text, kind),
            )
        for topic, addr, text in KNOWN_RETRACTED_OBSERVATIONS:
            con.execute(
                """
                DELETE FROM observations
                WHERE topic = ? AND coalesce(addr, -1) = coalesce(?, -1) AND text = ?
                """,
                (topic, addr, text),
            )
        for addr, name, kind, confidence, source, note in KNOWN_LABELS:
            con.execute(
                """
                INSERT INTO symbols(addr, name, kind, confidence, source, note)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(addr) DO UPDATE SET
                    name=excluded.name,
                    kind=excluded.kind,
                    confidence=excluded.confidence,
                    source=excluded.source,
                    note=excluded.note,
                    updated_at=CURRENT_TIMESTAMP
                """,
                (addr, name, kind, confidence, source, note),
            )
            if kind == "function":
                fn = con.execute(
                    "SELECT end_addr, size FROM functions WHERE addr = ?",
                    (addr,),
                ).fetchone()
                if fn is not None:
                    end_addr = fn["end_addr"]
                    size = fn["size"]
                else:
                    next_fn = con.execute(
                        "SELECT addr FROM functions WHERE addr > ? ORDER BY addr LIMIT 1",
                        (addr,),
                    ).fetchone()
                    if next_fn is None:
                        continue
                    end_addr = next_fn["addr"]
                    size = end_addr - addr
                con.execute(
                    """
                    INSERT INTO functions(addr, end_addr, size, name, status, source, note)
                    VALUES (?, ?, ?, ?, 'manual', ?, ?)
                    ON CONFLICT(addr) DO UPDATE SET
                        end_addr=coalesce(functions.end_addr, excluded.end_addr),
                        size=coalesce(functions.size, excluded.size),
                        name=excluded.name,
                        status='manual',
                        source=excluded.source,
                        note=excluded.note,
                        updated_at=CURRENT_TIMESTAMP
                    """,
                    (addr, end_addr, size, name, source, note),
                )
                function_count += 1
        for topic, addr, confidence, text in KNOWN_OBSERVATIONS:
            existing = con.execute(
                """
                SELECT 1 FROM observations
                WHERE topic = ? AND coalesce(addr, -1) = coalesce(?, -1) AND text = ?
                """,
                (topic, addr, text),
            ).fetchone()
            if existing is None:
                con.execute(
                    """
                    INSERT INTO observations(topic, addr, confidence, text)
                    VALUES (?, ?, ?, ?)
                    """,
                    (topic, addr, confidence, text),
                )
        for struct_name, offset, name, kind, size, confidence, source, note in KNOWN_FIELDS:
            con.execute(
                """
                INSERT INTO struct_fields(struct_name, offset, name, kind, size, confidence, source, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(struct_name, offset) DO UPDATE SET
                    name=excluded.name,
                    kind=excluded.kind,
                    size=excluded.size,
                    confidence=excluded.confidence,
                    source=excluded.source,
                    note=excluded.note,
                    updated_at=CURRENT_TIMESTAMP
                """,
                (struct_name, offset, name, kind, size, confidence, source, note),
            )
        for addr, text, kind, confidence in KNOWN_COMMENTS:
            existing = con.execute(
                """
                SELECT 1 FROM comments
                WHERE addr = ? AND text = ? AND kind = ?
                """,
                (addr, text, kind),
            ).fetchone()
            if existing is None:
                con.execute(
                    """
                    INSERT INTO comments(addr, text, kind, confidence)
                    VALUES (?, ?, ?, ?)
                    """,
                    (addr, text, kind, confidence),
                )
        con.commit()
    finally:
        con.close()
    print(
        f"seeded {len(KNOWN_LABELS)} labels, {len(KNOWN_OBSERVATIONS)} observations, "
        f"{len(KNOWN_FIELDS)} fields, {len(KNOWN_COMMENTS)} comments, "
        f"and marked {function_count} known functions into {args.db}"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--elf", type=Path, default=DEFAULT_ELF)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("elf").set_defaults(func=cmd_elf)

    p = sub.add_parser("strings")
    p.add_argument("term", nargs="*")
    p.add_argument("--min", type=int, default=4)
    p.add_argument("--width", type=int, default=160)
    p.set_defaults(func=cmd_strings)

    p = sub.add_parser("scan-ptrs")
    p.add_argument("--section", default=".rodata")
    p.add_argument("--min-run", type=int, default=3)
    p.add_argument("--window", type=int, default=128)
    p.add_argument("--show", type=int, default=8)
    p.add_argument("--near", nargs="*", default=[])
    p.set_defaults(func=cmd_scan_ptrs)

    p = sub.add_parser("disasm")
    p.add_argument("addr")
    p.add_argument("--count", type=int, default=64)
    p.add_argument("--labels", action="store_true", help="annotate output with labels/comments from --db")
    p.set_defaults(func=cmd_disasm)

    p = sub.add_parser("words")
    p.add_argument("addr")
    p.add_argument("--count", type=int, default=64)
    p.set_defaults(func=cmd_words)

    p = sub.add_parser("surface-table")
    p.add_argument("--format", choices=("markdown", "csv", "json"), default="markdown")
    p.add_argument("--all", action="store_true", help="show all 25 fields in each 100-byte record")
    p.set_defaults(func=cmd_surface_table)

    p = sub.add_parser("surface-record-refs")
    p.add_argument("--tail", action="store_true", help="only show offsets +0x34 through +0x60")
    p.add_argument("--limit", type=int, default=120)
    p.add_argument("--init", action="store_true", help="create the database if it does not exist")
    p.set_defaults(func=cmd_surface_record_refs)

    p = sub.add_parser("cfg")
    p.add_argument("target")
    p.add_argument("--end")
    p.add_argument("--count", type=int)
    p.add_argument("--max-bytes", type=parse_int, default=0x800)
    p.add_argument("--max-blocks", type=int, default=120)
    p.add_argument("--disasm", action="store_true")
    p.add_argument("--init", action="store_true", help="create the database if it does not exist")
    p.set_defaults(func=cmd_cfg)

    p = sub.add_parser("field-refs")
    p.add_argument("offset", nargs="+")
    p.add_argument("--base", nargs="*", help="optional base register names, e.g. s1 s2")
    p.add_argument("--op", nargs="*", help="optional memory ops, e.g. lw sw lwc1 swc1 ldc2 sdc2")
    p.add_argument("--limit", type=int, default=120)
    p.add_argument("--init", action="store_true", help="create the database if it does not exist")
    p.set_defaults(func=cmd_field_refs)

    p = sub.add_parser("xrefs")
    p.add_argument("target")
    p.add_argument("--lookahead", type=int, default=4)
    p.add_argument("--show", type=int, default=40)
    p.add_argument("--save", action="store_true", help="store discovered xrefs in --db")
    p.set_defaults(func=cmd_xrefs)

    p = sub.add_parser("prologues")
    p.add_argument("--start")
    p.add_argument("--end")
    p.set_defaults(func=cmd_prologues)

    sub.add_parser("init-db").set_defaults(func=cmd_init_db)

    p = sub.add_parser("schema")
    p.add_argument("--init", action="store_true", help="create/update the database schema first")
    p.set_defaults(func=cmd_schema)

    p = sub.add_parser("label")
    p.add_argument("addr")
    p.add_argument("name")
    p.add_argument("--kind", default="unknown")
    p.add_argument("--confidence", default="medium")
    p.add_argument("--source", default="manual")
    p.add_argument("--note")
    p.set_defaults(func=cmd_label)

    p = sub.add_parser("note")
    p.add_argument("addr")
    p.add_argument("text")
    p.add_argument("--kind", default="note")
    p.add_argument("--confidence", default="medium")
    p.set_defaults(func=cmd_note)

    p = sub.add_parser("observe")
    p.add_argument("topic")
    p.add_argument("text")
    p.add_argument("--addr")
    p.add_argument("--confidence", default="medium")
    p.set_defaults(func=cmd_observe)

    p = sub.add_parser("field")
    p.add_argument("struct")
    p.add_argument("offset")
    p.add_argument("name")
    p.add_argument("--kind", default="unknown")
    p.add_argument("--size", type=int)
    p.add_argument("--confidence", default="medium")
    p.add_argument("--source", default="manual")
    p.add_argument("--note")
    p.set_defaults(func=cmd_field)

    p = sub.add_parser("fields")
    p.add_argument("term", nargs="?")
    p.add_argument("--limit", type=int, default=120)
    p.add_argument("--init", action="store_true", help="create/update the database if it does not exist")
    p.set_defaults(func=cmd_fields)

    p = sub.add_parser("forget")
    p.add_argument("table", choices=("comments", "observations"))
    p.add_argument("text")
    p.add_argument("--addr")
    p.add_argument("--init", action="store_true", help="create the database if it does not exist")
    p.set_defaults(func=cmd_forget)

    p = sub.add_parser("labels")
    p.add_argument("term", nargs="?")
    p.add_argument("--limit", type=int, default=200)
    p.add_argument("--init", action="store_true", help="create the database if it does not exist")
    p.set_defaults(func=cmd_labels)

    p = sub.add_parser("import-strings")
    p.add_argument("--min", type=int, default=4)
    p.set_defaults(func=cmd_import_strings)

    p = sub.add_parser("db-strings")
    p.add_argument("term", nargs="?")
    p.add_argument("--limit", type=int, default=80)
    p.add_argument("--width", type=int, default=160)
    p.add_argument("--init", action="store_true", help="create the database if it does not exist")
    p.set_defaults(func=cmd_db_strings)

    p = sub.add_parser("import-functions")
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("--min-size", type=int, default=8)
    p.set_defaults(func=cmd_import_functions)

    p = sub.add_parser("mark-function")
    p.add_argument("addr")
    p.add_argument("name", nargs="?")
    p.add_argument("--end")
    p.add_argument("--near", type=parse_int, default=0x20, help="window for folding a nearby auto prologue")
    p.add_argument("--keep-near-auto", action="store_true")
    p.add_argument("--confidence", default="high")
    p.add_argument("--source", default="manual")
    p.add_argument("--note")
    p.set_defaults(func=cmd_mark_function)

    p = sub.add_parser("import-xrefs")
    p.add_argument("--lookahead", type=int, default=6)
    p.add_argument("--branches", action="store_true")
    p.add_argument("--data-ptrs", action=argparse.BooleanOptionalAction, default=True)
    p.set_defaults(func=cmd_import_xrefs)

    p = sub.add_parser("refs")
    p.add_argument("target")
    p.add_argument("--out", action="store_true")
    p.add_argument("--limit", type=int, default=80)
    p.add_argument("--init", action="store_true", help="create the database if it does not exist")
    p.set_defaults(func=cmd_refs)

    p = sub.add_parser("func")
    p.add_argument("target")
    p.add_argument("--limit", type=int, default=80)
    p.add_argument("--init", action="store_true", help="create the database if it does not exist")
    p.set_defaults(func=cmd_func)

    p = sub.add_parser("observations")
    p.add_argument("term", nargs="?")
    p.add_argument("--limit", type=int, default=80)
    p.add_argument("--init", action="store_true", help="create the database if it does not exist")
    p.set_defaults(func=cmd_observations)

    sub.add_parser("seed-known").set_defaults(func=cmd_seed_known)

    args = ap.parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
