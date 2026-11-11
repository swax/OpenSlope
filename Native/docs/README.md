# Native documentation

Start with the [Native README](../README.md) to download and play. This index groups player
instructions, supported imports, feature contracts and contributor guides. The
[parity matrix](desktop-parity.md) records current coverage; individual reports retain their
build-specific evidence and limits. [Release notes](../releases/) collect version changes.

## Player guides

- [Map library and ISO import](map-library.md)
- [Quest course library and first use](quest-launcher.md)
- [Desktop controls and authored starts](desktop-controls.md)
- [Equipment, camera and ride interfaces](equipment-camera-ui.md)
- [Quest controls and grip frames](quest-controls.md)
- [Quest riding steering](vr-steering.md)
- [Walking and boarding](boarding.md)
- [On-foot movement and stock equipment](foot-flight.md)
- [Avatars and controllers](avatar.md)
- [Course progression and timed runs](course-runs.md)
- [Desktop and wrist audio settings](audio-settings.md)
- [Native graphics quality](graphics-quality.md)
- [Desktop gameplay parity work](desktop-parity.md)

## Game imports

- [SSX (2000) PS2 import](ssx-import.md)
- [SSX Tricky GBA import](ssx-gba-import.md)
- [SSX 3 PS2 import](ssx3-import.md)
- [SSX On Tour PS2 import](ontour-import.md)
- [1080 Avalanche course import](avalanche-import.md)
- [Jonny Moseley Mad Trix import](madtrix-import.md)
- [Disc course titles](course-titles.md)
- [Import sessions and converted music](import-cache.md)
- [ISO import performance](import-performance.md)
- [SSX 3 and On Tour fidelity audit](streamed-world-fidelity.md)

## Riding and course behavior

- [Native prototype specification alignment](spec-alignment.md)
- [Authored collision foundation](collision-foundation.md)
- [Playable authored prop contact](world-contacts.md)
- [Course recovery and reset fade](course-recovery.md)
- [Crash and animated recovery](crash-recovery.md)
- [Rails](rails.md)
- [Rail response and flowing water](rail-water.md)
- [Pads and scripted boost volumes](boost-volumes.md)
- [Wind vents and shaft entry, build 0.54.1](vent-entry.md)
- [Authored instance teleports](teleports.md)
- [Shared trick score and boost energy](trick-scoring.md)
- [Rider body and head motion](rider-motion.md)
- [Autonomous rider input foundation](ai-input.md)
- [Shared opponent field](ai-field.md)

## World objects and effects

- [Static world props](static-props.md)
- [Authored world graph runtime](world-logic.md)
- [World effects coverage audit](effects-coverage.md)
- [Model-object animation and moving contacts](prop-animations.md)
- [Detached spline-path drawing](spline-movers.md)
- [Collision bags and scripted knock-off bodies](rigid-props.md)
- [Collision fence reactions](fence-reactions.md)
- [Breakable barriers and transparent overlays](shatter.md)
- [Deferred counters and fragile glass](deferred-world.md)
- [Interaction restoration](interaction-resets.md)
- [Material playback](material-playback.md)
- [Crowd material grids](crowd-playback.md)
- [Flags and banners](flag-cloth.md)
- [World particles and fireworks](world-particles.md)
- [Geometry boost afterimage](boost-trail.md)
- [Riding cloud effects](riding-effects.md)
- [Carved wake](carved-wake.md)
- [Four-rail carve spray](spray-sheet.md)

## Rendering and lighting

- [Terrain textures and baked lightmaps](terrain-appearance.md)
- [Terrain visibility and submission](terrain-culling.md)
- [Sky panorama and distance fog](world-appearance.md)
- [Automatic course sun and sky import](world-settings-import.md)
- [Course sun and beams](celestial.md)
- [Desktop enhanced lighting](enhanced-lighting.md)
- [Snowfall, desktop graphics and course loading](snowfall-graphics-0.61.md)
- [Surface chunks, takeoff puffs and contact sparks](surface-spray-0.62.md)

## Audio

- [Map audio interoperability](audio-library.md)
- [Automatic course Audio extraction](audio-import.md)
- [Native sound and music playback](audio-playback.md)
- [Automatic collision sound routes](collision-audio-import.md)
- [Automatic board surface audio mapping](board-audio-import.md)
- [Board audio performance](board-audio-performance.md)
- [Native music lifecycle and authored masters](music-playback.md)
- [Music assignment for game-wide catalogues](music-assignment.md)
- [Ambient voice selection](ambient-field.md)
- [Common riding audio for SSX 3 and On Tour](common-riding-audio.md)
- [Common course ambience for streamed maps](common-course-ambience.md)

## Development and releases

- [Build and run Native](building.md)
- [Testing Native](testing.md)
- [Developing Native](development.md)
- [Disc importer structure](importer-architecture.md)
- [Native source provenance](source-provenance.md)
- [Distributing the native player](releases.md)
- [Quest / Horizon OS integration](quest-system-integration.md)

## Playtest and build reports

These are dated investigations and validation records. Use the player guides above for current instructions.

- [Desktop and terrain playtest follow-up](playtest-safety.md)
- [Desktop and Quest playtest follow-up](playtest-followup.md)
- [Quest play-test follow-up, build 0.53](quest-playtest-0.53.md)
- [Start, interaction and lighting follow-up](playtest-0.54.md)
- [Merquer play-test follow-up](merquer-playtest-0.56.md)
- [Prop lighting preview alignment](prop-lighting-0.57.md)
- [Palm-directed finger curls, build 0.59](finger-curl-0.59.md)
- [Snowdream crash bags and flare halos](snowdream-playtest-0.60.md)
- [Scored board grabs and supersampled desktop UI](score-ui-0.63.md)
- [Steep jump-corner containment](jump-corners-0.64.md)
- [Ground-flare preview profile](lamp-profile-0.65.md)
- [Course contact and opponent continuity](course-contact-0.67.md)
- [Opponent recovery and route continuity](opponent-recovery-0.68.md)
- [Landing frames and terrain corners](landing-frame-0.69.md)
- [Forward reset bias](reset-bias-0.70.md)
- [Checkpoint standings and completion clocks](race-standings-0.71.md)
- [Curved terrain collision and compound clearance](curved-terrain-0.72.md)
- [Bank touchdown and ground-state continuity](bank-touchdown-0.73.md)
- [Desktop landing, flip and crash-bag corrections](playtest-contact-0.74.md)
- [Embedded deck contact after a paused playtest](embedded-contact-0.75.md)
- [Desktop controls, build 0.76](desktop-controls-0.76.md)
- [Desktop ISO setup, build 0.78](desktop-iso-0.78.md)

## Documentation boundary

These pages document Native's behavior, import mappings, application approximations, build
procedures and validation. Original-game research, addresses and symbols, detailed derivations,
and local capture paths belong in the optional local research workspace. Component documentation
cites behavioral and format conclusions with `[Trailmap: anchor]` identifiers. That workspace
is not required by a fresh checkout.

Follow the [research boundary](../../CONTRIBUTING.md#reverse-engineering-hygiene) and keep
implementation provenance accurate. Publication checks enforce this document boundary;
they do not establish legal clearance or clean-room origin.
