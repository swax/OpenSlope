# Equipment, camera and ride interfaces

Build 0.35 connects one shared equipment lifecycle to desktop and OpenXR. The
implementation is authored from Slopesmith's public ride manual/behavior inventory,
clean Trailmap 400 camera conclusions, and standard rigid-frame, ray/box, sphere/triangle
and exponential-response identities. No other component's runtime implementation is used.

## Carry and throw

The four shared stock designs (Contour, Sunset Rally, Timberline and Night Shift)
are embedded into native builds. Game startup, a full course restart, explicit board recall or an
on-foot behind-the-head pull choose a random design, avoiding immediate repeats.
Respawns, mounting, catching and ordinary grabs keep the current
board's artwork. Each opponent owns its own choice. The top/base atlas convention
and source-art provenance are in [stock board art](../../Slopesmith/docs/stock-board-art.md).

Boards use the avatar's course-lighting field, including ambient tint and
directional keys, sampled at each board's position. The topsheet, base and edges
respond to their world-space normals while mounted, held or loose.

On desktop, hold RMB while pointing at the loose board to carry it and release
RMB to throw. E spawns and mounts at the player's feet or dismounts while riding.
It preserves airborne momentum. Left-drag captures relative mouse movement to
look around while riding or turn the on-foot character. The mouse wheel changes follow distance; V/F changes view.
The pointer remains visible in third person when neither carrying nor looking.
Both camera views use left-drag. Escape releases a held drag until the button is
released. Escape with an already visible cursor opens/closes the pause menu. P also
opens/closes that menu. G retains nearby
mount/dismount. See foot-flight.md for current movement and stock snowboard art.

Quest uses either trigger to ride/dismount and either squeeze to carry. A loose deck
answers an unobstructed aim ray out to 4 m with 10 cm padding. Pickup is measured
from the fist to its outline within 1.5 m; hand transfer requires 35 cm. Releasing
the previous hand after transfer does not throw. A closing grip behind the head
summons from anywhere: at least 10 cm behind, within 55 cm, and no lower than
25 cm below the head, in a yaw-only frame. Summoning takes priority over proximity.
Grounded mounted grips do nothing; airborne grips take the board off without
changing the rider's horizontal arc. A trigger while holding re-equips at the
rider's feet, retaining airborne velocity and its arriving speed cap.

The rigid edge attachment uses the controller model's physical upright edge for
the board's long axis. Left/right edges and the 2-inch controller-side offset are
mirrored inward; the 1.5-inch wearer-side offset is shared. Raw OpenXR grip and
hand-skin frames are recovered through an exact inverse mapping. The fixed-step
throw sampler measures deck-centre translation and rigid rotation, low-passes over
50 ms and caps at 12 m/s and 720 degrees/s. Summon, transfer and the desktop's
180 ms pickup approach do not inject discontinuity velocity. Held rendering uses
the latest hand pose without advancing physics. Focus/tracking loss drops gently.

A thrown deck keeps horizontal momentum and tumbles until contact. Five swept deck
points test terrain and solid props; the existing loose-board slide/settle path
then takes over. Holding Boost with a carried board applies unlimited nose-directed
thrust and the existing board afterimage. Build 0.36 uses the first-party 1.86 m
stock snowboard and its conservative grab box instead of the 0.35 diagnostic quad.
Its 18 m/s² loose-board gravity, 3.5 m/s² ground slowdown, contact radius,
50 ms filtering and approach duration remain explicit application tuning. This is
not a general rigid-body/inertia solver, and custom gear dimensions remain work.

## Follow camera

Desktop follows horizontal travel, not board spins. Standing ground uses facing;
a vertical airborne pop retains its previous bearing. The near candidate has a
1.8 m full boom, 2.1 m under boost, and a subject 1 m above the root. Its base
pitch is `-0.16 - atan2(35,180)`; trajectory pitch is halved while falling.
Heading/pitch close 1/16 of the error per 60 Hz tick, and the retained eye admits
20% per tick, both expressed as time-based exponentials. Warps and view changes
reset history; mount/dismount preserves the selected zoom and view mode.
The lens is 78.15 degrees vertical with a 0.15 m near clip.
[Trailmap: 400-camera, 400-camera-lens, 400-camera-eye-follow,
400-camera-near, 400-camera-air-pitch, 400-camera-terrain]

Terrain/solid sight lines pad the eye along the blocking normal. A 0.45 m sphere
then checks cached terrain triangles and prop collision geometry, with bounded
iterations, before and after eye smoothing. This is an independent render-volume
safety policy; pathological concave spaces and all owned-course trajectories still
need wider comparison. Quest third person retains Slopesmith's separate 2 m back /
1 m up presented-eye offset and unshifted physical body.

## Desktop and wrist interface

The desktop HUD shows speed, equipment state, timed-run clock, boost/charge and
contextual controls. The pause menu provides resume, restart, view, sound, stats,
controls, run-mode cycling, board recall and a paged map library. The library finds
portable map folders under `Maps/` and alongside the command-line-selected map;
loading replaces the player, graphics scene and audio together. Failed loading
leaves a readable menu message. The window close button and menu Exit end play.
Run-mode cycling skips events whose required route is absent; opening a map that
does not support the current event falls back to Freeride.

Quest Y toggles a left-wrist panel, initially shown. Aim the right controller and
pull its trigger to select resume/hide, restart, view, controls, sound, stats,
recall, recenter, head steering or exit. A captured menu press stays consumed
until release, even after leaving/hiding the panel, so it cannot also ride a board.
From build 0.82, hiding the menu also hides the compact speed/status watch,
stats, controller models and labels, menu pointer and board selection outline.
Press Y again to restore the presentation. Tracked avatar hands/body and all
riding/board inputs remain active while it is hidden. Third-person panels, pointer
and controller models follow the presented eyes while the body stays unshifted.
Controls have a dedicated page. Build 0.53 also shows contextual controller
labels while the wrist menu is visible. Its panel follows the controller beyond
the hand and uses scene depth, so nearer hands/controllers remain visible.

Both hosts use the same bounded triangle UI, palette and first-party bitmap font;
there is no browser/UI framework dependency. The current UI is deliberately a
ride interface: text entry, gamepad navigation, arbitrary desktop folder picking,
VR editing palettes and the full Slopesmith editor are outside this slice.
Physical wrist reach/readability, throw feel and controller alignment still need
worn-headset confirmation; compilation and deterministic tests do not establish it.

## Verification

`native_equipment` exercises rigid-frame queries, exact grip round trips, mirrored
edge placement, half-turn rotation axes, throw caps, transfer/release, summon,
held-trigger latching, mid-air re-equipping, unscripted ballistic contact, camera
orbit/clearance and menu capture. Production replay inputs can supply an `Equipment`
object with `Hands`, `Grip`, `Trigger`, `Rays`, `Head`, `Facing`, `Tracked` and
`Relative`. `--ui-menu` and `--ui-controls` capture the actual desktop interface.
The Vulkan avatar test also captures desktop/wrist menu, controls, HUD and held
board geometry in UNORM/sRGB targets, checking visible text and accents.
`Native/tests/equipment_replay_test.py` drives seven equipment scenarios through
the production desktop renderer. `Native/tests/desktop_ui_test.py` clicks the
real menu, skips an unsupported event and replaces a live Vulkan map scene.

Local 0.35 validation passes all 35 portable suites, seven production equipment
replays (168 rendered frames), real desktop menu/map replacement, 157 Vulkan
avatar/UI checks, the existing 224-frame boarding replays and 13,740 general
Vulkan channel checks. The complete repository `npm run verify` gate passes.
The exact packaged desktop EXE also passes the equipment/menu replays and renders
the interface over an existing private ALASKA map. The signed ARM64 Quest APK is
version 0.35.0/code 36; Android lint reports zero errors and four existing warnings.
All 15 license/notice assets match their sources, with no course media bundled.
The device-test APK contains only the authored ISO fixture. No device installation
or worn-headset validation was performed for this milestone.
