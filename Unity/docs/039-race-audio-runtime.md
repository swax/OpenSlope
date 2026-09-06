# 039 — Race-music and announcer runtime

Unity playback for the PathFinder graph and announcer banks produced by Snowknife. Graph/file
decoding belongs to [Snowknife 039 — Race-audio extraction](../../Snowknife/docs/039-race-audio-extraction.md),
and retail behavior is specified by `[Trailmap: 270-music-graph, 430-music-and-announcer]`.

## Inputs

`snowknife race-music` stages a song directory containing `graph.json` and decoded `chunk_NNN.wav` files.
`snowknife speech` supplies event-grouped MC banks under `Assets/OpenSlope/Maps/Shared/speech/mc/`.

`OpenSlope/Setup/Race Audio` loads those assets, builds `OpenSlope_Map/RaceAudio`, and wires every rideable board.

## PathFinder director

`RaceMusicDirector` walks the decoded song graph. Two AudioSources alternate chunks with
`PlayScheduled`, butt-joining them at DSP-time boundaries. At each boundary the director either chooses the
first link whose range contains the current path level or applies a queued event's router jump.

The port derives path level from available ride state—base intensity plus speed, boost, and airtime—and eases
toward the target. Boost edges queue tier-one enter/exit events. This substitutes for parts of the retail trick
state that the free-ride board does not implement.

Race music fades in on mount and out on dismount. While active it ducks `MusicDirector`, which normally owns
the map-declared environment bed off-board and falls back to intro stems only when that declaration is absent.

## Announcer

`AnnouncerU` holds selected event banks such as Go, Big Air, Land, Knockdown, Slow, Boost, and Sweet.
It chooses a random variant without immediately repeating one, subject to per-event probability controls and
a global cooldown that approximates the retail excitement gate.

`RideableBoard.Race.cs` supplies the events:

- mount → Go;
- sustained airtime → Big Air;
- landing after meaningful airtime → Land;
- out-of-bounds recovery → Knockdown;
- slow riding, boost edges, and a long clean stretch → their matching calls.

Announcer playback is a local two-dimensional voice source. It is not synchronized between players.

## Current limits

- A setup currently wires one playlist song even when Snowknife decoded multiple candidates.
- The announcer uses a cooldown/probability approximation rather than the complete excitement ladder.
- Crowd name chants remain unwired.
- The finish router becomes useful only when a race-mode finish event is active.

## See also

[015 — Audio runtime](015-audio-runtime.md), [017 — Rideable board](vrchat/017-rideable-board.md), and
[019 — Fireworks](019-fireworks.md).
