#!/usr/bin/env python3
"""Decode what a built disc's course bank actually holds, and say what it SOUNDS like.

`audio_voices.py` reads the engine's voice pool, which answers "did a voice start". That is the live half and
it is not the whole question: a voice starts for a slot encoded at the wrong rate, a slot holding silence, and
a slot whose loop region is missing — the last of those shipped for as long as the emitter feature existed and
every graded fixture called it fine [Trailmap: 420-audio-runtime]. What no memory read can see is the SAMPLE.

So this opens the finished ISO, pulls the course bank out of AUDIO.BIG, decodes the slots the disc says carry
custom clips, and reports the pitch it hears and the loop the bytes describe. The fixture's clips are plain
sine bursts at known frequencies, so "the bed is 220 Hz and wraps" is a measurement rather than an opinion.

  python tools/autotest/audio_tone.py discs/ssx-tricky-autotest8.iso
  python tools/autotest/audio_tone.py <iso> --plan Maps/AUTOTEST8/autotest-plan.json    grade the cells
  python tools/autotest/audio_tone.py <iso> --slot 64 --slot 35    look at slots the manifest does not name
  python tools/autotest/audio_tone.py <iso> --wav-dir temp/tones   also write what it decoded, to listen to

READ-ONLY on the image, and it needs no emulator: this is the half of the audio grade that can run on a build
machine. The pair is the whole claim — the bytes are right AND the engine started a voice on them.

The reader here is deliberately its OWN implementation of BIGF/BNKl/PS-ADPCM rather than a call into
Snowknife. A decoder sharing code with the encoder agrees with it by construction, which is precisely the
property a check on the encoder must not have: the loop-marker bug that hung the console round-tripped through
our own reader without complaint for a day. Two implementations disagreeing is a finding.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
SNOWKNIFE = ROOT / "Snowknife" / "Snowknife" / "bin" / "Debug" / "net10.0" / "snowknife.exe"

#: PS-ADPCM frame flag bits [Trailmap: 260-psadpcm-loop]. Bit 0 ends the voice, bit 1 says repeat rather than
#: release, bit 2 marks the address the SPU wraps back to.
FLAG_END, FLAG_REPEAT, FLAG_LOOP_START = 0x01, 0x02, 0x04

#: The four ADPCM predictor pairs, in 1/64ths.
PREDICTORS = [(0, 0), (60, 0), (115, -52), (98, -55), (122, -60)]


# --------------------------------------------------------------------------------------------- containers

def bigf_members(data: bytes) -> dict[str, bytes]:
    """BIGF: a big-endian header, then (offset, size, name) triples. RAW members, no RefPack in AUDIO.BIG."""
    if data[:4] != b"BIGF":
        raise ValueError("not a BIGF archive")
    count = struct.unpack(">I", data[8:12])[0]
    at = 16
    members: dict[str, bytes] = {}
    for _ in range(count):
        offset, size = struct.unpack(">II", data[at:at + 8])
        at += 8
        end = data.index(b"\0", at)
        name = data[at:end].decode("ascii", "replace")
        at = end + 1
        members[name] = data[offset:offset + size]
    return members


def bnk_slots(data: bytes) -> dict[int, dict]:
    """BNKl: a slot table of self-relative u32 offsets (0 = empty) into patch-tag headers.

    Returns the slots that carry sound, each as its decoded tag values plus the raw codec bytes. Tag payloads
    are big-endian: 0x84 rate, 0x85 sample count, 0x86/0x87 loop start/end in samples, 0x88/0x89 the channel
    data offsets, 0xA0 the codec.
    """
    if data[:3] != b"BNK":
        raise ValueError("not a BNKl bank")
    version = data[4]
    count = struct.unpack("<H", data[6:8])[0]
    table = 0x0C if version == 2 else 0x14
    slots: dict[int, dict] = {}
    for index in range(count):
        entry = table + 4 * index
        rel = struct.unpack("<I", data[entry:entry + 4])[0]
        if rel == 0:
            continue
        at = entry + rel + 4                      # skip the "PT" platform dword
        sound = {"rate": 22050, "samples": 0, "channels": 1, "codec": 0x05,
                 "loopStart": None, "loopEnd": None, "offsets": []}
        while at < len(data):
            tag = data[at]
            at += 1
            if tag in (0xFF, 0xFE):
                break
            if tag in (0xFC, 0xFD):
                continue
            size = data[at]
            at += 1
            value = int.from_bytes(data[at:at + size], "big")
            at += size
            if tag == 0x82:
                sound["channels"] = value
            elif tag == 0x84:
                sound["rate"] = value
            elif tag == 0x85:
                sound["samples"] = value
            elif tag == 0x86:
                sound["loopStart"] = value
            elif tag == 0x87:
                sound["loopEnd"] = value
            elif tag == 0xA0:
                sound["codec"] = value
            elif tag == 0x88:
                sound["offsets"].insert(0, value)
            elif tag == 0x89:
                sound["offsets"].append(value)
        frames = (sound["samples"] + 27) // 28
        if sound["codec"] != 0x05 or not sound["offsets"]:
            sound["frames"] = b""
        else:
            start = sound["offsets"][0]
            sound["frames"] = data[start:start + frames * 16]
        slots[index] = sound
    return slots


# ------------------------------------------------------------------------------------------------- codec

def decode_psadpcm(frames: bytes) -> np.ndarray:
    """16-byte frames of 28 samples: a shift/predictor byte, a flag byte, then 14 bytes of nibble pairs."""
    out = np.empty((len(frames) // 16) * 28, dtype=np.float64)
    hist1 = hist2 = 0.0
    at = 0
    for frame in range(len(frames) // 16):
        base = frame * 16
        header = frames[base]
        shift, predictor = header & 0x0F, min(header >> 4, len(PREDICTORS) - 1)
        plus, minus = PREDICTORS[predictor]
        for byte in range(14):
            raw = frames[base + 2 + byte]
            for nibble in (raw & 0x0F, raw >> 4):
                value = nibble - 16 if nibble > 7 else nibble
                sample = (value << 12) >> shift
                sample += (hist1 * plus + hist2 * minus) / 64.0
                sample = max(-32768.0, min(32767.0, sample))
                hist2, hist1 = hist1, sample
                out[at] = sample
                at += 1
    return out


def frame_flags(frames: bytes) -> list[int]:
    return [frames[i * 16 + 1] for i in range(len(frames) // 16)]


# -------------------------------------------------------------------------------------------- listening

def dominant_hz(samples: np.ndarray, rate: int) -> tuple[float, float]:
    """The strongest frequency in the clip, and how much of the total energy sits in its bin.

    Parabolic interpolation over the neighbouring bins, because a one-second clip at 16 kHz has 1 Hz bins and
    a 220 Hz tone resampled off 22.05 kHz does not land on one. The purity number is what separates a tone
    from noise or from a retail sound that happens to have a peak.
    """
    if samples.size < 64:
        return 0.0, 0.0
    windowed = samples * np.hanning(samples.size)
    spectrum = np.abs(np.fft.rfft(windowed))
    spectrum[0] = 0.0
    peak = int(np.argmax(spectrum))
    if peak == 0 or spectrum[peak] <= 0:
        return 0.0, 0.0
    if 0 < peak < spectrum.size - 1:
        left, mid, right = spectrum[peak - 1], spectrum[peak], spectrum[peak + 1]
        divisor = left - 2 * mid + right
        offset = 0.5 * (left - right) / divisor if divisor else 0.0
    else:
        offset = 0.0
    hz = (peak + offset) * rate / samples.size
    energy = float(np.sum(spectrum ** 2))
    band = float(np.sum(spectrum[max(0, peak - 2):peak + 3] ** 2))
    return hz, (band / energy if energy else 0.0)


def rms_dbfs(samples: np.ndarray) -> float:
    if samples.size == 0:
        return -math.inf
    rms = float(np.sqrt(np.mean(samples ** 2)))
    return 20 * math.log10(rms / 32768.0) if rms > 0 else -math.inf


def loop_reading(sound: dict) -> tuple[bool, str]:
    """Does this slot SUSTAIN, and does its region and its frame flags agree?

    Both halves have to be right and they are written by different code. The tags are the SPU's loop
    addresses; the flags are what the voice reads frame by frame, and a sample whose last frame carries the
    bare end flag stops there whatever the tags say — which is exactly the shape that shipped silent.
    """
    flags = frame_flags(sound["frames"])
    if not flags:
        return False, "no sample data"
    tagged = sound["loopStart"] is not None and sound["loopEnd"] is not None
    marked = [i for i, flag in enumerate(flags) if flag & FLAG_LOOP_START]
    sustains = bool(flags[-1] & FLAG_REPEAT)
    if not tagged and not marked and not sustains:
        return False, f"one-shot (last frame {flags[-1]:#04x})"
    problems = []
    if not tagged:
        problems.append("frame flags loop but no 0x86/0x87 region")
    if not marked:
        problems.append("region tagged but no frame marks the repeat address")
    if not sustains:
        problems.append(f"last frame is {flags[-1]:#04x}, which releases the voice instead of wrapping")
    if any(flag == FLAG_END for flag in flags):
        problems.append("a frame carries the bare end flag")
    # Retail marks the frame one PAST the one the loop-start sample falls in; a marker on the frame itself
    # hung level load on hardware [Trailmap: 260-psadpcm-loopmark].
    if tagged and marked and marked[0] != min(sound["loopStart"] // 28 + 1, len(flags) - 1):
        problems.append(f"repeat marked at frame {marked[0]}, not {sound['loopStart'] // 28 + 1}")
    # And it leaves TWO frames past the region carrying the wrap, never one. Checked here against retail's
    # own count rather than against what our encoder does, because a reader that only knows the encoder's
    # description agrees with the encoder's bugs — this one shipped a bed that played once and stopped, and
    # this check read it as a healthy loop [Trailmap: 260-psadpcm-loop].
    wrap = len(flags) - 1 - max((i for i, flag in enumerate(flags) if flag != 0x03), default=-1)
    if len(flags) >= 5 and wrap != 2:
        problems.append(f"{wrap} frame(s) past the loop region carry the wrap, not the 2 retail leaves")
    # A sustaining slot's declared length lands on a frame boundary in every shipped bank. Ours stopped part
    # way into the final frame, which is the sort of difference that reads as harmless and is the only one
    # left between our loops and theirs.
    if sound["samples"] % 28:
        problems.append(f"{sound['samples']} samples is {28 - sound['samples'] % 28} short of a whole frame; "
                        "every retail sustaining slot declares a frame multiple")
    if problems:
        return True, "LOOP SUSPECT — " + "; ".join(problems)
    return True, f"loops {sound['loopStart']}..{sound['loopEnd']} (frame {marked[0]} marks the wrap)"


# ------------------------------------------------------------------------------------------------ disc

def read_bank(iso: Path, bank: str) -> dict[int, dict]:
    """Pull AUDIO.BIG out of the image and hand back the named course bank's slots.

    Snowknife does the ISO9660 walk — that is a solved problem living somewhere already, and unlike the
    audio formats below there is nothing to be learned from a second implementation of it.
    """
    if not SNOWKNIFE.exists():
        raise RuntimeError(f"snowknife not built at {SNOWKNIFE}")
    with tempfile.TemporaryDirectory() as work:
        big = Path(work) / "AUDIO.BIG"
        result = subprocess.run([str(SNOWKNIFE), "iso-extract", str(iso),
                                 r"DATA\AUDIO\AUDIO.BIG", str(big)],
                                capture_output=True, text=True)
        if result.returncode != 0 or not big.exists():
            raise RuntimeError(f"could not pull AUDIO.BIG out of {iso.name}: "
                               f"{result.stderr.strip() or result.stdout.strip()}")
        members = bigf_members(big.read_bytes())
    for name, data in members.items():
        if Path(name).stem.lower() == bank.lower():
            return bnk_slots(data)
    raise RuntimeError(f"{bank}.bnk is not in AUDIO.BIG (it has {len(members)} members)")


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(np.clip(samples, -32768, 32767).astype("<i2").tobytes())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("iso", type=Path, help="a built ISO")
    parser.add_argument("--sounds", type=Path,
                        help="the disc's <iso>.sounds.json manifest; found beside the ISO when not named")
    parser.add_argument("--plan", type=Path, help="an autotest-plan.json; grades its audio cells")
    parser.add_argument("--bank", help="course bank name, when there is no manifest to read it from")
    parser.add_argument("--slot", type=int, action="append", default=[],
                        help="also decode this slot, repeatable")
    parser.add_argument("--wav-dir", type=Path, help="write each decoded slot here as a WAV")
    parser.add_argument("--tolerance", type=float, default=0.04,
                        help="fractional pitch error a cell may carry and still pass (default 4%%, which "
                             "covers the resample onto the bank's own rate)")
    args = parser.parse_args(argv)

    manifest = {}
    manifest_path = args.sounds or args.iso.with_suffix(".sounds.json")
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    bank = args.bank or manifest.get("Bank")
    if not bank:
        print(f"no {manifest_path.name} beside the ISO and no --bank: nothing says which bank to read.\n"
              "A disc built before the manifest existed, or one whose custom sounds were refused, has none — "
              "pass --bank <name> to look anyway.")
        return 1

    slots = read_bank(args.iso, bank)
    print(f"{args.iso.name}: {bank}.bnk, {len(slots)} slot(s) with sound"
          + (f", {manifest['BankBytes']:,} of {manifest['BankBudget']:,} bytes"
             if "BankBytes" in manifest else ""))

    wanted = {int(entry["Slot"]): entry for entry in manifest.get("Sounds", [])}
    for slot in args.slot:
        wanted.setdefault(slot, {"Wav": f"slot {slot:03d}", "Event": None, "Slot": slot})
    if not wanted:
        print("the manifest names no custom clips; pass --slot to decode one anyway")
        return 1

    decoded: dict[int, dict] = {}
    header = f"{'slot':>4} {'event':>5}  {'clip':<32} {'rate':>6} {'len':>6} {'peak Hz':>9} {'pure':>5} {'dBFS':>7}  loop"
    print("\n" + header)
    print("-" * len(header))
    for slot in sorted(wanted):
        entry = wanted[slot]
        sound = slots.get(slot)
        if sound is None:
            print(f"{slot:>4} {str(entry.get('Event') or '?'):>5}  {entry['Wav'][:32]:<32}  EMPTY — the bank "
                  "ships nothing here, so this clip never made it onto the disc")
            decoded[slot] = {"empty": True}
            continue
        samples = decode_psadpcm(sound["frames"])[:sound["samples"]]
        hz, purity = dominant_hz(samples, sound["rate"])
        loops, note = loop_reading(sound)
        # Only the first channel run is decoded, so say so rather than letting a stereo slot read as if the
        # whole of it had been measured. On a course bank this is slot 64 and nothing else — the shared glass
        # smash [Trailmap: 260-slot-64] — and the last time it was read as mono its size was misreported by
        # half.
        if sound["channels"] > 1:
            note += f"  [{sound['channels']}ch — channel 0 only]"
        seconds = sound["samples"] / sound["rate"] if sound["rate"] else 0.0
        print(f"{slot:>4} {str(entry.get('Event') or '?'):>5}  {entry['Wav'][:32]:<32} {sound['rate']:>6} "
              f"{seconds:>5.2f}s {hz:>9.1f} {purity:>5.2f} {rms_dbfs(samples):>7.1f}  {note}")
        decoded[slot] = {"hz": hz, "purity": purity, "loops": loops, "note": note,
                         "dbfs": rms_dbfs(samples), "rate": sound["rate"], "seconds": seconds}
        if args.wav_dir:
            write_wav(args.wav_dir / f"{bank}-{slot:03d}.wav", samples, sound["rate"])
    if args.wav_dir:
        print(f"\ndecoded WAVs written to {args.wav_dir}")

    if not args.plan:
        return 0
    return grade(json.loads(args.plan.read_text()), manifest, decoded, args.tolerance)


def grade(plan: dict, manifest: dict, decoded: dict[int, dict], tolerance: float) -> int:
    """Grade the plan's audio cells against what the bank decodes to.

    Only the cells carrying a fixture CLIP are gradeable here: a retail event names a sound nobody wrote down
    a pitch for, and inventing an expectation for it would be the harness proving its own assumption. Those
    rows are printed as measurements instead.
    """
    cells = plan.get("audio") or []
    if not cells:
        print("\nthe plan carries no audio cells")
        return 0
    by_event = {entry["ExportedEvent"]: entry for entry in manifest.get("Sounds", [])}
    print()
    print(f"{'cell':<24} grade         what the disc holds")
    failures = 0
    for cell in cells:
        routed = by_event.get(cell.get("event"))
        if routed is None:
            print(f"{cell['id']:<24} {'n/a':<13} retail event {cell.get('event')} — no fixture clip, so this "
                  "cell has no pitch to check")
            continue
        heard = decoded.get(routed["Slot"])
        if heard is None or heard.get("empty"):
            grade, note = "FAIL", f"slot {routed['Slot']:03d} is empty — the clip is not on the disc"
        else:
            wants_loop = cell["expect"] in ("sounds", "gated")
            expected = cell.get("toneHz")
            problems = []
            if wants_loop and not heard["loops"]:
                problems.append("does not loop — a continuing emitter on a one-shot slot goes silent when the "
                                "sample runs out")
            if cell["expect"] == "one-shot" and heard["loops"]:
                problems.append("loops, and a collision hit must not")
            if "SUSPECT" in heard["note"]:
                problems.append(heard["note"])
            if expected and abs(heard["hz"] - expected) > expected * tolerance:
                problems.append(f"reads {heard['hz']:.0f} Hz where the fixture wrote {expected} Hz")
            if heard["purity"] < 0.5:
                problems.append(f"is not a clean tone ({heard['purity']:.2f} of its energy at the peak)")
            if heard["dbfs"] < -40:
                problems.append(f"is near silent ({heard['dbfs']:.0f} dBFS)")
            grade = "FAIL" if problems else "pass"
            note = ("; ".join(problems) if problems
                    else f"{heard['hz']:.0f} Hz at {heard['dbfs']:.0f} dBFS, "
                         + ("looping" if heard["loops"] else "one-shot")
                         + f", slot {routed['Slot']:03d}")
        failures += grade == "FAIL"
        print(f"{cell['id']:<24} {grade:<13} {note}")
    print()
    print(f"{plan.get('name', 'plan')} bank: {failures} failure(s)")
    print("This grades the BYTES, not the console: a slot that decodes correctly can still go unheard if the "
          "engine never starts a voice on it. audio_voices.py is the other half.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
