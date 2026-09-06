#!/usr/bin/env python3
"""Read the engine's placed-emitter voice table live, so "is this ambience actually playing" is a fact.

Every other way of checking an authored emitter is indirect. The export can be read, the bank can be decoded,
the ADL row can be parsed -- and all three can be right while the console plays nothing, which is exactly the
failure this was written for: a custom emitter whose bank slot was encoded as a ONE-SHOT, so the SPU stopped
the voice at the end of the sample and a correct-looking build was silent [Trailmap: 420-audio-runtime].
Listening is not a test either; a bed that is meant to be quiet at distance sounds the same as one that never
started.

The engine keeps a fixed pool of external voices and the runtime's own reject pass walks it every time an
emitter wants to start, so the pool is authoritative about what is sounding:

    AudioExternal_FindVoicePlayingEvent   state == 1, bankHandle != -1, matching eventId, 40 entries of 0x50
    AudioExternal_StartVoice              refuses when the entry already holds a voice at +0x30

So `+0x30 != -1` is the signal worth reporting -- a voice HANDLE, not merely a populated slot. An entry can be
live and eventless while the emitter is out of range or, for the hit-gated class, before the rider has hit the
prop that arms it.

READ-ONLY: this never writes to the emulator.

  python tools/autotest/audio_voices.py                          poll a running PCSX2 for 20 s
  python tools/autotest/audio_voices.py --seconds 60             ...for longer
  python tools/autotest/audio_voices.py --iso <iso> --seconds 90 boot the image, ride it, then report
  python tools/autotest/audio_voices.py --expect 179,16          exit non-zero unless both events sounded
  python tools/autotest/audio_voices.py --sound-index Maps/GARI/Audio/SoundIndex.json
                                                                 name the course-bank slot behind each event

The graded loop, against the audio bench. `run.py` builds the course and grades the DISPATCH half as it does
for any fixture; this grades the half dispatch cannot see, off the same image:

  python tools/autotest/run.py --fixture AUTOTEST8
  python tools/autotest/audio_voices.py --iso discs/ssx-tricky-autotest8.iso \
      --plan Maps/AUTOTEST8/autotest-plan.json --seconds 90

AUTOTEST8 places one emitter per mechanism down the fall line and the plan says what each must do, so the
grade is per cell rather than a list of ids that happened to sound. It rides in whatever mode the front end
lands in on purpose: none of the four mode-gated opcode families is involved in placed ambience, and a menu
prelude is host-timed tapping that misses often enough to be its own failure.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "instrumentation"))
from pine_hooks import Pine  # noqa: E402

import emu  # noqa: E402
from audio_banks_generated import SPECIAL_BANKS  # noqa: E402

#: The pointer to the audio config, whose first word is the external-voice pool. This is a THIRD absolute
#: address beyond the two `emu.Build` carries, and it lives here rather than there so the ride harness keeps
#: its two-word record; nothing in a normal pass reads it.
#:
#: Both were recovered structurally rather than transcribed: the walker above is recognised by its own
#: instruction shape (deref config, then a 40 x 0x50 scan testing state==1 / handle!=-1 / event==arg), and the
#: address is the `lui`/`lw` pair its caller loads immediately before the call. PAL and NTSC-U disagree by
#: 0x200, which is not the offset either of the other two words differ by -- so neither is derivable from the
#: other and both are measured.
AUDIO_CONFIG_PTR = {"SLES_505.45": 0x0034490C, "SLUS_203.26": 0x0034370C}

VOICE_COUNT = 40
VOICE_STRIDE = 0x50
VOICE_STATE = 0x00       # 1 while the entry is in use
VOICE_ENTITY = 0x04      # the placed instance the record hangs off
VOICE_EVENT = 0x0C       # the ADL ExternalSound SoundIndex
VOICE_HANDLE = 0x30      # the playing voice, or -1: THE audible signal
VOICE_BANK = 0x40        # resolved bank handle, or -1 while unresolved

#: Hit-gated: silent until the rider hits the owning instance, then permanent.
INTERACTIVE_EVENTS = {16, 28, 57}
CROWD_EVENTS = {97, 98, 99}


@dataclass(frozen=True)
class Voice:
    index: int
    event: int
    entity: int
    handle: int
    bank: int

    @property
    def playing(self) -> bool:
        return self.handle != 0xFFFFFFFF and self.handle != -1


def describe(event: int, slots: dict[int, dict] | None) -> str:
    if event in SPECIAL_BANKS:
        return f"{SPECIAL_BANKS[event]}.bnk"
    if event in CROWD_EVENTS:
        return "crowd bank"
    label = "hit-gated, " if event in INTERACTIVE_EVENTS else ""
    route = (slots or {}).get(str(event)) or (slots or {}).get(event)
    if route:
        return f"{label}{route['Bank']} slot {route['Slot']:03d}"
    return f"{label}course bank" if label else "course bank"


def pool_base(pine: Pine) -> int:
    build = emu.detect_build(pine)
    pointer = AUDIO_CONFIG_PTR.get(build.name)
    if pointer is None:
        raise RuntimeError(f"no external-voice pool address for build {build.name}")
    config = pine.r32(pointer)
    if not config:
        raise RuntimeError("the audio config pointer is null; no level is up yet")
    return pine.r32(config)


def dump_entries(pine: Pine, base: int, wanted: set[int]) -> dict[int, list[int]]:
    """Every word of the pool entry for the named events.

    "A voice started" and "a voice is audible" are different claims, and the pool as read above only supports
    the first. An entry is 0x50 bytes of which five words are identified; the rest necessarily includes
    whatever the mixer was handed. Reading them beside a RETAIL emitter on the same ride is what makes them
    legible — a word that is large on a bed you can hear and tiny on one you cannot is the level, whatever it
    is called.
    """
    words = pine.r32_many(base + index * VOICE_STRIDE + offset
                          for index in range(VOICE_COUNT)
                          for offset in range(0, VOICE_STRIDE, 4))
    per = VOICE_STRIDE // 4
    found: dict[int, list[int]] = {}
    for index in range(VOICE_COUNT):
        entry = words[index * per:(index + 1) * per]
        if entry[0] != 1:
            continue
        event = entry[VOICE_EVENT // 4]
        if event in wanted:
            found[event] = entry
    return found


def as_float(word: int) -> float:
    return struct.unpack("<f", struct.pack("<I", word))[0]


def read_voices(pine: Pine, base: int) -> list[Voice]:
    """Every in-use entry of the pool, in one PINE packet."""
    words = pine.r32_many(base + index * VOICE_STRIDE + offset
                          for index in range(VOICE_COUNT)
                          for offset in (VOICE_STATE, VOICE_ENTITY, VOICE_EVENT, VOICE_HANDLE, VOICE_BANK))
    found = []
    for index in range(VOICE_COUNT):
        state, entity, event, handle, bank = words[index * 5:index * 5 + 5]
        if state != 1:
            continue
        found.append(Voice(index, event, entity,
                           struct.unpack("<i", struct.pack("<I", handle))[0],
                           struct.unpack("<i", struct.pack("<I", bank))[0]))
    return found


def watch(pine: Pine, seconds: float, slots: dict | None, quiet: bool,
          dump: set[int] | None = None) -> dict[int, dict]:
    """Poll the pool, accumulating what each event id ever did.

    The sample INDEX each thing first happened on is kept, not just a count, because the hit-gated claim is
    about order: an emitter that was resident and silent before it started is a gate holding, and one that
    sounded on the first sample it appeared is a gate that never closed.
    """
    base = pool_base(pine)
    print(f"external-voice pool at 0x{base:08x} ({VOICE_COUNT} entries of 0x{VOICE_STRIDE:02X})")
    seen: dict[int, dict] = {}
    deadline = time.monotonic() + seconds
    sample = 0
    last = ""
    while time.monotonic() < deadline:
        try:
            voices = read_voices(pine, base)
        except (OSError, RuntimeError) as error:
            print(f"  read failed ({error}); stopping")
            break
        for voice in voices:
            record = seen.setdefault(voice.event, {
                "resident": 0, "played": 0, "entities": set(),
                "first_resident": sample, "first_played": None,
            })
            record["resident"] += 1
            record["entities"].add(voice.entity)
            if voice.playing:
                record["played"] += 1
                if record["first_played"] is None:
                    record["first_played"] = sample
        if dump and sample % 20 == 0:
            for event, entry in sorted(dump_entries(pine, base, dump).items()):
                cells = " ".join(
                    f"+{at * 4:02x}:{word:08x}"
                    + (f"({as_float(word):.3g})" if 1e-6 < abs(as_float(word)) < 1e6 else "")
                    for at, word in enumerate(entry))
                print(f"  [dump {event}] {cells}")
        if not quiet:
            line = " ".join(f"{v.event}{'*' if v.playing else ''}" for v in voices) or "(none)"
            if line != last:
                print(f"  {line}")
                last = line
        sample += 1
        time.sleep(0.05)
    return seen


def load_routing(iso: Path | None, named: Path | None) -> dict[int, dict]:
    """The disc's own record of where each custom clip ended up, keyed by the event the EXPORT gave it.

    A plan is written by the export and therefore names the reserved event pool; the repack then re-points
    those ids onto slots the target bank already ships, because an empty slot charges a clip full price
    against a budget the bank does not have [Trailmap: 260-bank-budget]. The pool reports event ids and
    nothing else, so without this the probe would look for 179, watch 63 sound, and grade a working disc as
    never resident. Absent manifest = no routing happened (or an older build), which reads correctly as an
    identity map rather than as an error.
    """
    path = named or (iso.with_suffix(".sounds.json") if iso else None)
    if path is None or not path.exists():
        return {}
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        print(f"  ignoring {path.name}: {error}")
        return {}
    if doc.get("Schema") != "openslope-disc-sounds/v1":
        return {}
    routing = {int(entry["ExportedEvent"]): entry for entry in doc.get("Sounds", [])}
    moved = [entry for entry in routing.values() if entry["ExportedEvent"] != entry["Event"]]
    print(f"{path.name}: {doc.get('Bank')} carries {len(routing)} custom clip(s), "
          f"{doc.get('BankBytes', 0):,} of {doc.get('BankBudget', 0):,} bytes"
          + (f"; {len(moved)} routed off the export's ids" if moved else ""))
    for entry in sorted(moved, key=lambda item: item["ExportedEvent"]):
        print(f"  {entry['Wav']}: event {entry['ExportedEvent']} -> {entry['Event']} (slot {entry['Slot']:03d})")
    return routing


def grade_plan(seen: dict[int, dict], plan: dict, slots: dict | None,
               routing: dict[int, dict] | None = None) -> int:
    """Grade an AUTOTEST8-style plan's emitter cells. Returns the count that REGRESSED.

    Grades follow the dispatch harness's own vocabulary so a reader does not have to learn a second one: a
    cell the rider never came within range of is `inconclusive` rather than failed, because a miss and a
    refusal are indistinguishable from here and letting one count as the other is how a harness manufactures
    evidence for whatever it was built to prove.
    """
    cells = plan.get("audio") or []
    if not cells:
        print("the plan carries no emitter cells")
        return 0
    print()
    print(f"{'cell':<20} {'event':>5}  grade         what happened")
    regressions = 0
    for cell in cells:
        event = cell.get("event")
        routed = (routing or {}).get(event)
        if routed:
            event = routed["Event"]
        record = seen.get(event)
        expect = cell.get("expect")
        if expect == "one-shot":
            # A collision clip is a transient voice; the pool never holds one, so silence here is not
            # evidence of anything. The cell is graded off the shipped bank by audio_tone.py instead.
            print(f"{cell['id']:<20} {event if event is not None else '?':>5}  {'n/a':<13} "
                  "a one-shot is not a pool entry — audio_tone.py grades its slot")
            continue
        if record is None:
            grade, note = "inconclusive", "never resident — the rider never came within its radius"
        elif expect == "sounds":
            if record["played"]:
                grade, note = "pass", f"sounded ({record['played']} sample(s))"
            else:
                grade, note = "REGRESSION", ("resident but never started a voice — what a slot encoded as a "
                                             "one-shot looks like")
        elif expect == "gated":
            silent_first = record["first_played"] is None or record["first_played"] > record["first_resident"]
            if not record["played"]:
                grade, note = "inconclusive", ("held silent, but the rider never hit it — the gate is "
                                               "unproven either way")
            elif not silent_first:
                grade, note = "REGRESSION", "sounded on the sample it appeared — the hit gate never held"
            else:
                grade = "pass"
                note = (f"silent for {record['first_played'] - record['first_resident']} sample(s), "
                        f"then sounded — gate held and opened")
        else:
            grade, note = "open", f"resident {record['resident']}, sounded {record['played']}"
        if grade == "REGRESSION":
            regressions += 1
        print(f"{cell['id']:<20} {event if event is not None else '?':>5}  {grade:<13} {note}")

    # Anything the pool carried that the plan does not name. On the audio bench that is the retail ambience
    # the donor slot ships, which is worth seeing rather than hiding: it is independent evidence the
    # placed-emitter path is alive on this disc at all.
    planned = {(routing or {}).get(cell.get("event"), {}).get("Event", cell.get("event")) for cell in cells}
    extra = sorted(event for event in seen if event not in planned)
    if extra:
        print()
        print("  also sounding (the donor slot's own ambience): "
              + ", ".join(f"{event}{'' if seen[event]['played'] else ' (silent)'}"
                          f" {describe(event, slots)}" for event in extra))
    return regressions


def report(seen: dict[int, dict], slots: dict | None, expect: list[int]) -> int:
    print()
    if not seen:
        print("no external voice was ever resident — no placed emitter came within range")
    else:
        print(f"{'event':>6}  {'sounded':>7}  {'samples':>7}  where it comes from")
        for event in sorted(seen):
            record = seen[event]
            mark = "yes" if record["played"] else "NO"
            print(f"{event:>6}  {mark:>7}  {record['resident']:>7}  {describe(event, slots)}")
    if not expect:
        return 0
    print()
    missing = [event for event in expect if not seen.get(event, {}).get("played")]
    for event in expect:
        record = seen.get(event)
        if record and record["played"]:
            print(f"  ok    event {event} started a voice ({describe(event, slots)})")
        elif record:
            print(f"  FAIL  event {event} was resident but never started a voice — "
                  "in range and refused, which is what a missing loop region looks like")
        else:
            print(f"  FAIL  event {event} was never resident — the rider never came within its radius, "
                  "or nothing placed it")
    return 1 if missing else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--iso", type=Path, help="boot this image and ride it; without it, attach to a running PCSX2")
    parser.add_argument("--seconds", type=float, default=20.0, help="how long to watch (default 20)")
    parser.add_argument("--expect", default="", help="comma-separated event ids that MUST sound")
    parser.add_argument("--plan", type=Path,
                        help="an autotest-plan.json with emitter cells (AUTOTEST8); grades them and exits "
                             "non-zero on a regression")
    parser.add_argument("--sound-index", type=Path, help="a level's Audio/SoundIndex.json, to name course-bank slots")
    parser.add_argument("--sounds", type=Path,
                        help="the disc's <iso>.sounds.json manifest, which says where the repack routed each "
                             "custom clip; found beside --iso when not named")
    parser.add_argument("--pine-slot", type=int, default=emu.PINE_PORT)
    parser.add_argument("--dump", default="",
                        help="comma-separated event ids whose full pool entry to print once a second — read one of yours beside a retail one to see what the mixer was handed")
    parser.add_argument("--quiet", action="store_true", help="only the summary, not every change")
    parser.add_argument("--leave-running", action="store_true", help="with --iso, do not close the emulator")
    args = parser.parse_args(argv)

    expect = [int(value) for value in args.expect.split(",") if value.strip()]
    slots = None
    if args.sound_index:
        slots = json.loads(args.sound_index.read_text()).get("CollisionEvents")
    plan = json.loads(args.plan.read_text()) if args.plan else None
    dump = {int(value) for value in args.dump.split(',') if value.strip()} or None
    routing = load_routing(args.iso, args.sounds)
    expect = [routing.get(event, {}).get("Event", event) for event in expect]

    def finish(seen: dict[int, dict]) -> int:
        rc = report(seen, slots, expect)
        if plan is None:
            return rc
        regressions = grade_plan(seen, plan, slots, routing)
        print()
        print(f"{plan.get('name', 'plan')}: {regressions} regression(s)")
        return rc or (1 if regressions else 0)

    if not args.iso:
        pine = Pine(port=args.pine_slot)
        return finish(watch(pine, args.seconds, slots, args.quiet, dump))

    process = emu.launch(args.iso, None, port=args.pine_slot)
    try:
        pine, state = emu.boot_into_level(process, port=args.pine_slot)
        # The mode is reported rather than steered: placed emitters are not one of the four opcode families
        # that test the mode word, so the front end landing in race costs this probe nothing — and steering
        # is host-timed tapping that misses often enough to be its own failure mode.
        print(f"level up at frame {state.frame} in {emu.mode_name(emu.read_game_mode(pine))}; "
              f"watching for {args.seconds:.0f}s of riding")
        return finish(watch(pine, args.seconds, slots, args.quiet, dump))
    finally:
        if not args.leave_running:
            emu.shutdown(process)


if __name__ == "__main__":
    raise SystemExit(main())
