# Desktop gameplay parity work

The active objective is feature parity with playing in Slopesmith, including
sound, music, effects, collisions, culling, anti-aliasing, graphical improvements,
performance work and the VR path. Desktop behavior is the current verification
target. The user reports successful Quest play with build 0.14.0 after the
APK/ISO transfer and in-app ALASKA import. This establishes initial device play; individual features,
comfort, lifecycle and frame budgets still need targeted headset checks. This
matrix tracks the full scope; a committed milestone is not completion of the goal.

Slopesmith's gameplay controls, public contracts and tests establish the feature
inventory and comparison behavior. Clean Trailmap bodies establish recovered
behavior; native implementation remains independently authored. Generated maps
can validate interoperability, never supply decoder implementation. Source-boundary
checks apply to every milestone. The shared ride contract is retained unchanged.
Parity excludes the retail cast (models, animations, stats) and the retail trick
repertoire, per the Scope section of CONTRIBUTING.md. The remaining work below is
behavioral or first-party, and any grab or named trick would be original OpenSlope design.

| Feature | Current evidence / remaining work |
|---|---|
| Custom and imported Maps playback | Quest library, desktop CLI and the paged desktop pause-menu map library work. Wider existing-map compatibility still needs coverage. |
| Textured terrain / static props | Committed `b8579a9`; authored CPU/Vulkan checks and generated-output comparison, with diffuse mipmaps added subsequently. Runtime draw/collision tombstones now follow authored graphs. Per-instance model clips, moving bounds and model-local lighting now have CPU/Vulkan evidence; see prop-animations.md. Full material fidelity, translucency in sRGB and complete live props remain. |
| Start placement and path data | Independent AIP/SOP reader and start-row selection pass authored fixtures and all eleven generated-output comparisons. Run mode selects its dataset and middle slot; cached origins/authored settings are preserved. Course DTF/checkpoint/finish consumption and nearby path-driven reset are implemented; exact staging formation and full AI path tracking remain. |
| Fixed-step carving / surface response | Portable scalar and geometry checks, shaped lean, cruise alignment and switch stance are verified. Full trajectory equivalence remains unproven. |
| Charged jump / air control / touchdown | Separate charge/release, launch carry, spins/flips, landing bands and swept floor contact pass CPU checks and a 269-frame actual Vulkan replay. Prewind, complete crash/recovery and trajectory comparison still need work. |
| Tuck / brake / boost / pause | Shared controls and focus handling are implemented. Timed-run boost spends a quarter-seeded meter, gates at zero, selects cap tiers and refills from banked style; see trick-scoring.md. Pads, authored force volumes and MAIN engage/pad chimes now run; boost-volumes.md records 116 authored checks, 67 actual drivers/47 pads and production Vulkan/PCM evidence. The sampled boost afterimage is now rendered on desktop/OpenXR; boost-trail.md records source cadence/colours, pixel tests and attachment/ramp limits. Airborne bleed and uber meter tiers remain; fill uses the single first-party profile rather than per-character stats. |
| Body and prop collisions | Independent import, box/triangle/occupancy queries, BVHs and Quest asset caching are connected to the shared rider. CPU and actual Vulkan cases cover rebound, pass-through and elevated ride surfaces; see world-contacts.md. Exact skeleton poses/masks, all trajectories, arbitrary dynamic bodies and general grazing-shape fidelity remain outstanding. Model-object collision follows authored clip poses with relative surface response and support carry; see prop-animations.md for temporal/rotational limits. Fragile glass now has contact-gated support, split surface/receiver handling and actual imported-pane fall-through; see deferred-world.md. Render meshes do not replace triangle collision assets. |
| Crash, breakables and world interaction | Hard prop, landing and unrideable-surface triggers enter a shared tumble/relative get-up lifecycle. A keyframed pose drives board/body presentation and a completion marker restores control; camera heading is separate. Run-gated timeout, reset-surface and bounds exits now use nearby path recovery, with Control 22 hold and desktop/stereo fade; see crash-recovery.md, course-recovery.md and world-logic.md. Recovery has 66 portable checks, 641 production Vulkan replay frames and 66 supported placements across eleven imports. Authored reset volumes now share that recovery. Exact tumble timing and landing gates, exact viewport effect, wedge accumulators, full property/region dispatch, complete break/rearm, debris, exact original lap transport and rigid-body movers remain outstanding. Directional/altitude/staged force nodes now use native swept collision volumes; see boost-volumes.md. Authored teleport now interrupts travel and performs stopped, destination-facing placement with run/music continuity; teleports.md has CPU/Vulkan/PCM and actual MERQUER evidence. Checklist counters and gated crack pools now dispatch their own trigger; paired glass support/private material frames have real-data and Vulkan/PCM checks in deferred-world.md. Detached subway/chairlift route copies and cables now run; see spline-movers.md. Persistent model playback, region/end latches, runtime visibility and moving support are now integrated; see prop-animations.md. |
| Rails / splines | Independent import, analytic capture, tangent travel/boost, spin, masks and jump/exit have portable, production Vulkan and all-course comparison evidence. Shared rail style banks on snow, and VR supports gaze/free-deck steering with view carry; see rails.md, trick-scoring.md and vr-steering.md. Live energy registration, audio and complete mode/LTG/region behavior remain; authored mode/contact graph toggles now change live candidacy. Detached spline-path drawing has independent end/orientation/copy/lifetime consumers and actual imported-route captures; see spline-movers.md. |
| Race / showoff / freeride | Shared mode selection, horizontal stored-DTF progress, active-line checkpoints, AIP finish, clocks/timeout, countdown, lap events/gates and restart pass 329 portable checks and 2,352 production Vulkan frames; desktop title and VR controller panel show state. All eleven imported datasets/settings load; 54 Quest JNI/SAF checks include authored settings. Nearby recovery preserves clock and banked score; see course-runs.md and course-recovery.md. AI field/standings, remaining score/time opcodes, exact original lap ride, original intro/results, multi-rider reset bias, race audio/music and complete HUD remain. |
| Tricks and scoring | Spin/flip/rail style, big-air points, preview/bank, crash/reset loss, timed finish/restart and boost integration pass 62 checks and 1311 production Vulkan frames. Zero-point skips/reset/finish retain the last positive result. A right-controller score/meter panel has actual digit/color evidence within 84 avatar GPU checks. See trick-scoring.md for public-profile choices. Showoff gem contact, mode presence, tombstone/despawn, MAIN chime and same-frame bank ordering are implemented through world-logic.md, including 772 production Vulkan frames with pickup pixels/PCM. Remaining world dispatch, combo and uber meter behavior, targets, audio and full HUD remain. |
| Rider and equipment presentation | The original first-party stick figure now renders on desktop and OpenXR, with procedural crouch/stance/jump/recovery, first-person self visibility, tracked controllers and labelled controls. Optional Quest upper/full-body tracking and high-fidelity requests are integrated with per-joint fallback; see avatar.md. Build 0.39 adds procedural gait/balance, arm inertia, landing compression, independent head orientation and fixed switch bindings; see rider-motion.md. Selectable pose styles, first-party animation clips, exact hand poses, calibrated proportions, gear/stance choices, skis and alternate equipment art remain. Build 0.36 embeds the first-party stock snowboard GLB; alternate/custom equipment remains work. |
| On-foot / boarding | Quest starts beside a parked board; either trigger mounts nearby/dismounts, with physical room proximity. Shared walking/running, jump edges, solid/trigger/roof contacts, carried-momentum airborne separation and provisional board coasting pass CPU and 224-frame production Vulkan checks; desktop E/G/--on-foot share the mode. See boarding.md. Equipment-only X recall now preserves rider placement. Build 0.35 adds aimed mounting, carry, transfer, summon, bounded ballistic throwing and airborne re-equipping; see equipment-camera-ui.md. Build 0.36 adds crouch, public-profile directional/aimed flight, off-board boost PCM and sole trails; see foot-flight.md. Footsteps, broader walking world-event dispatch and full loose-board dynamics remain. Moving supports now carry walking/parked boards and pass momentum through mount/dismount/jumps; see prop-animations.md. |
| Camera and input | Build 0.34 aligns A jump/B boost/either trigger board/X recall-reset/Y controls/right-stick turn and camera. Controller-axis and full wrist-roll fixes have portable and GPU evidence, with worn verification pending; see quest-controls.md. Desktop look-down/chase collision and tracked controller help exist. Quest offers Stick only or Head + stick override; 26732 checks compare head/stick carve trajectories, stances/slopes, ownership and pinned/partial/full headset carry across snow/air/rails. See vr-steering.md for first-party tuning and pending worn checks. Build 0.35 adds relative mouse look/orbit/zoom, the clean-400 travel camera and volume guards, desktop HUD/map menu and interactive wrist controls; see equipment-camera-ui.md. Build 0.36 reduces desktop UI size, makes E spawn ahead, keeps click state-aware, and fixes switch-relative forward flips. Gamepad navigation, broader settings, selectable pose styles/calibration and worn-device comfort remain. See playtest-followup.md for the current user-tested gaps. |
| AI riders and other players | Outstanding: AI path following/field behavior and shared play-session movement. These are not satisfied by rendering static props. |
| Sound / music | Independent codecs, PCM mixer, Windows/Quest output, Maps sound routes, contact/ambient/board gates and queued music graph playback have CPU and actual-host evidence. Normal ISO import stages config-driven banks, ADL bindings, fixed/crowd routes, music triplets and intro stems; all eleven local imports compare against existing output. See audio-playback.md and audio-import.md. Build 0.44 independently recovers collision-event routes; eleven fresh imports match 1,045 routes, with actual GARI PCM evidence (collision-audio-import.md). Build 0.45 recovers board families into the map-local sidecar (board-audio-import.md). Build 0.46 adds authored bed response, rail handoff, boost envelope, clip prewarming and Native mix settings (board-audio-performance.md). Shared-bank-only custom-map resolution, authored editor mix export, dynamic traffic/chants, regional route verification, exact signal/pitch/ambient parity, remaining race/intro/trick lifecycle, async layers, speech/announcer and wider platform/device behavior remain outstanding. Authored main-8 course sounds and MAIN gem chimes now reach the mixer through world graphs. No retail media may enter source control or the application package. |
| Effects | Fixed-tick carve, powder and landing/skid clouds use extracted sprite art and a shared additive Vulkan pass; see riding-effects.md. A bounded paired wake follows terrain/rideable props and draws in two alpha passes; see carved-wake.md. Connected four-rail spray now throws outward during a carve and curls/fades over 0.9 s; see spray-sheet.md for application tuning and validation. Per-surface chunks/sparks, airborne puffs, exact sheet/wake bindings, exact boost attachment/ramp, crash/pickup/breakable effects and authored effect lifecycle remain outstanding. The seven-record boost geometry afterimage now uses source colour tiers and a shared desktop/stereo pass; see boost-trail.md. |
| Flag/banner cloth | Build 0.33 renders subtype-13 eight-section waves with private clocks, either fixed end, normalized amplitude, graph lifecycle and expanded culling bounds. All 119 owned flags activate and prepare correctly. Portable, independent silhouette, stereo and 161-frame production evidence is recorded in flag-cloth.md. Source random-sequence, dynamic-normal lighting, exact cloth contact and worn-headset appearance remain unverified. |
| World graphics | Build 0.40 adds authored timer/collision particles and fireworks, complete sprite registration, additive/alpha/darkening draws and nested Quest cache support; see world-particles.md for real GARI, pixel/PCM and device evidence, application tuning and remaining fidelity. Independent ISO sky conversion, model-only existing/custom sky loading, camera-centred stereo backdrop, open-top seam colour and distance fog have portable and actual Vulkan evidence; see world-appearance.md. Build 0.42 adds portable celestial/glare with terrain visibility and late UI; 0.43 independently recovers executable sun/sky settings (celestial.md, world-settings-import.md). Full world settings, original display-domain composition, weather/snow, billboards, complete crowd/SFX activity classification and combined material animation remain outstanding. Independent flipbook export/old-import recovery and private crack-frame selection exist; see deferred-world.md. Fixed-tick scroll/flip/pulse/dwell consumers now run with per-material frame counts, private UV phase and node controls/lifecycle; see material-playback.md. Crowd grids now consume shared art and cell/activity laws with native ISO/SAF support; see crowd-playback.md for application activity defaults, supplements and remaining audio/upgrade work. |
| Culling / anti-aliasing / image quality | Prop distance/frustum culling, diffuse mipmaps/trilinear minification, desktop/XR MSAA and Quest resolution/smoothing settings are implemented. Actual UNORM/sRGB GPU fixtures verify coverage and queued stereo isolation; see graphics-quality.md. Hierarchical terrain frustum selection/adaptive submission have all-course pixel-equivalence evidence; see terrain-culling.md. Terrain LOD/stitching, prop spatial gathering, atlas-safe lightmap filtering, anisotropy, cutout coverage and broader hardware validation remain. |
| Performance | Android Debug native code is optimized and XR submission defers completion until renderer resource reuse, with separate placement buffers per eye. Five-second phase/timestamp logs show 71.5ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“72 fps at 72 Hz on Quest 3 ALASKA with 4x MSAA, versus 31ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“36 fps in the preceding live build. See graphics-quality.md for sampling limits. Terrain submission also has two-course fixed-replay measurements. Worst-case full-course baselines, memory profiling, batching/upload work and wider trajectories remain. |
| VR | The user confirms walking, mounting and much improved performance on Quest. Build 0.21.0 has focused ALASKA rendering at 72 Hz, runtime full-body poses and actual high fidelity, with per-joint/procedural fallback. 55 device JNI/custom-library/SAF checks and 52 avatar Vulkan checks pass. User-imported ALASKA is preserved. Targeted comfort, wider quality/device coverage, all controls and lifecycle checks remain. |

Build 0.38 connects effect-activated Roller bodies, including collision bags and scripted lids, to
shared render/collision motion, impulses and sleep. Validation and remaining
solver/device limits are recorded in rigid-props.md.

Build 0.41 aligns desktop rail presentation and VR rail turn rates with public
Slopesmith behavior, and corrects V-driven water/caustic/scanline direction after
OBJ vertex conversion. See rail-water.md for desktop, owned-course and Quest
startup evidence; worn turn feel and appearance remain unconfirmed.

Build 0.42 renders portable world Glare records as a desktop fan and stereo sky
disc/corona, with terrain visibility and late desktop/wrist UI. Existing/custom
world records work; build 0.43 adds independent automatic ISO sun/sky settings
through a bounded scalar initializer reader. See celestial.md and
world-settings-import.md. Weather, point-light flares and wider graphics parity stay
active alongside the remaining gameplay/audio/performance requirements.

Milestones use a descriptive commit subject and bullet-point body. Each milestone
records its supported behavior, tests, comparison evidence and remaining limits.
Playable test EXEs are versioned in ignored build folders so a later change does
not silently replace a build the user is testing. No public distribution of local
course data is part of the work.

The next sequence is rider controls/start placement, authored collisions and world
interaction, rails/races/tricks, presentation/camera, audio/music/effects and the
remaining rendering/performance work. Evidence may change the order, but cannot
remove requirements from this matrix merely because an easier slice is complete.

Build 0.44 independently recovers collision-event sound routes during ISO import.
All eleven fresh imports match existing portable route exports, and actual GARI
walking/riding captures play the smash cue with unchanged physics. Build 0.45 adds board-family routing;
wider audio/music systems and worn listening remain. See collision-audio-import.md
and board-audio-import.md.

Build 0.46 aligns the primary-rider board bed with the public Slopesmith audio
response, including rail grind, launch/landing, big-air wind and held/flight boost.
Configured SFX prewarm at course entry, full/loop voices share PCM, and music reads
run outside the gameplay mutex. See board-audio-performance.md. Wider music,
announcer, custom shared-bank layout and editor mix export still need parity work.

Build 0.47.1 addresses the latest MESA terrain/landing report with continuous
terrain contact guards; clears boost audio across release and run/recovery gates;
aligns exhaust with the selected thrust end; allows continuous desktop rail
turns; and snaps the walking chase camera behind the avatar. Desktop HUD bars
use a stable screen-space overlay. Broader parity requirements above remain
active. See playtest-safety.md for measured regressions and device limits.

Build 0.48 adds portable authored board-mix export, custom hit/ambient/effect WAV
routing, shared/older-import common-bank fallback and off-board environment beds.
Quest folder caching retains those assets for maps without local audio metadata.
See `audio-library.md`; broader gameplay, music and graphics parity remains active.

Build 0.49 adds Horizon focus/pause gating, fresh-input rearming, resumed clock
guards, separate wrist map/exit actions, app-icon task resume and orderly Android
teardown. See `quest-system-integration.md` for authority and validation scope.
