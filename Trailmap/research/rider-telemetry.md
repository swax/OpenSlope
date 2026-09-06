# Played Rider Telemetry

`tools/instrumentation/rider_telemetry.py` turns an ordinary PCSX2 playthrough into a
frame-indexed behavioral reference trace. It does not require a choreographed
gold suite: play normally and mark problems just after they happen. Each marker
automatically points back over the preceding three seconds by default.

The target is the PAL `SLES-50545` image with PCSX2 PINE on
`127.0.0.1:28011`. Coordinates stay in their original form: Z-up and 100 engine
units per metre. Conversion and comparison are downstream operations; the
capture retains the source values.

## One played run

Run these commands from the repository root.

First pause the **emulated VM** using PCSX2's Pause Emulation action. SSX's own
start/pause screen is not enough: PINE reports that case as `running` even when
the SSX game-frame counter is frozen.

```powershell
python tools/instrumentation/rider_telemetry.py status
python tools/instrumentation/rider_telemetry.py prepare
python tools/instrumentation/rider_telemetry.py capture --label snowdream
```

`capture` can start while the VM and game are paused. Switch to PCSX2, resume
the VM, then start and play the course. The default output is a timestamped
JSONL file under `temp/telemetry/`.

During play:

- Press **Circle** immediately after anything worth revisiting. This is a
  generic marker and is usually easiest while holding the controller.
  Circle is absent from the shipped `BTNMAP0/1` riding-control map (Antic/jump
  is X, Boost/Tweak is Square, and optional CameraReverse is Triangle), so the
  marker does not inject a riding command.
- Background keyboard markers work while PCSX2 has focus:
  **Ctrl+Shift+J** = jump, **G** = ground/contact, **L** = landing,
  **P** = pass-through, and **M** = generic.
- Marker timing need not be precise. With the default
  `--marker-lookback 3`, a marker at frame 1,000 identifies the window beginning
  around frame 820.
- **Ctrl+Shift+Q** stops recording globally when the recorder runs in an
  interactive desktop terminal. A reliable stop from a second terminal is
  `python tools/instrumentation/rider_telemetry.py stop`; it works while the game is
  paused and lets the recorder write its footer. Ctrl+C also works when the
  capture terminal has focus. A time limit can be supplied with `--seconds N`.

After stopping, pause the PCSX2 VM again and restore the exact hook state that
existed before `prepare`:

```powershell
python tools/instrumentation/rider_telemetry.py restore
```

Do not delete `temp/telemetry/rider-telemetry-hook-state.json` if preparation
or restoration is interrupted. It is the recovery record. Pause the VM and run
`restore` again.

## Why `prepare` exists

The current live noclip patch has four detours. Its A detour only observes the
raw controller and writes the held mask/LX/LY into a passive data block. The B,
C, and D detours can change velocity, input, and wipeout behavior when noclip
is activated. A normal trick can press face-button combinations, so merely
leaving the active flag at zero is not a strong enough gold-capture boundary.

`prepare` therefore:

1. requires the PCSX2 VM to be paused;
2. saves the exact B/C/D words and active flag;
3. leaves passive pad observer A connected;
4. restores B/C/D to their stock instructions; and
5. verifies all writes before capture is allowed.

`restore` puts back the saved words exactly. Capture itself only reads PINE
memory and writes the host-side trace.

## What every frame contains

Each `kind: "frame"` JSONL record is fenced by the SSX game-frame counter: the
counter is read, all fields are sampled, and the counter is read again. If it
changed, the sample is discarded and retried. This prevents a position from
one tick being paired with contact data from the next.

Decoded groups include:

- position, velocity, the orientation quaternion, its visible board-forward
  basis vector, timestep, heading, and speed cap;
- the active render camera's position and right/up/forward basis on every
  frame, its decoded 0.825-rad horizontal half-FOV / 4:3 vertical FOV / near
  clip, plus the exact adjacent raw camera words;
- motion/control states and important ground/race flags;
- surface type, contact error, bog/budget depths, normal, smoothed up,
  probe/contact tangents, and lateral axis;
- per-surface visual deck lift, lateral lean-pose offset, and the actual render
  bank composed by the game;
- jump charge/snapshot, lean, slip, prewind, and airborne spin slew fields;
- the final post-blend 19-bone body pose: animated hip translation, all 57
  local Euler rotation channels in radians, current animation event ids, and
  the final board/render position and matrix;
- raw held-button mask and left-stick bytes.

Schema v4 resolves model part id 0 from the live rider, decodes its 84-byte MPF
bone records into the header (name, parent, bind translation/rotation), and
samples its 60-channel evaluated pose every tick. These are the values after
the animation layers have blended, not the authored AFL curves in isolation.
The exact skeleton and channel words are retained. Batched PINE requests keep a
live 19-bone sample to about 3.8 ms on the current test machine, below one 60 Hz
frame budget. Use `--no-rig` only when diagnosing an unsupported character/model.

A best-effort `detail` record every ten frames (configurable with
`--detail-interval`) carries path arc/lateral error, closest/lookahead points,
DTF, auxiliary contact vectors, and the final board/render matrix. If a detail
read crosses a game-frame boundary it is discarded rather than delaying the
next core sample; its drop count is explicit in the footer.

The `raw` object keeps the exact little-endian words backing every named field.
This is intentional: when later RE gives an offset a better meaning, old
playthroughs can be reinterpreted without replaying the course. Unrelated gaps
in the 23 KiB boarder object are omitted so a complete snapshot remains fast
enough for every 60 Hz tick.

The footer reports coherent-snapshot retries and any missed game frames. An
ideal canonical trace has `captureSafety.observerOnly: true`, no error record,
and zero missed frames. A trace with misses can still be useful around marker
windows; the gap count makes the limitation explicit.

## Sample cost and the golden profile

Missed frames track coherence retries almost one for one: a sample that straddles
a tick is discarded, and the retry costs enough wall time to lose the next game
frame outright. Packet count is therefore the direct lever on the miss rate, and
one frame's fenced payload — every boarder region, the active camera record and
the pad words — is read as a single batched request. `Region64Batch` collects the
regions, `read_frame_anchor` resolves the pointer chain and the opening fence
against the previous frame's pointers, and the closing fence re-checks the chain;
a core sample is three requests, or four with the rig.

`--golden` drops the rig and detail passes for runs that will become golden-run
references, where an unbroken frame sequence matters more than body pose. It sets
`captureProfile: "golden"` in the header. The camera stays in the fenced payload:
once the payload is one request, an extra region costs commands rather than round
trips.

For a statistical study — `rig-study`, `camera-study` — a few percent of dropped
frames is harmless, because those bin samples and take medians. For an input
stream it is not: a single-frame button press occupies exactly one frame, so one
lost frame silently erases a whole edge.

The recorder re-resolves the world, clock, and local-human boarder pointer for
every coherent sample. Restarting a run or changing race modes may replace the
boarder allocation; that produces an explicit `context` record and sampling
continues against the new object. Frame-counter resets or implausibly large
jumps are reported as discontinuities, not as fabricated missed-frame totals.

## Review and annotation

Summarize a trace and automatically locate air/contact transitions. Each
transition reports speed plus signed trajectory and visible-board pitch, so a
natural lip can be compared without opening the periodic detail matrix:

```powershell
python tools/instrumentation/rider_telemetry.py analyze temp/telemetry/snowdream-YYYYMMDD-HHMMSS.jsonl
```

For a focused Garibaldi turn study, coast straight briefly, hold one direction
long enough to settle, release to neutral, then hold the other direction. Repeat
once at a different speed and mark each completed maneuver with **M** or Circle.
The rig report bins grounded samples by the game's own lean slew, prints the
largest left/right bone-pose deltas and per-bone angular speeds, and emits JSON
that can be used to tune or import a Slopesmith pose:

```powershell
python tools/instrumentation/rider_telemetry.py capture --label gari-rig
python tools/instrumentation/rider_telemetry.py rig-study temp/telemetry/gari-rig-YYYYMMDD-HHMMSS.jsonl --negative-event 758 --neutral-event 757 --positive-event 760 --json-out temp/telemetry/gari-rig-study.json
```

By default `rig-study` uses only motion-state 2 (ordinary ground riding), with
settled bins at lean `<= -0.35` and `>= +0.35` and neutral at `abs(lean) <= 0.08`.
Use `--all-motion` for air/rail/recovery clips, or change the thresholds when a
short run did not reach both bins. The optional event filters select one event
id in `--event-layer` (the third layer, index 2, by default) after lean binning;
omit them until a first report shows which events settle during the maneuver.
Euler axes are kept in the retail local
representation: negate local XYZ, then compose `Rz * Ry * Rx`, matching the
MPF/glTF path and recovered AFL poses. Representative joint coordinates are
medians of complete per-frame hierarchy reconstructions; they are deliberately
not reconstructed from mean Euler angles, which biases remote knees and hands.

The 2026-07-19 GARI rig run produced 2,310 coherent final-rig frames (2,032
ordinary ground), covering surface ids 1/3/5 for 1,392/39/601 frames. Its third
animation layer predominantly held 757 in neutral, 758 through settled negative
turns and 760 through settled positive turns. The capture's opposite-stance
skeleton is uniformly 0.85 of the Mac skeleton: X-mirroring, exchanging the
left/right limb chains, and multiplying by `38.597 / 32.807` reproduces the
offline Mac neutral pose to millimetres. That provides a useful normalization
check before copying live joint coordinates into a differently sized rider.

The focused 2026-07-20 GARI ice run is
`ResearchData/telemetry/gari-ice-turn-retail-20260720-153219.jsonl`. Its first continuous
SurfaceType-5 interval supplies 534 grounded samples over 8.6 seconds. At full
right near 15.4 m/s the retail board yawed at a 77.5 deg/s median while travel
yawed at 42.3 deg/s, retaining 22.8 degrees of heading/travel slip. The matching
Slopesmith v5 trace (`riding-gari-2026-07-20T22-37-43-395Z.jsonl`) proves a full
right input but measures only 27.0/20.4 deg/s board/travel yaw and 13.4 degrees
of slip. History identifies the root port regression: the 2026-07-10 ground-model
commit added an extra `0.5` multiplier on top of the recovered heading curve's
own `c7 = 0.5239824` coefficient. The active profile restores that multiplier to
`1.0`; it does not add an ice-only lean force. The recovered banked contact-frame
response remains shared by every surface, while the retail three-component
turn-response helper remains open.

The controller-independent gold is
`ResearchData/telemetry/gari-ice-turn-retail-keyboard-20260720-160415.jsonl` (1,214
frames; 428 grounded Type-5 samples). Its first three settled full-key turns
measure board/travel yaw of `102.6/100.0`, `79.2/74.8`, and `65.5/61.8 deg/s`
at 13.43–14.53 m/s, with 26.7–27.5 degrees of slip. The corresponding keyboard
Slopesmith trace, `riding-gari-2026-07-20T23-09-26-575Z.jsonl`, receives exact
`steer=±1` and now reaches the correct slip, but its sustained travel yaw is only
16.3–21.7 deg/s. Re-evaluating the traced contact helper explains the entire
gap: neutral retail ice averages 13.77 m/s² response (the row's `A/100` is
13.5093), while the 4.73 m/s² port settles to only that smaller response. During
settled retail turns the response averages 17.16 m/s². The active port therefore
uses surface A for the grounded normal load and retains Snowdream's 4.73 only as
the independently measured contact-plane pull. That restores the general
banked-frame law rather than adding a Type-5 force.

Summarize one retail camera trace, or compare it directly with a Slopesmith v5
ride trace in common metre-scale framing metrics:

```powershell
python tools/instrumentation/rider_telemetry.py camera-study RETAIL.jsonl SLOPESMITH.jsonl --json-out temp/telemetry/camera-comparison.json
```

The report separates ground/air samples and measures target distance,
horizontal boom, eye height, aim/pitch/yaw error, camera and relative-offset
speed, stale samples, and Slopesmith clearance-branch counts. A v3+ Slopesmith
trace also reports every camera probe as a miss, terrain hit, or obstacle hit,
plus the native obstacle keys and correction-distance distribution. Schema v4
adds the bounded closest-terrain `volume` iterations used after the axis casts. Mark a
visible clip with `M`; the recorder's pre-roll retains the probe history leading
into it, and `F8` or ending the ride saves the segment.

To label every marker interactively without modifying the raw trace:

```powershell
python tools/instrumentation/rider_telemetry.py annotate temp/telemetry/snowdream-YYYYMMDD-HHMMSS.jsonl
```

Or label one marker non-interactively:

```powershell
python tools/instrumentation/rider_telemetry.py annotate TRACE.jsonl --marker 3 --label "tunnel kicker" --note "board passed through lip"
```

Annotations live beside the trace as `TRACE.annotations.json`. `analyze`
automatically includes them. The source JSONL remains immutable and can be
hashed or archived as the behavioral evidence record.

If a host interruption leaves a complete sequence of frames without its final
summary line, `recover-footer TRACE.jsonl` derives and appends only that footer.
It refuses a trace that already has one. Normal stop cleanup retries short
Windows file locks and writes the footer even if a stale stop-request file
cannot yet be removed.

## Record structure

JSONL is used so an interrupted long run remains readable through the last
complete line. Records appear in this order:

1. one `header` with schema, game identity, axes/scale, live pointer chain,
   raw-region map, hook words, and safety status;
2. `frame` records and interleaved `marker` records;
3. an optional `error`; and
4. one `footer` with stop reason, duration, frame/marker counts, retries, and
   missed frames.

The current schema is `ssx-tricky-rider-telemetry/v4`; the general analyzer also
reads the v1 full-frame, v2 compact-rider, and v3 physics/camera layouts. Treat
decoded names as the current RE interpretation and the raw words as the durable
measurement.
