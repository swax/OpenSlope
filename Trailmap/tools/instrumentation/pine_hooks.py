#!/usr/bin/env python3
"""Live-toggle the noclip hooks in a running PCSX2 via PINE (TCP 127.0.0.1:28011).

Flip each hook site between its stock words and the noclip detour words in EE
RAM, without touching the ISO. Toggling one site at a time is how a fault is
bisected to the detour that causes it.

  python tools/instrumentation/pine_hooks.py status          show hook sites + cave state
  python tools/instrumentation/pine_hooks.py off             restore ALL sites to stock words
  python tools/instrumentation/pine_hooks.py on              install ALL detours
  python tools/instrumentation/pine_hooks.py a|b|c|d on|off  toggle one site
  python tools/instrumentation/pine_hooks.py save N          PINE savestate to slot N
  python tools/instrumentation/pine_hooks.py load N          PINE loadstate from slot N

No retail instruction is written down here. A site is identified by the SHA-256 of the
two words it holds in a pristine build -- the same digests tools/patches/noclip_patch.py
pins a build by -- and `off` copies the stock words back from the operator's own
extracted executable (Trailmap/extracted/SLES_505.45, or whatever SSX_STOCK_ELF names)
after checking them against that digest. The probes beside this file share the helpers.
"""

from __future__ import annotations

import hashlib
import os
import socket
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "patches"))
from noclip_patch import DEFAULT_ELF, TARGETS as NOCLIP_TARGETS, vaddr_to_off  # noqa: E402

PORT = 28011

#: The build every address under tools/instrumentation/ is written against.
TARGET = NOCLIP_TARGETS["SLES_505.45"]

#: name -> (hook site, SHA-256 of the two stock words there, the cave its detour jumps to).
SITES = {
    "a": (TARGET.site_a, TARGET.site_digests[0], 0x002B4C60),  # pad decode
    "b": (TARGET.site_b, TARGET.site_digests[1], 0x002B4C90),  # SharedUpdate
    "c": (TARGET.site_c, TARGET.site_digests[2], 0x002B4E40),  # input word
    "d": (TARGET.site_d, TARGET.site_digests[3], 0x002B4E80),  # wipeout entry
}


def j_ins(target: int) -> int:
    return 0x08000000 | ((target >> 2) & 0x03FFFFFF)


def pair_digest(words) -> str:
    """SHA-256 of two EE words: the form every stock-site table in this directory carries."""
    return hashlib.sha256(struct.pack("<2I", *words)).hexdigest()


def is_stock(words, digest: str) -> bool:
    """True when `words` are the two a site holds in a pristine build."""
    words = tuple(words)
    return len(words) == 2 and pair_digest(words) == digest


def words_hex(words) -> str:
    return " ".join(f"0x{word:08x}" for word in words)


def site_state(pine: Pine, site: int, digest: str, cave: int | None = None) -> str:
    """'stock', 'hooked' (a j into `cave` plus its nop), or 'unknown:<the live words>'.

    Printing unknown words is deliberate: they come from the operator's own emulator, and a
    site that matches neither state is exactly when they need to be seen.
    """
    words = (pine.r32(site), pine.r32(site + 4))
    if is_stock(words, digest):
        return "stock"
    if cave is not None and words == (j_ins(cave), 0):
        return "hooked"
    return f"unknown:{words[0]:08x},{words[1]:08x}"


def noclip_site_state(pine: Pine, name: str) -> str:
    site, digest, cave = SITES[name]
    return site_state(pine, site, digest, cave)


def stock_elf_path(elf: Path | None = None) -> Path:
    return Path(elf or os.environ.get("SSX_STOCK_ELF") or DEFAULT_ELF)


def stock_words(site: int, digest: str, elf: Path | None = None) -> list[int]:
    """The two stock words at `site`, copied from the operator's own executable and digest-checked."""
    path = stock_elf_path(elf)
    if not path.is_file():
        raise RuntimeError(
            f"{path} is missing; the stock words at 0x{site:08x} are copied from your own "
            "extracted executable (set SSX_STOCK_ELF to name it)."
        )
    data = path.read_bytes()
    off = vaddr_to_off(site)
    if off + 8 > len(data):
        raise RuntimeError(f"{path} is too short to hold 0x{site:08x}.")
    words = list(struct.unpack_from("<2I", data, off))
    if not is_stock(words, digest):
        raise RuntimeError(
            f"{path} does not hold the expected stock words at 0x{site:08x} "
            f"({words_hex(words)}); is it a pristine {TARGET.name}?"
        )
    return words


def restore_stock(pine: Pine, name: str, elf: Path | None = None) -> list[int]:
    """Put noclip site `name` back to stock and return the words now there.

    A site that already digests as stock is left alone -- read, not rewritten -- so the
    executable on disk is consulted only for a site that is currently detoured.
    """
    site, digest, _ = SITES[name]
    live = [pine.r32(site), pine.r32(site + 4)]
    if is_stock(live, digest):
        return live
    words = stock_words(site, digest, elf)
    pine.w32(site, words[0])
    pine.w32(site + 4, words[1])
    return words


class Pine:
    """A PINE client. `port` is the emulator's PINE *slot*, which is also its TCP port.

    One PCSX2 owns one slot, so talking to a second instance means naming its slot here. The slot is set
    per-instance in `PCSX2.ini` under `[EmuCore] PINESlot` (beside `EnablePINE`); there is no command-line
    flag for it, which is why `emu.pine_slot` edits the config for the length of a run.
    """

    #: Seconds to wait on one request. Generous rather than tight, because the failure it guards against is a
    #: DEAD emulator and the thing it keeps tripping on is a busy one: PCSX2 services PINE on the emulation
    #: thread, so a heavy batched read lands behind whatever that thread is doing, and a run driven above real
    #: time (`emu.turbo`) leaves it less idle still. A three-second budget is not enough for that: it aborts
    #: auto-test batches mid-pass against a healthy emulator. Nothing depends on this being short -- a
    #: genuinely wedged run is caught by
    #: the sampler's own stall and wall-clock backstops, which report WHY they stopped.
    TIMEOUT = 15.0

    def __init__(self, port: int = PORT):
        self.port = port
        self.s = socket.create_connection(("127.0.0.1", port), timeout=self.TIMEOUT)

    def _req(self, payload: bytes) -> bytes:
        self.s.sendall(struct.pack("<I", 4 + len(payload)) + payload)
        hdr = self.s.recv(4)
        size = struct.unpack("<I", hdr)[0]
        rest = b""
        while len(rest) < size - 4:
            c = self.s.recv(size - 4 - len(rest))
            if not c:
                raise RuntimeError("connection closed")
            rest += c
        if rest[0] != 0:
            raise RuntimeError(f"PINE error {rest[0]}")
        return rest[1:]

    def r32(self, addr: int) -> int:
        return struct.unpack("<I", self._req(struct.pack("<BI", 2, addr)))[0]

    def r32_many(self, addrs) -> list[int]:
        """Read several EE words in one PINE packet.

        PCSX2 accepts multiple commands in one IPC request and returns their
        payloads consecutively behind a single status byte.  Keeping this here
        avoids one host/socket round trip per telemetry word.
        """
        addresses = list(addrs)
        if not addresses:
            return []
        data = self._req(b"".join(struct.pack("<BI", 2, addr) for addr in addresses))
        expected = 4 * len(addresses)
        if len(data) != expected:
            raise RuntimeError(f"PINE r32 batch returned {len(data)} bytes; expected {expected}")
        return list(struct.unpack(f"<{len(addresses)}I", data))

    def r64(self, addr: int) -> int:
        """Read two adjacent aligned EE words with one PINE request."""
        return struct.unpack("<Q", self._req(struct.pack("<BI", 3, addr)))[0]

    def r64_many(self, addrs) -> list[int]:
        """Read several aligned EE doublewords in one PINE packet."""
        addresses = list(addrs)
        if not addresses:
            return []
        data = self._req(b"".join(struct.pack("<BI", 3, addr) for addr in addresses))
        expected = 8 * len(addresses)
        if len(data) != expected:
            raise RuntimeError(f"PINE r64 batch returned {len(data)} bytes; expected {expected}")
        return list(struct.unpack(f"<{len(addresses)}Q", data))

    def w32(self, addr: int, val: int):
        self._req(struct.pack("<BII", 6, addr, val))

    def savestate(self, slot: int):
        self._req(struct.pack("<BB", 9, slot))

    def loadstate(self, slot: int):
        self._req(struct.pack("<BB", 10, slot))

    def _text(self, opcode: int) -> str:
        data = self._req(struct.pack("<B", opcode))
        size = struct.unpack("<I", data[:4])[0]
        return data[4:4 + size].rstrip(b"\0").decode("utf-8", errors="replace")

    def title(self) -> str:
        return self._text(0xB)

    def game_id(self) -> str:
        return self._text(0xC)

    def status(self) -> int:
        return struct.unpack("<I", self._req(struct.pack("<B", 0xF)))[0]


def main() -> int:
    p = Pine()
    args = [a.lower() for a in sys.argv[1:]] or ["status"]

    if args[0] == "status":
        states = {0: "running", 1: "paused", 2: "shutdown"}
        emu_status = p.status()
        print(f"game: {p.title()} [{p.game_id()}], {states.get(emu_status, f'unknown:{emu_status}')}")
        for name, (site, digest, cave) in SITES.items():
            w0, w1 = p.r32(site), p.r32(site + 4)
            state = ("STOCK" if is_stock((w0, w1), digest) else
                     "HOOKED" if w0 == j_ins(cave) and w1 == 0 else "???")
            print(f"site {name.upper()} @0x{site:08x}: {w0:08x} {w1:08x} [{state}]")
        for label, addr in (("active", 0x002B4C40), ("prevBoth", 0x002B4C44),
                            ("capMask", 0x002B4C48),
                            ("registry", 0x00338E58)):
            print(f"{label}: 0x{p.r32(addr):08x}")
        reg = p.r32(0x00338E58)
        if reg:
            print(f"worldObj *(reg+0x730): 0x{p.r32(reg + 0x730):08x}")
        return 0

    if args[0] == "save":
        p.savestate(int(args[1])); print(f"saved slot {args[1]}"); return 0
    if args[0] == "load":
        p.loadstate(int(args[1])); print(f"loaded slot {args[1]}"); return 0

    if args[0] in ("on", "off"):
        names, mode = list(SITES), args[0]
    elif args[0] in SITES and len(args) > 1 and args[1] in ("on", "off"):
        names, mode = [args[0]], args[1]
    else:
        print(__doc__)
        return 1

    for name in names:
        site, _, cave = SITES[name]
        if mode == "on":
            p.w32(site, j_ins(cave)); p.w32(site + 4, 0)
        else:
            restore_stock(p, name)
        w0, w1 = p.r32(site), p.r32(site + 4)
        print(f"site {name.upper()} -> {mode}: {w0:08x} {w1:08x}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
