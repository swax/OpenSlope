#!/usr/bin/env python3
"""The whole loop: author the fixture, pack it into an ISO, ride it, report what dispatched.

  python tools/autotest/run.py                       one pass of GOLD, the regression course
  python tools/autotest/run.py --repeat 3            three passes, one report each
  python tools/autotest/run.py --fixture AUTOTEST2   ride the bench instead
  python tools/autotest/run.py --skip-map --skip-pack   re-ride the ISO already built
  python tools/autotest/run.py --fixture AUTOTEST1    ride the catalogue's first half
  python tools/autotest/run.py --fixture AUTOTEST1B   ...and its second; both for the full sweep
  python tools/autotest/run.py --fixture AUTOTEST3    ride the field (the only course with opponents)
  python tools/autotest/run.py --fixture AUTOTEST5    ride the relay (two cells; does a teleport move you)
  python tools/autotest/run.py --fixture AUTOTEST6    ride the call (does a MainType-21 run an authored function)
  python tools/autotest/run.py --fixture AUTOTEST7    ride the migrated collision-response matrix
  python tools/autotest/run.py --pine-slot 28012     drive a second emulator instead of the default one

GOLD is the one to ride, and the splits below it are the point.

GOLD is the regression test: one cell per mechanism, 24 of them, short enough to fit a solo mountain. It
comes back all-green or something changed. AUTOTEST1 and AUTOTEST1B are the CATALOGUE it is selected from --
every cell hardware has ever demonstrated -- ridden when you want the full sweep rather than the regression
subset. They are two courses because a race pass reaches about 5,900 m and the catalogue outgrew that; each
half now ends around 3.3 km. AUTOTEST2 is the bench, where a cell asserts nothing until a batch has answered
it.
AUTOTEST3 is the field, and it exists because of what the others now do differently -- they ride SHOWOFF,
which puts one rider on the mountain instead of six. AUTOTEST5 is the relay: two cells asking whether an
authored teleport moves the rider, which is the one opcode that could make a course something other than a
single line. AUTOTEST6 is the call: a MainType-21 node running a function the level itself authors, which it
does -- the body runs, and it is handed the rider who touched the caller. Both are one-question courses
because the bench has no reach left: a showoff pass of it stops around 1,450 m and its last cell is already
at 1,490.

AUTOTEST7 is the old collision lab made machine-ridable: all seventeen exact crash-bag profiles, with one
second to observe each solid response before a fixture-authored relay puts the rider back on course.

That baseline is not a convenience. Every rider-acting opcode acts on the boarder its effect thread was
handed rather than on whoever touched the prop, so a field of opponents turns a deterministic node into a
lottery: the pads read as dead for days on a 3-in-42 rate that was nothing to do with the pads. Riding alone
removes that variable from every cell at once. What is left for AUTOTEST3 is the residue -- the questions
that are ABOUT having company, and cannot be asked without it.

AUTOTEST1 is the one exception, and it is a length problem rather than a preference: a showoff event is a
timed run of about two minutes and the catalogue needs four, so it rides a race and pays the lottery. It can
afford to -- nearly every cell in it grades dispatch, which does not care whose contact built the node --
and the cells that read the RIDER are on the three courses that ride alone. That is the whole reason GOLD is
a separate, shorter course instead of a flag on this one.

Each fixture gets its own export directory and its own ISO, so building one never disturbs the others, and
each declares its own mode in the plan it produces, so the driver reads the mountain rather than being told.

No setup and no human: the front end is driven by mashing CROSS into the pad decode (`pad_drive.py`), which
is how a person gets into Garibaldi too -- plus, for a mode that is not the default, a short scripted prelude
that steers the top-level menu first (`emu.py modescan` calibrates it).

Each stage can be skipped so a failure is re-run from where it failed rather than from the top -- a full
pass rebuilds a 2.9 GB image, and iterating on the verdict half should not pay for that.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_tone  # noqa: E402
import emu  # noqa: E402
import slot_lock  # noqa: E402
import verdict  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
SLOPESMITH = ROOT / "Slopesmith"
SNOWKNIFE = ROOT / "Snowknife" / "Snowknife" / "bin" / "Debug" / "net10.0" / "snowknife.exe"
MAPS = ROOT / "Maps"
ISOS = ROOT / "discs"

FIXTURE = "GOLD"
SLOT = "GARI"
REPORTS = ROOT / "Trailmap" / "temp" / "autotest"

#: The retail disc each region's fixtures are built from, and the boot executable it carries.
#:
#: The build name is what selects the two absolute addresses `emu` reads and the front-end prelude it
#: steers with, so it is carried here rather than inferred at ride time -- the prelude has to be chosen
#: before the emulator exists. `emu.detect_build` then asks PCSX2 what it actually booted, so a wrong
#: `--region` fails on the disc rather than on a mismatch nobody notices.
REGIONS = {
    "pal": ("ssx-tricky-europe.iso", "SLES_505.45"),
    "usa": ("ssx-tricky-usa.iso", "SLUS_203.26"),
}
DEFAULT_REGION = "pal"


def run(command: list[str], cwd: Path | None = None) -> None:
    print(f"\n$ {' '.join(str(part) for part in command)}")
    result = subprocess.run(command, cwd=str(cwd) if cwd else None)
    if result.returncode != 0:
        raise RuntimeError(f"command failed with code {result.returncode}")


def build_map(export_dir: Path, fixture: str, hud_text: bool = False) -> None:
    # `npx` is a .cmd shim on Windows, and subprocess without a shell will not find it by bare name.
    # shutil.which honours PATHEXT, so this resolves to the real launcher on both platforms.
    npx = shutil.which("npx")
    if npx is None:
        raise RuntimeError("npx not on PATH - node is required to author the fixture")
    command = [npx, "tsx", "scripts/auto-test-map.ts", str(export_dir), "--fixture", fixture]
    if hud_text:
        command.append("--hud-text")
    run(command, cwd=SLOPESMITH)


def pack_iso(export_dir: Path, out_iso: Path, base_iso: Path, hud_text: bool = False) -> None:
    if not SNOWKNIFE.exists():
        raise RuntimeError(f"snowknife not built at {SNOWKNIFE}")
    if not base_iso.exists():
        raise RuntimeError(f"base ISO not found: {base_iso}")
    run([
        str(SNOWKNIFE), "repack", str(base_iso), SLOT, str(MAPS / SLOT), str(export_dir), str(out_iso),
        "--texture-type2", "--bare-slot",
        # The sky colour is left alone so a rebuilt fixture differs from the last one only where the
        # fixture does.
        "--no-skycolor",
    ] + (["--patches", "hud-text"] if hud_text else []))


#: How many extra boots a pass gets when the front end takes the wrong menu entry.
#:
#: The prelude is host-timed tapping against a game-time menu, so a boot slowed by whatever else the machine
#: is doing lands an entry away and the `--mode` guard refuses the pass. That is the guard working, and it is
#: also not a reason to throw away a batch: the fix is another boot, which costs a minute against the ~10 the
#: ISO behind it cost. Bounded rather than open-ended, because a prelude that is genuinely miscalibrated
#: fails EVERY time and should say so instead of retrying until someone notices.
MODE_RETRIES = 3


def ride(iso: Path, plan: dict, frames: int, port: int = emu.PINE_PORT, speed: float = 1.0,
         menu: str | None = None, want_mode: str | None = None, weave: bool = False) -> dict:
    # Both are PCSX2.ini edits held for the run and put back after it, for the same reason: the emulator
    # reads each of them once, at launch. Holding them no longer than the run means an ordinary failure
    # never leaves a scalar behind in the user's emulator config. The slot has to be set here rather than
    # passed on the command line because PINE has no flag for it; setting it anywhere else connects to one
    # port while the PCSX2 this run started binds another.
    with emu.turbo(speed), emu.pine_slot(port):
        for attempt in range(MODE_RETRIES + 1):
            try:
                return _ride(iso, plan, frames, port, menu, want_mode, weave)
            except emu.ModeMismatch as mismatch:
                if attempt == MODE_RETRIES:
                    raise
                print(f"  {mismatch}\n  booting again ({attempt + 1}/{MODE_RETRIES})")
        raise AssertionError("unreachable")


def _ride(iso: Path, plan: dict, frames: int, port: int,
          menu: str | None = None, want_mode: str | None = None, weave: bool = False) -> dict:
    process = emu.launch(iso, None, port=port)
    try:
        # Returns with the rider already descending, so sampling starts on a moving run rather than burning
        # its first seconds on the countdown.
        pine, level = emu.boot_into_level(process, port=port, menu=menu, want_mode=want_mode)
        print(f"under way at frame {level.frame}, rider at "
              f"({level.position[0]:.0f}, {level.position[1]:.0f}, {level.position[2]:.0f})")
        log = verdict.attach(pine, plan["entries"])
        print(f"attached to {len(log.watches)}/{len(plan['entries'])} variant(s)")
        # The steered instrument pass: a cave at site C holds the turn axis on a game-time schedule, so the
        # rider carves the strips instead of tracking straight. Installed only after the pad cave is gone
        # (boot_into_level removed it -- the two share the cave region) and removed before the report, so
        # the detour never outlives the window it exists for.
        steerer = None
        if weave:
            import steer
            steerer = steer.Weaver(pine)
            steerer.install()
            print(f"steering: {steerer.describe()}")
        try:
            verdict.watch(pine, log, frames, on_tick=steerer.tick if steerer else None)
        finally:
            if steerer:
                try:
                    steerer.remove()
                except Exception as error:  # a dead emulator: the next run's install discards the record
                    print(f"note: could not restore site C ({error}); the ELF is streamed fresh next launch")
        # After the window, never inside it: this needs a whole heap snapshot, and the objects it looks for
        # live as long as the level, so there is nothing to be early for.
        if any(item.late for item in log.watches):
            print("searching the heap for objects not reachable from their instance...")
            verdict.watch_late(pine, log)
        doc = verdict.report(log)
        if steerer:
            # A steered pass is not a stock-executable pass. Stamped so no reader -- human or tally --
            # mistakes it for one, and so the signal analyzer can tell the two kinds of instrument run apart.
            doc["steered"] = steerer.describe()
        return doc
    finally:
        emu.shutdown(process)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fixture", default=FIXTURE, help="which course to build and ride")
    parser.add_argument("--region", default=DEFAULT_REGION, choices=sorted(REGIONS),
                        help="which retail disc to build the fixture into. The fixture itself is the "
                             "same either way -- what changes is the executable it rides on, and so "
                             "the addresses the harness reads and the ISO the pass is written to")
    parser.add_argument("--export-dir", type=Path, default=None)
    parser.add_argument("--iso", type=Path, default=None)
    parser.add_argument("--frames", type=int, default=None,
                        help="window length in simulation ticks; default is derived from the course length")
    parser.add_argument("--pine-slot", type=int, default=emu.PINE_PORT,
                        help="PINE slot of the emulator to drive; also its TCP port, and one per instance")
    parser.add_argument("--turbo", type=float, default=1.0, metavar="X",
                        help="run PCSX2 at X times real time (patches its NominalScalar for the run and puts "
                             "it back). The window is counted in GAME frames, so this shortens a pass without "
                             "changing what it measures -- but watch `samplesPerGameSecond` in the report, "
                             "which is what says whether the sampler kept up")
    parser.add_argument("--menu", default=None, metavar="PLAN",
                        help="a scripted front-end prelude run before the CROSS mash, e.g. "
                             "\"cross:2,down:1\". Calibrate it with `emu.py modescan`")
    parser.add_argument("--mode", default=None, choices=sorted(emu.GAME_MODES),
                        help="refuse to measure unless the front end landed in this mode. Steering is "
                             "open-loop (there is no cursor to poll), so this is what makes --menu safe: "
                             "a run that wanted a solo mountain and got a six-rider race fails loudly "
                             "instead of reporting a page of wrongly-attributed results")
    parser.add_argument("--weave", action="store_true",
                        help="steer the run: a cave at site C holds the turn axis full-lock left/right on a "
                             "game-time schedule (steer.py), so the rider CARVES the course instead of "
                             "tracking straight. Built for the AUTOTEST4 instrument's carving measurements; "
                             "the report is stamped `steered` because it is no longer a stock-executable "
                             "pass, and it should not be tallied with unsteered ones")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--hud-text", action="store_true",
                        help="add a Show message to every ordinary cell's contact chain and bake the patch "
                             "that gives the opcode a body. Fixture-required independent stage messages "
                             "enable that patch automatically.")
    parser.add_argument("--skip-map", action="store_true")
    parser.add_argument("--skip-pack", action="store_true")
    parser.add_argument("--reports", type=Path, default=REPORTS)
    args = parser.parse_args(argv)

    fixture = args.fixture.upper()
    base_name, build = REGIONS[args.region]
    base_iso = ISOS / base_name
    # Derived rather than defaulted so `--fixture` alone is enough. A shared ISO path would mean building the
    # bench silently replaced the gold map's image, and the next `--skip-pack` run would ride the wrong course
    # while reporting against the right plan.
    if args.export_dir is None:
        args.export_dir = MAPS / fixture
    if args.iso is None:
        # The region rides on the name for the same reason the fixture does: two discs carrying the same
        # course are still two different images, and `--skip-pack` picks by path. The default region keeps
        # the unsuffixed name so every existing image, report and habit still refers to the same file.
        suffix = "" if args.region == DEFAULT_REGION else f"-{args.region}"
        args.iso = ISOS / f"ssx-tricky-{fixture.lower()}{suffix}.iso"

    if not args.skip_map:
        build_map(args.export_dir, fixture, args.hud_text)

    plan_path = args.export_dir / "autotest-plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    # A fixture can require Show Message for its own presentation, independently of the CLI switch that adds
    # a banner to every ordinary collision chain. AUTOTEST7 uses separate announcement triggers so even its
    # no-contact controls identify themselves before the expected silence. The same plan that authored those
    # nodes owns the patch decision, keeping the two required halves impossible to forget separately.
    hud_text = args.hud_text or bool(plan.get("hudText"))
    if not args.skip_pack:
        # Under the SLOT lock, because the ISO is the other thing a running emulator owns. PCSX2 holds its
        # disc image open for the whole pass, so packing while someone else rides the same fixture fails on
        # a sharing violation -- and the run that dies is the one that was only trying to build. Waiting for
        # the rider costs a pass and fixes it. Taken and released around the pack alone rather than held
        # across the batch below: a queued run should wait for one pass, not for three.
        with slot_lock.SlotLock(args.pine_slot, f"{fixture} pack"):
            pack_iso(args.export_dir, args.iso, base_iso, hud_text)
        # The bank half of the audio grade, straight after packing. It needs no emulator and takes a second,
        # and it is the half that can fail while every live reading looks fine: a slot encoded as a one-shot
        # still gets a voice started on it, and the pool cannot tell that from a bed [Trailmap:
        # 260-psadpcm-loop]. Advisory here rather than fatal — the ride is still worth having, and the
        # failures print loudly enough to read above it.
        if plan.get("audio"):
            try:
                if audio_tone.main([str(args.iso), "--plan", str(plan_path)]):
                    print("NOTE: the disc's own sound bank does not match the plan; the cells below are being "
                          "ridden against a bank that is already wrong.")
            except (OSError, RuntimeError, ValueError) as error:
                print(f"NOTE: could not read the disc's sound bank ({error})")

    if args.frames is None:
        # An UPPER BOUND, not a target: a pass normally ends when the race does, and this only has to be
        # long enough that it never ends first. Too short is the bug worth avoiding -- cells past where the
        # rider got to come back `not-reached`, which grades as inconclusive and reads like a harness
        # problem rather than "the window was too short". The course knows how long it is, so the bound
        # follows it: 20 m/s is comfortably under the ~25 the rider actually holds, and the slack covers
        # the run-out past the last cell.
        #
        # In the GAME's ticks, so the same fixture covers the same course whatever the emulator manages.
        args.frames = int(plan.get("windowFrames")
                          or round((plan["runLengthM"] / 20.0 + 25.0) * emu.GAME_HZ))
        source = "fixture window" if plan.get("windowFrames") else f"{plan['runLengthM']:.0f} m of course"
        print(f"sampling {args.frames} frames "
              f"({args.frames / emu.GAME_HZ:.0f}s of game, {source})")

    # THE MODE COMES FROM THE FIXTURE unless the command line overrides it. A course declares the mountain
    # its cells assume, so the mode is a property of what is being measured rather than something to remember
    # on every invocation -- which is what it was when everything was ridden in a race by default and every
    # rider-acting cell quietly had five other candidates for its effects.
    if args.mode is None and "mode" not in plan:
        # A plan written before fixtures declared their mountain. Falling back to race is right -- it is what
        # such a plan was measured in -- but it must not be SILENT, because `--skip-map` is exactly how a
        # course whose cells now assume a solo mountain gets ridden with five opponents while the report says
        # nothing about it.
        print("  NOTE: this plan predates fixture modes, so the run falls back to race. Rebuild the map "
              "(drop --skip-map) to pick up the mode the fixture declares.")
    want_mode = args.mode or plan.get("mode") or "race"
    menu = args.menu if args.menu is not None else emu.mode_prelude(build, want_mode)
    if menu and args.turbo != 1.0:
        # Refused rather than warned. Steering is host-timed tapping against a front end that runs in game
        # time, so a scalar moves where every press lands, and recalibrating does not fix it: at 3x one press
        # covers three times as much menu and ordinary load variance outweighs a whole entry. Measured twice.
        raise SystemExit(
            f"--turbo {args.turbo:g} cannot be combined with menu steering (mode {want_mode}). The prelude is "
            f"a duration rather than a count, and at any scalar above 1x it selects the wrong entry -- "
            f"measured. Ride mode-steered passes at --turbo 1, or pass --mode race, which needs no prelude."
        )
    if menu:
        print(f"mode: steering to {want_mode} with \"{menu}\"")

    args.reports.mkdir(parents=True, exist_ok=True)
    failures = 0
    for pass_index in range(args.repeat):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        print(f"\n=== {fixture} pass {pass_index + 1}/{args.repeat} ===")
        doc = ride(args.iso, plan, args.frames, args.pine_slot, args.turbo, menu, want_mode, args.weave)
        # Stamped into the report so `tally.py` can refuse to average two different courses together.
        doc["fixture"] = fixture
        doc["plan"] = str(plan_path)
        doc["iso"] = str(args.iso)
        # And the disc, for the same reason one step out: the same fixture on two executables is two
        # measurements, and which one a report came from is not recoverable from the numbers in it.
        doc["region"] = args.region
        doc["build"] = build
        # The instrument strips AND the fall-line anchors ride IN the report, not only behind the plan path:
        # the plan file is overwritten on every rebuild, so a report that merely pointed at it would silently
        # re-bucket its samples by whatever spans the NEXT fixture happened to use — and project them onto a
        # fall line derived from anchor cells that have moved.
        if plan.get("strips"):
            doc["strips"] = plan["strips"]
            doc["anchors"] = [{"location": entry["location"], "distanceM": entry["distanceM"]}
                              for entry in plan.get("entries", []) if entry.get("location")][:2]
        verdict.print_report(doc)
        # Stamp first so the directory still sorts chronologically; the fixture rides on the tail so a batch
        # of one course can be picked out without opening every file.
        out = args.reports / f"run-{stamp}-{fixture.lower()}.json"
        out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
        print(f"saved -> {out}")
        if not doc["variants"]:
            failures += 1
        elif doc.get("ended", "complete") in verdict.FAULT_ENDS:
            # The window did not finish, so every cell the rider had not reached is untested. Grading a batch
            # on partial coverage is how a slow host turns into a false all-clear.
            print(f"\nthe window ended early ({doc['ended']}) - this pass covers less course than it should")
            failures += 1
        elif not any(row["fired"] for row in doc["variants"]):
            # The control cell is a retail model whose mode-1 proxy already dispatched in a live collision-lab
            # pass, so a run where NOTHING fires indicts the harness before it indicts any cell.
            print("\nNOTHING fired, including the retail control - suspect the harness or the ride, not the cells")
            failures += 1
        elif doc.get("regressions"):
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
