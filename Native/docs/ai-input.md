# Autonomous rider input foundation

`AiInput` synthesizes ordinary `RideInput` for the existing `Player`. It has no
position setter, separate integrator or alternate collision model. An immutable
`AiNetwork` shares the course's paths and precomputed horizontal rulers between
input sources. Build 0.66 connects this foundation to visible opponents,
standings and desktop/wrist controls; see `ai-field.md` for the shared field.

The implementation is independently authored from the sanitized clean body of
Trailmap 395 and public Slopesmith ride documentation/behavioral tests. No other
port's runtime implementation was consulted or incorporated. The existing
contribution scope excluding retail characters, stats and named tricks remains.

## Implemented control behavior

- Plan-view projection and eight-metre pursuit, with a forward-only cached
  segment and a thirty-metre scan window from its clamped foot. A long cached
  segment cannot prevent advancement to the next one, and the first forward
  interior foot takes priority over an earlier clamped endpoint. Height remains in the sampled point
  without becoming perpendicular tracking error or extra arc length.
- The board-plane bearing drives a proportional, deadbanded and clamped stick,
  quantized to increments of 1/31. The shared rider's lean and carving turn it.
- A three-dimensional chooser considers the six nearest routes, rejects ends,
  and combines geometric cost with rating/mood. Bounds only prune candidates
  conservatively; folded paths are measured in three dimensions. Ordinary
  tracking may ride a non-respawnable route; a recovery query excludes it.
- A gate stub hands off near its end. Grounded off-path re-choice runs at most
  once per second, using the clean five-metre perpendicular threshold. Build
  0.67 retains the forward cache when the chooser returns its current path.
  Facing away from the pursuit target keeps that otherwise valid path. A new
  path or an explicit placement reseeds the tracker.
- Along-course reference gaps produce a slewed 0.70--1.50 time-scale request.
  Lateral distance does not affect it. The field manager applies this request
  through its fixed-step rider clocks and supplies the standings ladder in
  build 0.66; the input source cannot move a rider faster by itself.
- Rival acquisition, hysteresis and a speed-gated clearance-disc aim change
  produce avoiding input without inventing persistent lanes. Physical body
  separation and the actual competitor roster belong to the shared field manager.
- Raw path event 100 requests an ollie only with its start still ahead, within
  1.531 m of the line and below 0.536 steering magnitude. The initial query looks
  three metres ahead; holding uses the half-metre window. Payload target speed
  controls ordinary boost/brake buttons during the approach. Unmarked natural
  air creates no jump press. Named retail tricks are not synthesized.

The current first-party rider profile uses nominal gain/commit and aggression.
Its low-meter mood floor is 0.31. Skill variation, objective-target attacks,
per-mode mood detail and original airborne trick decisions remain outside this
foundation and cannot be inferred from its passing tests.

## Shared-world command identity

World graph threads and `WorldAction` now carry an actor identity. Collision
dispatch, delayed waits and nested calls retain the subject. Speed conditions
read that actor's speed rather than the local human's. Retiring a rider removes
its speed context and clears rider ownership on pending work while world work
can finish. The legacy single-rider interface defaults to actor zero.

Build 0.66 connects this command plumbing to shared geometry/world lifetime,
subject routing, one world clock, multi-rider forces, private lap/recovery state
and shared audio/mutation delivery. Each rider uses the same scene rather than
an independent complete world; see `ai-field.md` for that integration.

## Validation and remaining integration

Synthetic tests feed the actual `Player` through straight and curved slopes,
gate-path handoff, a marked jump, an unmarked slope and a suspended route with
a reachable ground alternative. They also check horizontal metrics, folded
route selection, non-rewinding search, respawn filtering, catch-up requests,
rival avoidance and all three jump-start gates. World-graph tests cover delayed
subject/speed ownership, nested calls and retirement.

All 56 portable suites pass. The AI suite passes 5,439 synthetic assertions;
owned-course runs pass 31,906 assertions over eleven desktop courses, 22 gate
approaches and 26,400 physics ticks. Quest ARM64 passes 24,688 assertions over
its eight courses, 16 approaches and 19,200 ticks. The 78 world-graph assertions
also pass on both CPUs. Each sampled gate runs for twenty seconds and advances
214.5--404.8 metres by stored course DTF. Megaplex performs two ordinary course
recoveries per approach; the other sampled approaches do not place/reset.
These are single-rider approaches, not a multi-rider field, complete course
finish or lap/performance proof. No headset wear is required for these CPU tests.
The full repository gate passes in 865.2 seconds; the final long-segment
correction additionally passes the affected Native build/test gate, owned-course
runs and Quest checks. Unchanged component results are retained from that full
gate. The Native source audit checks 404 files without forbidden references.

This document records the input foundation at its original milestone. Build
0.66 connects it to the visible shared world, force clocks, standings and
desktop/wrist controls; see `ai-field.md` for current scope and validation.
Shared human play sessions and the wider parity matrix remain active work.
