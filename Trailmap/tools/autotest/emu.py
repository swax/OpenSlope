#!/usr/bin/env python3
"""PCSX2 lifecycle for the auto-test harness: launch an ISO, wait for the level, shut down.

The harness rebuilds the ISO on every iteration, so the emulator is started fresh each time rather than
reused -- PCSX2 mounts the disc at launch and PINE has no remount command.

Getting from the EA logo into a course is `pad_drive.py`'s job: it mashes CROSS into the decoded controller
state until a level comes up. That handles the whole front end from a cold boot with no human and no
savestate -- and a savestate would not have worked anyway, since one restores all of EE RAM and therefore
restores the level it was taken in, which is the one thing a harness that rebuilds the map must never do.

The attract-mode demo is a level too, and this deliberately does not stop for it: `read_level_state` only
answers once the boarder is the LOCAL HUMAN (`+0x41C == 1`), which the demo's AI rider never is.

An emulator is started under the PINE slot's queue (`slot_lock.py`) and the ticket is held until it is shut
down, so a second harness on the same machine waits its turn instead of resetting the first one's socket
partway through a pass. Nothing has to ask for that -- it comes with `launch`.

  python tools/autotest/emu.py boot <iso>   launch, mash into a course, report the rider
  python tools/autotest/emu.py status       report what a running PCSX2 is doing
"""

from __future__ import annotations

import argparse
import contextlib
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "instrumentation"))
from pine_hooks import Pine  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "patches"))
from noclip_patch import TARGETS as NOCLIP_TARGETS  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slot_lock  # noqa: E402

PINE_PORT = 28011
#: Looked up on PATH when neither `--pcsx2` nor `SSX_PCSX2_EXE` names one. Point either at the binary
#: for a portable install that is not on PATH.
DEFAULT_PCSX2 = "pcsx2-qt.exe"


class ModeMismatch(RuntimeError):
    """The front end committed to a mode the run did not ask for.

    Its own class because it is the one boot failure worth RETRYING rather than reporting. Steering the front
    end is host-timed tapping against a menu that runs in game time, so where a press lands depends on how
    fast the host got the disc read that boot -- and a second build running on the same machine is enough to
    move it by an entry. The prelude is not wrong when this happens; the boot was slow. `run.py` boots again.
    """

#: Simulation ticks per second [Trailmap: 002-timestep]. Every window and timestamp in
#: this harness is measured in the game's own frames and converted here, so what a run covers is a property
#: of the run rather than of how fast the host happened to emulate it.
#:
#: The constant is self-checking rather than assumed: a run reports frames-elapsed over wall-seconds against
#: this rate as `emulationSpeed`, which sits at ~1.0 on a healthy full-speed pass. A systematically wrong
#: rate here would show up as every run reporting the same wrong ratio.
GAME_HZ = 60.0

# The chain from the singleton to the rider [Trailmap: 150-logic]. Every link is checked because
# SharedUpdate runs on half-built worlds during load and teardown. The head of it is the one
# ABSOLUTE address in the chain, so it lives on the build record below; everything from
# `REGISTRY_WORLD` down is a class offset and is identical on both boot executables.
REGISTRY_WORLD = 0x730
WORLD_CLOCK = 0x1C
WORLD_BOARDER = 0xA4
CLOCK_FRAME = 0x18
BOARDER_POSITION = 0x140
BOARDER_LOCAL_HUMAN = 0x41C


# The rider words a cell can be graded against, all off the same boarder pointer the position comes from
# [Trailmap: 360-speed-and-boost]. They ride in the SAME PINE packet as the position, so "where the rider was"
# and "what the rider was doing" are one instant rather than a round trip apart.
#
#   +0x150  carried_velocity_vector — the vec4 every boost writes into. This is the only word that separates
#           a boost node that was BUILT from one that PUSHED, and without it "did the player get boosted"
#           is not answerable from the host at all.
#   +0x114  laps_remaining (u16) — the lap boost's whole gate. Seeded 4 on Megaplex and 0 everywhere else,
#           so on any other course the lap boost locks out on its first tick [Trailmap: 390-lap-field].
#   +0x424  raw motion state — the lap boost drives two dedicated states, and a state change is how a
#           scripted ride shows up when the velocity write is masked by the ride's own damping.
#   +0x134  boost_amount_request — what a MainType-17 speed pad writes, as `max(field, authored)`. It decays
#           1/60 per tick, so an authored 5.0 is legible for ~5 s: far longer than a 20 Hz sampler needs.
#   +0x138  boost_flag_window — the same shape for MainType 18's trick window. Neither node writes velocity,
#           so these two fields are the ONLY place a pad's effect exists.
BOARDER_VELOCITY = 0x150
BOARDER_LAPS = 0x114
BOARDER_MOTION = 0x424
BOARDER_BOOST_REQUEST = 0x134
BOARDER_TRICK_WINDOW = 0x138

# The ACTIVE GEM MULTIPLIER, and the word that makes the scoring family testable at all.
#
# Every rider owns a trick-score sub-object at `boarder+0x5820`; `S+0x28` holds the multiplier a gem set,
# which `TrickScore_ApplyGemMultiplier` writes as `max(current, gemValue)` — never a sum
# [Trailmap: 390-pickups-and-race, research/scoring.md]. It is the only place a MainType-14 node leaves a
# mark: the node writes nothing on its host, and the pickup chime it also plays is OUTSIDE the mode gate, so
# a gem in the wrong mode is fully audible and completely inert. Reading the chime as evidence is exactly the
# mistake this field exists to make unnecessary.
#
# Its rest value is a documented 1.0, which makes the reading self-checking: every cell on a course that is
# not a gem must read 1.0, so an offset that has drifted shows up as a column of something else rather than
# as a cell that quietly fails. `TrickScore_ResetCombo` puts it back to 1.0 on the next land or bail, so the
# multiplier is live for one banked trick — read the PEAK over a cell's window, not the end state.
BOARDER_TRICK_SCORE = 0x5820
TRICK_SCORE_MULTIPLIER = 0x28
BOARDER_GEM_MULTIPLIER = BOARDER_TRICK_SCORE + TRICK_SCORE_MULTIPLIER

# The three BOARD-AUDIO signal sources, off the same boarder [research/extracted-data.md "Board-snow audio
# mapping"]. These are the whole input to the SNOW.INF volume/bend programs, and the AUTOTEST4 instrument
# fixture exists to measure what they read while riding each surface family — every port shaping constant is
# ear-calibrated until these are numbers.
#
#   +0x160  the word `Dig` reads: the engine takes abs() of this f32 (edge bite / carving force).
#   +0x214  the word `Lean` reads: the engine takes abs(value * 127.0), so the raw field is ~0..0.905.
#   +0x320  the vector `Slip` projects against the +0x150 motion vector. Recorded raw (three floats) beside
#           the velocity that is already in the packet, so the projection is computed offline where the
#           formula can be revised without re-riding.
BOARDER_DIG = 0x160
BOARDER_LEAN = 0x214
BOARDER_SLIP_VECTOR = 0x320

#: `GameModeGlobal`, and it is not a boarder field — it is one word of the whole session, which is why it is
#: read here rather than probed per cell. Four rider-acting effect opcodes refuse to do anything unless it
#: holds 3 or 5: main types 6 and 15 (boost-meter fill), 14 (gem multiplier) and 16 (time bonus) each open
#: with the same two compares against it and return early otherwise [Trailmap: 150-logic §mode-gate].
#:
#: So a cell built on any of those four is untestable until this word is known, and it cannot be inferred from
#: the mode the fixture MEANT to ride: what the front end lands on is whatever mashing CROSS through the menus
#: reaches. Reading it turns four cells' worth of "presumably gated out" into a fact, in one word per sample.
#:
#: Both addresses read off the same five accessors in their own build (`lui v0,0x33 / lw a0,-3956(v0)` on PAL,
#: `-8564` on NTSC-U), rather than one being shifted from the other.
GAME_MODE_GLOBAL = {"SLES_505.45": 0x0032F08C, "SLUS_203.26": 0x0032DE8C}


@dataclass(frozen=True)
class Build:
    """The two absolute addresses this harness reads, per boot executable.

    Everything else it touches is a class offset and is the same on both discs, which is why this
    record is two words long rather than a second copy of the constants above.

    `registry_ptr` is taken from the noclip patch's table rather than restated, because that table
    is where it is already maintained and a second copy would be a second thing to keep right.
    """
    name: str
    registry_ptr: int
    game_mode_global: int


#: Keyed by the disc serial PCSX2 reports, which is what the harness has to go on: the emulator is
#: handed an ISO and asked what it is running, and a repack keeps the original serial.
BUILDS = {
    "SLES-50545": Build("SLES_505.45", NOCLIP_TARGETS["SLES_505.45"].registry_ptr,
                        GAME_MODE_GLOBAL["SLES_505.45"]),
    "SLUS-20326": Build("SLUS_203.26", NOCLIP_TARGETS["SLUS_203.26"].registry_ptr,
                        GAME_MODE_GLOBAL["SLUS_203.26"]),
}


def detect_build(pine: Pine) -> Build:
    """Which disc this emulator is running, cached for the life of the connection.

    Asked once and remembered, because it cannot change under a running emulator: PINE has no
    "swap disc" and `launch` starts a fresh process per ride.

    Getting this wrong is loud rather than subtle, which is the reason it is safe to rest on the
    serial alone. A registry pointer from the other build reads a word that is not a pointer to a
    world, so every link in `read_level_state` fails and the ride reports that no level ever came
    up -- rather than reporting plausible numbers off the wrong object.
    """
    cached = getattr(pine, "_ssx_build", None)
    if cached is not None:
        return cached
    serial = pine.game_id().strip().upper()
    build = BUILDS.get(serial)
    if build is None:
        raise RuntimeError(
            f"PCSX2 is running disc {serial!r}, which this harness has no address set for "
            f"(known: {', '.join(sorted(BUILDS))}). Riding it would read the wrong words.")
    pine._ssx_build = build
    return build

#: What each value of that enum IS, read off the engine's own 10-entry jump table at 0x00365730, which maps
#: it to the mode-name strings `FreerideMode` / `RaceMode` / `ShowoffMode` [Trailmap: 395-ai-riders]. It
#: agrees with the independently-measured gem gate, which had already established 3 and 5 as showoff.
#:
#: SHOWOFF is the mode this harness rides, and it wins on both counts at once. It is SOLO -- the roster probe
#: reads 1 rider against race's 6 -- which matters because a collision chain acts on the boarder its effect
#: thread was handed rather than on the rider who touched the prop, so an empty mountain has nobody else to
#: hand it to. And it is the only mode in which four opcodes do anything at all: main types 6 and 15
#: (boost-meter fill), 14 (gem multiplier) and 16 (time bonus) each test this word for {3, 5} and return
#: early otherwise.
#:
#: FREERIDE is named here for completeness and is NOT ridable by this harness. It is unreachable from the
#: front end the driver can steer (see MODE_PRELUDES), and it would cost coverage even if it were reachable,
#: because it is on the losing side of that same {3, 5} test -- freeride is solo AND has those four opcodes
#: dead, where showoff is solo with them live. There is no question showoff cannot answer that freeride can.
GAME_MODES = {
    "race": (0, 2, 4, 7, 9),
    "freeride": (1, 6, 8),
    "showoff": (3, 5),
}


#: The front-end prelude that selects each mode, PER DISC, as calibrated by `modescan` from a cold boot.
#:
#: It is per disc because the count is a duration (see below) and the two builds do not run their front ends
#: at the same rate: PAL presents at 50 Hz and NTSC-U at 60, so the same schedule of host-timed taps covers a
#: different amount of menu. A number carried across from the other region is not a starting point -- it is
#: the failure this table exists to make impossible to reach by accident.
#:
#: `race` needs none -- it is what mashing CROSS takes by default -- and that is the only reason the harness
#: worked without any of this for so long. It is also why every rider-acting cell was measured on a mountain
#: with five other candidates for its effects.
#:
#: THESE ARE ONLY VALID AT 1x. The count is really a duration: the front end advances in game time while the
#: tapping is host-timed, so a scalar changes where any tap index lands, and recalibrating does not rescue it
#: -- at 3x each press covers three times as much menu, so ordinary boot-to-boot load variance outweighs a
#: whole entry. Measured: the 1x prelude selected showoff first time; the recalibrated 3x one landed in race
#: twice. `run.py` refuses the combination rather than letting it be discovered again.
#:
#: THERE IS NO FREERIDE ENTRY, and that is a measured dead end rather than a gap waiting to be filled. The
#: top-level menu is a THREE-entry ring: from the default, one DOWN lands on showoff (mode 3), two on race
#: (mode 7), three back at the default (mode 2), and UP from the default does not move at all. The engine's
#: menu dispatcher `sub_0029b458` has five branches off the table at 0x003b3d90 -- screens 8, 9 and 12 are
#: the three that ring visits, and both freeride branches are screens 10 (mode 1) and 11 (mode 6), which it
#: never reaches. Steering to freeride would mean driving a submenu, not lengthening a prelude. Nothing wants
#: it: see GAME_MODES for why showoff dominates freeride for every question this harness asks.
#: THE TAP COUNT DRIFTS WITH HOST LOAD, so treat a run of ModeMismatch as a recalibration rather than as bad
#: luck. `cross:76` rode clean all morning and then missed EIGHT boots in a row, across two batches, once the
#: machine got busier; `modescan --taps 130` put the commit at tap 78 rather than 77, one press later. That is
#: the failure being a duration in disguise: a slower host advances less menu per tap, so the whole schedule
#: slides. `run.py` reboots and retries MODE_RETRIES times, which absorbs the flaky case but not a shift.
#:
#: AND DO NOT SET THIS FROM THE SCAN'S COMMIT INDEX -- that is what a shift looks like from the inside, and it
#: has now cost two batches. `cross:77` was derived that way (commit at tap 78, so the DOWN goes at 77) and
#: MISSED FOUR BOOTS OUT OF FOUR, while `cross:76` -- one press earlier, the number that predates it -- took
#: showoff on the first try. The scan and the prelude driver share `tap()` and still do not agree, and the
#: disagreement has a direction: the working prelude sits TWO below the scanned commit, not one.
#:
#: So verify a candidate rather than deriving it. `modescan --menu "cross:N,down:1"` reports which entry that
#: exact prelude selects, in one boot and with no ISO build behind it -- against three boots and ~10 minutes
#: of packing to find out the same thing from a ride:
#:
#:     python tools/autotest/emu.py modescan <iso> --menu "cross:76,down:1"
#:       tap 2: GameModeGlobal 0 -> 3 (showoff)      <- this prelude works
#:       ...the level came up but the mode word never moved      <- this one does not
MODE_PRELUDES = {
    "SLES_505.45": {
        "race": None,
        "showoff": "cross:76,down:1",
    },
    "SLUS_203.26": {
        "race": None,
        # Verified rather than derived, and the WHOLE WINDOW was measured rather than the first
        # number that worked: the scan put the commit at tap 69, and 66 lands in race while 67 and
        # 68 both take showoff. So the window is two presses wide and 68 is its upper edge -- one
        # further from the known failure, and what the scan's own advice pointed at.
        #
        # The NINE-tap gap from PAL's 78 is the reason this table is per build. It is far wider than
        # the drift MODE_RETRIES absorbs, so the PAL number would have missed every boot rather than
        # some of them, and it would have missed them by landing in race and being refused.
        "showoff": "cross:68,down:1",
    },
}


def mode_prelude(build: str, mode: str) -> str | None:
    """The prelude that selects `mode` on `build`, or a refusal naming what to run.

    A MISSING entry and a `None` entry mean different things and must not collapse into each other:
    `None` is "this mode needs no steering", while missing is "nobody has calibrated this disc for
    this mode". Falling back to no prelude for the second would ride whatever the front end defaults
    to and report it under the mode that was asked for -- which is exactly the wrongly-attributed
    page of results the `--mode` guard exists to prevent, arrived at from the other direction.
    """
    table = MODE_PRELUDES.get(build)
    if table is None:
        raise SystemExit(f"no front-end calibration for build {build}")
    if mode not in table:
        raise SystemExit(
            f"{build} has no calibrated prelude for `{mode}` (it has: "
            f"{', '.join(sorted(table))}). Calibrate one against that disc, which costs one boot:\n"
            f"    python tools/autotest/emu.py modescan <iso> --taps 130\n"
            f"then confirm the candidate before trusting it:\n"
            f"    python tools/autotest/emu.py modescan <iso> --menu \"cross:N,down:1\"")
    return table[mode]


def mode_name(value: int) -> str:
    for name, values in GAME_MODES.items():
        if value in values:
            return name
    return f"mode-{value}"


def read_game_mode(pine: Pine) -> int:
    """The mode enum, readable with or without a level -- it is a session word, not a world field."""
    return pine.r32(detect_build(pine).game_mode_global)


def pcsx2_exe() -> Path:
    """Where the emulator is: `--pcsx2` / `SSX_PCSX2_EXE` if either names it, otherwise PATH.

    The PATH lookup happens HERE rather than being left to the caller. A bare `pcsx2-qt.exe` only means
    "search PATH" to something that actually searches, and `Path.exists()` does not -- it would resolve
    against the working directory and report the emulator missing on a machine that has it installed.
    Returning the found path also keeps `pcsx2_ini()` honest, since it reads the config beside the binary.
    """
    named = os.environ.get("SSX_PCSX2_EXE", "").strip()
    if named:
        return Path(named)
    found = shutil.which(DEFAULT_PCSX2)
    return Path(found) if found else Path(DEFAULT_PCSX2)


def pcsx2_ini() -> Path | None:
    """PCSX2's own config file, which is the only way to reach its speed limiter.

    Not reachable any other way, which is why this exists rather than a flag. PINE's opcode set is reads,
    writes, save/load state and four strings -- no speed control. `pcsx2-qt -help` on 2.6.3 lists no
    `-setting` override. And the Tab key is a HOTKEY: it needs a focused window, and it applies
    `[Framerate] TurboScalar`, which ships at 2. So a headless run changes the file or runs at 1x.
    """
    named = os.environ.get("SSX_PCSX2_INI", "").strip()
    if named:
        return Path(named)
    home = Path.home()
    for candidate in (home / "Documents" / "PCSX2" / "inis" / "PCSX2.ini",
                      home / "OneDrive" / "Documents" / "PCSX2" / "inis" / "PCSX2.ini",
                      pcsx2_exe().parent / "inis" / "PCSX2.ini"):
        if candidate.exists():
            return candidate
    return None


def _ini_set(text: str, section: str, key: str, value: str) -> tuple[str, str | None]:
    """Rewrite one `key` inside one `[section]`, returning the new text and the value replaced.

    Section-aware because the keys are not unique across the file, and a global search-and-replace on a name
    like `VsyncEnable` is the kind of edit that works until the day it silently changes something else in
    somebody's emulator config.
    """
    lines = text.splitlines(keepends=True)
    inside = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("["):
            inside = stripped == f"[{section}]"
            continue
        if not inside or "=" not in line:
            continue
        name, _, current = line.partition("=")
        if name.strip() != key:
            continue
        lines[index] = f"{name}= {value}\n" if name.endswith(" ") else f"{name} = {value}\n"
        return "".join(lines), current.strip()
    return text, None


@contextlib.contextmanager
def turbo(scalar: float):
    """Run PCSX2 at `scalar` x real time for the duration of the block, then put the config back.

    THE MEASUREMENT DOES NOT CHANGE, and that is what makes this safe to use for evidence rather than only
    for convenience. Every window in this harness is counted in the GAME's own frames and the sampler retunes
    its sleep from the emulation speed it measures, so a faster host covers the same course with the same
    density -- it is the same instruction stream, observed more often per wall-clock second.

    What CAN change is whether the sampler keeps up. Each sample costs a handful of PINE round trips, and at
    4x it needs four times as many per second to hold its rate in game time. That failure is not silent: the
    report carries `samplesPerGameSecond`, which sits near the requested 20 on a healthy pass and drops when
    the host cannot feed it. Read it on any turbo run before reading anything else.

    Restored in a `finally`, and the config belongs to the user rather than to this harness -- so a scalar is
    never left behind by an ordinary failure. A hard kill of the whole process is the case that can, and the
    restore line printed on entry is what makes that recoverable by hand.
    """
    ini = pcsx2_ini()
    if ini is None or scalar == 1.0:
        if scalar != 1.0:
            print(f"  no PCSX2.ini found, so --turbo {scalar} does nothing; set SSX_PCSX2_INI")
        yield
        return
    original = ini.read_text(encoding="utf-8")
    patched, was_scalar = _ini_set(original, "Framerate", "NominalScalar", f"{scalar:g}")
    # Vsync would re-cap the presentation at the monitor's rate, which is the limiter this is trying to lift.
    patched, was_vsync = _ini_set(patched, "EmuCore/GS", "VsyncEnable", "false")
    print(f"  turbo {scalar:g}x: {ini} NominalScalar {was_scalar} -> {scalar:g}, VsyncEnable {was_vsync} -> false")
    ini.write_text(patched, encoding="utf-8")
    try:
        yield
    finally:
        ini.write_text(original, encoding="utf-8")


@contextlib.contextmanager
def pine_slot(port: int):
    """Make the PCSX2 this run starts listen on `port`, then put the config back.

    PINE's slot is read from `PCSX2.ini` at launch and has no command-line flag, so a harness asked to ride
    a non-default slot would otherwise connect to one port while the emulator it just started bound another.
    That is the whole reason `--pine-slot` existed and did not work: the error you get when the default slot
    is held even names it as the remedy.

    Written and restored exactly as `turbo` does, and for the same reason -- the config belongs to the user,
    so an ordinary failure never leaves a slot behind. Riding a second slot is what lets a run share a
    machine with a PCSX2 somebody opened by hand, instead of demanding they close it.
    """
    ini = pcsx2_ini()
    if ini is None or port == PINE_PORT:
        if port != PINE_PORT:
            print(f"  no PCSX2.ini found, so --pine-slot {port} cannot be applied; set SSX_PCSX2_INI")
        yield
        return
    original = ini.read_text(encoding="utf-8")
    patched, was_slot = _ini_set(original, "EmuCore", "PINESlot", str(port))
    if was_slot is None:
        # `_ini_set` rewrites keys and does not create them, so a name it cannot find writes nothing at
        # all: the emulator comes up on its own slot while the harness waits on another one, and the only
        # symptom is PINE never answering. Refusing here rather than proceeding is the difference between
        # a one-line fault and ninety seconds of a silent timeout. Note the exact section and key: PCSX2
        # does not call this `[Pine] Slot`, and looking for that name is how the failure gets in.
        raise RuntimeError(
            f"{ini} has no EmuCore/PINESlot to rewrite, so --pine-slot {port} cannot be applied. "
            "Set the slot once in PCSX2's settings so the key exists, or ride the default slot.")
    print(f"  pine slot: {ini} PINESlot {was_slot} -> {port}")
    ini.write_text(patched, encoding="utf-8")
    try:
        yield
    finally:
        ini.write_text(original, encoding="utf-8")


def pine_port_busy(port: int = PINE_PORT) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.4)
        return probe.connect_ex(("127.0.0.1", port)) == 0


@dataclass
class LevelState:
    world: int
    boarder: int
    frame: int
    position: tuple[float, float, float]
    #: Carried velocity in raw units per second (centimetres), same frame as `position`.
    velocity: tuple[float, float, float] = (0.0, 0.0, 0.0)
    #: `laps_remaining`. The low half of the word — the field is u16.
    laps: int = 0
    motion: int = 0
    #: The two pad-boost request fields, which are what MainType 17 and 18 exist to write.
    boost_request: float = 0.0
    trick_window: float = 0.0
    #: `GameModeGlobal`, the session-wide word four scoring opcodes gate themselves on.
    game_mode: int = 0
    #: The three board-audio signal sources, raw: `Dig` reads abs(dig), `Lean` reads abs(lean * 127), and
    #: `Slip` is a projection of `slip_vec` against `velocity` — computed offline, recorded raw.
    dig: float = 0.0
    lean: float = 0.0
    slip_vec: tuple[float, float, float] = (0.0, 0.0, 0.0)
    #: `TrickScoreState+0x28`, the active gem multiplier. Rests at 1.0, which is what makes it self-checking.
    gem_multiplier: float = 0.0


def read_level_state(pine: Pine) -> LevelState | None:
    """The live world/rider, or None while no level is up."""
    build = detect_build(pine)
    registry = pine.r32(build.registry_ptr)
    if not registry:
        return None
    world = pine.r32(registry + REGISTRY_WORLD)
    if not world:
        return None
    clock, boarder = pine.r32_many((world + WORLD_CLOCK, world + WORLD_BOARDER))
    if not clock or not boarder:
        return None
    if pine.r32(boarder + BOARDER_LOCAL_HUMAN) != 1:
        return None
    frame = pine.r32(clock + CLOCK_FRAME)
    # One packet: position, velocity and the two state words. Splitting these would let the rider move
    # between the read of where it was and the read of how fast it was going.
    words = pine.r32_many(
        [boarder + BOARDER_POSITION + axis * 4 for axis in range(3)]
        + [boarder + BOARDER_VELOCITY + axis * 4 for axis in range(3)]
        + [boarder + BOARDER_LAPS, boarder + BOARDER_MOTION,
           boarder + BOARDER_BOOST_REQUEST, boarder + BOARDER_TRICK_WINDOW, build.game_mode_global,
           boarder + BOARDER_DIG, boarder + BOARDER_LEAN]
        + [boarder + BOARDER_SLIP_VECTOR + axis * 4 for axis in range(3)]
        + [boarder + BOARDER_GEM_MULTIPLIER]
    )
    position = struct.unpack("<3f", struct.pack("<3I", *words[:3]))
    velocity = struct.unpack("<3f", struct.pack("<3I", *words[3:6]))
    boost, trick = struct.unpack("<2f", struct.pack("<2I", *words[8:10]))
    dig, lean = struct.unpack("<2f", struct.pack("<2I", *words[11:13]))
    slip_vec = struct.unpack("<3f", struct.pack("<3I", *words[13:16]))
    gem = struct.unpack("<f", struct.pack("<I", words[16]))[0]
    return LevelState(world, boarder, frame, position, velocity,
                      words[6] & 0xFFFF, words[7], boost, trick, words[10], dig, lean, slip_vec, gem)


#: How long to keep waiting for a PCSX2 nobody in the queue owns. The lock serialises every emulator this
#: harness starts, so a still-busy port after acquiring it means an instance started by hand or leaked by a
#: run that died between its terminate and its wait. Both clear in seconds; anything longer is a person's
#: emulator, and saying so beats queueing behind it silently.
PORT_CLEAR_TIMEOUT = 120.0


def launch(iso: Path, state_file: Path | None, fullscreen: bool = False,
           port: int = PINE_PORT) -> subprocess.Popen:
    """Start PCSX2 on `iso`, resuming `state_file` when one is given.

    Takes the slot's queue ticket first (`slot_lock`) and holds it until `shutdown` -- so two harnesses on one
    machine take turns instead of resetting each other's socket mid-pass. Every caller inherits that by
    calling this; there is nothing to opt into.
    """
    exe = pcsx2_exe()
    if not exe.exists():
        raise RuntimeError(f"PCSX2 not found: {exe}. Put {DEFAULT_PCSX2} on PATH, "
                           "or name the binary with --pcsx2 or SSX_PCSX2_EXE.")
    if not iso.exists():
        raise RuntimeError(f"ISO not found: {iso}")
    lock = slot_lock.SlotLock(port, label=iso.stem).acquire()
    try:
        deadline = time.monotonic() + PORT_CLEAR_TIMEOUT
        announced = False
        while pine_port_busy(port):
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"PINE port {port} is still in use after waiting {PORT_CLEAR_TIMEOUT:.0f}s, and no other "
                    f"run in the queue holds it. A PCSX2 started outside this harness owns the slot: close "
                    f"it, or ride with a different --pine-slot."
                )
            if not announced:
                print(f"  PINE port {port} is still busy though the queue is clear; waiting for it to close")
                announced = True
            time.sleep(1.0)
        args = [str(exe), "-batch", "-nogui", "-fastboot"]
        args.append("-fullscreen" if fullscreen else "-nofullscreen")
        if state_file is not None:
            if not state_file.exists():
                raise RuntimeError(f"savestate not found: {state_file}")
            args += ["-statefile", str(state_file)]
        args += ["--", str(iso)]
        process = subprocess.Popen(args)
    except BaseException:
        lock.release()
        raise
    # Rides on the handle rather than in a table keyed by pid, so the claim lives exactly as long as the
    # object the caller will hand back to `shutdown`.
    process.ssx_slot_lock = lock
    return process


def wait_for_pine(process: subprocess.Popen, timeout: float = 90.0, port: int = PINE_PORT) -> Pine:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"PCSX2 exited during boot with code {process.returncode}")
        try:
            return Pine(port)
        except OSError as error:
            last = error
            time.sleep(0.5)
    raise RuntimeError(f"PINE did not answer on port {port} within {timeout:.0f}s ({last})")


def wait_for_game(pine: Pine, timeout: float = 120.0) -> str:
    """Block until PCSX2 can name the disc it booted.

    PINE answers as soon as the emulator core is up, which is well before the game is. Asking for the ID
    then returns a hard error rather than an empty string, so this is a retry loop and not a null check.
    """
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        try:
            game_id = pine.game_id().strip()
            if game_id:
                return game_id
        except (RuntimeError, OSError) as error:
            last = str(error)
        time.sleep(0.5)
    raise RuntimeError(f"PCSX2 never identified the disc within {timeout:.0f}s ({last})")


def wait_for_runtime(pine: Pine, timeout: float = 120.0) -> int:
    """Block until the game's singleton exists — the point past which its code is settled.

    Nothing may be written into the executable's image before this. The disc ID arrives while PCSX2 is still
    streaming the ELF, and site A reads its stock words a beat before the loader has finished writing the
    rest of the image; a cave installed in that window is overwritten by the tail of the load, and the hook
    then jumps into whatever the loader put there. That is a hard emulator crash, and it is what this exists
    to prevent. Measured on a cold boot: site A settles ~3 s in, the registry ~6 s in.
    """
    deadline = time.monotonic() + timeout
    registry_ptr = detect_build(pine).registry_ptr
    while time.monotonic() < deadline:
        registry = pine.r32(registry_ptr)
        if registry:
            return registry
        time.sleep(0.25)
    raise RuntimeError(f"the game runtime never came up within {timeout:.0f}s")


def wait_for_level(pine: Pine, timeout: float = 180.0, settle_frames: int = 30) -> LevelState:
    """Block until a level is up AND its clock has advanced.

    The clock check is not decoration: the pointer chain is briefly complete while the level is still being
    built, and a harness that started driving there would read entity fields that the loader has not
    finished writing.
    """
    deadline = time.monotonic() + timeout
    first: LevelState | None = None
    while time.monotonic() < deadline:
        state = read_level_state(pine)
        if state is not None:
            if first is None:
                first = state
            elif state.frame >= first.frame + settle_frames:
                return state
        else:
            first = None
        time.sleep(0.25)
    raise RuntimeError(f"no level came up within {timeout:.0f}s")


def _gap_m(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return sum((a[axis] - b[axis]) ** 2 for axis in range(3)) ** 0.5 / 100.0   # raw units are centimetres


class _UnderWay:
    """Has the rider actually been released, or has the level merely moved it?

    Two things look identical to a single distance check, and only one of them is a run. The pointer chain
    resolves before the level has finished placing the rider, so the position read at that instant is not the
    start gate -- and the subsequent jump TO the gate clears any displacement threshold within a frame or two.
    A pass that accepted it sampled a rider still held through the countdown for the whole window and reported,
    truthfully and uselessly, that nothing was ever reached.

    So displacement is measured against a baseline taken once the clock has run, and it has to come with
    motion still in progress: a teleport is a large gap between two stationary samples, while a descent keeps
    producing new ones.
    """

    SETTLE_FRAMES = 90          # ~1.5 s: long enough for the level to finish placing the rider
    MOVING_M = 0.25             # per-sample travel that separates a descending rider from a held one

    def __init__(self, gate: LevelState) -> None:
        self.origin = gate.position
        self.settle_frame = gate.frame + self.SETTLE_FRAMES
        self.previous: tuple[float, float, float] | None = None
        self.settled = False

    def __call__(self, pine: Pine, metres: float) -> bool:
        state = read_level_state(pine)
        if state is None:
            return False
        if not self.settled:
            if state.frame < self.settle_frame:
                return False
            # The clock has run; whatever the level did with the rider it has done. Re-baseline here.
            self.settled = True
            self.origin = state.position
            self.previous = state.position
            return False
        moving = self.previous is not None and _gap_m(state.position, self.previous) >= self.MOVING_M
        self.previous = state.position
        return moving and _gap_m(state.position, self.origin) >= metres


def boot_into_level(process: subprocess.Popen, buttons: int | None = None,
                    mash_timeout: float = 300.0, start_timeout: float = 90.0,
                    underway_m: float = 15.0, port: int = PINE_PORT,
                    menu: str | None = None, want_mode: str | None = None) -> tuple[Pine, LevelState]:
    """Cold boot to a rider that is actually descending, then hand back a stock game.

    Mashing runs in TWO phases, and the second is not optional. The level pointer chain completes while the
    rider is still held at the start gate through the countdown, so stopping there leaves a run that never
    starts: the rider jitters at the gate for the whole sample window and every cell reports, truthfully and
    uselessly, that it was never reached. The second phase keeps tapping until the rider has actually left
    the gate.

    Past that the run needs no input at all -- gravity carries it down the fixture's fall line -- so the pad
    cave is REMOVED, not merely disarmed, before anything is measured. Every verdict downstream is a claim
    about how the retail engine behaves, and none of them should be made with a detour of ours still sitting
    in the pad decode.

    The two mash timeouts here are deliberately still WALL-CLOCK, unlike the sample window. They bound host
    work -- booting, streaming the ELF, waiting on a front end -- and an emulator slow enough to blow them
    has a problem worth stopping for. The cost is that they are the first thing to trip if several instances
    are ever run at once; that surfaces as a loud failure rather than as a quietly short run, which is the
    right direction for a harness whose output is evidence.
    """
    import pad_drive

    pine = wait_for_pine(process, port=port)
    print("pine up; waiting for the disc... ", end="", flush=True)
    print(f"{wait_for_game(pine)} ({pine.title()})")
    wait_for_runtime(pine)
    target = pad_drive.resolve_target(pine)
    pad_drive.wait_for_elf(pine, target)
    layout = pad_drive.build_layout(target)
    pad_drive.install(pine, layout)
    try:
        mask = pad_drive.BUTTONS["cross"] if buttons is None else buttons
        # The mode prelude, if one was asked for: a scripted number of presses that moves the front-end
        # cursor off its default before the mash below takes whatever is under it. It runs FIRST because
        # every entry it is choosing between lives on the top-level menu -- once the mash is past that
        # screen, a DOWN steers a character or a course instead, and a course is the one thing this harness
        # cannot afford to pick by accident.
        if menu:
            pad_drive.run_plan(pine, layout, menu)
        if not pad_drive.mash(pine, layout, mask, mash_timeout,
                              until=lambda: read_level_state(pine) is not None):
            applied = pine.r32(layout.applied)
            raise RuntimeError(
                f"no course came up within {mash_timeout:.0f}s of mashing "
                f"{pad_drive.describe(mask)} (cave ran {applied} times - "
                f"{'the button bit is wrong' if applied else 'the cave never ran'})"
            )
        gate = read_level_state(pine)
        print(f"at the gate, frame {gate.frame}; mashing through the countdown")
        under_way = _UnderWay(gate)
        if not pad_drive.mash(pine, layout, mask, start_timeout,
                              until=lambda: under_way(pine, underway_m)):
            raise RuntimeError(
                f"the rider never left the start gate within {start_timeout:.0f}s "
                f"(still within {underway_m:.0f} m of where the level put it)"
            )
    finally:
        pad_drive.uninstall(pine)
    state = read_level_state(pine)
    if state is None:
        raise RuntimeError("the level went away between the start of the run and the first sample")
    # WHAT WE ACTUALLY LANDED IN, checked before a single verdict is read. Steering the front end is
    # open-loop -- there is no cursor to poll -- so this is the half that makes it safe: the mode enum names
    # the menu entry that was taken, and a run that wanted a solo mountain and got a six-rider race would
    # otherwise produce a full page of perfectly plausible, wrongly-attributed results.
    landed = mode_name(state.game_mode)
    if want_mode and landed != want_mode:
        raise ModeMismatch(
            f"asked for {want_mode} and the front end landed in {landed} "
            f"(GameModeGlobal {state.game_mode}); the menu prelude "
            f"{'took a different entry this boot' if menu else 'was not given'} — "
            f"calibrate it with `python tools/autotest/emu.py modescan <iso>`"
        )
    print(f"mode: {landed} (GameModeGlobal {state.game_mode})")
    return pine, state


def shutdown(process: subprocess.Popen, grace: float = 10.0) -> None:
    """Stop PCSX2 and hand the PINE slot to whoever is queued behind it."""
    try:
        if process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=grace)
    finally:
        # Released after the emulator is actually gone, never before: the next run in the queue starts by
        # waiting for the port to close, and handing over early would just move the wait.
        lock = getattr(process, "ssx_slot_lock", None)
        if lock is not None:
            lock.release()
            process.ssx_slot_lock = None


def cmd_boot(args: argparse.Namespace) -> int:
    process = launch(args.iso, None, port=args.pine_slot)
    try:
        _, state = boot_into_level(process, mash_timeout=args.timeout, port=args.pine_slot)
        print(f"level up at frame {state.frame}: boarder 0x{state.boarder:08x} "
              f"at ({state.position[0]:.1f}, {state.position[1]:.1f}, {state.position[2]:.1f})")
        if args.hold:
            print(f"holding for {args.hold:.0f}s; Ctrl-C to stop early")
            time.sleep(args.hold)
        return 0
    finally:
        if not args.leave_running:
            shutdown(process)


def cmd_modescan(args: argparse.Namespace) -> int:
    """Find WHERE in the mash the front end commits to a mode, one press at a time.

    The problem this solves is that steering is blind: the top-level menu selector is an argument to the
    dispatcher rather than a field of a reachable object, so there is nothing to poll while pressing. But the
    COMMIT is loud -- `GameModeGlobal` is written the moment an entry is chosen -- so tapping one press at a
    time and watching that word says exactly which tap landed on the top-level menu. The DOWN presses that
    choose a different entry belong immediately before it, which turns "guess a button sequence" into
    "insert n presses at a known index".

    Run once per front end. The answer is a prelude string for `--menu`, and it is worth re-running only if
    the boot path changes (a different disc, a savestate, an added splash screen).
    """
    # CALIBRATE AT THE SPEED YOU RIDE AT. Unlike everything downstream of the start gate, a menu prelude is
    # not turbo-invariant: the sample window is counted in the game's own frames, but this is host-timed
    # tapping against a front end that advances in game time, so a tap index measured at 1x lands somewhere
    # completely different at 3x. Calibrating and riding at different scalars is how a prelude that was
    # verified silently starts choosing the wrong menu entry.
    with turbo(args.turbo):
        process = launch(args.iso, None, port=args.pine_slot)
        return _modescan(args, process)


def _modescan(args: argparse.Namespace, process: subprocess.Popen) -> int:
    import pad_drive

    try:
        pine = wait_for_pine(process, port=args.pine_slot)
        print(f"pine up; waiting for the disc... {wait_for_game(pine)}")
        wait_for_runtime(pine)
        target = pad_drive.resolve_target(pine)
        pad_drive.wait_for_elf(pine, target)
        layout = pad_drive.build_layout(target)
        pad_drive.install(pine, layout)
        try:
            if args.menu:
                pad_drive.run_plan(pine, layout, args.menu)
            mask = pad_drive.parse_buttons(args.button)
            previous = read_game_mode(pine)
            # 0 is the value the enum holds before any menu entry is taken -- the front-end setter writes
            # 1..7 and never 0 -- so it means "nothing chosen yet" here rather than the Race it maps to in
            # the engine's name table.
            print(f"  before any press: GameModeGlobal {previous}"
                  f"{' (nothing committed yet)' if previous == 0 else f' ({mode_name(previous)})'}")
            committed_at: int | None = None
            for index in range(1, args.taps + 1):
                pad_drive.tap(pine, layout, mask, 1)
                now = read_game_mode(pine)
                in_level = read_level_state(pine) is not None
                if now != previous:
                    if committed_at is None:
                        committed_at = index
                    print(f"  tap {index}: GameModeGlobal {previous} -> {now} ({mode_name(now)})"
                          f"{'  [level up]' if in_level else ''}")
                    previous = now
                elif in_level:
                    print(f"  tap {index}: level up, still {now} ({mode_name(now)})")
                if in_level:
                    # The useful index is where the MODE was committed, not where the level finished
                    # loading -- there are several presses of character and course select between them, and
                    # a DOWN inserted among those steers a course rather than a mode.
                    if committed_at is None:
                        print(f"\nthe level came up at tap {index} but the mode word never moved, so this "
                              f"front end commits somewhere this scan cannot see")
                        return 1
                    print(f"\nmode committed at tap {committed_at} -> {previous} ({mode_name(previous)}); "
                          f"level up at tap {index}.\nTo take a different entry, put the DOWN presses "
                          f"immediately before the commit:\n  --menu \"{args.button}:{committed_at - 1},down:N\"")
                    return 0
            print(f"\nno level came up within {args.taps} taps of {args.button}"
                  + (f" (mode committed at tap {committed_at})" if committed_at else ""))
            return 1
        finally:
            pad_drive.uninstall(pine)
    finally:
        if not args.leave_running:
            shutdown(process)


def cmd_status(args: argparse.Namespace) -> int:
    if not pine_port_busy(args.pine_slot):
        print(f"no PCSX2 listening on PINE slot {args.pine_slot}")
        return 1
    pine = Pine(args.pine_slot)
    states = {0: "running", 1: "paused", 2: "shutdown"}
    print(f"game: {pine.title()} [{pine.game_id()}], {states.get(pine.status(), '?')}")
    state = read_level_state(pine)
    if state is None:
        print("no level up (front end, loading, or teardown)")
    else:
        print(f"level up at frame {state.frame}: boarder 0x{state.boarder:08x} "
              f"at ({state.position[0]:.1f}, {state.position[1]:.1f}, {state.position[2]:.1f})")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pine-slot", type=int, default=PINE_PORT,
                        help="which emulator to talk to; PCSX2's PINE slot is also its TCP port")
    parser.add_argument("--pcsx2", type=Path, default=None, metavar="EXE",
                        help=f"the emulator binary. Defaults to SSX_PCSX2_EXE, then {DEFAULT_PCSX2} on PATH")
    sub = parser.add_subparsers(dest="command", required=True)
    boot = sub.add_parser("boot")
    boot.add_argument("iso", type=Path)
    boot.add_argument("--timeout", type=float, default=300.0)
    boot.add_argument("--hold", type=float, default=0.0, help="seconds to stay in-level before shutting down")
    boot.add_argument("--leave-running", action="store_true")
    boot.set_defaults(func=cmd_boot)
    scan = sub.add_parser("modescan", help="find which press commits the front end to a mode")
    scan.add_argument("iso", type=Path)
    scan.add_argument("--taps", type=int, default=40)
    scan.add_argument("--button", default="cross")
    scan.add_argument("--menu", default=None, help="a prelude to run before the scan, e.g. \"cross:2,down:1\"")
    scan.add_argument("--turbo", type=float, default=1.0, metavar="X",
                      help="calibrate at this emulation scalar. A prelude is host-timed tapping against a "
                           "front end that runs in game time, so it is NOT turbo-invariant -- calibrate at "
                           "the same scalar you intend to ride at")
    scan.add_argument("--leave-running", action="store_true")
    scan.set_defaults(func=cmd_modescan)
    status = sub.add_parser("status")
    status.set_defaults(func=cmd_status)
    args = parser.parse_args(argv)
    # Carried in the environment rather than threaded through every call: `pcsx2_exe()` is reached from
    # `launch`, `pcsx2_ini` and the speed-limiter writes, none of which otherwise need to know about argv.
    if args.pcsx2 is not None:
        os.environ["SSX_PCSX2_EXE"] = str(args.pcsx2)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
