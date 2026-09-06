# autotest — author a fixture, build the ISO, ride it, read the verdict

A closed loop over the real console pipeline. It answers *what the engine supports*, which a survey of what
retail shipped cannot: retail is a corpus of things that were done, and the questions that keep coming up
are about things nobody at EA had reason to do.

```
Slopesmith fixture  ->  repack  ->  PCSX2  ->  the rider descends  ->  per-variant verdict
```

```
python tools/autotest/run.py                          one pass of GOLD, the regression course
python tools/autotest/run.py --skip-map --skip-pack   re-ride the ISO already built
python tools/autotest/run.py --repeat 3               three passes
python tools/autotest/run.py --fixture AUTOTEST1      the full catalogue rather than the subset
python tools/autotest/run.py --fixture AUTOTEST2      ride the bench instead
python tools/autotest/run.py --fixture AUTOTEST4      ride the board-audio instrument, then:
python tools/autotest/audio_signals.py                the per-surface signal table off the newest run
python tools/autotest/run.py --fixture AUTOTEST7      ride the migrated collision lab
python tools/autotest/run.py --fixture AUTOTEST8      build+ride the audio bench (dispatch + bank), then:
python tools/autotest/audio_voices.py --iso discs/ssx-tricky-autotest8.iso \
       --plan Maps/AUTOTEST8/autotest-plan.json       grade what actually STARTED A VOICE
python tools/autotest/audio_tone.py discs/ssx-tricky-autotest8.iso \
       --plan Maps/AUTOTEST8/autotest-plan.json       decode the shipped bank and grade what it SOUNDS like
python tools/autotest/run.py --pine-slot 28012        drive a second emulator rather than the default one
python tools/autotest/run.py --region usa             the same fixture on the NTSC-U disc

# one rider on the mountain instead of six -- see "Choosing a MODE" for why the scalar is 1x
python tools/autotest/run.py --fixture AUTOTEST2 --turbo 1 \
       --menu "cross:76,down:1" --mode showoff
```

The mode comes from the fixture, so no flag is needed for any of them. `--mode` overrides it and is still
what refuses to measure when the front end lands somewhere else.

**The cost of the solo baseline is wall-clock, and it is worth naming.** Menu steering only works at 1×
(below), so a mode-steered pass cannot use `--turbo` — `run.py` refuses the combination rather than letting
it be rediscovered. That is most of why GOLD is a 2.3 km course and not a 6.1 km one: at 1× the catalogue is
four minutes of riding for a green table you already expected. `AUTOTEST3` needs no prelude, so it is the one
fixture that can still be turbo'd.

No setup, no savestate, no human at any point.

## The courses

There are two kinds. **GOLD is the regression test** — ride it to find out whether something broke. The
**`AUTOTEST` courses are the extensive ones**, where the work happens; they are numbered rather than named
after their contents, because a course called `AUTOTEST_GATES` would be a lie one batch later, and because a
spec citation pins a measurement to that number.

| fixture | mode | what it holds |
|---|---|---|
| `GOLD` | showoff | the **regression test**, and the one to ride by default. 24 cells, 2.0 km, one per mechanism — selected out of `AUTOTEST1` rather than copied from it, so a cell edited in the catalogue is edited here. Each carries a line saying what a red row against it *means*, which is a different question from the one the catalogue cell was built to answer. |
| `AUTOTEST1` | race | the **catalogue, first half**: 35 cells, last at 3.2 km. Every cell is a fact hardware has demonstrated. It does not fit in a showoff pass (see the timed-run note below), which is why it rides a race and why GOLD exists. It is also published as an editable Slopesmith project, which makes it the working demo of every effect known to run on a PS2 — open it and every proven node is there, wired, on a prop you can select. |
| `AUTOTEST1B` | race | the **catalogue, second half**: 36 cells, last at 3.29 km. Same job and the same standard of evidence — a separate course only because one race pass cannot reach 70 cells (below). Ride both for the full sweep. |
| `AUTOTEST2` | showoff | the **bench**. Open questions only. A cell here asserts nothing until a batch has answered it, and graduates by being rewritten as a graded cell in the catalogue. **It is FULL**: a showoff pass of it reaches about 1,450 m — well under the 2,660 m a showoff pass covers on an unobstructed course, because a bench dense with contact cells scrubs the rider to 12–18 m/s — and its last reachable cell already sits at 1,490 m. Cells added past that report `not-reached` whatever the engine does, so a new question needs a graduation first, or a course of its own. |
| `AUTOTEST3` | race | the **field**. The only course ridden with opponents, for the questions that are *about* opponents — the one ridden in a mode the scoring gate REJECTS, which makes it the negative half of that pair, and the only place `gate-human`'s rejecting half can be asked at all, since that needs a second board. All the same argument: some questions need a different mountain, and a course is the only thing that can hold one. |
| `AUTOTEST5` | showoff | the **relay**, and the shortest course here: a control and one cell, 440 m. It asked whether an authored **teleport** (MainType 24) moves the rider, aiming one at a bare panel 130 m off the fall line that nothing else can reach. **It does** — 132.9 m in one sample, arriving 3.00 m from the panel with speed cut from 23.9 m/s to nothing, three passes of three. The 3 m and the stop are the handler's own constants, so this reproduces documented behaviour rather than reporting a bare displacement. A lane-based course has its primitive. |
| `AUTOTEST6` | showoff | the **call**: a control and two cells, 320 m. It asked what a MainType-21 node does with a function the level itself authors, and **both halves came back yes**, three passes of three. The body RUNS: a call whose function holds one hop put a node on a companion 130 m off the fall line that carries no chain, on the same sample the caller fired, with the rider measured 129.8 m away. And the body is handed the CALLER'S rider: a cell whose own chain carries nothing rider-acting wrote 4.933 / 5.000 / 5.000 into the boost request from a speed pad inside the called function — and the cell three seconds downhill read that same request decayed to 1.95, so the countdown was running rather than a word read stale. Neither cell reads the caller for its evidence, on purpose: the chain's own debounce already owns that instance's live-node slot, so a node the body installed there would say something ran without saying which table it came from. Its own course for the same reason the relay has one, plus a blunter one — the bench had no reach left. |
| `AUTOTEST7` | showoff | the **migrated collision lab**: the original sixteen profiles plus the mode-1 `PlayerBounce=false` follow-up, kept at their exact scale-1 crash-bag geometry. Pass-through controls run first; every solid case gets one second of unmodified response sampling, then a MainType-24 relay recentres the rider for the next cell. A hidden pass-through trigger 12 m before every specimen posts `stage/17 + original lab label` through Show Message, including the two specimens whose own expected result is no collision dispatch; the plan enables the required HUD patch automatically. The fixture grades dispatch and the rider's velocity discontinuity independently. Its 4,800-frame window is part of the generated plan. Clean default HUD run `20260808-125743`: **17/17 messages posted, 17/17 collision cases passed**, zero regressions and zero inconclusive; calibration passes separate contact-only controls at 0.00–0.02 m/s from solid response at 1.17 m/s or more. |
| `AUTOTEST4` | showoff | the **instrument**. The terrain is the experiment: five 250 m full-width strips of painted SurfaceType (pack / ice / metal / chute / rock) ridden straight while every sample carries the boarder's raw board-audio signal words — `Dig` (+0x160), `Lean` (+0x214) and the `Slip` vector (+0x320). Its two cells are anchors, not questions: the retail control proves the pipeline, and the second gives the analyzer a fall line to project samples onto. `tools/autotest/audio_signals.py` buckets a run's `riderPath` by the plan's own strip spans and reports the measured signal distributions; it carries no retail expression program. An unsteered pass reads the clean-riding baseline (Slip and Lean sit near zero down a straight fall line); `run.py --weave` rides the carving range under the site-C steering cave (see "Steering"), and a steered instrument ride goes `--mode race --frames 14400` — no menu prelude to miss, and the timed-showoff clock replaced by a window long enough for a rider whom a full-lock weave scrubs to ~4 m/s. `Slopesmith/tools/ride-study/board-bed-study.ts` replays those measured inputs through OpenSlope's independent authored response for tuning. |
| `AUTOTEST8` | showoff | the **audio bench**, and the only fixture graded on something other than dispatch. Five cells: the usual retail control, then one placed ambient emitter per mechanism — a retail global event that loads its own named bank and needs nothing injected, a custom clip that goes through the reserved event pool and the repacker's bank injection, a hit-gated custom clip, and a custom collision one-shot. Its verdict comes from `tools/autotest/audio_voices.py`, which reads the engine's own fixed pool of external voices — the same table the runtime's reject pass walks before starting one — so a cell passes on a voice HANDLE existing rather than on a node having been built. That distinction is the reason the course exists: a custom emitter shipped silent for as long as the feature had existed, with a correct export, a correct ADL row and the right clip in the right bank slot, because the slot carried the one-shot end marker and the SPU releases a voice when its samples run out. Every graded fixture said it was fine. The gated cell is also this course's silence control — the engine holds it quiet until the rider hits its prop, so a pass where everything sounds fails here instead of reading green. Its SECOND grade comes from `tools/autotest/audio_tone.py`, which opens the finished ISO, decodes the course bank's own PS-ADPCM and reports the pitch it hears and the loop the bytes describe. That half needs no emulator and catches what the pool structurally cannot: the pool grades voice ALLOCATION, and this course's own retail-slot cell proves the engine allocates one for a sample that stops. The two together are the claim — the bytes sustain, and the engine started a voice on them. |

**The baseline is a solo mountain, and that is a measurement decision rather than a convenience.** Every
rider-acting opcode acts on the boarder its effect thread was handed rather than on whoever touched the prop,
so a field of five rivals turns a deterministic node into a lottery — the two pad opcodes read as dead for
days on a 3-in-42 rate that had nothing to do with the pads and everything to do with who else was on the
hill. Riding showoff removes that variable from every cell at once. What is left for `AUTOTEST3` is the
residue: cells whose question cannot be asked alone, which so far means *who* gets an effect when there is
more than one candidate, and anything reading the course reset's placement (it averages the **other** riders'
distance to finish, so alone that average has no terms).

### A showoff run is TIMED, and that is what sets the length of a course

Found by trying. A showoff pass of the full catalogue ended — level restarted — at **128.6 s** with the rider
**2,660 m into a 6,110 m course**, leaving 38 of 67 cells unreached in one contiguous block from 2,750 m
down. Three race passes of the same course ran their full 240 s window, reached ~5,900 m, and left 3–4
unreached. So a showoff event is a timed run of about two minutes; nothing else about the pass was wrong, and
the roster read 1 rider exactly as intended.

**2,660 m is therefore the budget any solo course is built against**, and it is why GOLD's last cell sits at
2,120 m with the run-out ending at 2,330 m. Spacing stayed at the proven 90 m rather than being squeezed to
fit more in: the attribution window is nearest-cell and the launcher needs room to land, so the cell *count*
is the thing to trade, not the spacing.

The catalogue rides a race for the same reason. That costs it the rider lottery and it can afford it: almost
every catalogue cell grades **dispatch** — whether the engine built the node — which does not care whose
contact built it. Every cell that reads the *rider* is on GOLD, the bench or the field, all of which ride
alone.

### A race pass reaches ~5,900 m, so the catalogue is two courses

At 70 cases the catalogue's last row sat at **6,350 m** and the bottom six — `cracked-tough` and its
companion, both button cells, the vent and the course reset — could never report, whatever the engine did.
They graded `inconclusive` on every pass, which is the failure that looks like a harness problem and is not.
The cost was never only those six: it taxed every future graduation, because anything added at the bottom
pushed something else out of reach.

Split at a group boundary rather than at the midpoint, so no pair is separated from the control that makes it
readable, each half now ends around 3.3 km with ~2.6 km spare. GOLD selects from *both*, since the catalogue
is still one body of evidence and only the riding is divided.

**A lane-based course would not have fixed this**, which is worth stating because the teleport makes it look
like it should. The budget is TIME, and a teleport spends it rather than saving it: the placement zeroes the
rider's velocity, so they arrive stopped and take about five seconds to rebuild to 21.4 m/s — slower than the
~33 they were carrying. Against 2.7 s of riding per cell, one warp costs more than the cell it would save.
The only thing that buys rows is another run.

### The budget is TIME, so a shorter mountain is not more cells — and that is worth being exact about

A course is a single fall line with its cells strung down it, and the obvious way out is to stop making it a
line: lanes side by side, the rider handed from the bottom of one to the top of the next. `AUTOTEST5` exists
to find out whether the one opcode that could do that — MainType 24, teleport to a named instance — works
from an authored level at all.

**What it would buy, and what it would not.** The ceiling above is a clock, not a distance. A showoff run
ends at ~128.6 s whatever shape the terrain is, and a rider covers ~2,660 m in that time whether it is one
6 km slope or six 400 m lanes. So lanes do **not** add cells on their own, and anyone reaching for them to
fix `AUTOTEST1`'s reach problem will find the same 240 s. Three things they *would* buy:

- **A rider off the race line.** Opponents follow the authored line, so lane 2 and below are somewhere they
  never go. That is the one way `AUTOTEST1` could keep race's 240 s window and stop paying the lottery,
  which is the only reason it rides with company at all — and it is the biggest of the three by far, because
  it is worth a doubling of the measurement window rather than a saving on disk.

  **A bare teleport at the start does the opposite.** A full-corridor gate is crossed by the whole field, so
  the best case is an arbitrary subset of six riders landing in one spot. The separation has to be
  *selective*, which means a condition in front of the move — `gate-human`, whose rejecting half has never
  been askable on a course with one board. `human-gate-warp` on `AUTOTEST3` is that pair, and it is worth
  riding even if the teleport is dead, because it settles the gate either way.

  Note that the teleport is itself rider-acting and so is subject to the same owner-word lottery. That is
  not only a hazard: **a body moving 130 m is a far better probe of that word than a float reaching 5.0**,
  which is what `pad-gate` has been squinting at for four batches. Making it decisive wants every rider's
  position rather than the local one's — `find_roster` in `ee.py` already recovers all six boarder
  addresses, so what is missing is sampling `+0x140` on each of them rather than any new discovery.
- **Cells packed by time rather than by ground.** The 90 m spacing is there because attribution is
  nearest-cell and a launcher needs room to land. A rider warped from cell to cell spends the ~4.5 s of
  travel between them on nothing; lanes reclaim that only if the teleports are per-cell, which trades a dead
  cell costing one row for a dead teleport costing every row below it. Worth doing only against a
  demonstrated firing rate, and lanes that are also rideable end-to-end make the failure degrade instead of
  stall.
- **A mountain small enough to be cheap.** 6.35 km of quilt exists only because the cells have to go
  somewhere.

None of that was worth designing against until the primitive was measured, which is why `AUTOTEST5` is two
cells rather than a lane fixture — **and the primitive works.** An authored MainType-24 node moves the rider
132.9 m to a placement they could not otherwise reach, landing 3.00 m off it, stopped.

**And it lands on the PLAYER in a race.** `human-gate-warp` on `AUTOTEST3` puts a `gate-human` in front of one
and rides it against five opponents: three passes of three, the local rider moved 132.0 / 127.5 / 132.4 m on
the frame the cell fired, each time from ~30 m/s to a standstill, each time on their own contact with the slot
empty until then. Two further facts came out of the same passes and both matter more to a lane fixture than
the warp does:

- **The lane is ordinary rideable ground.** After the warp the rider descended the half-corridor at 21.4 m/s
  for ~45 s and roughly a kilometre, undisturbed.
- **Being off the line is not on a leash; being STATIONARY is.** The engine put the rider back on the race
  line, but only after they had come to a stop — 0 m/s at 52.5 s, reclaimed at 53.9 s. A lane whose cells keep
  a rider moving is not fighting the engine. One that dead-ends is.

What none of that settles is `gate-human`'s rejecting half — which is what the roster column below was built
for.

### Sampling the whole field, not just the rider

Every signal in this harness reads the local human. That is the right subject for "what did this cell do to
me" and no use at all for **"which of six did it act on"** — and that second question is the one standing
between several cells and an answer, because a rider-acting opcode services the boarder its effect thread was
handed rather than whoever touched the prop.

So `riderPath` now has a companion, `rosterPath`: every rider's position, in roster order, read in the **same
packet** as the local rider's own row. Sharing the packet is not tidiness — "who moved" is a comparison
between riders, and reading them a round trip apart would let one rider's position be a frame older than
another's, which at 30 m/s invents most of a metre of relative motion in the one measurement whose job is to
attribute a displacement to a single body.

Nothing had to be discovered for this. `find_roster` in `ee.py` already recovers every boarder address off the
heap snapshot `attach()` takes anyway, before the window opens, so the field costs three words per rider per
tick and no extra search.

Each cell then reports a **`warped:`** column naming any rider relocated while it owned the run — `rider 3
(local) 132.03 m @7.25s`. Two properties are worth knowing:

- **The window is half-open.** It runs from this cell's dispatch to the *next* cell's, so a cell that fires
  and relocates somebody on the same sample owns that relocation and the cell above it does not also claim
  it. Without the upper bound every cell inherits the end-of-run reclaim.
- **Stale entries are dropped.** A roster address that stops being a rider reads as garbage rather than as a
  position, and garbage differences are enormous, so anything past 100 km is a dead pointer rather than a
  warp.

It made `human-gate-warp` decisive on its first ride, and it applies unchanged to the pads: their owner word
is the same `thread+0xe8`, and "it wrote on somebody else" stops being a hypothesis the moment the somebody
else can be named.

**What it read.** Three passes, six riders, and exactly one body relocated each time — the player, 125.9 /
115.1 / 126.0 m. None of the five opponents moved, and they were not merely absent: **15 AI contacts within
0.2–1.6 m of the gated panel's origin against 3 human ones, and a tally of 0 warps to 3**. In two of the three
passes all five opponents crossed *before* the human with the slot still empty and nothing was built, which is
the half a debounce cannot explain away. So `gate-human` **rejects an AI rider**, which had been unaskable
since the node was added — a solo course has one board, and a field course could not see what the other five
did.

That is also the shape of the answer the pads need. It cost one ride because the instrument was the thing
missing, not the data.

### A control has to be where the rider IS, and on a race course that is not the top

`AUTOTEST3`'s control reported `not-reached` or `pre-occupied` on six straight passes with the rider 69–118 m
wide of it, which is a worse failure than no control at all: a dark control is supposed to stop you reading
the rows beneath it, and one that is dark every time for reasons unrelated to the harness teaches readers to
skip the top row — so they will skip it on the run where it matters.

**The cause was distance, not size.** Six riders leave the gate abreast and the pack decides where the player
is until it has sorted itself out, which takes about 200 m. Moved from 140 m to 230 m, the same crash bag
fired in three passes of three with the rider 1.7–2.1 m from it. `leadInM` on the fixture is the fix.

**Widening it was the wrong fix twice over**, and both failures are silent, so it is worth knowing before
anybody tries it again. A 300 m corridor-spanning volume in the first slot came back `pre-occupied` twice and
`not-reached` once:

- **The reach test is ORIGIN-based.** `crossed` and the attribution window use a 25 m ball around the prop's
  own origin, so a rider 83 m wide of a 300 m box has physically crossed it and still reports `not-reached`.
  Box extent never enters into it — **a wider cell is not an easier cell to reach.**
- **Wide and early is worse than narrow and early.** The first of six riders abreast to touch a
  corridor-spanning trigger fills its slot before the harness starts sampling, so widening the control made
  an opponent more likely to claim it, not less.

### The signal that measured 1.43 m while the rider moved 132.9

Worth keeping, because the first reading of that batch said the opcode was dead, and every corroborating
number agreed with it.

Rider signals are attributed from the moment a cell FIRED. All of them but `jump` are peaks over single
samples, so a window opening at dispatch contains what it needs. **`jump` is a difference between two adjacent
samples**, and a teleport acts AT dispatch — so the "after" sample was inside the window and the "before"
sample was one index outside it, and the reading fell back to the 1.43 m of ordinary riding that followed.
Three passes, consistent to two decimal places, reporting a node that did nothing.

Nothing else in the report contradicted it. The cell dispatched, the chain ran on, the rider was where the
course expected. The way it was caught was reading the raw `riderPath` out of a saved run rather than the
graded row — which is the general lesson: **a derived signal can fail while every input to it is correct**,
and the only defence is that the raw samples are kept in the report. `_rider_signal` now hands `jump` one
sample of lead-in, and only `jump`; replayed against the three saved runs it returns 132.9 m and leaves the
control cell's 1.57 m untouched.

### Freeride is not ridable, and does not need to be

Worth recording because it looks like the obvious solo mode and is a dead end twice over.

**It is unreachable from the front end this driver can steer.** The top-level menu is a three-entry ring:
from the default, one DOWN lands on showoff (mode 3), two on race (mode 7), three back at the default
(mode 2), and UP from the default does not move at all — all measured, each one an aborted run that `--mode`
caught. The menu dispatcher `sub_0029b458` has five branches off the table at `0x003b3d90`; screens 8, 9 and
12 are the three that ring visits, and both freeride branches are screens 10 (mode 1) and 11 (mode 6), which
it never reaches. Getting there means driving a submenu, not lengthening a prelude.

**And it would lose coverage if it were reachable.** Main types 6, 14, 15 and 16 test the mode word for
{3, 5} and return early otherwise, so boost-meter fill, the gem multiplier and the time bonus are all dead
outside showoff. Freeride is solo *with those four opcodes dead*; showoff is solo *with them live*. There is
no question showoff cannot answer that freeride can, so the solo baseline is showoff and this is closed.

Each fixture declares its own mode, and the plan it produces carries it, so the driver reads the mountain
rather than being told. A plan written before that field existed says so on the run rather than quietly
falling back.

They are separate courses rather than two halves of one because of what a mixed report does to a reader: it
comes back with graded rows and open rows interleaved, the eye learns to skim the ungraded ones, and the one
row that mattered gets skimmed with them. Each fixture builds its own export directory and its own ISO, so
building one never disturbs the other, and `tally.py` refuses to average two of them together — they share
cell ids (both open with the same retail control) so a mixed batch would report a fire rate over passes that
were not asking the same question.

## Two discs

`--region usa` builds the fixture into the NTSC-U disc instead of PAL. The **fixture does not
change** — same course, same cells, same plan — so a pair of passes is a comparison of the two
executables and nothing else.

Three things follow the disc, and each of them fails in a way worth knowing:

- **The two absolute addresses this harness reads**: the registry singleton and `GameModeGlobal`.
  Everything else it touches is a class offset and is identical in both builds, which is why the
  build record is two words long. They are selected from the serial PCSX2 reports, asked once per
  connection. Wrong, and the pointer chain resolves to something that is not a world, so the ride
  reports that no level ever came up — loud, rather than plausible numbers off the wrong object.
- **The front-end prelude.** Held per build, and a number carried across from the other region is
  the failure the table exists to prevent: the count is really a duration, and the two discs do not
  present their menus at the same rate. NTSC-U commits at tap 69 where PAL commits at 78 — a nine-tap
  gap, which is more than the drift `MODE_RETRIES` absorbs. A mode with no calibration for a disc is
  **refused** rather than ridden without a prelude, because riding without one takes the front end's
  default and reports it under the mode that was asked for.
- **The ELF patches.** `--hud-text` and the rest are selected by the boot executable named in the
  disc's own `SYSTEM.CNF`, so a descriptor authored for one region can never be written into the
  other's executable. Nothing here has to know about that.

The output ISO carries the region in its name unless it is the default, so `ssx-tricky-gold.iso`
still means what it always did and a USA pass writes `ssx-tricky-gold-usa.iso` beside it rather than
over it. The report is stamped with both `region` and `build` — the same fixture on two executables
is two measurements, and which one a report came from is not recoverable from the numbers in it.

## Getting into a course

`pad_drive.py` mashes CROSS into the decoded controller state until a course comes up — the same thing a
person does to get into Garibaldi. It is a code cave at site A (`0x0017B104`, the pad decode the noclip
patch already vetted) that ORs forced buttons into what the decode just stored.

A savestate would have been the obvious alternative and it does not work here: one restores all of EE RAM,
so a state taken in-level restores the level it was taken in, and a harness that rebuilds the map every
iteration would ride a stale course forever.

**The harness cannot drive a disc built with `--patches noclip`.** Both hook site A, and `wait_for_elf`
waits for that site to read its STOCK words — which is how it knows the ELF has finished loading. On a
noclip disc it never does, so the wait burns its 120 s and raises "the game executable never settled in EE
RAM". From outside, a script that retries looks exactly like a disc stuck at the intro movie, because
nothing is pressing anything. Build the disc without `noclip` when the harness has to ride it; other
patches do not share that site.

Three details that are not optional:

- **Do not install into the executable before the runtime exists.** The blob this cave lives in is real
  (unreferenced) code in the shipped ELF, not zero padding. On a cold boot site A reads its stock words at
  ~3 s while the loader is still writing the image, and a cave installed in that window gets overwritten —
  the hook then jumps into the loader's output and takes PCSX2 down with an access violation. The gate is
  the game's registry singleton, which appears at ~6 s.
- **Mash twice.** The level pointer chain completes while the rider is still held at the gate through the
  countdown. Stopping there produces a run that never starts, and every cell then reports — truthfully and
  uselessly — that it was never reached. The second phase taps until the rider has actually left the gate.
- **"Left the gate" is not a distance.** The chain also resolves before the level has finished placing the
  rider, so a position read at that instant is not the start gate, and the subsequent jump *to* the gate
  clears any displacement threshold within a frame or two. A run accepted that way is indistinguishable from
  a real one until its report comes back with every cell unreached. So the baseline is taken once the level
  clock has run (~1.5 s), and displacement has to arrive with motion still in progress: a teleport is a large
  gap between two stationary samples, a descent keeps producing new ones.

- **A crash leaves a recovery record, and it must not wedge the next run.** The cave writes down site A's
  original words before it installs, and an emulator that dies mid-run never gets to restore them. That
  record then describes bytes which no longer exist anywhere — the ELF is streamed fresh off the ISO at every
  launch — so the install discards it when site A reads stock, and still refuses when it does not. The
  arbiter is what the memory says, not what the file says.

Past the gate the run needs no input at all: the fixture is a straight fall line and gravity carries it. The
pad cave is therefore **removed, not merely disarmed, before anything is measured** — every verdict is a
claim about the retail engine and none should be made with a detour of ours still in the pad decode.

### Choosing a MODE, and why steering is blind but arrival is not

Mashing CROSS takes the defaults, and the defaults are a six-rider **race** — which is the wrong mountain for
two whole classes of question. A collision chain acts on the boarder its effect thread was handed rather than
on the rider who touched the prop, so a field of opponents is a field of wrong owners; and four opcodes (main
types 6 and 15, 14, 16) do nothing at all outside **showoff**.

**Showoff is the mode to ride, and it answers both at once** — measured, and against the prediction. The
dispatcher puts showoff on the same footing as race (`screen 9 → {3,–,5}` beside `screen 8 → {2,–,4}`, same
three-way sub-selector), which reads like two event types with one field between them, and freeride looked
like the solo one. The roster probe says otherwise: **showoff runs 1 rider, race runs 6.** The structural
argument was about how the menu is *built*, and the count is about what the mode *does*. Where those disagree
the count wins, which is the entire reason that probe exists.

The engine's own mapping, off the 10-entry jump table at `0x00365730` that turns the mode enum into
`FreerideMode` / `RaceMode` / `ShowoffMode`:

| mode | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|---|
| | race | **freeride** | race | **showoff** | race | **showoff** | **freeride** | race | **freeride** | race |

**Steering cannot be closed-loop.** The top-level selector is an argument to the menu dispatcher
(`sub_0029b458` takes it in `a0`) rather than a field of any object reachable from a global, so there is
nothing to poll while pressing and a repeat-until would walk past the entry it was aiming at. `--menu`
therefore takes a scripted prelude — `--menu "cross:2,down:1"` — run before the mash.

**Arrival is checked instead, and that is what makes the blind half safe.** `--mode freeride` refuses to
measure unless `GameModeGlobal` says the front end landed there. Without it a prelude that is one press off
does not fail; it rides a different mode and reports a full page of perfectly plausible, wrongly-attributed
results, which is the worst thing this harness can produce.

Finding the prelude is one calibration run:

```
python tools/autotest/emu.py modescan discs/ssx-tricky-autotest2.iso
```

It taps CROSS one press at a time and watches the mode enum. Steering is unobservable but the **commit** is
loud — that word is written the moment an entry is chosen — so the tap it changes on is the tap that landed
on the top-level menu, and the DOWN presses belong immediately before it. That turns "guess a button
sequence" into "insert n presses at a known index". Re-run it only if the boot path changes.

Measured on this disc from a cold boot, at two scalars:

| scalar | mode commits at | level up at | prelude |
|---|---|---|---|
| 1× | tap 77–78 | tap 96–97 | `cross:76,down:N` — **verified**, not derived; see below |
| 3× | tap 28 | tap 36 | `cross:27,down:N` |

The ratio between them is the point, and it is why the next section exists: 77/28 ≈ 2.75 against a 3×
scalar, because the count was never a count.

Two things about that number are worth knowing before trusting it. It is really a **duration** — 77 taps at
this driver's pacing is about 23 seconds of front end — so a prelude has to keep the same press rhythm, which
is why `tap()` and the scan share one. And the nineteen taps between the commit and the level are character
and course select: a DOWN that lands among *those* steers a course rather than a mode, which is why the
prelude ends before tap 77 rather than anywhere later, and why `--mode` exists to catch it when it doesn't.

**The number drifts with host load, and recalibrating does not always rescue it.** `cross:76` rode
three-for-three one morning and then missed **twelve consecutive boots** across three batches once the machine
got busier — a slower host advances less menu per tap, so the schedule slides. `modescan --taps 130` then put
the commit at tap 78 rather than 77, and `cross:77` missed as well. So the calibrated index does **not**
reliably transfer from the scan to the prelude driver even though they share `tap()`; something else in the
boot differs. Treat a run of `ModeMismatch` as a reason to stop steering rather than to keep re-rolling:
`--mode race` needs no prelude at all, allows turbo, and is the right escape for any cell that is not
rider-graded. `MODE_RETRIES` absorbs the flaky case and cannot absorb a shift. [open]

#### DERIVING the prelude from the scan is the mistake; VERIFYING it costs one boot

The paragraph above is the symptom. The cause is now pinned, and it has cost two batches, so it is worth
being blunt about: **`cross:77` was derived from the scan** — commit at tap 78, so put the DOWN at 77 — and it
missed **four boots out of four**, while `cross:76`, one press earlier, took showoff on the first try. Both
measured the same afternoon on the same disc. The scan and the prelude driver share `tap()` and still do not
agree, and the disagreement has a **direction**: the working prelude sits *two* below the scanned commit, not
one.

Do not reason about why. Check:

```
python tools/autotest/emu.py modescan <iso> --menu "cross:76,down:1"
  tap 2: GameModeGlobal 0 -> 3 (showoff)                      <- this prelude works
python tools/autotest/emu.py modescan <iso> --menu "cross:77,down:1"
  the level came up at tap 19 but the mode word never moved   <- this one does not
```

That is **one boot and no ISO build**, against three boots behind ten minutes of packing to learn the same
thing from a ride. `MODE_PRELUDES` in `emu.py` holds the verified number **per build**; when a batch starts
missing, re-verify it this way rather than re-deriving it from a fresh scan.

**Measure the whole window, not the first number that works.** Three boots instead of one, and what they buy
is knowing which side of the edge the entry sits on. NTSC-U scanned a commit at tap 69; 66 lands in *race*
and both 67 and 68 take showoff, so the window is two presses wide and the entry is its upper edge. A single
verified number cannot tell you whether it is in the middle of a comfortable window or one press from
falling into the neighbouring mode, and that is exactly what drift moves it across.

**And keep the host quiet while a steered pass boots.** The prelude is host-timed tapping against a game-time
front end, so a test suite or a compile running beside it is not background noise, it is the variable. The
four-for-four miss above had a browser-based WebGL test suite running alongside it.

**PCSX2 itself dies at the gate sometimes.** Three times in one day, `pad_drive.uninstall` raised
`ConnectionResetError` while restoring its patch sites at frame 0 — the emulator process is gone, the port is
free and the slot lock has been released, so it reads as contention and is not. Re-ride. Worth chasing if the
rate climbs, since each occurrence costs a whole pass. [open]

#### A prelude is NOT turbo-invariant, and this is the one place that bites

Everything downstream of the start gate is counted in the game's own frames, which is exactly what makes
`--turbo` free: the same course, the same instruction stream, observed more often per wall-clock second. A
menu prelude is the opposite kind of thing. It is **host-timed tapping against a front end that advances in
game time**, so at 3× the menu is three times further along by any given tap index, and a prelude calibrated
at 1× selects something else entirely.

This was found the way these things usually are — a prelude verified at 1×, a ride launched at `--turbo 3`,
and a run that aborted instead of measuring. Aborting is the system working: `--mode` caught it rather than
letting a race-mode pass masquerade as a showoff one. `modescan` therefore takes `--turbo` too.

Recalibrating at 3× was not enough, though, and the reason generalises. The commit point reproduced fine
(tap 28), but a prelude built from it *still* landed in race — because at 3× each press covers three times as
much front end, so the steering resolution is three times coarser and the ordinary boot-to-boot variance in
load times is now worth more than one menu entry. The 1× prelude verified first time and the 3× one did not,
twice.

**So steer at 1×.** Turbo is free for the part of a run that is counted in game frames and actively harmful
for the part that is counted in presses. A mode-steered pass costs about two minutes at 1× — the front end is
most of it — and that is the correct trade against a prelude that silently picks the wrong entry.

The cheap way to test a candidate prelude is `modescan` itself rather than a full ride — pass the prelude with
`--menu` and it reports which entry that prelude actually selects, without riding a course:

```
python tools/autotest/emu.py modescan <iso> --menu "cross:76,down:1"   # 1x prelude
  menu: cross x76
  menu: down x1
  tap 2: GameModeGlobal 0 -> 3 (showoff)
```

That run is also what established the mapping is **direct**: the on-screen menu positions line up with the
dispatcher's own jump-table indices, so the default `cross`-only path is index 2 (race, mode 2) and one DOWN
is index 3 (showoff, mode 3). The table at `0x003b3d90` therefore predicts the rest —

| steer (after the `cross:` prefix for your scalar) | index | expected |
|---|---|---|
| none | 2 | race, mode 2 — measured at both scalars |
| `down:1` | 3 | **showoff, mode 3** — measured at 1× |
| `down:2` | 4 | freeride, mode 6 |
| `up:1` | 1 | freeride, mode 1 |

— but predicted is not measured, and `--mode` is what keeps the difference honest on every run that uses one.

#### The same boot, twice, lands in two different modes

A correct prelude is not a prelude that always works. Load times vary boot to boot, and a host-timed press
sequence inherits that variance — so the same `cross:76,down:1` that `modescan` confirms commits at tap 77
can land an entry away when the machine is busy with something else. Two harnesses on one workstation is
enough:
the emulators take turns (above), but a compile running beside the boot does not.

So `--mode` catching it is a **retry**, not a failure. `run.py` boots again, up to `MODE_RETRIES` times, and
says so:

```
  asked for showoff and the front end landed in race (GameModeGlobal 2); the menu prelude took a
  different entry this boot — calibrate it with `python tools/autotest/emu.py modescan <iso>`
  booting again (1/3)
```

The bound is what keeps it honest. A prelude that is genuinely miscalibrated misses **every** time, exhausts
the retries and reports the same message — so the distinction between "the host was busy" and "the number is
wrong" survives, and the answer to the second is still `modescan`. A batch is never thrown away for the first
one, which used to cost the ~10 minutes of ISO build sitting behind it.

### Two harnesses, one emulator: the slot is a queue

One PCSX2 owns one PINE slot, and PINE is single-client, so a second emulator on the same slot does not share
it — the newcomer's socket wins and the incumbent's next read dies with a connection reset. That failure lands
on the *innocent* run and looks like an unstable emulator rather than like contention, which is what makes it
worth designing against rather than warning about.

So the slot is taken under an exclusive lock and everyone else **waits**. `emu.launch` takes the ticket before
it starts PCSX2 and `emu.shutdown` hands it on after the emulator is gone, which means every path that drives
an emulator through this harness — `run.py`, `emu.py boot`, anything written later — inherits the queue
without opting in. A queued run says who it is waiting for:

```
  PINE slot 28011 is taken by pid 24180 (ssx-tricky-gold, 6 min in); waiting for it
  PINE slot 28011 is free; taking it
```

The ticket covers the whole emulator rather than only its socket, so `run.py` also takes it around the **ISO
pack**. PCSX2 holds its disc image open for the length of a pass and two runs of one fixture share an image
path, so a build that does not wait dies on a sharing violation — before the port check it would otherwise
have hit — and the run that dies is the one that was only trying to build. The pack takes and releases its own
ticket rather than holding one across a `--repeat` batch: a queued run should wait for one pass, not three.

The lock is an OS byte-range lock (`slot_lock.py`), so the kernel releases it when the holder exits **however
it exits** — killed, crashed, terminal closed. There is no stale lock to clear by hand and nothing ever has to
guess whether another pid is really alive. A PCSX2 started outside the harness has no ticket to inherit, so
that case is caught separately: after taking the lock the launcher waits up to `PORT_CLEAR_TIMEOUT` for the
port itself to close, then says plainly that someone's own emulator owns the slot.

`SSX_PINE_LOCK_TIMEOUT` sets how long to queue (default 3600 s, about two full passes); `SSX_PINE_LOCK=0`
skips the queue, which is a foot-gun rather than a feature.

**Serialising is the answer, not a limitation.** Two emulators *can* run at once on two slots, and the harness
side of that has always worked — `--pine-slot` names a different one. What does not work is the configuration:
the slot lives in `PCSX2.ini` as `PINESlot` under `[EmuCore]` — **configuration, not a command-line flag**
(v2.6.3 has no config-path option; `-portable` keys off the install directory, so a second slot means a second
copy of PCSX2). And even given two, both instances would then split one host between them, while this harness
reads a running game 20 times a game-second and grades cells on *when* they fired. A pass that loses its
timing margin does not fail cleanly — it reports cells as inconclusive, which reads as a broken mechanism.
One full-speed pass at a time is worth more than two degraded ones.

## A run ends when the race does

**Finishing the course does not end the level.** The race ends, the results come up, and the engine puts the
rider back at the gate with the level clock **reset to zero**. A pass therefore ends the moment that clock
goes backwards, and everything past it belongs to a different run of the same course.

That is not a tidiness argument. Sampling through a restart breaks three separate things:

- **the window never completes** — elapsed frames collapse back toward zero before reaching any window
  longer than one race, so the run keeps going until a backstop kills it. Measured on the catalogue course: a race
  takes ~2 minutes (~7,000 ticks) against a 160 s window, and the run looped **nine times**, reporting
  25,004 m travelled on a 2,690 m course and an `emulationSpeed` of 0.16 that was not slowness at all;
- **the timeline stops being ordered** — probe timestamps come off the reset clock, so the ordered trace,
  which exists precisely to say what happened *before* what, silently interleaves two runs at the same game
  time. This is the tool the breakable-kill finding rests on;
- **attribution gains a channel nobody chose** — a second descent re-approaches every cell, and those
  samples are eligible to be credited to the cell that fired on the first.

A restart drops thousands of ticks at once, so the test needs no tuned threshold — a second of slack keeps
it clear of any single odd read. `ended` records it as `restarted`, which is a **normal** end, alongside
`complete` (the frame bound elapsed) and `level-gone`. Only `cut-short` and `stalled` are faults.

The engine offers a more precise signal still: the boarder's per-frame event bitmask pair at `+0x384`/
`+0x388`, where **event 18 is the finish** ([Trailmap: 390-pickups-and-race]). That would end a pass at the
line rather than a few seconds later at the restart. It is worth doing, and worth *measuring* before relying
on it rather than guessing which word is current and how the bit is numbered.

## The window is counted in the game's frames

Past that, a run samples for a number of **simulation ticks**, not host seconds, and that is a correctness
property rather than a nicety.

A wall-clock window shortens the *course* whenever the emulator drops below full speed. The rider gets less
far down the fall line, every cell past that point reports `not-reached`, and `not-reached` grades as
inconclusive — so a loaded host quietly becomes "we could not test the bottom half of the fixture", phrased
as though the harness were at fault. Nothing in the output distinguishes it from a genuinely short course.
Counting the game's own ticks makes what a run covers a property of the run.

The sample *pace* follows the same argument: the sleep is retuned from the emulation speed measured so far,
so the timeline keeps ~20 samples per second of game time however fast the host is going. A fixed host
interval would over-sample a slow emulator, spending PINE round trips to cover a run more densely the slower
it went — backwards for a host running more than one.

The frame count is an **upper bound**, not a target: a healthy pass ends when the race does, and the bound
only has to be long enough never to end first.

Two backstops, since an unbounded loop inside a `--repeat` batch is its own hazard: 30 s with the frame
counter not advancing ends the run (`stalled` — a wedged or paused emulator, which is a different thing from
a slow one), and host time is capped at 4× the bound's real-time length (`cut-short`). Either sets `ended`
in the report, `run.py` counts it as a failed pass, and both `print_report` and `tally.py` say so on the
first line — a window that did not finish must never read as a complete one. The `cut-short` guard is what
caught the restart loop above, which is the argument for having it.

`emulationSpeed` rides in every report for the same reason: it is `frames / 60 / wallSeconds`, sits at ~1.0
on a healthy pass, and is what would expose the 60 Hz tick rate ([Trailmap: 002-conventions]) as wrong if it
ever were.

The boot and mash timeouts are deliberately **still wall-clock**. They bound host work — streaming the ELF,
waiting on a front end — and an emulator slow enough to blow them has a problem worth stopping for. They are
the first thing that would trip if several instances were ever run at once, which surfaces as a loud failure
rather than a quietly short run.

### `--turbo` is free, and `samplesPerGameSecond` is the price tag

Because the window is counted in the game's frames and the sampler retunes its own pace, running the
emulator faster shortens a pass **without changing what it measures**. It is the same instruction stream;
only the wall-clock cost of watching it goes down. `run.py --turbo 3` takes it.

**It can also cost you the BOOT, which is a different failure from a degraded sample rate and looks nothing
like one.** PINE is serviced on a game thread, so a run driven above real time leaves that thread less idle —
and the boot cave's teardown is a verified write, a read-back per word at the busiest moment of the launch.
Twice in five `--turbo 3` boots of `AUTOTEST3` it died there, once `ConnectionResetError` and once
`TimeoutError`, before a single sample was taken. Neither is a reason to distrust turbo's *measurements*: the
window is counted in game frames, so a 1x pass and a 3x pass measure the same thing. It is a reason to drop
to 1x when a batch has to land rather than merely be fast — the same three passes cost 3 minutes instead of
1, and `samplesPerGameSecond` comes back up (17.5 → 19.2).

It has to go through PCSX2's config file, and that is worth knowing before reaching for the keyboard. PINE's
opcode set is reads, writes, save/load state and four strings — no speed control. `pcsx2-qt -help` on 2.6.3
lists no `-setting` override. And **Tab is a hotkey**: it needs a focused window, so it is out of reach of a
`-nogui` run, and it applies `[Framerate] TurboScalar`, which ships at 2. So `emu.turbo()` patches
`NominalScalar` (and switches vsync off, which would otherwise re-cap presentation at the monitor's rate),
launches into it, and restores the file in a `finally`. The config belongs to the user, so an ordinary
failure never leaves a scalar behind; a hard kill of the whole process can, which is why the restore line is
printed on the way in.

The one thing turbo *can* cost is sample density. Each sample is a handful of PINE round trips, and holding
20 samples per second of **game** time at 3× means three times as many per second of host time. When the host
cannot feed that, the density falls and everything short-lived starts getting missed — silently, because
every cell still reports a verdict.

So it is not silent any more: **`samplesPerGameSecond` rides in every report** and on the first line of
`print_report`. It sits near 20 on a healthy pass at any speed. Read it before reading anything else on a
turbo run, and treat a run that dropped well below as a run that covered the course thinly, whatever its
verdicts look like.

## What the fixture is

`Slopesmith/src/core/collision/autotest.ts` builds every fixture the same way: one single-file column of
cases down a straight fall line, each case one field apart from the one above it. `AUTO_TEST_GOLD_CELLS`
picks GOLD's subset out of the catalogue by id and gives each pick the line it is reported under; an id that
no longer resolves throws at build time rather than quietly shortening the regression course.

It is shaped so a machine can ride it. `lab.ts` — the sibling fixture that answers how the rider *responds*
to a contact — puts its cases in lanes and makes them solid, because it was authored to be ridden by a
person. This one does the opposite:

- one column down the fall line, so no steering is needed;
- every case spans the rideable corridor, so lateral drift cannot miss one;
- every case is pass-through (`responseMass: 0`), which leaves contact and effect dispatch fully intact
  ([Trailmap: 130-collision-data]) while letting the rider carry on to the next case.

The first cell is a control: the collision lab's own retail crash bag, whose mode-1 proxy already dispatched
in a live pass. A run where the control stays dark indicts the harness, not the cells below it.

**Every chain leads with a 3 s debounce, and that is load-bearing.** Dispatch is detected by watching
`entity+0xe4`, which the constructed node fills and its destructor clears, so an undebounced chain that
builds and completes inside a frame or two is invisible to any host-side sampler and reports as "never
dispatched". The first full run made exactly that mistake: only `ride-over-button` fired, because its recipe
is the one that already carried a debounce — the other nine were firing and being missed. A debounce holds
the evidence still for three seconds, and it is what every retail collision header carries anyway, so this
is the shipped shape rather than a measurement artefact bolted on.

### The plan's name check has two rules, because the export has two naming conventions

`auto-test-map.ts` joins each case to its packed instance through `bakedGroups`, keyed by the case's own
authoring id — so the join is exact — and then checks that the name it got is the one that case should have
baked. That second check is what catches a case wired to the wrong baker, and it takes two forms.

Most of the fixture's shapes are named from something the fixture authored per cell: a panel's model is built
for that cell and carries its name, so the group ends `_AT<n><cell id>`. An **imported** prop is not. Its
group is `Import_<n>_<model>`, named after the shared Custom-catalogue record, because several placements
can be the same model — `Import_0_SnowGun`, `Import_1_SnowGun`. A cell with `shape: 'clip'` (or
`companionShape: 'clip'`) therefore sets `imported` on its plan entry and is checked against that family
instead. Add a clip cell without it and the export fails outright, naming the cell, which is the intended
behaviour: silence there would mean a plan the harness attaches to the wrong entity.

## A catalogue, not just a probe

Every cell asks one question. Once hardware has answered it, the answer is written back into the cell as an
`expect`, and from then on the harness GRADES each run against it rather than merely measuring:

| grade | meaning |
|---|---|
| `pass` | hardware still does what it was demonstrated to do |
| `REGRESSION` | it does not — the runner exits non-zero |
| `open` | no expectation yet; this pass measures the cell, it does not judge it |
| `inconclusive` | the rider never reached the cell, so the pass proves nothing about it |
| `unobservable` | a persistent graph already owns the slot the verdict reads |

A cell can be graded on four separate things, and they answer different questions: `expect` on the dispatch
slot (a node was built), `expectPaint` on the flip node's own applied frame (pixels changed), `expectRider`
on the RIDER (somebody was moved), and `expectSlot` on how many times the instance let go of a node it built
(a teardown happened, or was suppressed).

`inconclusive` applies even when the expectation was `no-dispatch`. A cell the rider missed and a cell that
refused to fire look identical from here, and letting a miss count as a pass would quietly turn a broken
ride into a green suite.

**A hop COMPANION is graded separately, and `no-dispatch` on one is deliberately one-sided.** `companionExpect`
exists because a negative control's two halves want opposite expectations: `cracked-tough` must dispatch on
its host — ordinary contact builds a Cracked node whatever its strength — while its companion must stay
empty, because the trigger column is never reached. One `expect` cannot say both, and inheriting the host's
would fail the control exactly when it is working. What a `no-dispatch` companion can never be is *green*: the
rider never approaches it, so an empty one reads `not-reached` → `inconclusive`. It can only ever go RED, and
that is the right shape for this claim — nothing but the mechanism under test can put a node on that slot, so
a node appearing there is a regression and its absence is the expected silence.

Two kinds of cell deliberately carry no expectation, and they live on the bench rather than in the catalogue:

- **Cells whose answer was "the question was wrong."** The first speed-gate pair moved the third payload word
  between 0 and 1e6 and got the same answer both times. The word is declared an `int` and read by the engine
  as an `f32`, so both spellings were ~0.0 — it was the same threshold twice, asked twice. The cell that
  replaced it moved the *selector* instead and settled it in one batch. A cell that cannot separate its
  hypotheses is not a weak result, it is a design fault, and the fix is a better cell rather than more passes.
- **Cells that are not reliable enough to grade.** `auth-gate-scaled` fires about five passes in seven while
  every unscaled gate beside it fires every time. An expectation on it produced one REGRESSION in a
  three-pass batch, which is worse than useless: a suite that cries wolf once a batch stops being read.

Neither is a gap to be filled in later by lowering the bar. A cell that asserts nothing costs one line of
output; a cell that asserts something false costs every future run's credibility.

There is a third move, and it is not the same as lowering the bar: **grade the claim you can defend rather
than the number you happened to measure.** This has now caught two cells, and the second is the clearer
lesson:

- The boost cell's attributed rise runs 2.4–13.7 m/s depending on how squarely the rider crosses a 40 m box.
  An expectation set near the top of that spread failed a pass that was not a failure.
- The reset cell moved the rider **2975–2983 m** on the bench and **22–25 m** on the catalogue course. Neither is
  wrong: the node carries the rider back to the course line, so the distance is how far off it they were —
  on the bench the run had sailed past the end of a short course, on the catalogue course it was still on the line.
  A threshold fitted to either number is fitted to a course's geometry rather than to the node.

That last one came back and had to be withdrawn outright, which is the sharpest version of the lesson. The
catalogue course's 22–25 m was **the cell above it talking**: the reset sits one field below the only cell that
throws the rider into the air, and what it was measuring was the rider still being airborne. Growing the
course from 2,690 m to 3,950 m changed nothing about the node and everything about that — the rider now
usually lands first, so the same cell read 22.3 m in one pass of three and ~2 m in the other two. A number
produced by a neighbour is not a property of the node, and no bar placed anywhere makes it one. The cell now
grades dispatch only, and says so in its own text; the node keeps its proof from the batch that measured it
against a rider thousands of metres off the line.

In both cases what the cell is *for* is "the node moved somebody", so the bar belongs just clear of the
course's own noise floor — ordinary motion is under 2.5 m a sample and the largest rise without a boost is
0.8 m/s — rather than near the largest effect ever seen. Same claim, honest grade.

### Sampling faster only helps if the GAME advances

Oversampling a word is worth doing only when the word can vanish between two ordinary samples, and the first
attempt at it here was worthless in a way worth recording. Reading a pair of words three times in a row costs
three PINE round trips and buys nothing: the emulator has not advanced a frame between them, so it is one
frame sampled three times. It has to be **paced through the sample interval**, and only then is it 60 Hz of
game time rather than of host time.

Then read the handler and find out whether the word needed it at all. `boarder+0x134`, the speed-pad request,
does not vanish: `BoarderMotion_SharedUpdate` subtracts 1/60 from it each tick and clamps at zero, and nothing
else in .text writes it, so an authored 5.0 is **five seconds** of non-zero — about a hundred samples at the
ordinary pace. There was never a rate at which it was hard to see. Its twin `+0x138` is a genuine case: it
decays the same way *and* is zeroed outright, with its `+0x13c` flag, by the motion-state enter helper, so a
trick window really can end between two frames. One of the pair needed the extra reads and one never did, and
only reading the consumer says which — a rule that generalises past these two words.

Which turned a nine-pass negative into a question about something else entirely. The pads DO write; three
passes have caught both fields holding their authored 5.0, and the passes that read 0.000 recorded a call that
never happened rather than a value that got away. The reading that had been on this cell for a day — "a 20 Hz
sampler mostly misses it" — was wrong, and so was the tool it called for. A code cave at the store records
writes that survive one frame, and one frame is not how long these survive.

A close cousin, worth naming because it nearly caused a *fifth* wrong threshold: **do not pool signals that
are not the same quantity.** `rise` is m/s, `jump` is metres, the pad requests are seconds of window. A
tally column that ranged over all of them together showed the boost cell as `1.6–9.1`, which reads like a
signal grazing its 1.5 bar — the 1.6 was that cell's *jump in metres* sitting beside its 7.1 m/s rise. Read
per signal, the boost cell rises 7.1–9.1 m/s while every other cell on the course rises 0.0 or less, and the
bar is nowhere near the data. The column now reports each signal separately.

That same column had a second way to mislead, and it was found the same way — by nearly publishing a wrong
claim off it. A reading at the noise floor is dropped rather than ranged, since a range running from 0 to the
effect describes neither; so a signal **one pass in three** caught printed exactly like one every pass caught.
The two pad opcodes came back `boost-request 5.0-5.0` off a single pass out of three and read like a settled
result on a question that had been open for nine passes. The column now carries the count whenever a pass came
back empty (`5.0-5.0 (1/3)`). How often is part of the reading, not a detail — which is the section below.

The count went on to be the finding. Those two opcodes have now written in **3 of 42** passes, and across all
42 they have never disagreed with each other: both or neither, no pass where one landed alone. Two props 90 m
apart, two dispatcher branches, two destination words — a rate that is a property of the PASS rather than of
either cell, which is not a thing a per-cell reading could ever have shown and is currently the strongest
constraint on what gates them.

This is what makes the fixture accumulate. A cell under investigation asserts nothing and can never
masquerade as a passing test; a cell that has been demonstrated stays demonstrated, and the day some change
to the exporter, the packer or the engine data stops reproducing it, the next run says so.

## One pass is not a result

A single pass answers "did this fire *this time*", which is the wrong question for any cell that is not
perfectly reliable. The x6 scale gate fired in four passes out of five, and in each of those four it looked
like a solid result. Nothing in that pass distinguishes it from a cell that fires every time.

So a cell earns an `expect` from a BATCH, and `tally.py` reads the batch:

```
python tools/autotest/run.py --repeat 3      # three passes, one report each
python tools/autotest/tally.py               # collapse the three into a fire-rate table
```

It reports fire rate, the grade breakdown, and the spread of closest approach per cell. Approach travels
with the rate because it separates the two explanations for a dark cell: one the rider drifted 40 m wide of
did not fail, it was never tested. `always` and `never` are only offered from three or more passes;
anything ragged is called `INTERMITTENT` and stays ungradeable.

## Grading what a frame LOOKS like: `shot.py` and `fog_meter.py`

Every verdict above is read out of EE memory, which is the right instrument for "did the engine build a
node" and no instrument at all for "how opaque is the fog". That second question is a port question — our
fog banks are drawn alpha-over in Unity (`OpenSlope/Particle`) and nobody has measured what the PS2 does — and it
is answered from pixels or not at all.

**`shot.py` gets the pixels, and it needed no new discovery beyond one measurement.** PINE cannot help: its
opcode set is reads, writes, save/load state and four strings, and the framebuffer lives in GS local memory
rather than EE RAM, so there is nothing to read. PCSX2's own screenshot is a *hotkey*, which reads as
needing a focused window — and it does not. Qt turns a posted `WM_KEYDOWN` into a `QKeyEvent` for the window
it was posted to, so one `PostMessage` at the render surface makes PCSX2 write its own internal-resolution
PNG. No compositor, no occlusion risk, no focus theft, and a pass can run while the machine is used for
something else. Verified on v2.6.3 / Qt 6.10, under `-nogui` as well as windowed.

```
python tools/autotest/shot.py --check              audit the settings a measurement depends on
python tools/autotest/shot.py --out temp/fog.png   capture
```

`--check` first, always. FXAA averages neighbouring pixels, which is precisely what a patch mean is trying
to measure; ShadeBoost applies gamma *after* the blend and breaks the linearity every calculation here
assumes. Both produce plausible wrong numbers rather than visible failures.

**And `accurate_blending_unit` must be Full or Maximum.** This is the one that matters most for fog, because
a fog reading *is* a reading of the blend unit: below Full, PCSX2 approximates it for speed, which visibly
darkens textures and means the composite in the framebuffer is not the one the console would have produced.
A measurement taken at Medium is not a noisy measurement of the PS2, it is an accurate measurement of
PCSX2's shortcut. The speed cost is irrelevant for a still frame. `--check` now refuses it.

**`fog_meter.py` reads the fog off the shot**, and the one idea it rests on is that an absolute colour
cannot be interpreted. A fog puff over snow and the same puff over rock differ by the snow and the rock.
So photograph a backdrop of KNOWN CONTRAST through the fog and read the fog off what it did to that
contrast — two patches of one surface, same depth, same light, one dark and one light:

| composite | contrast | midpoint |
|---|---|---|
| alpha-over `(1-a)·bg + a·C` | shrinks by `1-a` | moves toward `C` |
| additive `bg + Cs·As` | **unchanged** | moves up by `Cs·As` |
| darkening `bg·(1-a)` | shrinks by `1-a` | moves toward 0 |

Every unknown that wrecks an absolute reading — the panel's albedo, the lightmap on it, the exposure — is
common to both patches and divides out of the contrast, so the blend MODE falls out of two numbers. Note
row three: contrast alone cannot separate alpha-over from darkening, which is why the midpoint is carried
too, and why an all-black recovered colour is reported as an ambiguity rather than a result.

```
python tools/autotest/fog_meter.py selftest                    grade the reader against known fog
python tools/autotest/fog_meter.py measure shot.png --layout photometer.json
python tools/autotest/fog_meter.py annotate shot.png out.png --layout photometer.json
```

Four things about it are load-bearing, and three of them were wrong first:

- **`--transfer` is the quiet way to be wrong.** The algebra is linear in whatever space the renderer
  *blended in*. The PS2 blends 8-bit framebuffer values, so a PCSX2 shot is already in its blend space
  (`linear`). Unity in Linear colour space and three.js with an sRGB output both blend in linear light and
  encode on the way out, so their PNGs must be decoded first (`srgb`) — read one as the other and a 50% fog
  measures as 73%. This is the whole reason the cross-renderer comparison is not just diffing screenshots.
- **A clipped patch is refused, not measured.** Additive fog over a white panel saturates, and a saturated
  patch reports a contrast that shrank — the same signature as opacity. So the backdrop pair is mid-grey and
  dark grey rather than white and black, and the reader errors out if either rail is touched.
- **Pixel scatter is not the whole error.** A flat patch has zero scatter and an apparently perfect mean,
  but the renderer still rounded every pixel to the same code value, and that rounding does not average away
  — it is a shared offset. `sd/sqrt(N)` alone reports unbounded confidence on exactly the flat patches this
  instrument samples, so there is a quantisation floor of `1/sqrt(12)` code values under every sigma. The
  independent-pixel count is also divided by the upscale factor squared, since PCSX2 at `upscale_multiplier
  = 2` emits each rendered pixel as a 2×2 block.
- **The recovered colour is a quotient by the opacity, so a thin fog cannot pin it.** At `a = 0.15` a
  half-code wobble in the midpoint is a 3-unit swing in the colour; at `a = 0.02` it is 25. The reading
  publishes that error bar, and `selftest` grades against the bar rather than a flat tolerance — a constant
  would either fail the honest thin case or pass a wildly wrong thick one.

`selftest` composites synthetic cards with known fog in all three modes through both transfer functions and
checks the reader recovers the mode, the opacity to ±0.01, and the colour within its own error bar. It also
checks the two refusals, because each was once a plausible wrong number.

### One patch pair is not enough, and the reason is the texture

The obvious instrument is a single dark/light patch pair, and it is not good enough — which was found by
building it, measuring a fog whose answer was already known, and watching it scatter.

Graded against Unity, where the puff's alpha is knowable from the shader (`fog0` texture alpha × `_Alpha`),
a **control** with a flat white texture and `_Alpha = 0.5` reads `0.497 / 0.492 / 0.500 ± 0.010` and a fog
colour of `(121.4, 146.9, 181.3) ± (1.5, 2.0, 2.8)` against a true `(120.7, 144.0, 180.6)`. So the algebra
and the sRGB transfer are right. Point the same single pair at the **real** `fog0` puff and successive
radii read 0.194, 0.209, 0.164 — non-monotonic, on a blob that must fall off monotonically.

The per-pixel map says why. `fog0` is a **cloudy texture, not a smooth blob**:

| r/R | mean opacity | sd *within* that annulus | change over one cell |
|---|---|---|---|
| 0.05 | 0.1877 | 0.0399 | 0.0457 |
| 0.35 | 0.1573 | 0.0276 | 0.0467 |
| 0.55 | 0.0962 | 0.0178 | 0.0452 |
| 0.85 | 0.0183 | 0.0080 | 0.0260 |

Alpha varies by ±0.04 between neighbouring points on a signal of 0.19. A single pair therefore scatters by a
quarter of the quantity it is measuring, **however clean the pixels are** — this is structure in the subject,
not noise in the instrument, so no amount of care with one pair recovers it. Two methods do:

- **`map` — the gold standard.** Render the viewpoint four times (dark/light backdrop × fogged/clear) and
  the alpha-over algebra solves at every pixel, assuming nothing at all: no symmetry, no smoothness, no
  knowledge of the texture. Its own check is that opacity outside the puff must come out zero, and it does —
  `0.00000 ± 0.00000`. Needs re-rendering, so it is available in Unity and Slopesmith and **never on a
  console**.
- **`checker` — what a console allows.** One frame, a checkerboard backdrop, reference cells taken from
  outside the fog in the same frame. Averaged over an annulus it lands within **0.003** of the exact map at
  every radius. The cells are classified from the frame being measured rather than from a clear reference —
  verified identical to four decimal places, which it must be, since the fog attenuates both cell families
  but leaves them separable.

A checkerboard rather than two stripes because the two luminances have to be interleaved finely enough that
both are sampled under the same fog, and the structure that defeats one pair is uncorrelated between cells,
so it averages down. What does *not* average down is anything varying systematically across the region,
which is why a region should be an annulus or a small box rather than a swathe crossing the whole puff.

**A mirrored pair either side of the puff axis is the trap to avoid.** It looks rigorous — the two patches
are at equal radius, so surely equal alpha — and it silently assumes the texture is left-right symmetric.
`fog0` is not. The tell was the two patches reporting different pixel spreads (sd 2.00 against 0.25) for
what was supposed to be the same fog.

### Two more refusals, both earned the hard way

- **Channel opacities that disagree mean `--transfer` is wrong.** Alpha is one scalar, so a real alpha-over
  blend must attenuate all three channels equally. Slopesmith read `0.107 / 0.085 / 0.057` under `srgb` and
  a flat `0.188` under `linear` — the truth. The disagreement is now a note on the reading.
- **A fogged pair with MORE contrast than the reference is not a fog.** Additive leaves contrast exactly
  alone and the other two scale it by `1-a ≤ 1`, so retention above 1 says the two pairs are not the same
  backdrop. The first PS2 attempt returned retention **1.94** and a confident "additive" off nothing but a
  second piece of rock having more contrast than the first. Now a hard error.

### What the three renderers say

One `fog0` billboard, photographed against a known-contrast backdrop, read by the same algebra:

|  | blend | blends in | peak opacity | fog colour | source |
|---|---|---|---|---|---|
| **PS2** (PCSX2, Full blending) | **alpha-over** | gamma (framebuffer bytes) | **0.578** | **(215, 216, 216)** | measured, `checker` |
| Unity `OpenSlope/Particle` | alpha-over | **linear light** | **0.2542** | (121, 144, 181) | measured, `map` |
| Slopesmith `SpriteMaterial` | alpha-over (`NormalBlending`) | gamma (sRGB codes) | **0.2434** | (121, 144, 177) | measured, `map` |

Three things fall out, and the first two are corrections to what the ports assume:

- **The PS2 is alpha-over, not additive.** `400-rendering.md` [[400-blend]] records the sprite batch as
  hard-coding additive (`Cs·As + Cd`), and that is the note fog was expected to follow. It does not: a
  fogged patch pair keeps only 42% of its contrast, and additive keeps 100% by definition. The blend the
  ports chose is right; the reason they were right was a guess.
- **Both ports are about 2.4× too thin.** Slopesmith is the cleanest comparison because it also blends in
  gamma space — 0.243 against hardware's 0.578. Unity's 0.254 is a linear-space alpha and is the same
  authored guess (`_Alpha 0.50` against `opacity 0.48`).
- **And too blue.** Hardware's fog reads a near-neutral off-white around (215, 216, 216); both ports carry a
  blue-grey (`#b8c7db` / `0xb8c7d9`) that lands near (121, 144, 179).

The two ports agree with each other because they copied one authored guess, not because either was
measured — and now that there is a measurement, both are wrong in the same direction.

**Opacity also falls off as the camera closes on a bank**, which is the behaviour Unity's `OpenSlope/Particle`
carries as `_NearFade` (added as a fill-rate fix, not from evidence). Measured on the approach: 0.578 at
39.5 m, 0.413 at 58.2 m, and 0.047 at 17.3 m. The near collapse reproduced across two runs (0.037 at 27.3 m
in the first), so the effect is real — but one frame at 19.1 m read 0.514, so the SHAPE of the falloff is
not pinned and the sampling (auto-picked lowest-contrast tile) is doing some of the work. Treat the
existence of a near fade as measured and its curve as open.

### The fixture is built, and it found a hole in the pipeline instead of a fog reading

`Slopesmith/tools/reference-study/photometer-map.ts` authors **PHOTOMETER**: a 200 × 80 m checkerboard panel
square across the fall line at 90 m, with a fog volume parked 15 m in front of its middle. It exports clean,
packs clean (`snowknife repack … --texture-type2`, zero findings, 256×256 checker page shipped verbatim), and
the panel renders on hardware exactly as intended — crisp cells filling the frame, both greys well clear of
the rails.

It took a fix to `repack` to make its fog draw at all, and the two wrong diagnoses on the way there are
worth recording, because both were plausible and both would have sent someone rewriting the wrong thing:

- **NOT "repack drops particle volumes."** It does not mention them in its log, and Snowknife's own comment
  (in `LevelPipelineService.cs`) places the JSON in the extract → Unity-bundle path, which together read
  like a missing feature. They are not: `snowknife pbd-from-json Maps/PHOTOMETER` produces a PBD whose
  header carries `NumParticleInstances 1` and `NumParticleModel 1`. The bank is on the disc.
- **NOT the volume's data or its name.** Retail volumes are all `Fog_*` and the engine picks a particle's
  sprite by effect type, so `Photometer_Bank` looked like the culprit. Renaming it `Fog_Sphere_A_0` changed
  nothing. Nor did replacing the synthetic nine-puff starter cloud with GARI's **actual shipped 18-puff
  cluster**, cloned verbatim out of `Maps/GARI/ParticleModels.json` — same radii, same `Rotation` scale
  factor, same `U1`, same bounds.

**The actual cause: `repack` was shipping the DONOR slot's fog table and discarding the export's.** The work
folder it builds the PBD from is a clone of the donor level, with specific authored files overlaid on top —
`Lights.json`, `Splines.json`, and so on. `ParticleInstances.json` and `ParticleModels.json` were not on
that list, so every pack silently carried GARI's ten banks at GARI's coordinates, which on authored terrain
is nowhere the rider will ever look. It reads exactly like "authored fog does not render".

The way to see it is to pull the PBD back out of a built ISO rather than trusting the standalone builder:

```
snowknife iso-extract <iso> DATA/MODELS/GARI.BIG work/GARI.BIG
snowknife big-extract work/GARI.BIG work/out        # header u32 #4 is NumParticleInstances
```

That read **10** — GARI's count — where the export had authored 12, while `snowknife pbd-from-json
Maps/PHOTOMETER` on the same data read 1. Two different numbers from two paths over one input is the whole
diagnosis. `RepackService` now overlays both particle files, together (an instance addresses its cluster by
`ParticleModelIndex`, so overlaying one alone would point authored placements into the donor's model table),
and the same check now reads the authored count.

So **authored fog banks reached Unity and never reached a disc** — Slopesmith's "Add fog volume" had never
been exercised end to end on hardware, which is why nothing had caught it.

Two smaller things the fixture had to learn, both of which would silently ruin a reading:

- **Frame the CAMERA, not the editor.** A 4:3 frame at ~60° shows about 1.15 × the distance in width. The
  first attempt put a 160 m panel at 46 m, where only ~53 m is in shot — the clear reference thirds were
  off-screen entirely.
- **Author the checkerboard ON the GS ladder.** 24 cells × 8 texels = 192 px, which the packer resampled to
  128 and turned every cell edge into a ramp. 32 × 8 = 256 ships verbatim; 8 texels per cell is the minimum
  that keeps a pure interior through bilinear magnification.

### Why retail scenery will not do either

The cheap route was tried first: ride retail Garibaldi, shoot a burst, and measure a fog bank against
whatever contrast the scenery offers. The plumbing works — `emu.boot_into_level` + `shot.capture` on a timer,
with the rider's position recorded per frame, put `ride-20.png` **92.6 m** from `Fog_Sphere3_0` with the
puffs plainly in shot over a cracked rock face whose dark veins read like a natural checkerboard.

It is still not a measurement, and the reason generalises. There is no way to see *the same surface* both
fogged and clear: the reference has to come from a different piece of rock, and two rocks differ by more
than the fog does. Every placement tried returned a confident "additive" with a physically impossible
retention of 1.3–1.9. A console cannot re-render, so the second backdrop has to be **in the frame and under
the same fog** — which is precisely what an authored checkerboard panel behind a fog volume provides, and
why the fixture is not a convenience.

## What a verdict means

The signal is `entity+0xe4`, the live collision-effect-node slot. Contact reaches node construction only
through `CollisionEffectNode_GetOrCreate`, which fills that slot, and only the node's destructor clears it —
so it is a **level that persists**, not a one-frame edge. That is what makes this robust where watching for a
half-second texture flip was not.

| verdict | meaning |
|---|---|
| `fired` | the slot went empty → occupied during the run: the graph ran |
| `crossed-without-firing` | the rider passed within 25 m and nothing was constructed |
| `not-reached` | the rider never got near it — untested, not failed. A cell that fires WITHOUT being reached is a hop target, and the tally names it as such rather than burying the result the cell exists to produce |
| `refused` | the rider never got near it and never could, but the cell that DRIVES it dispatched — so the empty slot is a refusal rather than a gap |
| `pre-occupied` | a node was already installed at baseline (a persistent graph owns the slot), so contact dispatch is not observable on this cell |

`not-reached` and `pre-occupied` exist because both would otherwise be silently reported as a failure to
dispatch, which is how a harness ends up manufacturing evidence for whatever it was built to prove.

### A row the rider cannot reach needs something other than the rider to cover it

A hop's companion is placed a half-corridor off the fall line **so that** nothing but the hop can put a node
on it. `not-reached` is therefore its resting state rather than a coverage gap, and for the four companions
that expect `dispatch` that never mattered: they fire, and firing outranks proximity.

`cracked-tough-target` is the one that expects `no-dispatch`, and on it the two correct rules collided. The
engine behaving properly leaves the slot empty; the prop is unreachable by construction; `not-reached` grades
inconclusive whatever was expected. **The row could not pass, whatever the engine did.** It had been invisible
because the cell sat past the reach of a race pass until the catalogue was split — and before it graduated off
the bench it carried no expectation at all, so it graded `open`.

A companion now names its host in the plan (`coveredBy`), and the harness waives `not-reached` only when that
host **fired**. That is deliberately a positive observation rather than an absence: a run that ended before
this stretch of course leaves the host un-fired too, so both rows stay inconclusive together and a short ride
still reports honestly. A companion that DOES pick up a node is still a regression — the waiver decides what
an empty slot means, not whether an occupied one is allowed.

Reports land in `Trailmap/temp/autotest/run-<stamp>-<fixture>.json`.

### `fired` says the slot filled, not whose contact filled it

There is **one live-node slot per instance**, and the fixture rides an event with a full field of AI riders
(`Trailmap: 395-ai-riders` — the standings pass sorts every rider with the human as one rung among them). An
opponent crossing a cell fills that slot exactly as the local human does, and every cell the fixture grades is
graded off the local human's position — so a pass where the rider goes wide can still report `fired`, and then
every payload probe beside it describes a chain that ran for somebody else.

This is not hypothetical: on run `20260806-172947` the rider's closest approach to the two pad cells was
6.2 m and 10.0 m and both reported `fired`. Read as "the chain ran and the opcode did nothing", that pass is
evidence against an opcode that in fact works.

Every row therefore carries `closestAtSeconds` beside `firedAtSeconds`. **What it cannot be is an automatic
verdict**, and finding that out cost a ride worth repeating here. The obvious rule — warn when the slot filled
well before the rider's own nearest sample — was implemented, and on an all-green catalogue pass it fired on nearly
every cell. `closest` is measured to the instance's **origin**, and a full-corridor panel is contacted a dozen
metres from its origin on a slope the rider is still descending, so the nearest sample lands after the contact
as a matter of geometry rather than of ownership. Cells at 14 m of closest approach are the normal case here,
not the suspicious one.

It also would not have explained the cells it was built for. In the batch after it existed, the speed pad's
slot filled *at* the rider's own nearest sample, within 0.2 s, on all three passes, and the pad still wrote
nothing.

The general shape, and this fixture keeps relearning it — four attribution windows and a pooled tally column
went the same way before this: **a new signal that appears to explain the thing it was built to explain is
the one to distrust, and the way to find out is to point it at the cells that are already green.** A warning
that fires on a
passing fixture is worse than no warning, because the cost of the two errors is not symmetric — a missed
warning leaves a cell open, a false one retracts a real result. The two timestamps stay in the JSON, to be
read on a cell whose prop is small enough that contact and origin are the same place.

### When the object is not reachable from its instance

Every probe above hangs off the instance — either a chain walked from it, or an offset off whatever
`entity+0xe4` currently holds. Some objects are not on either. A **spline mover** is the case that forced a
second mechanism: the mover reads its host out of `node+0x78`, but the host's own live-node slot holds a
different, smaller node, so no offset off that pointer reaches the mover. Measured over three passes, at both
candidate offsets, the words came back `0` and a `.rodata` address against a known instance — a clean negative
from a probe built to prove itself, which is the only reason it was a fact rather than a plausible number.

What such an object does have is a **pointer back**. `lateWatch` names the offset that holds the instance
address, searches the heap snapshot for it, and watches what it finds:

```ts
lateWatch: { label: 'mover', backPointer: 0x78, offsets: [0x40, 0x4c, 0x50, 0x74], seconds: 4 }
```

Two things about it are deliberate.

It runs **after the window, not inside it**. The search needs a whole heap snapshot, which takes long enough
that running it mid-window would tear a hole in every other cell's timeline — and these are persistent objects
that live as long as the level, so there is nothing to be early for.

But *after the window* has a trap in it, and the first run of this walked straight into it. A window normally
closes because **the race finished**, and finishing tears the level down and builds it again with the rider
back at the gate — so the snapshot is of a different level, and the instance address being searched for
belonged to the previous one. That run reported `0 moving of 3 candidates`, which reads exactly like a mover
that does not move and was nothing of the kind. The search now **refuses** on a run that ended `restarted` or
`level-gone` and says so in the row, because the alternative is a null result that looks like a finding. To
actually get the reading, bound the window so it closes while the level is still up:

```
python tools/autotest/run.py --frames 14400 --skip-map --skip-pack   # 240 s: past the cell, before the finish
```

The cost is honest and worth stating: every cell below where the rider got to is `not-reached` on that pass.
A shortened window is an instrument for one cell, not a regression batch, and should not be read as one.

And it **over-collects on purpose**. A specific instance address appears in the instance table and in every
other object that happens to reference it, so most candidates are coincidences at the right offset, and no
static test separates them. Nothing tries to. Each candidate's words are sampled over a short window and the
report keeps only the ones that CHANGED, with their timeline intact: a distance that climbs tick after tick is
a mover running, and the same offset inside a table holds still. It is the same discipline as the name-hash
search, which over-collects and lets the authored location settle it — offer the candidates, then let a value
you already know decide.

### A one-shot object has to be MADE to persist before it can be read

The mechanism above rests on an assumption its own text states: these are "persistent objects that live as
long as the level, so there is nothing to be early for". The **effect thread** breaks that assumption, and it
is the object the pad question has been stuck behind for 42 passes. `EffectThread_FinalizeAndFree` frees the
thread the moment the header runs out of nodes, so a search that runs after the window is looking for a block
that was released seconds earlier — and reading a freed, possibly reused allocation is worse than reading
nothing, because it answers.

The fix is not in the harness. **The chain is authored, so the chain can refuse to end**: a `wait` as the last
node parks the thread on `EffectOpcode4_StoreWaitDelay`'s countdown, and it stays alive with its fields intact
for as long as the authored delay. Ten minutes is not a duration anyone waits for; it is "never", written in
the only units the node has.

That buys a second thing for free, and it is what gets the reading into the report at all. The search reports
only candidates whose words **changed** — the filter that separates the real object from an address sitting in
a table. The word this cell wants (`thread+0xe8`, the owner boarder) never changes, so on its own it would be
discarded as a coincidence. `CollisionEffectNode_LifetimeTick` subtracts 1/60 from `thread+0x40` every tick
while the thread is parked, so listing that offset alongside makes the real thread the one candidate that
moves, and carries the static word it is holding into the output beside it.

```ts
lateWatch: { label: 'thread', backPointer: 0xe4, offsets: [0x40, 0xe8, 0xe4, 0xe0], seconds: 4 }
```

Generalised: **when the object you need is short-lived, look for an authored way to stop it ending, and for a
word on it that moves.** The first makes it findable and the second makes it reportable.

## Parts

| file | what it does |
|---|---|
| `run.py` | the loop; every stage skippable so a re-run starts where it failed |
| `emu.py` | PCSX2 launch/shutdown, the boot gates, cold boot to a descending rider |
| `slot_lock.py` | the PINE slot's queue, so two harnesses take turns instead of resetting each other |
| `pad_drive.py` | the site-A cave that works the front end |
| `ee.py` | bulk EE reads, the instance-name → live-entity join |
| `verdict.py` | samples the run and reports it |
| `tally.py` | collapses several runs into one fire-rate table |

`ee.py` finds an instance by searching the heap for its name hash and then **confirming the candidate against
the location the export authored**, rather than trusting the hash hit or a tabulated pair order. A hash
collision or an off-by-one-word read cannot survive that check.

## What it does not tell you

`entity+0xe4` proves a node was **constructed**. It does not prove the node's payload did its job: a cell
that reports `fired` has had its collision graph dispatched, not necessarily its sound played or its boost
applied.

The way past that is a probe on a word the node itself writes, and the fixture now has three shapes of it:
the flip's applied frame (`+0x5c` moving 0 → 1 is paint, not merely construction), the boost node's mode
(`+0x60` reading back the authored value), and `entity+0xe8`, which is read off the instance rather than the
node and so survives the node being torn down. That last one caught the roller's constructor doing exactly
what the spec claims — `0x…a3 → 0x…c5`, setting `0x4`/`0x40` and clearing `0x2`/`0x20` — and caught the flip
taking the instance out of the drawn state and putting it back.

A hop is the one case where the host tells you nothing at all. A MainType-7 node whose index does not resolve
is bounds-checked away and does nothing, while the chain around it dispatches normally — so the host reports
a clean pass either way. The hop cell therefore watches its TARGET, a second prop with no chain of its own
that the rider never approaches. Nothing but the hop can put a node on that slot.

### Reading the rider instead of the node

For anything that acts on the player, the node is the wrong place to look: the question is not what the node
holds but what the rider did. Several nodes write **nothing at all** on their host — a speed pad raises the
rider's speed cap rather than pushing them, a trick pad opens a window, a reset relocates them — so on those,
the dispatch slot is the *only* thing the fixture could ever have seen, and it says nothing about whether the
node worked.

So every sample also carries the boarder's own words, in the same packet as its position
([Trailmap: 360-speed-and-boost], [Trailmap: 390-lap-field], [Trailmap: 360-pads-rt]):

| word | what it answers |
|---|---|
| `+0x150` carried velocity | did a boost push anybody |
| `+0x134` `boost_amount_request` | did a MainType-17 speed pad land — the whole of what it does |
| `+0x138` `boost_flag_window` | the same for MainType 18's trick window, in seconds |
| `+0x114` `laps_remaining` | whether the lap boost's gate is even open on this course |
| `+0x424` raw motion state | which scripted ride, if any, the rider is under |
| `+0x5848` active gem multiplier | the whole of what a MainType-14 node does — `TrickScoreState+0x28` |

Two of those are gates rather than results, and a third rides beside them for the same reason:
`GameModeGlobal`, reported per run as `gameMode`. Four rider-acting opcodes — main types **6**, **14**, **15**
and **16**, the boost-meter fills, the gem multiplier and the time bonus — open by testing it and return
early unless it holds 3 or 5. **The driven front end lands this fixture in mode 2**, so all four are
unanswerable here however cleanly their chains dispatch, and the fixture deliberately carries no cell for
them. It is read rather than assumed because mashing CROSS through the menus takes whatever default the game
offers, which is not a thing the fixture chooses.

The general rule the three of them share: **check the gate before building the cell.** A gated-out node
dispatches, constructs, and reports a clean pass while doing nothing — the most expensive kind of dark cell,
because it looks like a finding.

#### …and re-check it, because a gate can OPEN under you

That paragraph was written when mashing CROSS took the default and the fixture landed in **race, mode 2**.
Steering to showoff changed the answer and nothing went back to say so, so for a while the fixture carried a
standing claim — repeated in Slopesmith's own node description — that four opcodes were untestable here, on
a course that had since started riding the mode their gate demands.

**GOLD, the bench and the instrument all declare `showoff`, so `GameModeGlobal` reads 3 on every pass of
them** and main types 6, 14, 15 and 16 are open. Only one of the four can be authored: the SSF reader and
writer have no branch for 6, 15 or 16, so a document carrying one cannot round-trip, let alone pack. Main 14
is a single float and packs, and `gem-multiplier` on the bench is the cell.

Its observable is the reason it took this long: the node writes nothing on its host, and the pickup chime
sits **after** the gated branch rejoins, so a gem in the wrong mode is fully audible and completely inert.
The mark is `TrickScoreState+0x28` at `boarder+0x5848`, which the handler sets to `max(current, authored)`.

**That word rests at exactly 1.0, which makes it the one rider signal whose BASELINE is a claim.** Every cell
on a course that is not a gem must read 1.0, so an offset that has drifted shows up as a whole column of
something else rather than as one cell that quietly failed — a self-check the other five signals cannot
offer, since none of them has a documented rest value. (`tally.py` therefore holds a per-signal rest value
rather than assuming zero, or a rest reading would print on every row and bury the one cell that moved.)

### And the answer was NO, which is worth more than the write would have been

Three passes in showoff, `gameMode 3`, one rider, 0.46–0.84 m of approach: the chain dispatched every time —
the Debounce behind the MainType-14 node took the slot for its full 3 s — and the multiplier never left 1.0.

The value is in what that kills, because the mode gate has been the standing explanation for this whole
family and it is now spent:

- **not the mode** — the run read 3, which is what the handler tests for;
- **not the sampler or the offset** — the field is read every sample and rests at *exactly* 1.0 rather than at
  noise, which is the self-check above passing;
- **not the owner word** — the speed pad and the trick pad on *this course in these passes* wrote 4.9–5.0
  into their own fields, so a rider-acting opcode did reach this rider;
- **not chain position** — all three are the leading node of their chain.

What is left is narrow enough to aim at: either the handler carries a condition past the mode compare, or the
multiplier is set and reset inside one frame — `TrickScore_ResetCombo` puts the field back to 1.0 on the next
land or bail, and a rider crossing a full-corridor panel is landing constantly. The next cell is this one on
a host the rider cannot land on, or the field read from a code cave at the store rather than at 20 Hz.

The negative half of the gate is a cell too, and it is still worth riding: `gem-multiplier-race` on
**AUTOTEST3**, the course that rides race. Same node, same tier, same chain position, different mode. A gate
is a claim about two outcomes and one course can only produce one of them.

A cell asserts against these with `expectRider`, naming a signal and bounding it: `rise` (m/s), `climb` (m),
`speed` (m/s), the two pad requests, or `jump` — the largest single-sample displacement, which is how a reset
is caught, since no boarder field records that one happened. Every signal is measured on every cell whether
or not it is asserted, because the cell under investigation is exactly the one whose numbers are worth
reading.

**`rise`, `climb` and `speed` are three different questions about one push, and a port can pass any of them
while failing the others.** `rise` is the node's own output — peak vertical speed, the thing the lag
arithmetic produces. `climb` is what a player feels: metres of altitude actually gained, so everything
between the two belongs to somebody else (gravity, the airborne integrator, whether the cap clamps on the
way up). `speed` is the whole velocity magnitude, and it is where the **cap** shows up — a scripted boost
node writes neither pad-request field, so it raises no cap tier of its own, and a grounded rider stays
bounded however violent the push.

`climb` is measured per **continuous stretch** of a cell's window rather than across the whole of it, and the
reason is structural rather than defensive. The cell that measures a throw is the last one on its course by
construction — a launched rider arrives at whatever follows both airborne and climbing — so the rider it
launches sails off the end of the fixture and the engine resets them thousands of metres back up the
mountain. The first batch measured straight through that. Splitting rather than truncating matters too: a
window routinely *opens* with a gap, because the cell fires the moment contact dispatches while the rider is
still close enough to the cell above for a sample or two to belong to that one, and cutting at the first
break left three passes reporting a 13 m/s launch that gained no altitude at all.

Velocity is what makes a boost gradeable. `riderPeakRiseMps` is the highest upward speed the rider reached
after a cell dispatched, **while that cell was the nearest one to them**, and the fixture's slope is authored
with zero roughness, so a positive number is a push and nothing else — every other cell on the course reports
a rise around −7.5 m/s, which is the descent. An `expectRider` of `atLeast` demands a push; `atMost` demands
that one did not happen, which is what a *gated* boost has to prove and what no dispatch-slot reading could
ever show.

Nearest-cell is the whole rule, and getting there took three tries — each wrong one produced a confident
false grade rather than a visible failure, which is the failure mode worth knowing about:

1. a fixed **time window** let the one cell that launches the rider lend its climb to the cell a field below
   it, which reported a 10 m/s lift it had nothing to do with;
2. a fixed **proximity ball** fixed that and broke the other end — a boost host is a 40 m box crossed
   off-centre, so a 25 m ball around its origin admitted only the first few ticks, before the push had built,
   and the cell that *does* lift reported nothing;
3. keeping the time cap **alongside** nearest-cell clipped the last cell on the course, where a launched
   rider falls back into the box and is pushed again long after the node was built: 2.4 m/s attributed
   against a 13.7 m/s run peak that nothing else on the course could have caused.

Nearest-cell alone needs no number. A sample belongs to whichever cell is closest to it, so the window covers
a whole crossing however long the rider lingers and can never reach the next cell.

`laps_remaining` earns its place for the same reason: it is seeded from the COURSE rather than authored, and
it decides on its own whether the lap boost does anything at all. Reporting it per run turns "the node did
nothing" into "the node did nothing *because* the counter was 0", which is the difference between a mystery
and a documented gate.

### The roster, and a probe that refuses rather than guesses

`riderCount` and `roster` are on every run for the same reason again, and they were added the day "how many
riders does this mode put on the mountain" turned out to be something people *knew* rather than something a
run *said*. It matters twice over. A cell that has to be sure whose contact it is reading needs to know
whether there was anyone else to contact; and a rider-acting opcode is handed the boarder its effect thread
owns rather than the rider who touched the prop, so an owner that is not the local human can only be reported
as an anonymous pointer until there is a field to name it against.

The offsets are the engine's own — `sub_00113820` reads the count at `+0x88`, refuses on non-positive, and
walks the array from `+0xC4`, and the standings pass early-outs below 2. What was **not** known is which
object carries them: the walker is a virtual out of the vtable written to `s0+0x34` by 0x00114c88, one of a
dozen sub-object vptrs installed into a single allocation, so the manager sits inside a compound object
rather than at any base the harness already holds.

The first version guessed that base, guessed wrong, and **said so** — which is the part worth keeping. A
wrong base still reads a plausible small integer followed by plausible-looking words, so a probe shaped to
answer would have reported a rider count that was simply made up.

It proves itself before it answers. A candidate is accepted only when the count is in range, every one of
that many slots is a heap-aligned address, and the array **contains the boarder already reached by a
different route**. That last test is the load-bearing one: the local human is a rider like any other in every
engine pass that walks this list, so a correct roster must hold it, and a full 32-bit address landing at an
exact slot is not something a wrong base produces by accident.

That check is also what makes it safe to stop guessing and **scan**. Every candidate offset in a window off
the world is tested the same way, read as one block and evaluated offline so the width costs a single batched
transfer rather than a round trip per candidate. Scanning widens the search; it does not weaken the evidence.
The offset that won is reported as `rosterAt`, because a discovered number nobody prints cannot be checked
for stability across runs, nor promoted to a constant once it has been.

Failing everything, the report prints `UNREAD (no candidate base proved itself)` rather than omitting the
line — a missing line reads like a field of one, which is exactly the answer this probe exists to be trusted
about.

It is read **once**, retried for a couple of seconds and then dropped. The field is settled for a level, so
this is a property of the run rather than a per-sample signal, and a window that cannot satisfy the check
will not start satisfying it: retrying every sample would spend round trips on a question already answered
no, and `samplesPerGameSecond` is graded.

A cell can close part of that gap with a `watches` entry — extra words sampled in the same PINE packet as
the dispatch slot, so "the node ran" and "the node changed something" are read at the same instant. Two
bases:

- `entity` — a pointer chain from the instance, walked once at attach. Cheap, but only valid for structures
  built at level load.
- `liveNode` — offsets relative to whatever `entity+0xe4` holds right now, re-addressed each tick and only
  for cells currently occupied. This is the one contact-built nodes need, because nothing about them exists
  until the contact being measured happens.

Each probe reports three things about its word, and they answer different questions: the **set** of values it
took, where it **ended**, and the ordered **trace** of every change with a timestamp. The set alone was not
enough for the breakable-kill cell — "hid and stayed hidden" and "hid and came back" are the same three
numbers — and the final value alone still could not say *when* it came back. Reading one word against
another's timeline needs the sequence, which is why a cell can also trace `entity+0xe4` itself: the verdict
already reports when the slot filled, and the trace is what reports when it emptied.

The fixture uses the second to read the texture-flip node's own state
(`research/texture-flip-runtime.md`): sub-type at `+0x14`, applied frame at `+0x5c`, captured material and
frame counts at `+0x60`/`+0x64`, enable at `+0x2d0`. A flip never writes the level's material record — it
builds a node-local override table and hands the renderer that — so the node is the only place the answer
lives.

## Two events, held apart

A whole family of nodes has nothing of its own to read: they act on some OTHER node, and a chain runs inside
a single tick, so "did this command reach that node" is a question no host-side sampler can answer. A `wait`
in the chain is what makes it answerable — it puts a second of daylight between the node being installed and
the command that acts on it, and the two timestamps then ARE the measurement.

That is how the three node-lifetime modes were separated, none of which writes a word anyone could probe:

| chain | what the instance's live-node slot does |
|---|---|
| an untouched 3 s Debounce | fills on contact, empties 2.98–3.05 s later |
| …Wait, destroy (mode 0) | empties at 0.98–1.07 s — the Wait's second, not the Debounce's three |
| …Wait, pause (mode 1) | the same 1.00–1.03 s; the slot cannot tell this from destroy |
| …Wait, tombstone (mode 2) | sub-type moves 2 → 5 and the slot **never** empties again |

The pause row is the honest one and worth keeping in that shape. The disassembly says mode 1 calls a stop
method where mode 0 calls the destructor; the fixture says both release the instance at the same moment.
Reporting what was seen rather than what the ELF predicts is the difference between a catalogue and a wish
list — and the reader is told which is which.

The same trick proves the `wait` itself, by putting it in front of an effect already demonstrated to leave a
mark: a breakable kill takes the prop out of the drawn state on the *same sample* its node appears, and with
a Wait ahead of it the two come apart by 1.017 s in every pass. Nothing but a working delay produces that gap.

## A missing transition needs a partner cell

The two suppression latches are the hardest thing this fixture has been asked to grade, because the claim
they make is that something **does not happen**. A populated column 3 or 4 does not run a chain — the engine
only tests whether the column is filled, and a filled one skips the default teardown. So there is no value to
read, no timestamp to catch: the whole evidence is one transition that the control cell has and the latched
cell does not.

That is why they are authored in pairs, an unlatched control one field uphill carrying the byte-identical
chain, and why the pairing matters more here than anywhere else in either fixture. Both events — a region
unloading, a node reaching its own end — happen on the engine's schedule rather than the rider's. A single
cell that never emptied its slot would be indistinguishable from a cell whose region never unloaded during
the window.

Read as pairs, three passes each, they came back byte-identical:

| pair | control | latched |
|---|---|---|
| persistent flag, column 3 | slot empties, flags revert to the rest value | slot **never** empties, flags keep the bit the node set |
| breakable kill, column 3 | slot empties, prop is **drawn again** | slot never empties, prop **stays hidden** |
| breakable kill, column 4 | slot empties, prop drawn again | *identical to its control* |
| pulsing flipbook, column 4 | **three** nodes built and released in 2.6 s | **one** node, held 10.6 s |

The two negatives in that table are worth as much as the positives. Column 4 does nothing for a breakable
kill because the kill's tombstone never reaches a self-end, so the column is never consulted — which means
**which latch an effect needs is decided by how its node ends, not by what the effect does**. A cell that had
only tried the obvious-sounding column would have reported "latches do not keep a prop broken" and been
wrong.

`expectSlot` grades this, as bounds on how many times the slot is released rather than a held/released flag —
and the flag is what it was written as first. That version failed the flipbook cell on its very first replay,
correctly: column 4 suppresses a node's *own* end and nothing else, so a latched pulse still goes when its
region unloads. It builds ONE node where its control builds three, which is the finding, and "never releases"
was never the claim. Bounds also keep the assertion off the course's geometry — how often a region cycles
depends on where the cell sits and how long the window is, neither of which is a property of the latch.

Both halves of each pair are graded, which is the point of grading it at all: assert only that the latched
cell holds on and an engine that stopped tearing anything down would come back green — the exact regression
these cells exist to catch.

Three of the four bars survived the move from the bench to the catalogue. The fourth did not, and it is the
**same lesson a third time**: the flipbook cell's `atMost: 1` was a number fitted to how long the bench course
happened to be. On the catalogue course the region reactivates and runs the whole thing again 35 s after the rider
has gone — one pass of three came back with two cycles of an unchanged 10.2 s node, and the cell went red for
a reason that has nothing to do with the latch. Its claim is *one node per crossing*; the harness counts per
run; those are only the same number on a course short enough that the region never comes back. Withdrawn
rather than loosened, since any bar wide enough to survive an unbounded number of cycles is wide enough to
pass a broken latch.

Its control keeps its bar, and the asymmetry is the useful part: cycling can only ADD pulses to a
free-pulsing cell, never remove them, so `atLeast` is safe where `atMost` is not. The same holds for the two
column-3 cells — `atMost: 0` survived the region cycling in every pass, because a latch that suppresses the
teardown suppresses it every time round.

### The run's own end is not a teardown

`atMost: 0` then failed anyway, on the longer catalogue course, and the cause is worth writing down because it looks
exactly like a broken latch: **four cells released at the same timestamp, which was the last sample of the
run.** A pass ends when the race restarts, and the restart tears down every instance still holding a node.
Five cells released on that sample and they were precisely the five whose slots were still occupied — the two
latched cells, the two spline movers, and the tombstone that is documented never to let go. The other 27 had
released earlier and had nothing left to give up.

So it is an event that happens to latched and unlatched cells alike and separates nothing, and whether it
lands inside the window is a property of the COURSE — the same 61 cells on a shorter map never reach it. The
slot grade now discounts a release on the final sample. That is a harness correction rather than a loosened
bar: the controls still release two to five times and the latched cells still hold at zero, so the pair
discriminates exactly as before.

## A cell that can hang the run goes at the bottom of the course

The trigger column is the one circumstance with no event of its own — nothing outside the effects runtime
fires it, and the authorable installer is a Counter reaching zero, which then runs the trigger column of its
own slot. Asking that question needed three cells: an empty column as control, a bound-node command, and a
breakable kill.

The kill cell **wedged the emulator**, reproducibly, within two seconds of firing. The first batch had it
first of the three, and the two cells that would have explained it were behind it — so a run that should have
separated "the column does not fire" from "this payload is fatal" reported neither, three passes running.
Re-ordered control-first and moved 450 m further down the course, the stall moved with it: same cell, same
two seconds. That is the experiment, and it only exists because the cells were re-ordered rather than the
payload changed.

The finding: a DeadNode payload acts on **whatever node is installed**, and in a counter-scheduled chain what
is installed is the counter that is at that moment inside its own update firing this very chain. The chain
asks the engine to destroy the thing running it.

Two rules came out of it, and the second is the general one:

- **Order cells so a cell that can take the run down is downhill of every cell that explains it.** Nothing
  else in either fixture can do this, so it had never come up.
- A cell that reliably ends a run `stalled` cannot live in a fixture. Every batch would exit non-zero and the
  red light would stop meaning anything — the same argument that keeps `auth-gate-scaled` ungraded, one step
  further. The reproduction is recorded here and in the node's own warning instead: one-input Counter, Wait,
  Mark, with a breakable kill in the slot's trigger column.

The control and the command cell both survived and answered their own question. The column **does** fire — the
kill cell's prop went undrawn with its sub-type at the kill's tombstone tag, which nothing in its collision
chain could do. But the bound-node command in the same position never landed: bit 0x0800 never appeared, on
any pass, while the control beside it was identical. By the time a deferred chain runs, the counter that
scheduled it has already retired and **the instance's node slot is empty**, so a MainType-3 message finds no
receiver and its null guard drops it.

### The third payload, and what the second one was for

Replacing the kill with an ordinary **flipbook** hung the engine too — three passes of three, same second.
That is what made the finding worth the two wasted batches, because it rules out the DeadNode opcode. What
the two payloads share is that both **install a node on the counter's own instance**, and the column runs
while the counter is inside the update firing it: the chain drops the thing running it.

Retail settles it, and the corpus is unusually decisive here. There is exactly **one** counter-fired trigger
column in the twelve levels — MERQUER slot 345 — and it carries exactly **one node, a MainType-7 hop**.
Megaplex's twenty column-5 chains do carry a DeadNode, and every one of them is fired by a Cracked node
rather than a Counter, which is not retiring itself at that moment.

So the fourth cell asks the question with retail's own answer, and it passes: contact → counter → Wait →
mark → the column hops onto a companion 130 m off the fall line that the rider never approaches and nothing
else names, and that companion's slot holds the hopped node on the same sample the count reaches zero. Three
passes, full speed, no stall. **The trigger circumstance is the last authorable column, and it is now
demonstrated** — with the constraint that its payload must reach somewhere other than the object that
scheduled it.

The method lesson is the one already at the top of this section, arriving from the other direction: a cell
that can take the run down belongs downhill of every cell that explains it, and when one does take the run
down, the next move is to **change one thing about the payload** rather than conclude anything about the
column.

### When two cells both want the bottom, change the shape rather than the order

The rule above orders cells by what they do to the RUN. A second kind of cell disturbs only what is
immediately below it, and the bench now carries two: `vent-throw` throws the rider 11–21 m into the air, and
`pad-gate` carries a reset that sends them somewhere else. Each has a real claim on being last, and the
ordering rule cannot settle it because neither is wrong.

What settles it is that the two constraints are not the same size. A reset disturbs **everything** downhill of
it, so that cell has to be last. A launcher disturbs exactly **one** cell — the next one, which the rider
arrives at still airborne — and that is a property of the cell being arrived at rather than of the launcher.
The recorded passes cross the 90 m of spacing in about 2.9 s against a flight nearer 3.8, so an 8 m gate panel
is simply not where that rider is; a 40 m volume is. Sizing the downhill cell to catch an airborne arrival
costs nothing it was measuring and frees the ordering entirely.

The general form: **an ordering constraint is often a contact constraint wearing different clothes.** Before
reordering a course around a cell, check whether the cell below it can just be shaped to survive.

## Probe the pointer the engine passes, not the one it names

The control dispatcher does not call a receiver's handler with the pointer it read out of the instance's node
slot. It adds a **this-adjust** taken from the vtable next to the method, and for the AnimObject family that
adjust is −0x30: the effect-node sub-object is embedded partway into the allocation, the slot registers the
sub-object, and the handler works in allocation coordinates.

So a watch offset copied straight out of a handler is only right for receivers whose adjust is zero. The
counter and the UV scroll are; the clip-budget receiver is not, and probing it at the handler's own number
read past the end of a 108-byte node and came back holding the allocator's poison fill — **a null result
shaped exactly like a command that never arrived**. It was caught by noticing that the poison pattern was
also on the four unrelated probes every cell carries, which no live node would leave.

The general rule this fixture now runs on: a `liveNode` offset is a claim about a struct, and it needs a
value that could only be that struct's — the authored rate reading back exactly, a count at the number it was
authored with — before anything read at a neighbouring offset means anything.

## A right offset can still be an unreadable probe

The clip cells failed the other way, and it took much longer to see. Every offset was correct. The clock at
`liveNode−0x0c` was the clock, it advanced by exactly 1/60 a tick, and it read back the authored rate. What
was missing was any probe that could distinguish the case where **there was nothing to play**.

A model-clip node on a model with no keyframes gets a play window of `start == end == 0`, and at that window
the wrap arithmetic is the identity. A looping clip therefore free-runs at one second per second forever —
indistinguishable from a clip that is playing — and a play-once clip clamps to zero on its first tick and
ends, which looks like a clip that finished. Both readings are what a working clip produces. So the fixture
ran ten passes of "the clock advanced, the clip plays" against a control that also advanced, and the
conclusion it published was that *nothing the engine exposes distinguishes a model with keyframes from one
without*. That conclusion was an artefact of the probe set: both sides of the comparison were the negative
case, because the only model in the fixture with keyframes was a **borrowed** one, and the borrow path drops
the clip (the donor declares `AnimTime 60`; what reaches the runtime is 0).

Two probes fixed it, and neither is clever — `−0x04` is the window end and `+0x2c` is the count of animated
records the model carries. Either at zero means the model is inert and every number beside it is void. They
now ride on every clip cell rather than the one that needed them, because the cost is nil (the live-node
packet is sent anyway, and PINE bills round trips rather than words) and a cell that reports its own window
can never be re-read years later as though it had one.

The general rule: **a probe set needs a reading that the negative case cannot produce.** "The word changed"
is not that, whenever a broken configuration also changes the word. Ask what the failure would look like
before trusting what the success looks like — and if the answer is "the same", the missing probe is the
whole experiment. The corollary that caught this one: a control is only a control if it *can* differ, and a
control built from the same broken ingredient as the subject is just the subject twice.

## A node with no observable needs one behind it

`entity+0xe4` is filled by the **property-node factory**, and a whole main type never goes near it. A
MainType-2 timer emitter builds no property node at all, so a persistent graph containing only an emitter
leaves the slot empty for the whole run — and "the emitter installed fine" and "the graph never ran" are the
same reading. There is no probe that fixes this, because there is nothing on the instance to probe.

What fixes it is the chain. Put the invisible node **first** and a node that does take the slot **second**,
and the second one appearing is execution having reached past the first. `emitter-persistent` is an emitter
followed by a Flag wave (sub-type 13, already demonstrated to install and hold), and `emitter-burst` is the
collision-column form, where the ordinary leading Debounce is the instrument.

The question those two ask is narrower than it looks, and getting it right meant noticing what the fixture
already contained: **the marker on every cell IS a timer emitter**, from the same template with the same
51-word payload. The record packs and has ridden sixty-odd chains. What none of those passes needed is for
anything to run AFTER it — the marker is always last — so "does a chain continue past a type-2 node" was
open while looking thoroughly settled. Put the emitter at the head and the question answers itself.

`persistentTailNodes` on a case is what makes a multi-node persistent chain expressible; before it, the
persistent column could only ever hold one node. Neither cell reads a particle: pixels are out of reach here
and both say so.

Generalised, and it is the same move as the parked effect thread two sections up: **when the thing you want
to read has nothing to read, arrange for something else to be readable only if it happened.**

## The persistent column reads backwards

A persistent graph runs with no contact at all, so its cells invert every convention here. The node installs
before the rider arrives, the transition the verdict calls `fired` is that **install** rather than a dispatch,
and a cell still holding its node at the first sample comes back `pre-occupied` → `unobservable`, which is
accurate and beside the point. The claim moves to the sub-type word instead.

Two of the four then hand the instance to the collision chain's own Debounce as the rider crosses, and that
corroborates rather than spoils it: a sub-type that reads right on the way in and gives way on contact was
really there, and nothing in a collision chain could have written it.

The install is **not at level load**. Every persistent cell's slot is empty for the first forty-odd seconds of
a run and fills 4–8 s ahead of the rider, cell by cell down the course. A persistent effect is scoped to its
stretch of mountain, which is worth knowing before authoring one that is meant to be running already.

## The debounce is load-bearing twice over

Beyond holding the evidence still (above), the 3 s debounce is what makes the NON-flip cells observable at
all, and the reason is worth knowing before anyone "simplifies" it away: the node factory destroys a live
node of a *different* sub-type before building the new one. A particle emitter is MainType 2 and never
touches `entity+0xe4`, so on those cells the debounce survives its full 3 s and is what the harness sees.
On the button cell the flip node replaces the debounce, and what the harness sees is the flip node's own
~0.5 s lifetime instead.

## Steering

The verdict fixtures ride unsteered — a straight fall line, gravity, a stock executable — and that is still
what every effect verdict is made on. What now exists beside it is `steer.py`: a code cave at site C
(`0x00117B7C`, where `input_ring.py` already reads the packed control word the physics consumes) that stores
a forced control word over the one the pad decode produced, for the local human boarder only. The turn axis
is bits 5–10 of the packed word, 6-bit signed ±31. Three details carry the same discipline as the pad cave:

- **the install order is load-bearing.** Site C's hook is a `j` at site+0 with a `jal` at site+4; writing the
  `j` first would put the `jal` in its delay slot for a frame. The installer nops the `jal` BEFORE writing
  the `j`, and restores in the reverse order.
- **the cave proves itself before it runs**: `verify_bounded_writer` disassembles the installed blob and
  refuses unless it contains exactly the two stores it was authored with and the pinned displaced tail.
- **it is removed before anything is measured on an unsteered cell** — the same rule as the pad cave: no
  verdict with a detour of ours still in the input path.

`run.py --weave` drives it as a Weaver — 1.0 s full-lock holds alternating sides with 1.5 s rests, ticked on
the game clock — which is what turned the AUTOTEST4 instrument's carving columns from "waits on scripted
input" into a banked table. A held full lock scrubs the rider to ~4 m/s, which is why steered instrument
rides take the race-mode long window rather than a timed showoff pass.
