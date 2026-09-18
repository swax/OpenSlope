# 042 — Multiplayer networking (shared rideable boards)

How the rideable board becomes a **shared, networked** object so that on an 80-player
instance everyone sees everyone else's board riding under their avatar, board pickups
don't fight, and idle boards cost almost nothing. This is the networking counterpart to
docs/vrchat/017 (the board itself) and docs/vrchat/025 (performance).

## Diagnosing clustered spawns or a stationary remote rider

The TUNING board's **Show FPS / debug** readout includes the local player, instance master,
pool owner, active/locally owned board counts, and aggregate successful TX/RX/failed-send counts.
It also shows the local ridden board (otherwise the nearest active board), its owner, occupancy,
and the age of its last successful send or received packet. While riding, TX should advance on
the owner and RX on the observer. A parked board normally stops sending, so an old packet age
on a free board is expected. `gate fixes` counts corrections of a parked board displaced from
the anchor saved by `PlaceAtGate`; it should ordinarily remain zero.

`PlaceAtGate` retains the requested pose until the board is taken off its post. The owner
reasserts that pose before sleeping or sampling a packet, so a later pool/pickup transform reset
cannot permanently strand the board at the shared build origin. This does not reposition a
board being ridden/carried or one that has left its post.

Serialization is asynchronous: `OnPreSerialization` captures pose and server timestamp together,
and `OnPostSerialization` records success/failure. Simulation sleep is separate from network
completion: an unconfirmed spawn/final pose retries at 2 Hz while parked, and a late join queues
another send. A successful serialization confirms the SDK send, **not receipt by every peer**.
The frame-velocity sample is separate from the packet position so deferred serialization cannot
corrupt the next velocity estimate. Ownership requests arm `_pendingMount` before `SetOwner`,
which may deliver its callback synchronously.

Run `Unity/tools/diagnostics/board-network-check.cs` as an editor command in an idle ClientSim
Play session with a built gate. If it creates a remote test player, rerun after the next frame.
Exit Play afterwards: the check temporarily changes board positions/owners and clicks the posts.
It exercises compiled Udon with injected serialization callbacks and a simulated activation
reset. It does not replace a two-client VRChat test: check all posts, each player mounting/riding,
late join, and ownership after the master leaves. PC and Android clients must use matching builds.

## Why the board has to be networked

A `VRCStation` positions a seated player at the station's seat transform *on each remote client*.
VRChat networks *which* station you're in, but it does **not** fine-sync your moving world
position — it relies on the station's transform being the same on every client. So a board (the
station) that isn't itself synced leaves a remote viewer's copy sitting at the gate while the
rider rides away: they see the rider stuck at the start, not carving down the hill. Making boards
a real shared experience on a big instance means the board has to be a **networked object whose
transform every client agrees on.**

A purely **local-first** board (`BehaviourSyncMode.None`, one private copy of every board per
client — see `RideableBoard`, `BoardSpawner`) does keep one property for free: every client
has the same fixed set of boards (5 posts × 3 = 15) regardless of player count, so there's no
runaway board growth to cap. The networked design below (see "Sizing") keeps that property too.

## Why a fully-networked board, not a hybrid ghost

The board *is* the synced object outright: whoever rides it owns it, runs its physics locally,
and its transform streams to everyone else. Two lighter alternatives don't hold up:

- **Stay local-first** — cheapest, but riders never see each other's boards, which defeats the
  point of a shared mountain on a big instance.
- **Hybrid** — ride a purely-local board for feel, broadcast a thin pose stream that drives a
  separate cosmetic "ghost" board under your avatar on remotes. This runs straight into the
  station-positioning rule above: the thing that places your avatar on remote screens *must* be a
  synced transform, and the natural home for that transform is the board itself. Putting the
  station on the synced ghost makes the ghost *the* networked board — i.e. rebuilds the
  fully-networked design — and running two interpolators (avatar vs. ghost) that disagree on
  carves and landings slides the board out from under your feet.

With the board and the seated avatar as the **same object**, they can never drift apart; the only
artifact is the whole rig being interpolated a hair behind reality, which is universal to all
VRChat networked movement and looks fine.

The usual objection — "won't the network fight my physics?" — does **not** apply in steady
state. In VRChat the **owner is authoritative**: the owner writes the synced transform and VRChat
serializes it *outbound*; inbound deserialization only runs on non-owners. So while you own and
ride the board, your local physics win outright. The cost lives only at the **ownership
seams** (acquiring on mount, losing on leave), and both are handled below.

## Architecture — two layers

Networking splits cleanly into two independent layers:

### Layer A — per-board transform sync + ownership

Each board syncs its own pose and gates its simulation on ownership:

- **Sync mode `Manual`, server-timestamped.** The pose is carried by `_netPos` (Vector3), `_netRot`
  (Quaternion), `_netVel` (Vector3, the owner's world velocity), and `_netSendTime` (double — the
  *server* time the sample was taken). One synced bool `occupied` carries "a rider is on this board."
- **Avatar-fit deck size is synced as STATE, not motion.** `FitToRider` scales the visible deck +
  collider to the rider's eye height — an owner-local change that remotes would otherwise never see
  (a tall avatar would ride an authored-size deck on everyone else's screen). So the fit scale rides a
  synced `_netScale` (float), set **only when it changes** (mount-fit / mid-ride avatar resize /
  dismount-reset) with an explicit `RequestSerialization` at that moment — it is *not* part of the
  continuous pose stream, since size changes rarely. Remotes apply it in `OnDeserialization`
  (`ApplyRemoteScale`, skipped when unchanged so the collider isn't resized every packet); a late joiner
  gets the current size with the first packet because it's a persisted synced field. A stale `_netScale ≤ 0`
  (the new-field default on an un-repushed board) is floored to the
  authored 1 so an existing board never shrinks to nothing. A board **keeps the rider's size after
  dismount** — it's persistent state, so an abandoned or at-a-gate board stays whatever size its last
  rider made it (the next rider re-fits it on mount). A brand-new pool board has never been ridden, so it
  sits at the authored size until first used.
  The owner serializes on a **fixed interval** (`netSendInterval`, ~0.1 s) rather than continuously,
  so packets arrive **regular and timestamped** — which is precisely what makes the remote
  dead-reckoning + acceleration below stable (this is SaccFlight's transport model; `SAV_SyncScript`).
- **Owner simulates; everyone else dead-reckons.** The full ride integration in `Update()` runs
  only when `Networking.IsOwner(gameObject)`. In `PostLateUpdate()` (after all movement, so it's
  robust to the rail/out-of-bounds/coast early-returns in `Update()`) the owner samples its pose +
  velocity into `_netPos`/`_netRot`/`_netVel`; on the send timer it calls `RequestSerialization()`.
  `OnPreSerialization` refreshes the pose and stamps `_netSendTime = ServerNow()` when the SDK
  actually services the request. It does **not** gate the send on `Networking.IsClogged`: VRChat
  already caches a manual serialization and retries it when the pipe clears, so skipping while clogged
  would only drop the freshest pose and lengthen the very gap the remote has to coast over (clog is
  exactly when the next sample matters most). Because `_netVel` is the transform **delta** (`disp/dt`),
  a teleport would otherwise serialize a bogus velocity spike — a *large* hop (> `netSnapDistance`) is
  caught and zeroed in the sampler, but a *short* one (a breadcrumb snap a few metres back onto the
  course) is under that threshold and would publish a rocket. So every teleport path (`RespawnAt` for
  lap loop-backs + on-track OOB resets, `PlaceAtGate` for re-dispense) calls **`PublishTeleport()`**,
  which seeds `_netPos`/`_netRot` to the destination, zeroes `_netVel`, and sets `_nextSendTime = 0` so
  the next `PostLateUpdate` sends the clean pose immediately (with its proper server stamp) and reads
  `disp = 0` rather than a spike. `ServerNow()` is a smooth clock anchored to
  `Networking.GetServerTimeInSeconds()`, common across clients. A non-owner runs `NetFollow()`, which
  has two parts:
  - **Extrapolate** the target forward to where the owner is *now*. The age is **ping-corrected**:
    `age = ServerNow() − _netSendTime` — the time since the owner *sampled* the data (network latency
    included), not just since we received it, so we extrapolate the exact amount the packet is stale.
    It's **curve-aware**: the remote reconstructs the owner's acceleration from two velocity samples
    over the *server-time* gap between their send stamps (regular + accurate, since sends are
    fixed-interval and timestamped) and predicts along the arc — `target = _netPos + _netVel·age +
    ½·_netAccel·accelAge²`. The **velocity term coasts the full `age`**, bounded only by the
    extrapolation **horizon** `netMaxExtrap` (~1.5 s). **The horizon must exceed VRChat's *real*
    manual-sync delivery interval** — which under load is ~0.5–1 s, *not* the 0.1 s requested — and
    this is the crux of a smooth remote: if the horizon is shorter than the real gap, the carrot
    *freezes* partway through every gap and the board stalls then jumps forward when the next packet
    lands; at ~1.5 s the carrot keeps gliding at the owner's last velocity across the whole gap, so a
    late packet finds the ghost already ~where the owner is and only nudges it. Past the horizon (a
    multi-second dropout) the coast *holds*, bounded, rather than rocketing away. The horizon is
    **floored at runtime** — a value `< 1.0` (e.g. the type-default `0` an already-built board carries,
    or any sub-interval setting) falls back to 1.5 — so the fix
    takes effect on existing boards on a plain recompile *without* re-pushing the field to every
    instance. The **accel parabola** uses a separate `accelAge` capped at 0.5 s (acceleration is only
    trustworthy for ~one interval, and an uncapped quadratic would blow up over the long horizon); it's
    low-passed + clamped by `netMaxAccel` and zeroed on a sharp velocity reversal so a wall-hit/carve-flip
    doesn't extrapolate a bounce. The ping-corrected age + full-`age` velocity coast cure the chronic
    *under*-shoot (the per-packet forward lurch); the server-timed interval keeps the reconstructed
    acceleration stable rather than noisy.
  - **Critically-damped chase** of that moving target via `Vector3.SmoothDamp` (`netSmoothTime`).
    This is the SaccFlight insight (`SAV_SyncScript`): never lerp
    the *position* straight at the target — drive the ghost by a continuous internal velocity
    (`_smoothVel`) and let the positional error feed in as a *damped* correction. So when a packet
    lands **behind** the extrapolation, the error bleeds off smoothly instead of yanking the position
    backward (the "lurch forward then snap back" artifact a plain position-lerp produces). The chase is
    **carrot/stick: the ghost only ever *chases* the carrot — during a ride it never teleports.** The
    one hard cut is a genuine respawn: the carrot landing more than `netRemoteSnap` (~50 m) away;
    anything closer slides in via the SmoothDamp, so a normal per-packet correction can never render as
    a forward jump. That 50 m is a **remote-only** threshold, deliberately split from the owner-side
    `netSnapDistance` (~8 m, which only rejects a one-frame teleport from the velocity sample) so the
    two uses can't fight — and it carries the same `> 0` runtime guard against the new-field default.
    **Rotation** is dead-reckoned too: the remote reconstructs the angular
    velocity from consecutive rotation samples (`_rotDelta = _netRot · inverse(_prevNetRot)`,
    low-passed) and extrapolates the heading/bank `age` forward with `SlerpUnclamped` (clamped by
    `netMaxRotExtrap`), then slerps onto that — so a carving board's orientation is predicted, not
    lagged.
  - **The visible deck pose is synced separately from the seat.** The synced root transform *is the
    `VRCStation` seat*, and the seat deliberately drops the carve: in VR it's pinned **level + yaw-only**,
    on desktop it's heading + a capped sliver of view-lean. The board's actual facing, carve **bank**, and
    slope/conform **pitch** are written only on the `Heading` pivot (the visible deck, decoupled from the
    seat). Syncing the root alone therefore left remote viewers watching a *flat, non-banking* plank —
    worst in VR. So the owner also samples the pivot's rotation **relative to the root** (`_netDeckLocal =
    inverse(root) · pivot.rotation`, mode-agnostic — it captures the snowboard's bank or the skis' heading)
    plus the roll angle `_netBank` (so the ski case can re-edge each ski), and both ride along in the
    routine pose packet. The remote recomposes `pivot.rotation = followedRoot · _netDeckLocal` after the
    root follow, slerping the deck-local toward the synced value per frame (it arrives at the packet rate;
    snapped on a respawn cut / first sample). A non-unit `_netDeckLocal` — the `(0,0,0,0)` Quaternion
    struct-default an un-repushed board carries — is read as identity,
    so the deck tracks the root exactly (the old behaviour) until the owner pushes a real sample. The
    cm-scale edge/pitch lift is *not* synced (the pivot rides the root position); it isn't worth a field.
- **Smooth server clock.** `ServerNow()` advances by local `Time.deltaTime` each frame but
  continuously *eases* toward `Networking.GetServerTimeInSeconds()` (5%/frame), correcting the drift
  that builds up when `Time.time` lags real time after a frame hitch (Unity's `maximumDeltaTime` cap).
  Easing instead of hard re-anchoring is what keeps `age` — and therefore the extrapolated position —
  from jumping every time the game hitches.
- **Ownership-gated mount.** `Interact()`:
  1. If `_riding` or `occupied` (synced — someone else is on it), do nothing.
  2. If we don't own it yet, set `_pendingMount`, then `Networking.SetOwner(localPlayer, gameObject)`,
     and return. The mount happens in `OnOwnershipTransferred(localPlayer)` once ownership lands.
     This is what kills the takeover snap — we never simulate while still a non-owner.
  3. If we already own it (solo instance, or a board we just took), seat immediately.
  A `_pendingMount` timeout (~2 s) aborts a request that never resolves (lost race / denied).
- **Can't steal a ridden board.** `OnOwnershipRequest(requester, newOwner)` returns `!occupied`,
  so VRChat refuses to transfer ownership of a board out from under its current rider. Abandoned
  boards (`occupied == false`) transfer freely, which is what lets the master reclaim them (Layer B).
  Note this gates ownership *transfer requests* only — it has no say over `VRCObjectPool.Return`. So
  the reclaim path (`ReturnBoard`) doesn't lean on it: it re-checks `occupied`, grabs ownership, and
  **only `Return`s once it confirms it owns the board** — a rider who mounted in the sync gap denies
  the grab (their `OnOwnershipRequest` sees `occupied`), the master stays a non-owner, and skips the
  return that pass. (The "denied grab ⇒ not owner locally" step is the one bit wanting in-instance
  confirmation; if a denied `SetOwner` still read as owner, a return deferred to `OnOwnershipTransferred`
  would be the fallback.)
- **`occupied` is the cross-client "taken" flag.** Set true in `OnStationEntered`, false in
  `OnStationExited` / every dismount/eject path (all owner-side). The dispenser reads it to know a
  board is free, and `Interact`/`OnOwnershipRequest` read it to prevent stealing.
- **Disconnect-orphan recovery.** Every `occupied`-clear path is a *local rider* path, so a rider who
  **leaves the instance while still mounted** never runs one — the synced flag stays stuck `true` with
  no rider. VRChat then force-reassigns the board (a transfer that bypasses `OnOwnershipRequest`), and
  the new owner would inherit `occupied == true` && `_riding == false`. That would strand the board
  *forever*: `Interact` refuses it, `OnOwnershipRequest` refuses transfer, and the manager sweep treats
  `occupied` as in-use so it never times out. So **`OnOwnershipTransferred` clears it**: an inherited
  board (no `_pendingMount`) that's `occupied` with no local rider is an orphan → `ClearOrphanedOccupied()`
  sets it free and `RequestSerialization()`s the flag. The `BoardManager` sweep runs the same call
  as an authoritative backstop on any board the pool owner ends up owning (covers a cascade where the
  inheriting owner *also* leaves before the clear broadcasts). Only the owner may publish the clear.
- **Idle-sleep (`sleepWhenParked`).** Once a board is parked & settled (no rider, stopped, wake
  melted) for `sleepDelay` (~1.5 s), it **sleeps**:
  `Update()` skips simulation. `PostLateUpdate()` retries the final pose until successful
  serialization, then stops publishing, so the board drops out
  of the continuous-sync budget and does no per-frame work. Remotes' `NetFollow` also idles once
  converged. A sleeping board is therefore ~free while it sits there visible — this is what lets
  abandoned/at-the-gate boards **persist on the mountain cheaply** instead of having to be returned.
  Waking is event-driven (a mount via `OnStationEntered`, or a re-dispense via `WakeUp()`), so it
  never blocks a pickup. Net: **steady cost scales with the number of *active riders*, not the total
  board count** — the irreducible floor you pay anyway to show people moving.

**Solo / non-networked fallback.** A `networked` master toggle (default `true`) gates all of the
above. In a solo instance the local player owns every object, so `IsOwner` is true and the board
behaves exactly as it does today. Set `networked = false` for the from-scratch demo board (docs/
demo) to keep it purely local. (Note the new-field-default gotcha: the `= true`
default only reaches *re-built* boards; re-run the setup or `CopyProxyToUdon` to push it onto
existing scene instances.)

### Layer B — the shared pool / dispenser

Layer A makes one board shareable. Layer B manages the *set* of boards across the instance: one
board per post, click an empty post to dispense another, a hard cap, and reclaim of idle boards.

- **No runtime `Instantiate`/`Destroy`.** Runtime `Networking.Instantiate`/`Destroy` is
  rate-limited, GC-hitchy, and a common desync source. Use a **fixed pre-placed pool** that is
  *recycled* — sized to the cap, never grown. **Decision: `VRCObjectPool`** — the platform-blessed
  component, which also solves late-joiner active-state and the spawned-object ownership transfer
  for us. A master-owned `BoardManager` layers the cap/LRU/timeout *policy* on top (it decides
  *when* to `TryToSpawn`/`Return`); the pool owns the *mechanism* (which objects exist + who owns
  them).
- **Cap = pool size = player cap.** When a board is needed and none is free, **reclaim the
  least-recently-used parked board** (oldest, not `occupied`) and re-pose it to the new post.
  Never reclaim an `occupied` board — the `occupied` checks at the reclaim sites are the guard, backed
  by `ReturnBoard`'s confirm-ownership-before-`Return` (see "Can't steal a ridden board" above).
- **Click-to-browse.** Clicking a post that already has a *free* board **replaces** it with a
  different board from the pool (spawn the new one first — guaranteed different since the old is
  still active — then return the old one), so a player can click through the deck variety without
  the live board count growing. Clicking a post whose board was ridden away just dispenses a new one.
- **Clean re-dispense.** A pooled board is only *deactivated then reactivated*, so it keeps every
  Udon field from its previous life — a leftover coast velocity, a half-melted wake ribbon, grind/
  carve flags — none of which a transform move or `WakeUp()` clears. So `Dispense` poses it through
  **`RideableBoard.PlaceAtGate(pos, rot)`**, which scrubs the motion/visual/audio state to a clean
  still board, sets `atGate` (so the riderless coast bails and a recycled board can't slide off its
  gate), wakes it to tick + sync the fresh pose, and publishes the free state. `atGate` is cleared on
  mount, freeing the post to hand out the next board.
- **Abandonment timeout (declutter backstop).** Because a parked board sleeps and costs ~nothing,
  the timeout is long (`abandonTimeout` = 1 hour): a dropped board persists on the mountain for
  anyone to grab, then eventually recycles so the pool can't stay permanently full. A ridden or
  at-a-post board never times out. Shorten it if you'd rather abandoned boards vanish sooner.
- **Sleep idle boards.** The real CPU cost of a board is its per-frame `Update()` + transform
  sync, *not* GPU (the decks are 44–630 tris). Layer A's idle-sleep (above) makes a parked board —
  abandoned or sitting at a gate — cost ~nothing (no tick, no continuous-sync deltas) while staying
  visible, and `VRCObjectPool` keeps genuinely-returned boards fully inactive. So the live set can
  be large and mostly idle without paying for it; the timeout below is a *declutter* backstop, not
  a perf timer.

**Authority + routing (the subtle part).** `VRCObjectPool` only lets the *pool object's owner*
`TryToSpawn`/`Return`. Keep that owner fixed at **master** (don't let it float between clickers —
that scatters the LRU/timeout bookkeeping across machines). A post click then has to ask master to
spawn, carrying *which* post. Route it with a small synced **request mailbox**: the clicker
`SetOwner`s the request object, writes `[UdonSynced] postIndex`, `RequestSerialization()`; master
(now a non-owner of the mailbox) gets `OnDeserialization`, reads the index, and — as pool owner —
`TryToSpawn`s, poses the board at that post's anchor, and leaves it for the rider to mount (Layer A
transfers board ownership to whoever actually rides, and refuses transfer while `occupied`). Master
also runs the abandonment-timeout sweep and the LRU `Return` when the pool is exhausted. Late
joiners get each board's active-state from the pool and its pose from the Manual per-board sync (VRChat
re-sends the last serialized pose to late joiners).

This authority/routing design is the one to get exactly right — none of it can be verified without
an in-instance upload.

## Sizing

With the abandonment timeout the working set is ≈ concurrent riders, so you don't need 80 live
boards. Pool size = player cap is just the clean hard ceiling so "no board available" can never
happen; in practice far fewer are ever active at once.

## The ownership seams, summarized

| Seam | Risk | Mitigation |
| --- | --- | --- |
| Acquire (mount) | takeover snap if you simulate before owning | gate the seat on `OnOwnershipTransferred`; never sim as non-owner |
| Acquire (contention) | two players grab the same free board | dispenser hands out only free boards; loser redirected; `OnOwnershipRequest` refuses if `occupied` |
| Lose (rider leaves) | VRChat auto-reassigns the board to master | sleeping board doesn't twitch in the gap; if the rider left *mounted*, the inheriting owner's `OnOwnershipTransferred` (and the manager sweep) clears the stuck `occupied` orphan so it's reclaimable again (Layer B) |
| Late joiner | needs current board poses | Manual per-board sync re-sends the last serialized pose on join |

## Verification status

Layer A (board-side networking in `RideableBoard`) is shareable: owner-authoritative sim,
remote pose follow, ownership-gated mount, un-stealable while ridden. `BoardSpawner` still
drives dispensing locally, so riders are visible to each other on a multiplayer instance even
without Layer B. **Remote dead-reckon follow is verified in-instance**: remote riders look
smooth — continuous carving, no forward jumps or teleports. The ownership/mount seams
(takeover-snap, anti-steal) still want multiplayer verification.

Layer B (the shared pool / dispenser) is compile-clean (C# + all four Udon programs) but **not
multiplayer-tested**.

### What still needs an in-instance upload to verify
None of the ownership/sync behaviour can be checked in ClientSim. On upload, confirm: (1)
`VRCObjectPool.TryToSpawn` assigns the spawned board to the master and `Return` deactivates it for
everyone; (2) **✓ confirmed** — a remote rider's board carves smoothly under their avatar with no
forward jumps; (3) taking a board is
snap-free and a ridden board can't be stolen; (4) a parked board sleeps (stops syncing) and wakes
cleanly on mount, abandoned boards return after the 1-hour timeout, and a full pool reclaims the
LRU; (5) `BoardCap = 32` is acceptable scene weight / build time (lower the const in
`StartGateSetup` if not — idle boards are cheap at runtime, so this is mostly a scene-size knob).

See also: docs/vrchat/017 (board ride model), docs/vrchat/025 (performance budget), docs/vrchat/013 (Udon components).
