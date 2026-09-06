# Ride study

Instruments for the ported ride model (`src/app/ride/physics.ts`, `docs/016`). Each one drives the real
model over synthetic geometry — a kicker, a grind line, a boost box — and prints what the board actually
did, tick by tick. They answer "why does it feel wrong here", which a pass/fail check cannot.

They print for a person to read. Only `jump-trace` also asserts, and only when asked (`assert`); the gate
invokes it that way for both jump shapes, faceted and smooth — see `test/run.ts`.

| Command | Question it answers |
|---|---|
| `npx tsx tools/ride-study/jump-trace.ts <kicker\|roller> [faceted] [assert] [quiet]` | At a jump lip, does the board carry takeoff momentum ballistically or get bent onto the landing? |
| `npx tsx tools/ride-study/rail-trace.ts` | Does the rail state match `[Trailmap: 350]` — vacuum catch, tangent capture, junction chaining, running off the end? |
| `npx tsx tools/ride-study/boost-throw.ts` | How far does a boost node throw the rider, at Megaplex's own tuning and box? |
| `npx tsx tools/ride-study/retail-pose-compare.ts [rig-study.json]` | Do the authored riding stances produce retail's measured board-frame poses? |
| `npx tsx tools/ride-study/board-bed-study.ts <report>` | How does OpenSlope's authored board-audio curve respond across a measured AUTOTEST4 run? |
| `npx tsx tools/ride-study/ice-slip-sweep.ts [surface] [drive] [recover]` | What slip angle does a held lean settle at — and when the input centres, does the TRAVEL come back under the board or does the board just swing onto its drift? |

`ice-slip-sweep` is the port half of a two-sided measurement; `Trailmap/tools/analysis/ice_slip_retail.py`
runs the same question over the retail v4 captures so the curves can be compared directly.

`board-bed-study` reads AUTOTEST4 instrument runs under `Trailmap/temp/autotest/` (local, gitignored capture
output from your own emulator sessions). It reports measured
signal distributions beside OpenSlope's authored response and carries no retail expression program.
