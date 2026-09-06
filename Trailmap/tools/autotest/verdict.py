#!/usr/bin/env python3
"""Watch an auto-test run and report, per variant, whether its collision graph dispatched.

The signal is `entity+0xe4`, the live collision-effect-node slot [Trailmap: 150-logic]. The contact walk
reaches construction only through `CollisionEffectNode_GetOrCreate`, which fills that slot, and only the
node's own destructor clears it. So a non-zero read is proof the engine built this instance's graph, and it
is a LEVEL rather than an edge -- it stays set for the node's whole lifetime instead of existing for one
frame the way a particle burst or a texture flip does. That is what makes the verdict robust against host
timing, which is exactly what defeated hand-timed attempts to catch a half-second flip.

The slot is not exclusive to contact, though: a PERSISTENT circumstance graph fills the same field at level
load, and a live read of a retail flipbook prop shows exactly that. So the test is a 0 -> non-zero
TRANSITION measured against a baseline taken before the rider is anywhere near the cell, and a cell that
already holds a node when the run starts is reported as such instead of as a pass.

A run therefore reports, per variant:

  fired         the slot went from empty to occupied during the run -- the graph ran
  crossed       the rider passed within reach of the prop, so `not fired` means something
  not-reached   the rider never got near it: the cell is untested rather than failed
  refused       the rider never got near it AND could not -- but the cell driving it dispatched, so the
                empty slot is a refusal rather than a gap (see `coveredBy`)
  pre-occupied  a node was already installed at baseline, so contact dispatch is not observable here

The middle two matter more than they look. A variant the rider missed and a variant that refused to
dispatch produce the same empty `entity+0xe4` history, and reporting them the same way would manufacture
evidence for whatever the run was trying to prove.
"""

from __future__ import annotations

import json
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "instrumentation"))
from ee import (ENTITY_LIVE_NODE, find_by_back_pointer, find_roster, read_block, resolve_instance,
                snapshot_heap)  # noqa: E402
from emu import (BOARDER_BOOST_REQUEST, BOARDER_POSITION, BOARDER_TRICK_WINDOW, GAME_HZ, PINE_PORT,
                 read_level_state)  # noqa: E402
from pine_hooks import Pine  # noqa: E402

# Raw SSX units are centimetres, so this is a 25 m ball around the prop's own origin -- generous enough to
# cover a full-corridor panel's span, tight enough that two cells 90 m apart never both claim one pass.
CROSSED_RADIUS_RAW = 2500.0

#: Extra reads of the two pad-request words between main packets, taking the effective rate on those two
#: from ~20 Hz to the game's own 60. They are the only words here that are consumed rather than held.
PAD_OVERSAMPLE = 2

#: How many ordered transitions a probe keeps. Enough to hold a whole build/change/teardown story with
#: room to spare; a word that oscillates every tick is a different finding and truncation says so.
TRACE_LIMIT = 24

# ---- Debug-message banners ([Trailmap: 443-debug-text]) ------------------------------------------------
#
# A run built with `--hud-text` carries a main-type-12 node behind each cell's debounce, and the patched
# opcode posts the node's own text to the HUD event ring. Reading that ring turns "the text appeared" from
# something a person has to watch for into something the pass records: the banner is posted by the ENGINE
# from the effect chain, so seeing one is a second, independent witness that the chain dispatched -- next to
# the live-node slot the cell is already graded on, and reached by a different route.
#
# Ring layout and the sentinel are the patch's, not the game's: kind 10 is the CHECKPOINT banner, and the
# aux word carries the sentinel that tells the shim this slot's value is a text pointer rather than a
# string id.
BANNER_RING = 0x5820 + 0x015C     # boarder -> trick-score state -> event ring
BANNER_SLOTS = 12
BANNER_STRIDE = 0x14
BANNER_KIND = 10
BANNER_SENTINEL = 0x53570000
#: A banner's text is fixed for the life of the level, so each pointer is read once and remembered.
BANNER_TEXT_MAX = 64
#: The node's three f32 colour channels sit immediately AHEAD of its text, so the one pointer the ring
#: carries reaches both. Reading them back is what makes the colour a measurement rather than an
#: assumption: a wrong offset would draw the message perfectly and colour it from whatever was next door.
BANNER_COLOUR_BYTES = 12
#: What one read_block asks for: the colour, the longest text worth reading, and the slack for an address
#: that is not 8-aligned -- rounded UP to a multiple of 8, because read_block requires it of the LENGTH as
#: well as the address. Getting only the address right fails at the first banner, mid-ride.
BANNER_READ_BYTES = (BANNER_COLOUR_BYTES + BANNER_TEXT_MAX + 8 + 7) & ~7


def _read_banner(pine: Pine, address: int) -> tuple[str, tuple[float, float, float] | None]:
    """The NUL-terminated UTF-16LE string a banner slot points at, and the colour ahead of it."""
    if not 0x00100000 <= address < 0x02000000:
        return "", None
    start = (address - BANNER_COLOUR_BYTES) & ~7
    blob = read_block(pine, start, BANNER_READ_BYTES)
    head = (address - BANNER_COLOUR_BYTES) - start
    colour = struct.unpack_from("<3f", blob, head)
    text = blob[head + BANNER_COLOUR_BYTES:]
    end = 0
    while end + 1 < len(text) and text[end:end + 2] != bytes(2):
        end += 2
    return text[:end].decode("utf-16-le", errors="replace"), colour


class BannerWatch:
    """Turns the ring's live slots into one record per POSTING.

    A slot stays populated for its whole lifetime, so sampling it says "a banner is on screen" every tick.
    What a pass wants is how many times the engine posted one, which is the transition into occupancy --
    so a slot only counts when it was not carrying that same text on the previous sample.
    """

    def __init__(self) -> None:
        self.texts: dict[int, tuple[str, tuple[float, float, float] | None]] = {}
        self.live: set[tuple[int, int]] = set()
        self.posts: list[tuple[float, str, tuple[float, float, float] | None]] = []

    def sample(self, pine: Pine, boarder: int, now: float) -> None:
        if not boarder:
            return
        ring = boarder + BANNER_RING
        start = ring & ~7
        length = ((ring - start) + BANNER_SLOTS * BANNER_STRIDE + 7) & ~7
        try:
            blob = read_block(pine, start, length)[ring - start:]
        except Exception:
            return
        seen: set[tuple[int, int]] = set()
        for index in range(BANNER_SLOTS):
            kind, value, _duration, _elapsed, aux = struct.unpack_from("<5I", blob, index * BANNER_STRIDE)
            if kind != BANNER_KIND or aux != BANNER_SENTINEL:
                continue
            seen.add((index, value))
            if (index, value) in self.live:
                continue
            if value not in self.texts:
                self.texts[value] = _read_banner(pine, value)
            text, colour = self.texts[value]
            self.posts.append((round(now, 3), text, colour))
        self.live = seen


#: Window ends that mean the run covered less course than it was asked to. The others -- the frame count
#: elapsing, the race finishing, the level going away -- are how a healthy pass ends.
FAULT_ENDS = ("cut-short", "stalled")

#: The default speed cap, m/s [Trailmap: 360-cap]. Reported against rather than graded: it is the line the
#: peak-speed signal has to cross before it is worth a column, since a grounded rider is bounded here and
#: only an airborne one (where the clamp is skipped) can exceed it.
SPEED_CAP_MPS = 27.888


@dataclass
class Probe:
    """One extra word watched alongside the dispatch slot, to answer what a node DID rather than that it ran.

    The pointer chain is walked once, at attach, and only the final address is sampled. Chasing it every
    tick would multiply PINE round trips by the number of cells and drag the sample rate down to where
    short-lived changes get missed — which is the exact failure this harness has already been bitten by.
    The cost is that a chain whose intermediate pointers move during a run goes stale; the structures these
    reach (model, material) are built at level load and do not.
    """
    label: str
    address: int
    baseline: int = 0
    changed_at: float | None = None
    values: set[int] = field(default_factory=set)
    #: The last value sampled. A set of observed values cannot tell "changed and stayed" from "changed and
    #: changed back", and for a word like the instance draw gate those are opposite findings — a breakable
    #: that hides is the first, a flip that blinks is the second.
    last: int = 0
    #: Ordered `(seconds, value)` for every change, which the set and the final value together still cannot
    #: reconstruct: they say WHICH values occurred and where it ended, never in what order or when. Reading a
    #: word against another word's timeline — did the draw come back when the node died, or before? — needs
    #: the sequence. Capped, because a word that oscillates would otherwise fill the report.
    trace: list[tuple[float, int]] = field(default_factory=list)
    #: Set for a probe read relative to whatever `entity+0xe4` currently holds, rather than a fixed address.
    #: The live effect node does not exist until contact builds it, so nothing about it can be resolved at
    #: attach; these are re-addressed each tick, and only for cells whose slot is currently occupied.
    node_offset: int | None = None


@dataclass
class VariantWatch:
    id: str
    question: str
    expect: str | None
    expect_paint: bool
    #: What this cell's node must do to the RIDER: a list of
    #: `{"signal": ..., "atLeast": x, "atMost": y}`. The dispatch slot proves a node was built; only these
    #: prove it did anything to the player, which for a boost or a pad is the whole question.
    expect_rider: list
    #: `{"atLeast": n, "atMost": n}` on how many times the instance's live-node slot is RELEASED after it
    #: first fills — the suppression latches' whole observable.
    #:
    #: They are the only thing this fixture grades whose claim is that something does not happen: a populated
    #: column 3 or 4 runs no chain, it skips the engine's default teardown. So there is no value to assert and
    #: no timestamp to catch, only a teardown that is missing beside a control where it is not — and grading
    #: both halves is what keeps the pair honest, since an engine that stopped tearing anything down at all
    #: would satisfy the latched cell alone.
    #:
    #: A count rather than a flag, because "held" is not what every latch buys. Column 4 suppresses a node's
    #: own end and nothing else, so a latched pulse still goes when its region unloads — it builds ONE node
    #: where its control builds three. Bounds rather than exact counts: how many times a region cycles is a
    #: property of the course and the window, not of the latch.
    expect_slot: dict | None
    instance_name: str
    entity: int
    location: tuple[float, float, float]
    #: The cell whose dispatch covers this row, for a row the rider CANNOT reach. A hop's companion sits a
    #: half-corridor off the fall line so that only the hop can put a node on it, so `not-reached` is its
    #: resting state rather than a coverage gap -- and a `no-dispatch` companion graded that way could never
    #: pass. Set from the plan's `coveredBy`; see the state table at the top of this file.
    covered_by: str | None = None
    # The live-node slot as found before the run: non-zero means a persistent graph already owns it.
    baseline: int = 0
    fired: bool = False
    fired_at: float | None = None
    node: int = 0
    closest: float = float("inf")
    #: WHEN the rider was nearest. Reported, not graded, and the difference is worth stating because the
    #: obvious use of it does not work.
    #:
    #: `fired` says the live-node slot filled; it does not say WHO filled it — one slot per instance, a full
    #: field of riders, so an opponent crossing a cell fills it exactly as the local human does. Comparing
    #: this against `fired_at` looks like the test for that, and it is not: `closest` is measured to the
    #: instance's ORIGIN, and a full-corridor panel is contacted a dozen metres from its origin on a slope
    #: the rider is still descending. So the nearest sample lands AFTER the contact as a matter of geometry.
    #: Wired as a warning it fired on nearly every cell of an all-green fixture.
    #:
    #: It stays because the two timestamps together are real information for a cell whose prop is small and
    #: whose contact should be at its origin. What it cannot be is an automatic verdict.
    closest_at: float | None = None
    crossed: bool = False
    samples: int = 0
    probes: list[Probe] = field(default_factory=list)
    #: `{"label", "backPointer", "offsets", "seconds"}` for an object that is NOT reachable from the instance
    #: and has to be found in the heap by the pointer it holds back to it. Run after the window closes.
    late: dict | None = None
    #: What that search found: `[{"address", "words": [[at, value], ...]}]`, one per candidate.
    late_found: list[dict] = field(default_factory=list)


@dataclass
class RunLog:
    watches: list[VariantWatch]
    unresolved: list[str] = field(default_factory=list)
    #: Simulation frames covered, which IS the window: how much of the course a run saw must not depend on
    #: how fast the host emulated it.
    frames: int = 0
    #: The absolute clock reading at the last sample, for lining a run up against an external trace.
    last_frame: int = 0
    #: Host time the window took. Only ever a diagnostic — divided by `frames` it says how fast the emulator
    #: was running, and nothing is graded against it.
    wall_seconds: float = 0.0
    #: Why the window ended. `restarted` (the race finished and the engine reset the level clock),
    #: `level-gone` (the level was torn down) and `complete` (the requested frames elapsed) are all normal
    #: ends. `cut-short` (the wall-clock backstop) and `stalled` (a frame counter that stopped advancing)
    #: are faults: the run covers less course than it should, and every cell past the rider is untested
    #: rather than failed.
    ended: str = "complete"
    #: `(seconds, x, y, z, vx, vy, vz, boostRequest, trickWindow)` per sample, all read in one packet so a
    #: cell's effect on the rider is one instant rather than a smear across several round trips. The
    #: timestamp is GAME seconds, derived from the frame counter.
    rider_path: list[tuple] = field(default_factory=list)
    #: Every distinct `laps_remaining` and raw motion state seen. Both are single words that decide whether a
    #: whole node does anything, so they are reported for the run rather than probed per cell.
    laps: set[int] = field(default_factory=set)
    motion: set[int] = field(default_factory=set)
    #: Every distinct `GameModeGlobal` seen. A set rather than a value because the front end is driven rather
    #: than navigated, so what the run ended up in is a reading, not a setting.
    game_mode: set[int] = field(default_factory=set)
    #: Set when the heap search was refused because the measured level no longer exists.
    late_skipped: str | None = None
    #: `(game seconds, text)` per HUD message banner the ENGINE posted, on a run built with
    #: `--hud-text`. Empty on every other run, including one whose ISO carries the nodes but not the
    #: patch — which is the distinction that makes an empty list here worth reporting rather than hiding.
    banners: list[tuple[float, str]] = field(default_factory=list)
    #: The local human's boarder, as the address rather than as its contents. Several opcodes act on a boarder
    #: they were HANDED (`thread+0xe8`) rather than on the rider they touched, and a probe that reads such a
    #: pointer says nothing until it can be compared against the rider this run is measuring.
    boarder: int = 0
    #: Every boarder on the mountain, the local human included, once the roster read has proved itself.
    #:
    #: It answers two questions that were being argued rather than measured. HOW MANY riders a mode puts on
    #: the course is the first, and it decides whether a mode is worth riding for a cell that has to be sure
    #: whose contact it is reading. The second is sharper: an opcode handed a boarder that is not the local
    #: human can only be reported as "somebody else" until there is a roster to name it against, and with one
    #: it becomes a named rider in a known field.
    roster: tuple[int, ...] | None = None
    #: The manager's address, found in the heap. Reported rather than swallowed: it is discovered per run
    #: until somebody traces the object properly, and a discovered address nobody prints cannot be compared
    #: against the next run's.
    roster_at: int | None = None
    #: `(seconds, x0, y0, z0, x1, y1, z1, ...)` per sample — EVERY rider's position, in roster order, read in
    #: the same packet as the local rider's own row so the field is one instant rather than a smear.
    #:
    #: The local rider's position is already in `rider_path`, and this is not a duplicate of it: the questions
    #: that need this are the ones about WHO, and they cannot be asked of a one-rider trace at all. Two of them
    #: were open when this was added and both had been argued rather than measured for weeks.
    #:
    #: A rider-acting opcode services the boarder its effect thread was HANDED (`thread+0xe8`) rather than the
    #: rider who touched the prop, and the pads have been stuck on that for four batches because their
    #: observable is a float on one boarder — "it did not write" and "it wrote on somebody else" read
    #: identically. A teleport has the same owner word and an observable nothing can miss, so sampling every
    #: rider turns that into a name: exactly one body moves 130 m, and this says whose.
    #:
    #: It also settles a gate that no solo course can ask about. `gate-human` passes for the player; whether it
    #: REJECTS an AI needs a second board on the mountain and a way to see what that board did.
    roster_path: list[tuple] = field(default_factory=list)


def resolve_chain(pine: Pine, entity: int, chain: list[int]) -> int | None:
    """Walk `chain` from an entity: every offset but the last is dereferenced, the last is the address.

    `[0xc0, 0x08, 0x10]` means "entity+0xc0 is a pointer, +0x08 off that is a pointer, and the word at +0x10
    off THAT is what we want".
    """
    address = entity
    for offset in chain[:-1]:
        address = pine.r32(address + offset)
        if not address or address & 3:
            return None
    return address + chain[-1]


def attach(pine: Pine, entries: list[dict]) -> RunLog:
    """Resolve every variant to its live entity from one heap snapshot."""
    heap_base, heap = snapshot_heap(pine)
    watches: list[VariantWatch] = []
    unresolved: list[str] = []
    for entry in entries:
        location = entry.get("location")
        found = resolve_instance(heap_base, heap, entry["instanceName"],
                                 tuple(location) if location else None)
        if found is None:
            unresolved.append(entry["id"])
            continue
        probes = []
        for spec in entry.get("watches") or []:
            if spec.get("base") == "liveNode":
                for offset in spec["offsets"]:
                    # Signed, because an offset can be NEGATIVE: `entity+0xe4` registers a sub-object
                    # embedded partway into its allocation, so a node's own fields can sit before the
                    # pointer the slot hands out. `f"{-12:x}"` would render that as `+0x-c`.
                    sign = "+" if offset >= 0 else "-"
                    probes.append(Probe(label=f"{spec['label']}{sign}0x{abs(offset):x}",
                                        address=0, node_offset=offset))
                continue
            if spec.get("base") == "absolute":
                # A FIXED address, owned by nothing — for asking where a write went when it did not go where
                # it was supposed to. The pad opcodes are the case: both act on a boarder they are HANDED
                # rather than the rider they touched, and no constructor on the collision-spawn path assigns
                # that field. If it is null, `swc1 f0, 308(a0)` puts the authored value at absolute 0x134,
                # in kernel-side low memory where nothing else writes floats — so a value appearing there is
                # the null-owner case caught in the act, and its absence rules that case out and leaves the
                # owner a real pointer that is not the local rider. Neither answer is reachable from any
                # instance-relative probe, which is why this base exists.
                for address in spec["addresses"]:
                    probes.append(Probe(label=f"{spec['label']}@0x{address:x}", address=address))
                continue
            address = resolve_chain(pine, found.entity, spec["chain"])
            if address is not None:
                probes.append(Probe(label=spec["label"], address=address))
        watches.append(VariantWatch(
            late=entry.get("lateWatch"),
            id=entry["id"], question=entry["question"], expect=entry.get("expect"),
            expect_paint=bool(entry.get("expectPaint")), expect_rider=entry.get("expectRider") or [],
            expect_slot=entry.get("expectSlot"), covered_by=entry.get("coveredBy"),
            instance_name=entry["instanceName"], entity=found.entity, location=tuple(location),
            probes=probes,
        ))
    # One batched read AFTER resolving them all, so the baseline is a single moment rather than a smear
    # across however long the snapshot search took.
    if watches:
        fixed = [probe for item in watches for probe in item.probes if probe.node_offset is None]
        addresses = [item.entity + ENTITY_LIVE_NODE for item in watches] + [probe.address for probe in fixed]
        values = pine.r32_many(addresses)
        for item, node in zip(watches, values):
            item.baseline = node
        for probe, value in zip(fixed, values[len(watches):]):
            probe.baseline = value
            probe.values.add(value)
    # The roster, off the snapshot that was taken anyway. It belongs here rather than in the sampling loop for
    # two reasons: the field is settled for a level, so this is a property of the run and not a signal; and
    # the manager is not at any base this harness holds, so finding it takes a whole-heap search that would
    # tear a hole in every cell's timeline if it ran mid-window.
    log = RunLog(watches=watches, unresolved=unresolved)
    state = read_level_state(pine)
    if state is not None:
        found = find_roster(heap_base, heap, state.boarder)
        if found:
            log.roster_at, log.roster = found
    return log


def watch(pine: Pine, log: RunLog, frames: int, hz: float = 20.0,
          stall_seconds: float = 30.0, wall_scale: float = 4.0,
          on_tick=None) -> RunLog:
    """Sample every variant's live-node slot and the rider's position for `frames` simulation ticks.

    The window is measured in the GAME's frames, not the host's clock, and that is a correctness property
    rather than a nicety. A wall-clock window silently shortens the run whenever the emulator drops below
    full speed: the rider gets less far down the course, the cells past where it got to report `not-reached`,
    and `not-reached` grades as inconclusive -- so a slow host quietly turns into "we could not test the
    bottom half of the fixture", reported in language that sounds like a harness fault. Nothing about that is
    visible in the output. Counting the game's own ticks makes the coverage of a run a property of the run.

    Sampling PACE follows from the same argument. The sleep is retuned from the emulation speed measured so
    far, so the density stays near `hz` samples per second of GAME time however fast the host is going. A
    fixed host interval would sample a half-speed emulator twice as densely per game second, spending PINE
    round trips to over-cover a slow run -- the opposite of what a host running several emulators wants.

    Two backstops, because an unbounded loop inside a `--repeat` batch is its own hazard: `stall_seconds` of
    no frame advance ends the run (a paused or wedged emulator, which is a different thing from a slow one),
    and `wall_scale` caps host time at that multiple of the window's real-time length. Either one sets
    `log.ended`, so a short window is always reported as short rather than passed off as a complete pass.
    """
    if not log.watches:
        return log
    started = time.monotonic()
    wall_cap = frames / GAME_HZ * wall_scale
    banners = BannerWatch()
    first_frame: int | None = None
    advanced_at = started
    previous_frame = -1
    high_frame = -1
    while True:
        tick = time.monotonic()
        state = read_level_state(pine)
        if state is None:
            # The level went away mid-run (a reset, a crash, the run finishing). Stop rather than keep
            # sampling addresses that no longer belong to this level.
            log.ended = "level-gone"
            break
        if first_frame is None:
            first_frame = state.frame
        # THE RUN IS OVER WHEN THE CLOCK GOES BACKWARDS. Finishing the course does not end the level: the
        # race ends, the results come up, and the engine puts the rider back at the gate with the level
        # clock reset to zero. Everything sampled past that belongs to a DIFFERENT run of the same course,
        # and there is no honest way to read it as a continuation of this one --
        #
        #   the window never completes, because elapsed frames collapse back to zero before reaching any
        #     window longer than one race, and the run rides until a backstop kills it;
        #   the timeline stops being ordered, because timestamps derive from the reset clock -- the ordered
        #     probe trace, which exists precisely to say what happened BEFORE what, silently starts
        #     interleaving two runs at the same game time;
        #   attribution gains a channel nobody chose, because a second descent re-approaches every cell and
        #     those samples are eligible to be credited to the cell that fired on the first.
        #
        # A restart drops thousands of frames, so the test needs no tuned threshold; a second of slack keeps
        # it clear of any single odd read.
        if high_frame - state.frame > GAME_HZ:
            log.ended = "restarted"
            break
        high_frame = max(high_frame, state.frame)
        elapsed = state.frame - first_frame
        if elapsed >= frames:
            break
        wall = tick - started
        if state.frame != previous_frame:
            previous_frame = state.frame
            advanced_at = tick
        elif tick - advanced_at >= stall_seconds:
            log.ended = "stalled"
            break
        if wall >= wall_cap:
            log.ended = "cut-short"
            break
        now = elapsed / GAME_HZ
        log.frames = elapsed
        log.last_frame = state.frame
        log.boarder = state.boarder
        # One block read of the HUD event ring. Cheap enough to do every tick, and it has to be every tick:
        # a banner's whole life is 2.5 s and what is being counted is the moment it appears.
        banners.sample(pine, state.boarder, now)
        # A driver's per-tick hook, on the GAME clock — the steered instrument passes (`run.py --weave`)
        # update their forced control word here, so the schedule survives turbo exactly as the window does.
        if on_tick is not None:
            on_tick(now)
        # The two pad-request words, oversampled — but only ONE of them needs it, and knowing which is the
        # point. `boarder+0x134` is a countdown, not a pulse: `BoarderMotion_SharedUpdate` subtracts 1/60 from
        # it every tick and clamps at zero, and nothing else in the ELF writes it, so an authored 5.0 is five
        # whole seconds of non-zero and no sampler at any rate can miss it. `boarder+0x138` decays the same
        # way in the same function — and is ALSO zeroed outright, alongside its +0x13c flag, by the
        # motion-state enter helper at 0x00108368. A trick window can therefore end between two frames, on a
        # transition the rider makes constantly, which is exactly the shape a 20 Hz sampler misses.
        #
        # So the extra reads buy nothing for the speed request and are the whole measurement for the trick
        # window. They are cheap either way — two words against the dozens the main packet carries — and both
        # are kept together because reading one and not the other would make the pair's results unequal
        # evidence, which is the one property this pair of cells exists to have.
        #
        # The peak is what is kept: each field is a maximum the pad asks for, so the largest reading in the
        # interval IS the measurement, and it inherits this packet's position, which moves under half a metre
        # in that time.
        boost, trick = state.boost_request, state.trick_window
        pads = [state.boarder + BOARDER_BOOST_REQUEST, state.boarder + BOARDER_TRICK_WINDOW]
        # The board-audio signal words ride at the TAIL, after the pads: `_rider_signal` reads the pads at
        # their historical indices 7/8, so anything new APPENDS rather than inserts — a row is a positional
        # contract with `audio_signals.py` and `board-bed-study.ts`, both of which index the motion state at
        # 14. The motion state therefore keeps that index rather than staying last, so a signal analysis can
        # still keep only the steady ground samples (a weaving rider spends real time airborne and
        # recovering, and those ticks belong to no surface's bed).
        log.rider_path.append((now, *state.position, *state.velocity, boost, trick,
                               state.dig, state.lean, *state.slip_vec, state.motion,
                               state.gem_multiplier))
        pad_entry = len(log.rider_path) - 1
        log.laps.add(state.laps)
        log.motion.add(state.motion)
        log.game_mode.add(state.game_mode)
        # Dispatch slots and every payload probe in ONE packet, so a cell's "the node ran" and "the node
        # changed something" are read at the same instant rather than a round trip apart.
        fixed = [probe for item in log.watches for probe in item.probes if probe.node_offset is None]
        # The whole field's positions ride at the TAIL of this packet rather than in one of their own. Three
        # words per rider against the dozens already here is nothing, and sharing the packet is the point:
        # "who moved" is a comparison BETWEEN riders, so reading them a round trip apart would let one rider's
        # position be a frame older than another's — which at 30 m/s is most of a metre of made-up relative
        # motion, in a measurement whose whole job is to attribute a displacement to one body.
        roster = log.roster or ()
        addresses = ([item.entity + ENTITY_LIVE_NODE for item in log.watches] + [p.address for p in fixed]
                     + [rider + BOARDER_POSITION + axis * 4 for rider in roster for axis in range(3)])
        values = pine.r32_many(addresses)
        if roster:
            tail = values[len(log.watches) + len(fixed):]
            # Rounded to the SAME grid as `fired_at`, which is what these are compared against. An unrounded
            # timestamp here reads as fractionally earlier than the dispatch it belongs to, and a half-open
            # window then hands the relocation to the cell ABOVE the one that caused it — measured, once.
            log.roster_path.append((round(now, 3),
                                    *struct.unpack(f"<{len(tail)}f", struct.pack(f"<{len(tail)}I", *tail))))
        nodes = values[:len(log.watches)]
        for probe, value in zip(fixed, values[len(log.watches):len(log.watches) + len(fixed)]):
            probe.values.add(value)
            if value != probe.last and len(probe.trace) < TRACE_LIMIT:
                probe.trace.append((round(now, 3), value))
            probe.last = value
            if value != probe.baseline and probe.changed_at is None:
                probe.changed_at = round(now, 3)
        # Second packet, and only for cells whose slot is occupied right now: the node these read from is
        # built by the contact that is being measured, so its address is not knowable in advance.
        live = [(probe, node + probe.node_offset)
                for item, node in zip(log.watches, nodes) if node
                for probe in item.probes if probe.node_offset is not None]
        if live:
            for (probe, address), value in zip(live, pine.r32_many(address for _, address in live)):
                probe.address = address
                probe.values.add(value)
                if value != probe.last and len(probe.trace) < TRACE_LIMIT:
                    probe.trace.append((round(now, 3), value))
                probe.last = value
                if probe.changed_at is None:
                    probe.changed_at = round(now, 3)
        for item, node in zip(log.watches, nodes):
            item.samples += 1
            distance = _distance(state.position, item.location)
            if distance < item.closest:
                item.closest, item.closest_at = distance, round(now, 3)
            if distance <= CROSSED_RADIUS_RAW:
                item.crossed = True
            # A transition, not a level: a cell whose slot was already occupied at baseline cannot report
            # contact dispatch, because the field it would report through is spoken for.
            if node and not item.baseline and not item.fired:
                item.fired = True
                item.fired_at = round(now, 3)
                item.node = node
        # Retune from the speed measured so far rather than sleeping a fixed host interval, so the timeline
        # keeps ~`hz` samples per GAME second whatever the emulator is managing. The floor stops a run that
        # has barely started (or an emulator crawling at 5%) from stretching the interval without bound.
        speed = max(now / wall, 0.05) if wall > 0.5 and now > 0 else 1.0
        spent = time.monotonic() - tick
        interval = 1.0 / (hz * speed)
        if spent < interval:
            # The two pad words get re-read THROUGH the sleep rather than before it, and that distinction is
            # the whole of whether this works. Reading them three times back to back costs three round trips
            # and buys nothing: the emulator has not advanced a frame between them, so it is one frame
            # sampled three times. Spacing the reads across the interval is what actually raises the rate on
            # these two words to the game's own, which is what a value that is WRITTEN AND THEN CONSUMED
            # needs — everything else here is a level that persists for as long as a node lives.
            slice_ = (interval - spent) / (PAD_OVERSAMPLE + 1)
            for _ in range(PAD_OVERSAMPLE):
                time.sleep(slice_)
                more = struct.unpack("<2f", struct.pack("<2I", *pine.r32_many(pads)))
                entry = log.rider_path[pad_entry]
                log.rider_path[pad_entry] = (entry[:7] + (max(entry[7], more[0]), max(entry[8], more[1]))
                                             + entry[9:])
            time.sleep(slice_)
        else:
            for _ in range(PAD_OVERSAMPLE):
                more = struct.unpack("<2f", struct.pack("<2I", *pine.r32_many(pads)))
                entry = log.rider_path[pad_entry]
                log.rider_path[pad_entry] = (entry[:7] + (max(entry[7], more[0]), max(entry[8], more[1]))
                                             + entry[9:])
    log.wall_seconds = time.monotonic() - started
    log.banners = banners.posts
    return log


def watch_late(pine: Pine, log: RunLog, hz: float = 20.0) -> RunLog:
    """Find objects that are not reachable from their instance, then watch them for a moment.

    Deliberately AFTER the window rather than inside it. The search needs a whole heap snapshot, which takes
    long enough that running it mid-window would tear a hole in every other cell's timeline — and the objects
    it looks for are persistent ones that live as long as the level, so there is nothing to be early for.

    The catch this has to survive is that the search over-collects: an instance address appears in the
    instance table and in every other object that references it, so most candidates are coincidences at the
    right offset. Nothing static separates them. What separates them is BEHAVIOUR, so each candidate's words
    are sampled over a short window and reported with their timeline intact. A distance that climbs tick after
    tick is a mover running; the same offset inside the instance table holds still. The caller reads which.
    """
    late = [item for item in log.watches if item.late]
    if not late:
        return log
    # THE LEVEL HAS TO STILL BE THE ONE THAT WAS MEASURED. A window normally closes because the race
    # finished, and finishing tears the level down and builds it again with the rider back at the gate — so
    # a search run afterwards walks a DIFFERENT heap, looking for an instance address that belonged to the
    # previous one. The first run of this reported "0 moving of 3 candidates", which reads exactly like a
    # mover that does not move and was nothing of the kind.
    #
    # There is no way to salvage it from here: the objects are gone. The fix is at the caller, which has to
    # bound the window so it ends while the level is still up — and until it does, this refuses rather than
    # reports, because a null result that looks like a finding is the worst thing this harness can produce.
    if log.ended in ("restarted", "level-gone"):
        log.late_skipped = log.ended
        print(f"  SKIPPED the heap search: the run ended '{log.ended}', so the level that was measured is "
              f"gone and anything found now belongs to a different one. Shorten the window (--frames) so it "
              f"closes before the race does.")
        return log
    heap_base, heap = snapshot_heap(pine)
    for item in late:
        spec = item.late
        candidates = find_by_back_pointer(heap_base, heap, spec["backPointer"], item.entity)
        item.late_found = [{"address": address, "words": []} for address in candidates]
        if not candidates:
            continue
        addresses = [address + offset for address in candidates for offset in spec["offsets"]]
        stride = len(spec["offsets"])
        started = time.monotonic()
        while True:
            now = time.monotonic() - started
            if now > spec.get("seconds", 3.0):
                break
            state = read_level_state(pine)
            if state is None:
                break
            values = pine.r32_many(addresses)
            for index, entry in enumerate(item.late_found):
                entry["words"].append([round(now, 3), values[index * stride:(index + 1) * stride]])
            time.sleep(1.0 / hz)
    return log


def _distance(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return sum((a[axis] - b[axis]) ** 2 for axis in range(3)) ** 0.5


def _late_moved(entry: dict) -> bool:
    """Did any word on this candidate change across the window — the only thing that separates it from a
    coincidence at the right offset."""
    words = entry["words"]
    if len(words) < 2:
        return False
    first = words[0][1]
    return any(sample != first for _, sample in words[1:])


def _signed(value: int) -> str:
    """A word as the engine would read it: hex, plus the signed value when the top bit is set."""
    return f"0x{value:08x}" if value < 0x80000000 else f"0x{value:08x}({value - (1 << 32)})"


#: Effect-node sub-type of a texture flip, and the offsets the fixture watches on it.
FLIP_SUBTYPE = 0x0B
PROBE_SUBTYPE = "+0x14"
PROBE_FRAME = "+0x5c"


def _paint_grade(item: "VariantWatch") -> str:
    """Did this cell's flip actually paint, as opposed to merely dispatching?

    Two conditions, because either alone is satisfiable by a failure: the node the contact built has to BE a
    texture flip (a chain whose slot ends up held by its debounce reports dispatch just as happily), and its
    applied-frame word has to take more than one value (a node that builds and settles on the resting frame
    has painted nothing). A single observed frame is not evidence of a flip, and `-1` is the engine's own
    signature for a material that reached it with no flip table at all.
    """
    if not item.expect_paint:
        return "n/a"
    by_label = {probe.label[probe.label.rfind("+"):]: probe for probe in item.probes}
    subtype, frame = by_label.get(PROBE_SUBTYPE), by_label.get(PROBE_FRAME)
    if subtype is None or frame is None or not subtype.values:
        return "inconclusive"
    if FLIP_SUBTYPE not in subtype.values:
        return "REGRESSION"
    return "pass" if len(frame.values) >= 2 else "REGRESSION"


def _slot_grade(item: "VariantWatch", final_at: float | None = None) -> str:
    """How many times did the instance let go of a node it had built?

    This is the suppression latches' whole observable. It reads the traced `entity+0xe4` rather than the
    verdict, because the verdict answers when the slot FILLED and the question here is what happened after.

    A cell whose slot never filled is inconclusive rather than failing: nothing was there to be released, and
    calling that zero releases would let a dead cell pass as a perfectly latched one.

    A release on the run's LAST sample is not counted, and that is not a bar being loosened. A pass ends when
    the race restarts, and the restart tears down every instance still holding a node at once — measured as
    exactly five cells releasing on the same timestamp, which were exactly the five whose slots were still
    occupied. It happens to a latched cell and an unlatched one alike, so it separates nothing; counting it
    would fail every `atMost: 0` cell on any course long enough for the restart to land inside the window,
    which is a property of the course rather than of the latch.
    """
    if not item.expect_slot:
        return "n/a"
    trace = next((probe.trace for probe in item.probes if probe.label == "liveNodeSlot"), None)
    if trace is None:
        return "inconclusive"
    filled = next((at for at, value in trace if value), None)
    if filled is None:
        return "inconclusive"
    releases = sum(1 for at, value in trace
                   if not value and at > filled and (final_at is None or at < final_at))
    low, high = item.expect_slot.get("atLeast"), item.expect_slot.get("atMost")
    if low is not None and releases < low:
        return "REGRESSION"
    if high is not None and releases > high:
        return "REGRESSION"
    return "pass"


def _attributed(path: list, since: float | None, location: tuple[float, float, float],
                others: list[tuple[float, float, float]]) -> list:
    """The rider samples this cell is answerable for: after it dispatched, while it is the nearest cell.

    The bound is proximity, and it took three attempts to get there — each wrong one produced a confident
    false grade rather than a visible failure, which is what makes this worth spelling out.

    A fixed TIME window credits a cell with whatever the rider was doing N seconds later. Cells one field
    apart are about that far apart at course speed, so the one cell that launches the rider lent its climb to
    the cell below it, and the lap-boost cell reported a 10 m/s lift it had nothing to do with. A fixed
    PROXIMITY ball fixed that and broke the other end: a boost host is a 40 m box crossed off-centre, so a
    25 m ball around its origin admitted only the first few ticks, before the push had built, and the cell
    that does lift reported nothing. Keeping the time cap alongside nearest-cell then clipped the last cell
    on the course, where a launched rider falls back INTO the box and is pushed again well after the node
    was built — 2.4 m/s attributed against a 13.7 m/s run peak that nothing else could have caused.

    Nearest-cell alone needs no number and no tuning. A sample belongs to whichever cell is closest to it, so
    the window covers a whole crossing however long the rider lingers, and can never reach the next cell —
    whatever the spacing or the host's size.

    Entries are `(index, sample)` so a consumer can tell genuine neighbours from two samples that merely sit
    next to each other in this filtered list.
    """
    if since is None:
        return []
    return [(index, point) for index, point in enumerate(path)
            if point[0] >= since
            and all(_distance(point[1:4], location) <= _distance(point[1:4], other) for other in others)]


#: Metres of single-sample travel above which a rider was MOVED rather than moved. A rider at the top cap
#: covers ~1.7 m between 20 Hz samples, so this sits two orders of magnitude clear of any real motion and
#: two orders under the thousands a course reset relocates by.
TELEPORT_M = 50.0


def _before_teleport(window: list) -> list:
    """A cell's window up to the point the rider was MOVED rather than moved.

    Everything past a teleport belongs to a different part of the run, and crediting it to this cell is how a
    cell reports something it had nothing to do with. It is not a corner case here: the cell that measures a
    throw is the last one on its course by construction -- a launched rider arrives at whatever follows both
    airborne and climbing -- so the rider it launches sails off the end of the fixture and the engine resets
    them thousands of metres back up the mountain, and the reset lands INSIDE this cell's window because the
    cell is still the nearest one to wherever they were put.

    Measured: three passes reported a 13.5 m/s `rise` with zero altitude gained, which is not a thing a push
    can do. The number was the reset's own velocity, sampled after the relocation and attributed to the vent.
    """
    for index in range(1, len(window)):
        if _distance(window[index][1][1:4], window[index - 1][1][1:4]) / 100.0 > TELEPORT_M:
            return window[:index]
    return window


def _runs(window: list) -> list[list]:
    """Split a window into the stretches the rider travelled continuously, cut at every gap.

    Distinct from `_before_teleport`, and the two answer different questions. A window is a filtered subset --
    only the samples where this cell was the nearest -- so consecutive entries can be a moment apart in the
    run with the rider perfectly ordinary in between. That gap is harmless to an INSTANTANEOUS reading and
    fatal to one that spans positions, because the altitude either side of it is not one climb.

    SPLIT rather than truncate. Cutting at the first break threw away everything after it, and a window
    routinely OPENS with one: the cell fires the moment contact dispatches, while the rider is still close
    enough to the cell above for a sample or two to belong to that one instead.
    """
    runs, current = [], [window[0]]
    for index in range(1, len(window)):
        if window[index][0] != window[index - 1][0] + 1:
            runs.append(current)
            current = []
        current.append(window[index])
    runs.append(current)
    return runs


def _roster_jumps(log: "RunLog", since: float | None, until: float | None) -> list[dict]:
    """Every rider RELOCATED between `since` and `until`, named by roster slot.

    The one measurement a single-rider trace cannot make. Everything else in this file reads the local human,
    which is the right subject for "what did this cell do to me" and useless for "which of six did it act on"
    — and that second question is the one standing between several cells and an answer, because a rider-acting
    opcode services the boarder its thread was handed rather than whoever touched the prop.

    A relocation is the same discontinuity `jump` reads and for the same reason: no boarder field records that
    a rider was moved, so the position gap IS the observable. `TELEPORT_M` sits two orders above what any
    rider covers between samples, so this needs no per-cell tuning.

    Bounded at BOTH ends, unlike `_attributed`. A cell's window runs to the end of the run, and out there the
    engine reclaims stopped riders and restarts the level — events that would otherwise be reported as this
    cell having moved somebody. `until` is the caller's business: the next cell's dispatch, or the end.
    """
    if not log.roster or not log.roster_path or since is None:
        return []
    count = len(log.roster)
    out: list[dict] = []
    for slot in range(count):
        for index in range(1, len(log.roster_path)):
            now = log.roster_path[index][0]
            # Half-open, and the open end is the point: a cell that fires and relocates somebody on the SAME
            # sample owns that relocation, so the cell above it must not also claim it. `since` is inclusive
            # and `until` is not, which hands it to exactly one of them.
            if now < since or (until is not None and now >= until):
                continue
            here, prior = log.roster_path[index], log.roster_path[index - 1]
            base = 1 + slot * 3
            gap = _distance(here[base:base + 3], prior[base:base + 3]) / 100.0
            # A stale roster entry reads as garbage rather than as a position, and garbage differences are
            # enormous. Anything past a course's own size is a dead pointer, not a rider.
            if not (TELEPORT_M < gap < 100_000):
                continue
            # The FIRST relocation, not the largest, for the same reason `jump` truncates at one. The last
            # cell on a course has no upper bound, so its window reaches the end of the run — where a stopped
            # rider is reclaimed and the level restarts. Taking the biggest would report whichever accident
            # was worse; the first is the one this cell caused.
            out.append({"rider": slot, "address": f"0x{log.roster[slot]:08x}",
                        "local": log.roster[slot] == log.boarder,
                        "m": round(gap, 2), "at": now})
            break
    return out


def _rider_signal(name: str, full: list, path: list | None = None) -> float | None:
    """One measurement of what happened to the rider, over the samples a cell is answerable for.

    Every one is a PEAK rather than an end state, because each of these fields is written once and then
    decays or is integrated away: a pad's request drains 1/60 per tick, an upward push is spent against
    gravity, and a teleport is over in a frame. Sampling at 20 Hz sees the peak and would miss the write.

    All ordinary peak signals are read from BEFORE the rider was relocated, since nothing a cell did survives
    into a part of the run it never touched. `jump` is the exception because the relocation IS its subject;
    `impact` is independently bounded to the first five samples around contact.

    `jump` and `impact` need a sample of LEAD-IN, and the distinction is worth stating because getting it wrong
    is silent. Every other signal is a peak over single samples: the value is in the sample, so a window that
    opens the instant the cell fired contains it. These two are DIFFERENCES between adjacent samples, so a
    displacement or velocity change that happens AT dispatch straddles the boundary — the "after" sample is
    in the window and the "before" sample is one index outside it.

    That is not a corner case, it is the normal shape for an opcode that acts immediately: measured on
    `teleport-warp`, a rider who was moved 132.9 m in one frame reported 1.43 m three passes running, which
    reads exactly like a node that did nothing. So the two difference signals are given the one sample before
    their windows open; handing it to a peak signal would credit this cell with a value that was already there
    before it fired.
    """
    if not full:
        return None
    if name == "impact":
        # The collision lab's response observable: largest VELOCITY discontinuity across the contact sample,
        # in a short five-sample window beginning one sample before dispatch. A solid response is not always
        # a literal rebound. The angled crash-bag proxy can reverse the fall-line component, stop the rider,
        # or redirect most of it sideways depending on exactly which face was hit; vector delta captures all
        # three while a signed one-axis projection misses the third.
        #
        # Bounded to the first few samples so an ordinary landing later in the cell's attribution window is
        # not credited to this contact. The one lead-in sample is load-bearing for the same reason it is for
        # `jump`: response occurs on the sample that dispatch opens the window, and the before velocity sits
        # just outside it.
        if path is None:
            return None
        first = full[0][0]
        start, stop = max(0, first - 1), min(len(path) - 1, first + 4)
        return round(max((sum((path[index][axis] - path[index - 1][axis]) ** 2
                              for axis in (4, 5, 6)) ** 0.5
                          for index in range(start + 1, stop + 1)), default=0.0) / 100.0, 2)
    window = full if name == "jump" else _before_teleport(full)
    if not window:
        return None
    if name == "jump":
        # One sample of lead-in (above), then STOP AT THE CELL'S OWN RELOCATION.
        #
        # The truncation matters for the same reason `_before_teleport` exists, and it bites hardest on the
        # cell this signal is for. A teleport cell has to be LAST on its course, and the last cell owns every
        # sample to the end of the run — including the reclaim that puts a stopped rider back on the race
        # line. Measured on `human-gate-warp`: its own warp was 132.03 m and it reported 139.12, because a
        # reclaim 46 s later was larger. Reporting the bigger of two relocations is reporting whichever
        # accident was worse, so the window ends at the first one, which is the one this cell caused.
        if path is not None:
            first = window[0][0]
            if first > 0:
                window = [(first - 1, path[first - 1]), *window]
        for index in range(1, len(window)):
            if window[index][0] != window[index - 1][0] + 1:
                continue
            if _distance(window[index][1][1:4], window[index - 1][1][1:4]) / 100.0 > TELEPORT_M:
                window = window[:index + 1]
                break
    if name == "rise":            # velocity Z, centimetres/s in native space, positive is up
        return round(max(point[6] for _, point in window) / 100.0, 2)
    if name == "climb":
        # THE THROW, in metres: how far up the rider ended up, not how fast they left.
        #
        # `rise` is the push's own output and `climb` is what a player feels, and the two are different
        # questions because everything between them belongs to somebody else — gravity, the airborne
        # integrator, and whether the cap clamps on the way. A port can reproduce `rise` exactly and still
        # throw a rider twice as high, which is the failure this exists to catch.
        #
        # Measured from the FIRST attributed sample rather than from the run's own low point: the window
        # opens when the cell dispatched, so the base is the altitude the rider arrived at this cell with,
        # and a descending approach cannot inflate it. Index 3 is raw Z, the vertical axis in native space.
        #
        # Per CONTINUOUS STRETCH on top of the teleport cut above, because the two breaks are different: a
        # gap in the window leaves the rider ordinary but somewhere else, and the altitude either side of one
        # is not a single climb.
        return round(max((max(point[3] for _, point in run) - run[0][1][3])
                         for run in _runs(window)) / 100.0, 2)
    if name == "speed":
        # Peak carried SPEED in m/s — the whole velocity magnitude, not one axis. This is where the shared
        # speed cap shows up, and it is the half of a boost a port is most likely to get wrong: the engine's
        # clamp scales the entire vector down when it exceeds the cap, and a scripted boost node raises
        # nothing (it writes neither pad-request field), so a grounded rider is bounded at the default
        # ~27.9 m/s however violent the push. Airborne the clamp is skipped outright, which is exactly why
        # a vertical vent can put a rider far past course speed [Trailmap: 360-node-cap].
        return round(max(sum(point[axis] ** 2 for axis in (4, 5, 6)) ** 0.5
                         for _, point in window) / 100.0, 2)
    if name == "boost-request":   # boarder+0x134, what a MainType-17 speed pad writes
        return round(max(point[7] for _, point in window), 3)
    if name == "trick-window":    # boarder+0x138, seconds of trick window from MainType 18
        return round(max(point[8] for _, point in window), 3)
    if name == "gem-multiplier":
        # `TrickScoreState+0x28`, the whole of what a MainType-14 node does. A peak like the rest, and for a
        # sharper reason than decay: the multiplier is CONSUMED by the next banked trick and reset to 1.0 by
        # `TrickScore_ResetCombo` on the following land or bail, so the end state on a descending rider is
        # 1.0 whether or not a gem ever landed.
        #
        # It rests at exactly 1.0, so this is the one rider signal whose baseline is a claim: every cell that
        # is not a gem reads 1.0, and a column of anything else says the offset is wrong rather than that the
        # cells failed.
        return round(max(point[15] for _, point in window), 3)
    if name == "jump":
        # The largest ADJACENT-sample displacement, in metres. A rider under power moves ~1.3 m between 20 Hz
        # samples; a relocation moves them. This is the observable for both opcodes that MOVE a rider rather
        # than pushing one — the course reset (13) and the teleport to an instance (24) — because neither
        # writes any boarder field saying it happened. The position discontinuity is all there is.
        #
        # Adjacency has to be checked against the original path, not against this window. A cell's window is
        # a filtered subset, so two entries that are neighbours IN THE LIST can be a minute apart in the run —
        # which is exactly what happens after a reset carries the rider back past earlier cells. Measured
        # without this check, the control cell reported a 194 m "jump" that was really the rider leaving and
        # returning.
        return round(max((_distance(window[i - 1][1][1:4], window[i][1][1:4])
                          for i in range(1, len(window))
                          if window[i][0] == window[i - 1][0] + 1), default=0.0) / 100.0, 2)
    return None


def _rider_grade(item: "VariantWatch", measured: dict) -> str:
    """Did this cell's node do what it claims to the rider, as opposed to merely being built?

    A cell that never dispatched is inconclusive rather than failed — there is no window to measure in, and
    calling that a failure would blame the node for a contact that never happened.
    """
    if not item.expect_rider:
        return "n/a"
    worst = "pass"
    for want in item.expect_rider:
        value = measured.get(want["signal"])
        if value is None:
            return "inconclusive"
        if want.get("atLeast") is not None and value < float(want["atLeast"]):
            worst = "REGRESSION"
        if want.get("atMost") is not None and value > float(want["atMost"]):
            worst = "REGRESSION"
    return worst


def _grade(expect: str | None, state: str, banner_at: float | None = None) -> str:
    """Score one cell against what hardware previously demonstrated for it.

    A cell whose slot read empty but whose BANNER posted is graded `pass`, and that is a strengthening
    rather than a let-off. The banner is emitted by the effect chain itself, from a node the fixture puts
    behind the debounce — so one appearing proves the chain ran and that everything ahead of the message,
    the debounce included, was built. What it does NOT prove is a node AFTER the message, so this only
    ever rescues the dispatch expectation, never `expectPaint`, `expectRider` or `expectSlot`.

    `boost-directional` is why it exists: across six runs its banner posted six times and the live-node
    slot read it four, so a third of its passes were reporting a sampler miss as a broken node. Reading
    the chain's own evidence settles which of the two witnesses was wrong.

    A cell the rider never reached is INCONCLUSIVE whatever was expected, including when the expectation was
    `no-dispatch` — a miss and a refusal look identical from here, and letting a miss count as a pass would
    quietly turn a broken ride into a green suite.

    `refused` is the one case where they do NOT look identical, and it is not that rule being relaxed: the
    row was never reachable in the first place, and the cell that drives it dispatched. It falls through to
    the same comparison every reached cell gets.
    """
    if expect is None:
        return "open"                       # still a question; this pass measures rather than judges it
    if state == "not-reached":
        return "inconclusive"
    if state == "pre-occupied":
        return "unobservable"               # a persistent graph owns the slot the verdict reads
    fired = state == "fired"
    if not fired and expect == "dispatch" and banner_at is not None:
        return "pass"                       # the chain said so itself; see the docstring
    return "pass" if fired == (expect == "dispatch") else "REGRESSION"


def report(log: RunLog) -> dict:
    # When the run ended, as the probes saw it. A pass ends on the race restarting, and that restart
    # releases every slot still held — an event common to latched and unlatched cells alike, so the
    # slot grade discounts it rather than reading it as a teardown some latch failed to suppress.
    final_at = max((at for item in log.watches for probe in item.probes
                    for at, _ in probe.trace), default=None)
    def observed(item: "VariantWatch") -> str:
        if item.baseline:
            return "pre-occupied"
        if item.fired:
            return "fired"
        if item.crossed:
            return "crossed-without-firing"
        return "not-reached"

    states = {item.id: observed(item) for item in log.watches}
    # A row the rider CANNOT reach, resolved against the cell that drives it. Only `not-reached` is waived and
    # only on the host having FIRED, which is a positive observation rather than an absence: a run that ended
    # before this stretch of course leaves the host un-fired too, and both rows stay inconclusive together.
    for item in log.watches:
        if states[item.id] == "not-reached" and item.covered_by:
            if states.get(item.covered_by) == "fired":
                states[item.id] = "refused"

    rows = []
    for item in log.watches:
        state = states[item.id]
        rivals = [other.location for other in log.watches if other is not item]
        window = _attributed(log.rider_path, item.fired_at, item.location, rivals)
        # Every signal is measured whenever the cell fired, expectation or not: a cell under investigation is
        # exactly the one whose numbers are worth reading, and it is what a later expectation is set from.
        measured = {name: _rider_signal(name, window, log.rider_path)
                    for name in ("rise", "climb", "speed", "boost-request", "trick-window", "jump",
                                 "gem-multiplier", "impact")}
        # Bounded by the NEXT cell's dispatch rather than by the end of the run. A cell's attributed window
        # runs to the end, and out there a stopped rider is reclaimed and the level restarts — relocations
        # this cell had nothing to do with, which would otherwise be reported under its name.
        after = [other.fired_at for other in log.watches
                 if other is not item and other.fired_at is not None
                 and item.fired_at is not None and other.fired_at > item.fired_at]
        # The cell's own banner, matched by the text the fixture gives it: its id. Absent on any run not
        # built with --hud-text, which is why its absence can never make a grade worse.
        banner_at = next((at for at, text, _ in log.banners if text == item.id), None)
        rows.append({
            "id": item.id,
            "question": item.question,
            "expect": item.expect,
            "grade": _grade(item.expect, state, banner_at),
            "bannerAt": banner_at,
            "paintGrade": _paint_grade(item),
            "slotGrade": _slot_grade(item, final_at),
            "rider": measured,
            "riderGrade": _rider_grade(item, measured),
            "riderJumps": _roster_jumps(log, item.fired_at, min(after) if after else None),
            "instanceName": item.instance_name,
            "entity": f"0x{item.entity:08x}",
            "verdict": state,
            "fired": item.fired,
            "crossed": item.crossed,
            "baselineNode": f"0x{item.baseline:08x}" if item.baseline else None,
            "firedAtSeconds": item.fired_at,
            "liveNode": f"0x{item.node:08x}" if item.node else None,
            "closestApproachM": round(item.closest / 100.0, 2) if item.closest < float("inf") else None,
            "closestAtSeconds": item.closest_at,
            "samples": item.samples,
            "probes": [{
                "label": probe.label,
                "onLiveNode": probe.node_offset is not None,
                "address": f"0x{probe.address:08x}",
                "baseline": None if probe.node_offset is not None else f"0x{probe.baseline:08x}",
                "observed": probe.changed_at is not None,
                "atSeconds": probe.changed_at,
                # Signed as well as raw: the flip node writes -1 into its applied-frame word when the
                # material carries no flip table, which is the diagnostic this exists to catch.
                "values": [_signed(value) for value in sorted(probe.values)][:8],
                # Where the word ENDED, which the sorted set above deliberately destroys.
                "last": _signed(probe.last),
                # ...and the order it got there in, which neither of the two above can reconstruct.
                "trace": [[at, _signed(value)] for at, value in probe.trace],
            } for probe in item.probes],
            # Only the candidates that MOVED, and the count of the ones that did not. The search over-collects
            # by design and most hits are the same address sitting in a table; a word that changes over the
            # window is the object doing something, and a report that listed all of them equally would bury
            # the one finding under its own noise.
            "late": None if not item.late else {
                "label": item.late["label"],
                # Never let a refused search read as a search that found nothing.
                "skipped": log.late_skipped,
                "candidates": len(item.late_found),
                "moved": [{
                    "address": f"0x{entry['address']:08x}",
                    "offsets": [f"+0x{offset:x}" for offset in item.late["offsets"]],
                    "words": [[at, [_signed(value) for value in values]] for at, values in entry["words"]],
                } for entry in item.late_found if _late_moved(entry)],
            },
        })
    # "Did the rider descend at all" is the first question any empty result raises, so the answer travels
    # with the verdicts rather than being reconstructed from them.
    path = log.rider_path
    travelled = sum(_distance(path[i - 1][1:4], path[i][1:4]) for i in range(1, len(path)))
    # Deepest point reached, not end-minus-start: a run long enough to cover the fixture is also long enough
    # to finish and restart, and the difference across a lap boundary reads as a rider that climbed.
    # Index 3 is raw Z, the VERTICAL axis in native space — a path entry is (seconds, x, y, z), so the
    # obvious-looking [2] is one of the two horizontal axes.
    descended = (path[0][3] - min(point[3] for point in path)) if path else 0.0
    grades = ([row["grade"] for row in rows] + [row["paintGrade"] for row in rows]
              + [row["riderGrade"] for row in rows] + [row["slotGrade"] for row in rows])
    return {
        "kind": "ssx-tricky-autotest-run",
        # The window, in the unit it was actually measured in. `seconds` is derived from it and is game time,
        # not host time -- two runs of the same fixture report the same number however the host was loaded.
        "frames": log.frames,
        "seconds": round(log.frames / GAME_HZ, 2),
        # Host time, and the ratio of the two. Nothing is graded against either; they are here so a run that
        # emulated at half speed says so out loud instead of looking like a normal pass.
        "wallSeconds": round(log.wall_seconds, 2),
        "emulationSpeed": (round(log.frames / GAME_HZ / log.wall_seconds, 2)
                           if log.wall_seconds > 0 else None),
        # Samples per second of GAME time -- the density every probe and every rider signal was read at, and
        # the one number that has to be checked before a fast run is believed. The sampler holds its rate by
        # retuning its sleep from the measured emulation speed, so at 1x it lands near the requested 20; drive
        # the emulator faster than the host can feed PINE and it falls, and everything short-lived starts
        # getting missed. A run that says 19.3 covered the course as densely as any other; one that says 6 did
        # not, whatever its verdicts look like.
        "samplesPerGameSecond": (round(len(log.rider_path) / (log.frames / GAME_HZ), 1)
                                 if log.frames else None),
        "ended": log.ended,
        "lastFrame": log.last_frame,
        "unresolved": log.unresolved,
        "regressions": sum(1 for grade in grades if grade == "REGRESSION"),
        "inconclusive": sum(1 for grade in grades if grade in ("inconclusive", "unobservable")),
        "open": sum(1 for grade in grades if grade == "open"),
        "rider": {
            "samples": len(path),
            "startRaw": [round(value, 1) for value in path[0][1:4]] if path else None,
            "endRaw": [round(value, 1) for value in path[-1][1:4]] if path else None,
            "travelledM": round(travelled / 100.0, 1),
            "maxDescentM": round(descended / 100.0, 1),
            "peakRiseMps": round(max(point[6] for point in path) / 100.0, 2) if path else None,
            # `laps_remaining` decides on its own whether the lap boost does anything at all, and it is
            # seeded from the COURSE rather than authored, so it is reported for every run rather than
            # inferred from one cell's behaviour.
            "lapsRemaining": sorted(log.laps),
            "motionStates": sorted(log.motion),
            # HUD message banners the engine posted, in order. On a `--hud-text` run this is a second
            # witness to dispatch that does not share a mechanism with the live-node slot every cell is
            # graded on: the banner is posted from the effect chain itself, so a cell that shows one ran its
            # chain past the debounce whatever the slot read said.
            "banners": [{"at": at, "text": text,
                         "colour": [round(c, 3) for c in colour] if colour else None}
                        for at, text, colour in log.banners],
            # What the driven front end actually landed in. Four scoring opcodes do nothing outside {3, 5},
            # so this decides on its own whether a cell built on one of them was ever able to answer.
            "gameMode": sorted(log.game_mode),
            # The rider's own address, so a probe that reads a boarder POINTER out of a node has something to
            # be equal to. Without it such a probe reports a plausible heap address and settles nothing.
            "boarder": f"0x{log.boarder:08x}" if log.boarder else None,
            # The whole field, and `null` rather than a guess when the read could not prove itself. How many
            # riders a mode puts on the mountain stops being something to know about the game and becomes
            # something the run says; and an opcode handed a boarder that is not the local human can be
            # matched against this list instead of reported as an anonymous pointer.
            "riderCount": len(log.roster) if log.roster is not None else None,
            "roster": ([f"0x{rider:08x}{' (local)' if rider == log.boarder else ''}"
                        for rider in log.roster] if log.roster is not None else None),
            # The offset the manager was found at, so a run can be compared with the next one. Stable across
            # runs means it is a constant waiting to be written down; unstable means the scan is matching
            # something incidental and the whole reading needs re-earning.
            "rosterAt": f"0x{log.roster_at:08x}" if log.roster_at is not None else None,
        },
        # The whole sampled timeline, one row per sample:
        #   [seconds, x, y, z, vx, vy, vz, boostRequest, trickWindow, dig, lean, slipX, slipY, slipZ, motion,
        #    gemMultiplier]
        # Position/velocity in raw centimetres; dig/lean/slip are the RAW board-audio signal sources
        # (`Dig` = abs(dig), `Lean` = abs(lean * 127), the heading vector at +0x320 whose lateral residual
        # against the velocity is `Slip`) [research/extracted-data.md "Board-snow audio mapping"]; motion is
        # the raw +0x424 state, so an analysis can keep only the steady ground samples; the multiplier is
        # `TrickScoreState+0x28` and rests at 1.0. Serialized on every
        # run because a question about rider motion or ride feel keeps being asked of runs that had already
        # happened; `tools/autotest/audio_signals.py` is the first consumer, bucketing these by the
        # AUTOTEST4 plan's surface strips.
        #
        # New columns APPEND. Two consumers index the motion state at 14 and one guards on `len(row) < 15`,
        # so a row grows at the tail and older reports stay readable by the same code.
        "riderPath": [[round(point[0], 3)] + [round(value, 1) for value in point[1:7]]
                      + [round(value, 3) for value in point[7:14]]
                      + [int(point[14])] + [round(value, 3) for value in point[15:]] for point in path],
        # The whole field's positions, `[seconds, x0, y0, z0, x1, ...]` in roster order. Kept raw for the same
        # reason `riderPath` is, and the reason is not hypothetical: the derived `jump` column read 1.43 m
        # through a rider being moved 132.9 m, and what caught it was replaying the raw samples out of a saved
        # run. A derived signal can be wrong while every input to it is right, and the samples are the appeal.
        "rosterPath": [[point[0]] + [round(value, 1) for value in point[1:]] for point in log.roster_path],
        "variants": rows,
    }


def print_report(doc: dict) -> None:
    rider = doc.get("rider") or {}
    speed = doc.get("emulationSpeed")
    density = doc.get("samplesPerGameSecond")
    print(f"\nwindow: {doc.get('frames', 0)} frames ({doc.get('seconds', 0)}s of game) in "
          f"{doc.get('wallSeconds', 0)}s of host"
          + (f", {speed}x realtime" if speed else "")
          + (f", sampled {density}/game-second" if density else ""))
    ended = doc.get("ended", "complete")
    if ended in FAULT_ENDS:
        # Never silent: every cell the rider had not reached yet is about to grade as inconclusive, and the
        # reason is up here rather than in whatever those cells look like.
        print(f"        ENDED EARLY ({ended}) - cells past this point are untested, not failed")
    elif ended == "restarted":
        # In a showoff run nothing crosses a finish line: the mode's own clock expires (120 s on GARI,
        # [Trailmap: 390-showoff-clock]) and the engine ends the run for everyone and returns the rider to
        # the gate. Same end state as finishing a race, so the sampler cannot tell them apart from the clock
        # going backwards alone -- but "ended at the finish" was the wrong story for the mode this rides.
        print("        the run ended and the engine put the rider back (a race finishing, or a showoff "
              "clock expiring — both reset the level clock)")
    print(f"rider: {rider.get('samples', 0)} sample(s), travelled {rider.get('travelledM', 0)} m, "
          f"max descent {rider.get('maxDescentM', 0)} m, peak rise {rider.get('peakRiseMps')} m/s")
    print(f"       laps_remaining {rider.get('lapsRemaining')}, motion states {rider.get('motionStates')}"
          + (f", game mode {rider['gameMode']}" if rider.get("gameMode") else "")
          + (f", boarder {rider['boarder']}" if rider.get("boarder") else ""))
    # How many riders were actually on the mountain. Printed even when it is 1, because "this mode is solo"
    # is exactly the claim worth having in writing, and printed as UNREAD rather than omitted when the probe
    # could not prove itself -- a missing line reads like a field of one.
    banners = rider.get("banners") or []
    if banners:
        print(f"       hud messages: {len(banners)} posted — "
              + ", ".join(f"{item['text']}@{item['at']}s" for item in banners[:8])
              + (f", +{len(banners) - 8} more" if len(banners) > 8 else ""))
    if rider.get("riderCount") is not None:
        print(f"       riders on the mountain: {rider['riderCount']} at {rider.get('rosterAt')}"
              f" — {', '.join(rider['roster'])}")
    else:
        print("       riders on the mountain: UNREAD (no candidate base proved itself)")
    print(f"\n{'variant':24s} {'grade':13s} {'verdict':24s} {'closest':>9s}  {'at':>7s}")
    print("-" * 82)
    for row in doc["variants"]:
        closest = f"{row['closestApproachM']:.1f} m" if row["closestApproachM"] is not None else "-"
        at = f"{row['firedAtSeconds']:.2f}s" if row["firedAtSeconds"] is not None else "-"
        paint = row.get("paintGrade", "n/a")
        rider_grade = row.get("riderGrade", "n/a")
        # Only the signals that actually moved: four columns of ~0 on every gate would bury the one cell that
        # did something to the player.
        #
        # `speed` needs its own floor rather than the shared one. Every other signal rests at zero, so "not
        # zero" IS the news; peak speed rests at whatever the rider was already carrying, so printing it on
        # the same rule would put a ~20 m/s column on every fired row and bury the rows that matter. The
        # default cap is the line worth crossing — above it, something raised the rider past ordinary course
        # speed, which is the whole reason the signal is read [Trailmap: 360-cap].
        moved = " ".join(f"{name}:{value}" for name, value in (row.get("rider") or {}).items()
                         if value is not None
                         and (abs(value) > SPEED_CAP_MPS if name == "speed" else abs(value) > 0.05))
        slot = row.get("slotGrade", "n/a")
        # A pass the SLOT did not see is called out rather than blended in: it is a pass on the chain's own
        # evidence, and a cell that keeps needing it is saying something about the sampler worth reading.
        rescued = (row.get("bannerAt") is not None and row.get("firedAtSeconds") is None
                   and row.get("expect") == "dispatch")
        print(f"{row['id']:24s} {row.get('grade', 'open'):13s} {row['verdict']:24s} {closest:>9s}  {at:>7s}"
              + (f"   banner@{row['bannerAt']:.2f}s" if rescued else "")
              + (f"   paint:{paint}" if paint != "n/a" else "")
              + (f"   slot:{slot}" if slot != "n/a" else "")
              + (f"   {moved}" if moved else "")
              # Only when somebody was RELOCATED, so this stays off every ordinary row. The local flag is the
              # whole reading: "rider 3 (local)" and "rider 1" are opposite answers to which boarder an
              # opcode was handed, and the distinction is invisible in every other column.
              + ("" if not row.get("riderJumps") else
                 "   warped: " + ", ".join(
                     f"rider {jump['rider']}{' (local)' if jump['local'] else ''} {jump['m']} m @{jump['at']}s"
                     for jump in row["riderJumps"]))
              + ("" if not row.get("late") else
                 f"   {row['late']['label']}: SEARCH SKIPPED ({row['late']['skipped']})"
                 if row["late"].get("skipped") else
                 f"   {row['late']['label']}: {len(row['late']['moved'])} moving"
                 f" of {row['late']['candidates']} candidate(s)")
              + (f" rider:{rider_grade}" if rider_grade != "n/a" else ""))
        for probe in row.get("probes") or []:
            if not probe["observed"]:
                print(f"{'':24s}   {probe['label']}: never observed")
                continue
            print(f"{'':24s}   {probe['label']}: {', '.join(probe['values'])}"
                  f"  (from {probe['atSeconds']:.2f}s, ended {probe['last']})")
            # The ordered story, for the words where WHEN matters as much as WHICH.
            if len(probe.get("trace") or []) > 1:
                print(f"{'':24s}     " + " -> ".join(f"{value}@{at:.2f}s" for at, value in probe["trace"]))
    print(f"\n{doc.get('regressions', 0)} regression(s), {doc.get('inconclusive', 0)} inconclusive, "
          f"{doc.get('open', 0)} still open")
    if doc["unresolved"]:
        # Not a verdict of any kind: these cells were never watched, because the harness could not confirm
        # which live entity they became.
        print(f"\nunresolved (no confirmed entity): {', '.join(doc['unresolved'])}")


def main(argv: list[str] | None = None) -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("plan", type=Path, help="autotest-plan.json from the export")
    parser.add_argument("--frames", type=int, default=round(90.0 * GAME_HZ),
                        help="window length in simulation ticks (60 = one second of game time)")
    parser.add_argument("--pine-slot", type=int, default=PINE_PORT,
                        help="which emulator to watch; PCSX2's PINE slot is also its TCP port")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)

    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    pine = Pine(args.pine_slot)
    log = attach(pine, plan["entries"])
    print(f"attached to {len(log.watches)}/{len(plan['entries'])} variant(s)")
    watch(pine, log, args.frames)
    doc = report(log)
    doc["plan"] = str(args.plan)
    print_report(doc)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
        print(f"\nsaved -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
