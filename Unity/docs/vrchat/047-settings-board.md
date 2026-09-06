# 047 — In-world Settings Board

A panel by the start gate holding the things a visitor sets **for themselves**: how they want to ride, what they want
to hear, and which world effects they want to see. Its sibling is the **Tuning Board**, which holds the diagnostics and
every performance claw-back; video has its own board (the **Jukebox**, docs/vrchat/049).

The setup clears an old `SoundBoard` object out of the bench so an existing scene doesn't end up with leftovers.

## Sections

Each row is built **only if that system is present** in the loaded map (a level with no decoded PathFinder song gets no
"Race music" row); the mode picker needs nothing from the map and is always built. Everything here is **local**, so a
click only changes the local client.

### Ride mode — one of three

| Button | What a gate mount starts | Authored map configuration | Recorded as |
|---|---|---|---|
| **Race** | a timed, scored run — the classic | race-only props active; show-off rail props hidden and those rails non-grindable | the leaderboard's **Best times** list |
| **Trick / Showoff** (default) | the same run | show-off rail props/grinding and native gems active; race-only props hidden | the leaderboard's **Top scores** list |
| **Free ride** | *no run at all*: no clock, no HUD readout, no lap countdown | both race-only and show-off-only content hidden | nothing — and boost stays unlimited |

The mode is a **local** choice (this board is sync `None`), so one player time-trialling doesn't stop the next
free-riding. It's pushed onto **every pooled board** as `RideableBoard.runMode` the way the Tuning Board pushes its
telemetry flag — the field only matters on whichever board you actually mount, and you can mount any of them, so the
mode follows you onto any board. `SettingsBoardSetup` also collects every imported `ModeVisibility` object and the
grind `RailNetwork`; `ApplyMode` switches those immediately using the level's `HideShowOff` / `HideRace` tags. The
switch is whole-GameObject presence, so a race-only boost pad loses its trigger/behaviour as well as its decal.

A board reads `runMode` when you **mount** it and freezes it into the run as `RunMode`, so switching the picker halfway
down the mountain doesn't rewrite the run you're on — it takes effect at your next gate mount. `FinishLine` reads that
frozen value and hands it to `Leaderboard.Submit`, which enters the run in **one** list: a time-trial pass with no
tricks can't park a `0` in the score table, and a points run that dawdled for a big line can't be read as a race time.
Both lists still *display* the other metric alongside, so nothing is lost from view.

Race and Trick otherwise use the same board simulation — tricks still animate, score on the nose HUD, and fill the
boost meter in race mode. Their map-content difference comes only from the decoded level effects above. Free ride also
omits the live run; the boost meter never governs the hold (`BoostMeterActive` needs one), which is the unlimited
free-ride boost the board already documented.

### Sound — per-player mutes

| Control | Target | How it works |
|---------|--------|--------------|
| **Background music** | `MusicDirector.uiMuted` | mute flag for the off-board environment bed, or the intro-stem fallback when a map declares no bed. Playback keeps advancing silently so un-muting resumes cleanly. |
| **Race music** | `RaceMusicDirector.uiMuted` | same — the PathFinder race soundtrack (plays while riding) goes silent. |
| **Announcer (MC)** | `AnnouncerU.muted` | gates new MC lines and cuts any line already playing. |
| **Crowd noise** | the looping `Crowd_*` grandstand `AudioSource`s | volume-muted directly (originals captured into `crowdVolumes`, restored on un-mute) — the loops keep playing at volume 0, so un-muting resumes seamlessly. |
| **Environmental sounds** | the looping `Ambient*` wind bed(s) | same volume-mute, from `ambientVolumes`. |
| **Global rider chat** | `BoardVoiceChannel.uiMuted` | un-checked drops you to plain proximity voice even while riding. |

### World — cosmetic effects

| Control | Target | How it works |
|---------|--------|--------------|
| **Snow effect** | `SnowfallU.SnowOn()` / `SnowOff()` | enables/disables the baked snow field's `MeshRenderer`. The field is stateless (flake position is a pure function of time), so it resumes exactly where it would have been. **Moved here off the retired Performance Board** — it reads as taste as much as framerate. |

## How muting works

The music/announcer systems are switched by a **mute flag** the director honours every frame, **not** `SetActive` on the
object. That's deliberate: a deactivated music director's `Update` won't re-`Start` its two-source crossfade state
machine on re-enable, so the bed would never resume — it would just go permanently silent. Instead each music director
folds the flag into its volume (alongside the existing race/video ducks), so muting is silent-at-0 and the bars keep
advancing under the hood; un-muting resumes seamlessly. The announcer's `muted` gates new lines (and cuts a playing one).

**Crowd noise** and **environmental sounds** have no Udon controller of their own — they're plain looping `AudioSource`s
(built by `AudioBuilder`). The board holds them directly and **volume-mutes** them (capturing their authored volumes
into a parallel array, restored on un-mute) — same silent-but-running idea as the music, and for the same reason (a
deactivated looping `playOnAwake` source won't auto-resume). The setup finds them by the importer's `Crowd_NN` /
`Ambient` naming, so a row appears only on maps that actually have that audio.

The mute flags are **`bool`s defaulting to `false` (= audible)**, so the [new-field-default gotcha][nf] can't leave a
live, un-repushed director silent: an instance that predates the field reads `false` and stays audible.

[nf]: ../../VRC/Audio/MusicDirector.cs

## Design

- **Per-player + local** (`SettingsBoard` is sync `None`): a click changes only the local client. Defaults are
  **all-ON, mode Trick / Showoff**, so an untouched board starts with the retail trick layer visible.
- **Input is VRChat Interact, not the UI laser** — each checkbox row has a `BoxCollider` + a `SettingsToggle` whose
  `Interact()` flips that row's Toggle and calls `Apply()`; each mode chip has one + a `SettingsModeButton` whose
  `Interact()` calls `SetMode(i)` (the laser doesn't reliably grab a world Canvas widget).
- The mode picker is **three chips, one lit** rather than three checkboxes — the board repaints them in
  `PaintModeButtons` so it reads as one choice, not three switches.
- `Apply()` re-reads every control and re-asserts the whole board — idempotent and order-independent, run on each Use.

## Placement & ordering

Bench slot 1 (`0 Info · 1 Settings · 2 Players · 3 Jukebox · 4 Diagnostics`), level with its siblings behind
the start gate (`PostBehind` 6 m). See `Map.BenchSlot`.

- **The board holds LIVE refs to every system it controls, so it must be built AFTER them.** `Setup All` runs it after
  Music Director + Race Audio (the mutes), **Snowfall** (the snow effect) and the **Start Gate** (the pooled boards the
  ride mode is pushed onto). If you rebuild any of those by hand, re-run `OpenSlope/Setup/Settings Board` afterward.

## Files

- `VRC/Boards/SettingsBoard.cs` — the controller (sync None).
- `VRC/Boards/SettingsToggle.cs` — per-row Interact helper (counterpart of `DiagnosticsToggle`).
- `VRC/Boards/SettingsModeButton.cs` — per-chip Interact helper for the ride-mode picker.
- `VRC/Boards/Editor/SettingsBoardSetup.cs` — builds + wires the board (`OpenSlope/Setup/Settings Board`),
  lives at `OpenSlope_Map/GateBench/SettingsBoard` so it's rebuilt per map.
- Controlled systems: `ModeVisibility` / the grind `RailNetwork` / `MusicDirector` / `RaceMusicDirector` / `AnnouncerU` / `BoardVoiceChannel` / the
  `Crowd_*` + `Ambient*` `AudioSource`s / `SnowfallU` / every pooled `RideableBoard` (`runMode`).
