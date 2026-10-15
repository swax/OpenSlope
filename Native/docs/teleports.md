# Authored instance teleports

Build 0.31 implements main-type 24 from clean Trailmap 150/230/390. A collision
thread with a rider resolves the destination's stable instance reference. The
destination can be invisible and collision-disabled; it is a placement marker,
not another trigger. A missing reference is ignored while the surrounding graph
continues. Ownerless setup/detached threads cannot move the player. Existing
SSFLogic data and saved source behavior files retain the same target joins.

Each rider's fixed creation slot chooses one of six offsets in the exit's own
frame: `(-1,0), (-1,1), (0,1), (1,1), (1,0), (0,0)`, multiplied by three metres.
Diagonal offsets retain their full length. The exit's local positive Y supplies
the horizontal arrival heading. Native converts that axis once into its frame,
so rotated exits face correctly. The current single player uses slot zero;
the shared placement helper and player tuning support all six slots. Destination
scale does not multiply the three-metre spread; this is the application policy
for custom scaled markers, since the shipped marker has unit scale.

Arrival is immediate and stopped. A native vertical query seats the rider on
available snow/rideable props; with no nearby hit the rider arrives at marker
height and falls normally. The query uses the shared two-metres-above/three-
metres-below placement span, an application choice where the teleport's exact
probe bounds are not established. Heading, body pose and camera are re-anchored,
and old collision travel ends before a solid beyond the entrance can cause a
response. There is no interpolation, snow wake or checkpoint/finish sweep across
the jump. Banked score, meter, run clock and world tombstones persist; pending
tricks and transient rider motion clear through the normal placement primitive.

Walking arrival preserves walking and places the parked board within reach,
including native support state. This is an application extension beyond the
recovered mounted rider. The first reset/teleport placement request in a fixed
tick wins, and at most one teleport is applied that tick; ambiguous custom
placement chains do not become unbounded recursion. Graph execution otherwise
retains its existing ordering and bounds. These choices do not establish full
multi-rider AI dispatch or an arbitrary moving marker transport system.

Transport uses a spatial placement serial distinct from the audio-reset serial,
so the camera/physics reset does not skip or restart the playing song. The actual
entry graph plays direct course slot 122 before requesting teleport. Rider-owned
course one-shots queued on a successful teleport frame play as local feedback so
the now-distant listener still hears the entry cue. That mix policy is an
explicit application choice; the clean spec establishes the cue and slot but
does not settle the direct-slot node's exact spatial mixing. Unrelated ambient
and collision emitters retain their ordinary spatial behavior.

## Evidence and remaining scope

Thirty-one portable suites pass. The teleport suite has 49 synthetic checks and
52 with the owned MERQUER comparison: six spreads through the real player,
rotated/scaled markers, stable references with stale payloads, legacy joins,
missing/ownerless targets, stopped/probed placement, interrupted solids, walking
and remounting, retained music, clock/score/meter continuity and skipped events.
An independent ISO fixture checks the twelve-byte node and target reference.

Five production Vulkan cases render 185 frames. Destination-facing marker pixels
verify both normal and rotated camera arrivals; PCM captures verify audible
entry feedback. Walking, Showoff countdown/clock, absent floor and skipped
checkpoint/finish cases run through the actual desktop host. A separate capture
crosses the actual imported MERQUER entrance 2308, stops at exit 3332's slot-zero
offset and moves about 816 m. Its exact target metadata is checked on the CPU;
the diagnostic-text capture comparison allows for its six-significant-digit
printing. This establishes the targeted portal, not a complete course ride.

The 0.31.0/code 32 ARM64 app and compatible test APK build and verify their
signatures. Lint reports zero errors/four existing warnings; fifteen exact
license/notice assets and no course media are packaged. The source-boundary
audit checks 225 files. Desktop/APK snapshots and a commit/hash manifest stay
in the ignored build tree. Device instrumentation is compiled, not newly run.

Full original score/time/energy opcode dispatch, grabs, uber tiers, AI races,
remaining effects/world properties, original lap transport and wider rendering/
performance/HUD work remain in desktop-parity.md. Those extra score/time opcodes
are absent from the shipped graph corpus and remain explicit work rather than
being silently marked supported. No new headset execution or VR performance
result is claimed; the installed steering build and imported ALASKA are preserved.

```powershell
./temp/native/Release/openslope_teleport_tests.exe
./temp/native/Release/openslope_teleport_tests.exe temp/native-rails-0.17.0/Maps/MERQUER
python Native/tests/teleport_replay_test.py temp/native/Release/openslope_player.exe
```
