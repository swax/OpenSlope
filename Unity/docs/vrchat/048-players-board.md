# 048 — In-world Players Board

A panel by the start gate, in the middle of the board row between the Settings and Jukebox panels (docs/vrchat/047,
docs/vrchat/049), that lists **everyone in the instance** and lets each visitor **warp** to any of
them with a look-and-Use — plus a single **"Hide me on the board"** checkbox that takes *you* off everyone else's list
(so people can't teleport to you). It's one of the start-gate boards — same build pattern, same Interact-driven input.

Built by `OpenSlope/Setup/Players Board` (`PlayersBoardSetup`), runs as part of `OpenSlope/Setup All` after the Jukebox. That same menu item is the re-run (it rebuilds the board in place). Lives under `OpenSlope_Map/GateBench/PlayersBoard`, so it's rebuilt per map.

## What it does

| Control | Effect |
|---------|--------|
| **A player row** (look + Use) | Warp to that player — read their pose **fresh** and teleport you `arriveDistance` (2 m) **in front of** them along their flat heading, facing back at them so you arrive looking at each other. |
| **◀ Prev / Next ▶** | Page the list (the "scroll"). The page/count line under the list reads `Page 1/3  ·  12 players`. |
| **Hide me on the board** (checkbox) | Take yourself **off everyone else's list** — others can no longer see or warp to you. Default **off** (visible). Amber checkmark, because *checked = an active opt-out*. |

The list shows **everyone except you** (you can't warp to yourself) and **except anyone who is hidden**, in a stable
order (sorted by VRChat player-id, so rows don't jump as people join and leave).

## Mostly local, one networked bit

The list and the warp are **pure-local**: each client enumerates VRChat's own player list (`VRCPlayerApi.GetPlayers`)
and teleports its own avatar (`localPlayer.TeleportTo`) — nothing about *who you warp to* crosses the wire.

The **one** thing that has to be networked is the hidden set: when you hide yourself, every *other* client must drop you
from *its* list. So `PlayersBoard` is sync **Manual** with a single synced field — `hiddenIds`, the player-ids that
have hidden themselves. Toggling "Hide me":

1. takes **ownership** of the board object (so you may write the synced field),
2. folds your id **into / out of** the latest `hiddenIds` we hold, and
3. `RequestSerialization()`s it to everyone.

Each client filters its list against the set it last received, and `OnDeserialization` **self-heals** the local
checkbox from the authoritative set. Manual sync also delivers `hiddenIds` to **late joiners**, so a fresh client
filters correctly from its very first rebuild. The owner prunes a departed player's id in `OnPlayerLeft`, so the set
can't grow without bound.

**Race:** editing the *last-received* array means sequential toggles by different people compose cleanly; only two
people toggling in the very same network frame can clobber (last-writer-wins on the whole array), which merely means a
hidden player may have to re-tick the box. That's harmless for a cosmetic convenience, so we don't pay for per-player
objects to make it airtight.

## Scrolling = paging (and why)

The "scrollable list" is a **fixed stack of 8 visible rows** paged with the **◀ Prev / Next ▶** buttons, not a
drag-scrolled `ScrollRect`. Same hard-won lesson as the sibling boards: VRChat's world-space UI laser doesn't reliably
drive a Canvas widget in-world, and a dragged scroll view is even less reliable. So every interactive element — a player
row, a nav button, the hide checkbox — is a **`PlayersButton`**: a `BoxCollider` + `Interact()` that calls back into
the board (`_TeleportToSlot` / `_PagePrev` / `_PageNext` / `_ToggleHide`). The board paints the current page's names onto
the rows and `SetActive(false)`s the empty slots so they carry no stray Interact.

There's **no per-frame work** — the list only rebuilds on join / leave / hide-change (`OnPlayerJoined`,
`OnPlayerLeft`, `OnDeserialization`); player **positions** are read fresh at warp time, so the board costs nothing while
it sits there.

## Placement & ordering

Stands level with its siblings behind the start gate (`PostBehind` 6 m) at bench slot 2, so the row reads
Info · Settings · Players · Jukebox · Diagnostics.
It resolves **nothing** from the map (the player list is a runtime thing), so unlike the Settings/Diagnostics boards it
always builds the same layout and has no build-order dependency on any other system — it only needs the start gate to
exist for placement.

## Files

- `VRC/Boards/PlayersBoard.cs` — the controller (sync Manual; the synced `hiddenIds` is the only networked state).
- `VRC/Boards/PlayersButton.cs` — per-element Interact helper (player row / nav button / hide checkbox).
- `VRC/Boards/Editor/PlayersBoardSetup.cs` — builds + wires the board.
