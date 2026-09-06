# 043 — Multiplayer items & effects (shared one-shots)

How world **items and effects** become shared across players, now that the board itself is networked
(docs/vrchat/042). When one rider sets off a firework, opens a door, shatters a sign, or grabs a gem, the goal
is for the *other* players to see it too, without paying a synced object per trigger on an 80-player
instance. This is the world-effects counterpart to docs/vrchat/042 (the board) and docs/vrchat/025 (performance).

## Detection is local, sharing is a broadcast

Every runtime effect the VRChat wiring pass realizes **detects locally**: each client detects its *own* local
player (or its own owned board) crossing a trigger volume. Detection stays local; the effect itself
**broadcasts** (`SendCustomNetworkEvent`) so every other client plays it too — which requires the
behaviour's sync mode to be **`Manual`**, not `None`: `None` *blocks* `SendCustomNetworkEvent` (VRChat
logs "Unable to send network event … with SyncType 'None'"). These broadcasters (`FireworkTrigger`,
`AnimTriggerU`, `BoostPad`, `GemPickup`, `BreakableLogoU`) are `Manual` with zero synced
variables, so they carry no per-frame sync traffic — Manual is just what lets the event through. The one
exception is `AmbientEmitter`'s dedicated contact-driven particle subtype: it manually serializes one transient
point/normal/sequence per hit because a parameterless event cannot reproduce where and which way the burst fired.
(`PhysicsProp` stays `None` — it broadcasts nothing.)

This is *not* "network everything." Two questions decide what each effect needs.

## Decision 1 — does this effect even need to be shared?

"Each player sees their own" is already correct and **free** for most effects. An effect only needs
cross-player agreement when divergence creates a **physical or visual contradiction**:

| Effect | Divergence if left local | Verdict |
| --- | --- | --- |
| **Breakable sign / logo** (`BreakableLogoU`) | shattered for me, still lit/intact for you (visual only — these ride THROUGH either way) | **Share — one-shot** |
| **Iris door / gate** (`AnimTriggerU` → `AnimatedPropU`) | open for me, shut for you → you hit an invisible wall | **Share — one-shot** |
| **Fireworks** (`FireworkTrigger`) | I see the volley, you see nothing | **Share for spectacle — one-shot** |
| **Boost pad** (`BoostPad`) | the *boost* is on *my* board; only the sparkle/chime is worth sharing | **Share cosmetic only** |
| **Gem pickup** (`GemPickup`) | gem gone for me, present for you | **Shared pop + regrow** (see below) |
| **Physics props** (`PhysicsProp`) | crash bag flung for me, parked for you | Low stakes; kept local |
| **Free-running anim** (bridge / kicker, flipbooks) | none — keyed off shared `Time.time` | **Already synced, nothing to do** |

**A gem hit is a shared POP + regrow — the same effect for everyone.** In a non-competitive free-roam
world there's no scarcity to enforce, so a gem is never consumed: hitting one makes it **pop** (vanish
INSTANTLY — a one-frame snap to nothing, no shrink — in a sparkle burst), **hold** gone for `popHoldDelay`
(~0.5 s, collider off the whole time), then **grow back** from nothing over `growBackDuration` (~1.2 s). The
gem only ever SCALES — it's never destroyed or hidden per-player — so it's always present and re-collectible
for everyone, and a transient shared pop can't strand it. It's **poppable again as soon as it starts
regrowing** (a re-hit mid-grow just restarts the pop); the **hold blackout** is what keeps a single *slow*
pass from double-popping — the collider is gone long enough that you've cleared it before it returns. The
collector hears the chime **locally** (instant, no round-trip); on a networked instance the pop is broadcast
(`SendCustomNetworkEvent(All, Pop)`) so every player sees the gem you hit pop + regrow — and the collector's
own broadcast echo is swallowed by a short dedupe window so it doesn't double. The hold-then-grow self-steps
with delayed events only during the pop cycle (no per-gem `Update`), and it writes a different transform
channel than the `SpinnerManager` spin (scale vs. rotation), so the two never fight.

## Decision 2 — does the shared state need to OUTLIVE the event?

There's one rule that shapes the choice:

> **A network event (`SendCustomNetworkEvent`) never reaches late joiners.**

So for anything you share, ask: *would a late joiner who missed the event see something wrong — and for
how long?*

- **No, or only briefly → broadcast a fire-and-forget event.** This covers genuinely transient
  one-shots (a firework volley, a pad sparkle, a gem cue) **and auto-resetting effects** (a door that
  closes itself, a sign that respawns). The auto-resetting ones self-heal: the worst a late joiner can
  miss is the short window before the reset — and by the time they spawn in and look, it has very likely
  *already* reset. Not worth carrying as persistent state.
- **Yes, indefinitely → synced state.** Only a **genuinely permanent** change (one that stays changed
  for the whole session, with no auto-reset) needs state delivered to late joiners. **Nothing in the
  world currently does this**, so it isn't built — see Layer B.

Everything shared today is in the first bucket. That's the whole implemented surface: Layer A.

## Layer A — shared one-shots → broadcast a network event

The single client that crosses the volume normally calls
`SendCustomNetworkEvent(NetworkEventTarget.All, …)` instead of firing directly. These event-only behaviours
carry no synced variables or ownership state. The contact-emitter exception writes one manually synced frame,
plays locally immediately, and lets `OnDeserialization` replay it remotely; a server-time guard suppresses the
old frame for late joiners.

**Why exactly one broadcaster (no dedup needed).** Detection is single-source: only the *local* walking
player raises `OnPlayerTriggerEnter`, and the board's `RiderProbe` path is gated on `board.IsRiding`,
which `RideableBoard` **forces `false` on remotes** (`Update()` early-returns into `NetFollow()` for
non-owners). So a remote board sweeping the same volume on your screen never fires — only the one client
who actually owns/rides the board (or walks through) broadcasts. The existing per-volume `Cooldown`
absorbs re-entry and throttles the broadcast.

Applied to:
- **`AmbientEmitter`** — ordinary dust/water/fire bursts broadcast parameterless `Play()`. A SubType-2 snow-tree
  burst instead syncs its live collider-surface point, outward normal, sequence, and timestamp so every peer's
  P6 shader uses the same origin and base direction; the transient state is ignored after three seconds.
- **`FireworkTrigger`** — `TriggerVolley()` (cooldown-gated) broadcasts `Fire()`; the staggered
  `FireNext()` volley then runs on every client.
- **`AnimTriggerU`** — `FireTrigger()` broadcasts `Fire()`, which calls the prop's `Trigger()` on
  every client; the door plays its own clip + auto-reset off the shared event, so it opens ~together
  and nobody rides into an invisible wall. (Added a 1 s `Cooldown` to throttle rapid re-entry.)
- **`BoostPad`** — **split**: the boost is a private change to *your* board, so `ApplyPadSpeedBoost`
  stays **local** (a remote shouldn't speed up because someone else hit a pad); only the cosmetic
  `PlayFx()` (sparkle + chime) is broadcast to `All`.
- **`GemPickup`** — `Hit()` pops the gem **instantly** (local, snappy: chime + `Pop()`) then broadcasts
  `Pop` to all, so everyone sees the same sparkle + instant vanish + grow-back. The chime stays local (the
  collector hears their own pickup; remotes only *see* it). `Pop()` self-guards on a short dedupe window, so
  the broadcaster's own echo no-ops while a remote plays the full effect. The gem is never hidden/destroyed -
  it only scales (snap to 0, grow back), so it stays collectible for everyone and regrows on its own.
- **`BreakableLogoU`** — `Hit()` shatters **instantly** (local, snappy) then broadcasts `NetBreak` to
  all; each client shatters its own copy and runs its own `respawnDelay` timer, so the sign re-arms
  within network latency of itself everywhere. `Break()`/`Restore()` self-guard on `_broken`, so the
  broadcaster's own `NetBreak` no-ops and a remote shatters with the full effect (sound + debris + piece
  throw). A remote's piece-throw falls back to the prop's facing (it didn't see the impact velocity) —
  invisible cosmetically. With `respawn = false` (a permanent break) a late joiner sees it intact until
  they break it themselves — the one existing toggle that technically wants Layer B (below); left as a
  one-shot anyway, acceptable for a cosmetic ride-through screen.

Each carries a `networked` toggle (default `true`). `NetworkEventTarget.All` includes the sender, so the
local client also runs the event — detection calls *only* the broadcast (or, for the split effects, the
local half + the broadcast), never the shared effect twice, so there's no double-fire. With
`networked = false` it falls back to the local-only path (solo / demo).

The VRChat wiring pass realizes these (`UdonTools.AddConfigured`, [013](013-udon-components.md)), which pushes the proxy's field defaults through
`CopyProxyToUdon` — so the `networked = true` default lands on a **re-import** with no change to the marker,
and there's no separate setup step. (Existing already-built instances read the new field as its
type-default `false` = local until re-imported — the new-field-default gotcha. Safe fallback
either way.)

## Layer B — genuinely-permanent state (not currently needed)

If a future effect ever needs to **stay** changed for the whole session with no auto-reset — a sign that
breaks once and never returns, a switch that stays flipped, a one-time collectible — a fire-and-forget
event isn't enough: a late joiner must be told the current value. The pattern to reach for then (not
built, because nothing needs it yet):

- **One master-owned `Manual`-sync object holding a packed array** keyed by a stable per-item Id —
  collapse N items into a single sync object so a late joiner gets the whole world in one
  `OnDeserialization`, instead of a `[UdonSynced]` flag per object (a swarm of sync objects + a
  late-joiner serialization storm).
- **A floating-owner request mailbox** — the `BoardRequest` pattern (docs/vrchat/042) — to route "item N
  changed" from a non-master to the master, since only the master may write the synced array.
- **Local prediction** (change instantly, reconcile on the authoritative echo) for snappy feel.

This is deliberately deferred. The trigger to build it is an effect with **no auto-reset** whose
divergence would otherwise persist — which is exactly the case the auto-resetting breakable *isn't*.
Until then it's pure cost.

## The seams, summarized

| Seam | Risk | Mitigation |
| --- | --- | --- |
| Single broadcaster | a remote board double-fires on its own screen | `IsRiding` forced false on remotes → only the owner/local crossing broadcasts |
| Broadcast apply | the broadcaster double-plays its own effect | the effect targets self-guard (`Break`/`Restore` on `_broken`) or the local half + broadcast are distinct calls |
| Late joiner | misses an event fired before they joined | only matters for permanent state (none today); auto-resetting effects self-heal (likely already reset by arrival), transient ones are irrelevant |
| Dropped event (clog) | a remote misses one cue | cosmetic + self-healing; the next action re-syncs — that's *why* these are kept stateless |

## Implementation status

Layer A — one-shot broadcast on `FireworkTrigger`, `AnimTriggerU` (door), `BoostPad`
(cosmetic), `GemPickup` (shared pop + regrow on hit), and `BreakableLogoU` (shatter +
per-client respawn) — is compile-pending and **not multiplayer-tested**. A re-import turns it all
on (the `networked = true` default is pushed by the wiring pass's `UdonTools.AddConfigured`); no
separate setup step.

Layer B — genuinely-permanent synced state, the packed-array + mailbox pattern described above —
is not built, reserved for when an effect actually needs to outlive the session without resetting.

### What still needs an in-instance upload to verify
None of the broadcast behaviour can be checked in ClientSim. On upload, confirm: (1) a rider's firework
/ opened door is seen by **other** players, exactly once (no double-fire, no miss); (2) a boost pad
sparkles/chimes for everyone but only boosts the rider, and a gem hit by one player pops (vanishes) +
sparkles + holds ~0.5 s + grows back for everyone (re-poppable mid-grow; the hold debounces a slow pass); (3) a sign
shattered by one player shatters for everyone and re-arms on each client (a late joiner who arrives
mid-break either sees it already reset or just shatters it themselves). There's no central authority,
ownership transfer, or master migration in this layer, so nothing else to stress.

See also: docs/vrchat/042 (board networking), docs/028 (breakable signs), docs/019 (fireworks), docs/038
(animated props), docs/040 (boost pads), docs/036 (breakable props), docs/vrchat/017 (rideable board).
