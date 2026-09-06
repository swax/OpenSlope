# Unity documentation

Implementation notes for the Unity importer, platform-neutral markers, Basis realization, and VRChat/Udon
runtime. These documents describe what this repository builds. Original-game behavior belongs to
`Trailmap/specs` and is cited with location-independent tags such as `[Trailmap: 320-ground-contact]`.
Unity docs own importer/runtime data flow, Unity and Udon constraints, settings,
deliberate divergences, and port verification; they do not maintain copies of
SSX tables, equations, constants, or behavioral algorithms.

The Unity 2022.3 importer and VRChat/Udon runtime are the primary target in this component. The Basis
realization uses Unity 6 and remains an experimental, partially verified port; its index records current
coverage and known gaps. Individual feature documents also retain explicitly labelled historical, retired,
or untested paths where they remain useful implementation context.

Numbers are stable identifiers within each documentation subtree. They must be unique within one folder,
but may be reused across `unity/`, `vrchat/`, and the other component documentation trees.

## Layout

- [Engine-neutral Unity importer](unity/README.md) — terrain, props, materials, lighting, and particles.
- [VRChat runtime](vrchat/README.md) — rideable boards, interaction, multiplayer, and world UI.
- [Experimental Basis port](basis/README.md) — Unity 6 realization of the same marker contracts.
- [Authoring and import guides](authoring/README.md) — Unity-side import/runbook material.
- this directory — features that cross the importer and one or more runtimes.

## Cross-layer features

- [008 — Texture animation](008-texture-animation.md)
- [009 — Collision](009-collision.md)
- [011 — Triggers and interactivity](011-triggers-and-interactivity.md)
- [012 — Spinning pickups](012-spinning-pickups.md)
- [015 — Audio runtime](015-audio-runtime.md)
- [016 — Physics props](016-physics-props.md)
- [018 — Rideable-board visual](018-board-visual.md)
- [019 — Fireworks](019-fireworks.md)
- [021 — Analytic terrain contact](021-smooth-contact-normal.md)
- [023 — Gem pickups](023-gem-pickups.md)
- [026 — Rail grinding](026-rail-grinding.md)
- [028 — Breakable signs](028-breakable-signs.md)
- [031 — Out-of-bounds reset](031-out-of-bounds-reset.md)
- [036 — Breakable props](036-breakable-props.md)
- [037 — Ride-through structures](037-ride-through-structures.md)
- [038 — Animated props](038-animated-props.md)
- [039 — Race-music and announcer runtime](039-race-audio-runtime.md)
- [040 — Boost pads](040-boost-pads.md)
- [044 — Snowfall](044-snowfall.md)
- [050 — Leaderboard](050-leaderboard.md)
- [051 — Teleport](051-teleport.md)
- [052 — Ambient emitters](052-ambient-emitters.md)
- [053 — Hazards, movers, and wind](053-hazards-movers-and-wind.md)
- [054 — Embellishments](054-embellishments.md)
- [VRChat 055 — ClientSim autotest](vrchat/055-clientsim-autotest.md)

## Project boundaries

Snowknife owns archive decoding, extraction commands, bundle production, and portable schemas. Slopesmith
owns interactive map authoring and its design studies. The Unity library consumes their versioned artifacts and
does not reinterpret source formats.

Each project is a top-level folder of the OpenSlope repository, carrying its own licence, so a link
across one of these boundaries is an ordinary relative path. `[Trailmap: ...]` citations stay
location-independent by design — they name a chapter of the specification, not a path to it.
When Unity work changes what is known about the original game, update Trailmap
first and describe only the Unity consequence here.
