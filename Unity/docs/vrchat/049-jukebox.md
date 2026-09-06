# 049 — In-world Jukebox (shared video queue)

A panel by the start gate that turns the billboard screens into a **shared video jukebox**. Anyone can **Add video**
(it pops VRChat's keyboard); the URL joins a **synced queue everyone sees**; when a video ends the next is **popped and
played for everyone**; a **draggable scrub bar** moves the **shared playhead**; and a moderator can **lock** seeking to
the current video's queuer. Play a video and it plays everywhere — change it and it changes for everyone.

Built by `OpenSlope/Setup/Jukebox` (`JukeboxSetup`), runs as part of `OpenSlope/Setup All` right after Video Billboards.
Re-runnable via `OpenSlope/Setup/Jukebox`. Lives under `OpenSlope_Map/GateBench/Jukebox`, so it's rebuilt per map.

## The two halves: renderer vs. brain

The video system is split:

- **`VideoBillboards`** (docs/vrchat/041) — the **local renderer**, sync `None`. One AVPro decode painted on every billboard
  screen. It only *decodes and draws*: `PlayUrl` / `Seek` / `StopVideo`, reports `CurrentTime()` / `Duration()`, owns the
  two purely-local concerns (ducking the music while a video sounds; retrying a transient stream error), and reports
  `OnVideoEnd` / `OnVideoReady` / `OnVideoError` back to the brain.
- **`Jukebox`** (this doc) — the **shared brain**, sync `Manual`, on the Jukebox. It owns the queue, the
  now-playing video, the shared playhead and the lock, and drives the renderer.

The AVPro player's **native loop is OFF** (`VideoBillboardsSetup`): the brain must see `OnVideoEnd` to advance the
queue. A native loop would silently restart the stream and the queue would never move.

## What's synced (owner-authoritative)

`Jukebox` is `Manual` sync. Only the object **owner** may write the synced fields, so every mutation first **takes
ownership** (`Networking.SetOwner`), edits, and `RequestSerialization()`s.

| Field | Meaning |
|-------|---------|
| `queueUrls` / `queueOwners` / `queueNames` | the pending queue — parallel arrays of the `VRCUrl`, the `playerId` who queued it, and their name (for the row label). |
| `nowUrl` / `nowOwner` / `nowName` | the currently-playing video + who queued it. |
| `nowStart` (server seconds) | the server time at which the current video's `t=0` played. Every client seeks to `serverNow − nowStart`, so they share **one playhead** (late joiners included). |
| `nowVersion` | bumped whenever the current video should **(re)load** from a fresh decode (a new item / a loop restart). A pure **scrub** moves `nowStart` only (no version bump), so clients `SetTime` instead of reloading the whole stream. |
| `playing` | is anything playing (false ⇒ screens hidden, original billboards show). |
| `lockMode` | the 3-way add + seek/skip lock: 0 unlocked, 1 queue unlocked, 2 locked (below). |

Because the URL must be a real `VRCUrl` (you can't build one from a string at runtime — only a `VRCUrlInputField`
produces one), **every queued item carries a genuine `VRCUrl`** ready to play when it's popped, on any client.

### Why the owner advances

Every client's local decode fires `OnVideoEnd`, but only the **owner** pops the next item (`if (Networking.IsOwner…)`),
so playback can't double-advance. The owner re-anchors `nowStart` to now, bumps `nowVersion`, broadcasts, and reloads
locally; everyone else reloads via `OnDeserialization`. A late joiner gets the synced state, reloads the current video,
and seeks to the shared playhead. A light **drift nudge** in `Update` re-seeks a client whose decode has slipped
(buffering, a stall) more than `driftTolerance` (1.5 s) off the shared playhead.

## Fair round-robin queue

A new video generally goes to the **end**, *unless* someone has already stacked multiple videos — then it's inserted
**before** that person's second one, so nobody hogs the queue. Formally: each item has a **round** = its occurrence
index for its queuer (1st video → round 1, 2nd → round 2…); the queue is kept **sorted by round**. A newly added item's
round is `1 + how many that player already has queued`, and it's inserted **before the first existing item whose round
exceeds it** (`FairInsert`).

Worked example — queue `A B C B` (A, B, C added once; B added a second time), player **D** adds one:

```
before:  A  B  C  B        rounds: 1  1  1  2
D's new item is D's first  -> round 1
insert before the first round-2 item (the second B):
after:   A  B  C  D  B
```

So D's first video plays before B's second — everyone gets their first turn before anyone gets a second.

## Permissions & lock modes

A moderator cycles a **3-way lock** (the Lock button: Unlocked → Queue unlocked → Locked → …), a gradient from fully
open to moderators-only. The synced `lockMode` gates two things — adding, and seek/skip:

| Mode | Add to queue | Seek / skip current |
|------|--------------|---------------------|
| 🔓 **Unlocked** (default) | anyone | anyone |
| 🔐 **Queue unlocked** | anyone | queuer of the current video, or a moderator |
| 🔒 **Locked** | moderators only | moderators only |

So "Queue unlocked" lets people keep contributing videos without being able to scrub/skip whatever's playing; "Locked"
is moderators-only across the board. When seek/skip is restricted, the scrub bar goes **non-interactable** for anyone
who isn't allowed.

- **Remove a queued item** is always its **queuer or a moderator**, independent of the lock mode. The `[✕]` button on a
  row only appears for someone who may remove it.
- Only a **moderator** can cycle the lock mode. "Moderator" = `localPlayer.isInstanceOwner || Networking.IsMaster`.

## The scrub bar (drag to seek)

Unlike the sibling boards (which avoid the world-space UI laser and use Interact for everything), the seek bar is a
**real draggable Unity `Slider`** driven by the laser — that's the natural way to scrub. It fills with playback progress
each frame; an `EventTrigger` (PointerDown/PointerUp) brackets a user drag so the per-frame fill steps aside while
dragging and the seek **commits once, on release** (not every drag frame). A seek re-anchors `nowStart` (no `nowVersion`
bump) and broadcasts, so everyone's playhead jumps without reloading the stream. The bar is `interactable` only for
those allowed to seek right now.

## The other controls (Interact buttons)

Everything except the scrub bar is a look-and-Use **`JukeboxButton`** (a `BoxCollider` + `Interact`):

- **▶ Add video** — reuses `UrlBox` to focus an always-active (invisible) `VRCUrlInputField` and pop VRChat's
  keyboard; on submit its `OnEndEdit → Jukebox.OnAddSubmitted` queues the URL.
- **⏭ Skip** — skip the current video (same permission as seeking).
- **◀ Prev / Next ▶** — page the queue list (a fixed stack of rows, paged — the same reliable pattern as the Players
  Board, since a drag-scrolled `ScrollRect` is unreliable in-world).
- **Screens: ON/OFF (for me)** — local: turn **this client's** decode on/off for framerate (off stops the AVPro decode +
  hides the quads — the single most expensive thing in the world; on reloads + re-seeks onto the shared playhead).
  Touches no synced state, so everyone else keeps watching.
- **🔓 Unlocked / 🔐 Queue unlocked / 🔒 Locked** — the moderator-only 3-way lock (cycles on each press; see above).

## Empty queue

When the current video ends and the queue is empty, the owner **loops the current** one (re-anchors `nowStart`, bumps
`nowVersion`) so the screens stay alive. A **dead link** (`InvalidURL`) is the exception: the owner drops it and either
plays the next queued item or stops (it won't loop a broken URL).

## Placement & ordering

Bench slot 3 (`0 Info · 1 Settings · 2 Players · 3 Jukebox · 4 Diagnostics`), level with its siblings behind the start
gate (`PostBehind` 6 m). See `Map.BenchSlot`. It's the tallest panel (the queue list).

- **Needs the renderer:** `Setup All` runs it **after** Video Billboards; it cross-wires `queue.video = billboards` and
  `billboards.queue = queue` (so `OnVideoEnd` advances the queue). If you rebuild Video Billboards by hand, re-run
  `OpenSlope/Setup/Jukebox`.
- AVPro video doesn't play in ClientSim — **upload** to test playback (the queue/list logic does run in Play with a
  second client).

## Files

- `VRC/Video/Jukebox.cs` — the shared queue brain (sync Manual).
- `VRC/Video/JukeboxButton.cs` — per-element Interact button (counterpart of `PlayersButton`).
- `VRC/Video/VideoBillboards.cs` — the local AVPro renderer it drives (docs/vrchat/041).
- `VRC/Video/UrlBox.cs` — the Add-button keyboard-pop helper.
- `VRC/Video/Editor/JukeboxSetup.cs` — builds + wires the board (panel, scrub `Slider`, queue rows, buttons).

## Note: synced `VRCUrl[]`

The queue is a synced `VRCUrl[]` (plus parallel `int[]` / `string[]`). This relies on VRChat supporting manual-sync
arrays of `VRCUrl` — confirm it compiles + syncs on the first build in the project (cap is `maxQueue`, 24, to stay
within the sync budget).
