#!/usr/bin/env python3
"""Bulk EE reads and live-instance resolution for the auto-test harness.

The harness has to turn a name it authored (`Model_7_AT9button-flip`) into the address of the entity the
engine built for it, because every verdict this harness reports is a field on that entity. The level's
instance hash table is the only join between the two, and it moves with the level, so it is found rather than
tabulated.

Finding it by pattern -- a long run of (pointer, hash) pairs -- is how `tools/pine/anim-nodes.mjs` does it,
and it needs the whole 32 MB. This takes the cheaper route in the other direction: the hashes are already
known, so each one is searched for as a 4-byte pattern and its neighbours are tested for a plausible entity
pointer. That leaves the pair ORDER undetermined, which is the point -- both neighbours are offered as
candidates and the caller settles it by reading the entity's live translation and matching the location the
export authored. A hash hit that lands on the wrong word cannot survive that, and neither can a hash
collision.

READ-ONLY: every function here reads.
"""

from __future__ import annotations

import struct
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "instrumentation"))
from pine_hooks import Pine  # noqa: E402

# Where the engine's heap lives; below this is scratchpad/kernel and never holds an instance.
HEAP_START = 0x00300000
HEAP_END = 0x02000000

# Entity fields the harness reads [Trailmap: 130-collision-data, 150-logic].
ENTITY_TRANSLATION = 0x30
ENTITY_MODEL = 0xC0
ENTITY_FLAGS = 0xE8
ENTITY_LIVE_NODE = 0xE4      # the live collision-effect-node slot: the dispatch signal

# One PINE packet carries many commands; this is the batch `tools/pine/ee-dump.mjs` settled on.
READS_PER_PACKET = 40000


def bx_string_hash(text: str) -> int:
    """The engine's string hash, mirrored from `tools/pine/pinelib.mjs`."""
    value = 0
    for char in text:
        value = ((value << 4) + ord(char)) & 0xFFFFFFFF
        high = value & 0xF0000000
        if high:
            value ^= high >> 23
        value &= ~high & 0xFFFFFFFF
    return value & 0xFFFFFFFF


def instance_hash(name: str) -> int:
    return bx_string_hash(name) & 0x7FFFFFFF


def read_block(pine: Pine, addr: int, length: int) -> bytes:
    """Read a contiguous 8-aligned region with batched Read64s."""
    if addr % 8 or length % 8:
        raise ValueError("read_block wants an 8-aligned address and length")
    out = bytearray()
    done = 0
    while done < length:
        count = min(READS_PER_PACKET, (length - done) // 8)
        values = pine.r64_many(addr + done + index * 8 for index in range(count))
        out += struct.pack(f"<{count}Q", *values)
        done += count * 8
    return bytes(out)


def snapshot_heap(pine: Pine) -> tuple[int, bytes]:
    """The engine heap, as one buffer, with the address its first byte holds."""
    return HEAP_START, read_block(pine, HEAP_START, HEAP_END - HEAP_START)


@dataclass(frozen=True)
class EntityCandidate:
    entity: int
    hash_addr: int
    """Which neighbour of the hash word the pointer came from: -4 or +4."""
    pair_offset: int


def find_entity_candidates(heap_base: int, heap: bytes, name: str) -> list[EntityCandidate]:
    """Every plausible entity for one instance name, most likely first.

    An instance name appears in the hash table exactly once, but its hash VALUE can appear elsewhere in
    32 MB as ordinary data, so this deliberately over-collects and leaves the decision to the caller.
    """
    pattern = struct.pack("<I", instance_hash(name))
    found: list[EntityCandidate] = []
    at = heap.find(pattern)
    while at >= 0:
        if at % 4 == 0:
            for offset in (4, -4):
                index = at + offset
                if 0 <= index <= len(heap) - 4:
                    pointer, = struct.unpack_from("<I", heap, index)
                    if HEAP_START <= pointer < HEAP_END and not pointer & 3:
                        found.append(EntityCandidate(pointer, heap_base + at, offset))
        at = heap.find(pattern, at + 1)
    return found


def find_by_back_pointer(heap_base: int, heap: bytes, offset: int, target: int,
                         limit: int = 32) -> list[int]:
    """Every heap block that could be an object holding `target` at `+offset`, most likely first.

    The inverse of the name-hash search above, and it exists because some objects are not reachable FROM the
    instance at all. A spline mover is the case that forced it: the mover's update reads its host out of
    `node+0x78`, but the host's own live-node slot holds a different, smaller node, so no offset off that
    pointer can reach the mover — measured, three passes, the candidate words coming back 0 and a .rodata
    address against a known instance.

    What the mover does have is a POINTER BACK, and a specific instance address is a strong pattern: 32 bits
    of a value the caller already knows, required at a fixed offset. This deliberately does not try to be
    exact, because it cannot be — the same address appears in the instance table and in every other node that
    happens to reference it. It over-collects and leaves the decision to the caller, exactly as the hash
    search does, and the caller settles it by WATCHING: a candidate whose distance word advances tick after
    tick is the mover, and one that holds still is a coincidence at the right offset.
    """
    pattern = struct.pack("<I", target)
    found: list[int] = []
    at = heap.find(pattern)
    while at >= 0 and len(found) < limit:
        base = at - offset
        # A negative base is off the front of the snapshot, and an unaligned one cannot be an object.
        if base >= 0 and (heap_base + base) % 4 == 0:
            found.append(heap_base + base)
        at = heap.find(pattern, at + 1)
    return found


#: The rider manager's roster, as the engine's own passes read it: `sub_00113820` takes the count from
#: `+0x88`, refuses on non-positive, and walks the array from `+0xC4`; the standings pass 0x00115100 reads the
#: same pair and early-outs below 2.
RIDER_COUNT_AT = 0x88
RIDER_ARRAY_AT = 0xC4
#: Loose on purpose: a sanity bound on the BASE being right, not a claim about how big a field may be.
RIDER_COUNT_MAX = 16


def find_roster(heap_base: int, heap: bytes, boarder: int) -> tuple[int, tuple[int, ...]] | None:
    """`(managerAddress, everyBoarder)`, found in the heap, or None if nothing proved itself.

    The offsets above are the engine's and are not in doubt. WHICH OBJECT carries them is: the walker is a
    virtual out of the vtable written to `s0+0x34` by 0x00114c88, one of a dozen sub-object vptrs installed
    into one allocation, so the manager sits inside a compound object at no base this harness holds. Scanning
    a window off the world was tried for exactly that reason and found nothing, twice — which is why this
    searches the heap instead of guessing harder.

    It is the `find_by_back_pointer` trick with a stricter acceptance test, and it can afford to be strict
    because the array's own shape is the evidence. A candidate is the local boarder's address appearing
    somewhere in memory, read as if it were slot `i` of a roster; the block is accepted only when the count at
    `+0x88` is in range AND actually covers slot `i` AND every one of those slots holds a distinct
    heap-aligned address. A coincidence has to satisfy all of that at once, which an address sitting in an
    unrelated table does not.

    Unlike the mover search this returns at most ONE answer rather than over-collecting, because here there is
    a static test that separates the real object — the mover had none, and had to be settled by watching.
    """
    pattern = struct.pack("<I", boarder)
    at = heap.find(pattern)
    while at >= 0:
        for slot in range(RIDER_COUNT_MAX):
            base = at - RIDER_ARRAY_AT - slot * 4
            if base < 0 or (heap_base + base) % 4 or base + RIDER_COUNT_AT + 4 > len(heap):
                continue
            count, = struct.unpack_from("<I", heap, base + RIDER_COUNT_AT)
            if not slot < count <= RIDER_COUNT_MAX:
                continue
            end = base + RIDER_ARRAY_AT + count * 4
            if end > len(heap):
                continue
            riders = struct.unpack_from(f"<{count}I", heap, base + RIDER_ARRAY_AT)
            if any(rider & 3 or not HEAP_START <= rider < HEAP_END for rider in riders):
                continue
            if len(set(riders)) != count:
                continue
            return heap_base + base, riders
        at = heap.find(pattern, at + 1)
    return None


def entity_translation(heap_base: int, heap: bytes, entity: int) -> tuple[float, float, float] | None:
    index = entity - heap_base + ENTITY_TRANSLATION
    if index < 0 or index + 12 > len(heap):
        return None
    return struct.unpack_from("<3f", heap, index)


def resolve_instance(heap_base: int, heap: bytes, name: str,
                     location: tuple[float, float, float] | None,
                     tolerance: float = 1.0) -> EntityCandidate | None:
    """The one entity whose live translation matches the location the export authored for `name`.

    Without a location to check against there is nothing to distinguish a real table entry from a stray
    32-bit value, so this reports nothing rather than guessing -- a wrong entity would report a confident
    verdict about a prop that is not the one under test.
    """
    candidates = find_entity_candidates(heap_base, heap, name)
    if location is None:
        return None
    for candidate in candidates:
        live = entity_translation(heap_base, heap, candidate.entity)
        if live is None:
            continue
        if all(abs(live[axis] - location[axis]) <= tolerance for axis in range(3)):
            return candidate
    return None
