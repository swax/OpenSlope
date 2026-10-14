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

| Feature | Current evidence / remaining work |
|---|---|
| Custom and imported Maps playback | Quest library and desktop CLI work. Desktop map selection/menu and wider existing-map compatibility still need coverage. |
| Textured terrain / static props | Committed `b8579a9`; authored CPU/Vulkan checks and generated-output comparison, with diffuse mipmaps added subsequently. Full material fidelity, translucency in sRGB and live props remain. |
| Start placement and path data | Independent AIP/SOP reader and start-row selection pass authored fixtures and all eleven generated-output comparisons. Run mode selects its dataset and middle slot; cached origins/authored settings are preserved. Course DTF/checkpoint/finish consumption is implemented; exact staging formation and path-driven reset remain. |
| Fixed-step carving / surface response | Portable scalar and geometry checks, shaped lean, cruise alignment and switch stance are verified. Full trajectory equivalence remains unproven. |
| Charged jump / air control / touchdown | Separate charge/release, launch carry, spins/flips, landing bands and swept floor contact pass CPU checks and a 269-frame actual Vulkan replay. Prewind, complete crash/recovery and trajectory comparison still need work. |
| Tuck / brake / boost / pause | Keyboard controls and focus handling are implemented; tuck lowers the visible stick figure. Boost remains binary; meter/tier/trick energy behavior is outstanding. |
| Body and prop collisions | Independent import, box/triangle/occupancy queries, BVHs and Quest asset caching are connected to the shared rider. CPU and actual Vulkan cases cover rebound, pass-through and elevated ride surfaces; see world-contacts.md. Exact skeleton poses/masks, all trajectories, dynamic bodies and general grazing-shape fidelity remain outstanding. Render meshes do not replace triangle collision assets. |
| Crash, breakables and world interaction | Hard prop, landing and unrideable-surface triggers now enter a shared tumble/relative get-up lifecycle. A keyframed pose drives board/body presentation and a completion marker restores control; camera heading is separate. Portable and actual-host checks cover momentum, switch, missing-marker holds and run-gated timeouts; see crash-recovery.md for provisional tuning and limits. Original character clips/tumble and landing gates, full path/fade reset, reset volumes, authored effect dispatch, break/rearm, debris, scripted forces, moving props and runtime visibility remain outstanding. |
| Rails / splines | Independent PBD/SSF conversion, analytic nearest capture, tangent travel/boost, spin, torso/head mask, charged jump and explicit exit pass portable, production Vulkan and all eleven import comparisons. See rails.md for application tuning. Rail tricks/scoring/audio, graph toggles and mode/LTG filtering remain outstanding. |
| Race / showoff / freeride | Shared mode selection, horizontal stored-DTF progress, active-line checkpoints, AIP finish, clocks/timeout, countdown, lap events/gates and restart pass 329 portable checks and 2,352 production Vulkan frames; desktop title and VR controller panel show state. All eleven imported datasets/settings load; 54 Quest JNI/SAF checks include authored settings. See course-runs.md. AI field/standings, score/pickups, scripted lap tube, original intro/results, path-driven respawn, race audio/music and complete HUD remain. |
| Tricks and scoring | Outstanding: completed spins/flips, grabs, strings/combo banking, landing/crash outcomes and meter integration. |
| Rider and equipment presentation | The original first-party stick figure now renders on desktop and OpenXR, with procedural crouch/stance/jump/recovery, first-person self visibility, tracked controllers and labelled controls. Optional Quest upper/full-body tracking and high-fidelity requests are integrated with per-joint fallback; see avatar.md. Original clips/tricks, exact hand poses, calibrated proportions, gear/stance choices, snowboard/skis and equipment art remain. Current board is a diagnostic quad. |
| On-foot / boarding | Quest starts beside a parked board; B mounts nearby/dismounts, with physical room proximity. Shared walking/running, jump edges, solid/trigger/roof contacts, carried-momentum airborne separation and provisional board coasting pass CPU and 224-frame production Vulkan checks; desktop G/--on-foot share the mode. See boarding.md. Crouch/flight, recall/grab/carry, footsteps/world-event dispatch and full loose-board response remain. |
| Camera and input | Tests confirm trick rotation stays out of the camera frame; desktop chase-camera rays avoid solid props/terrain. Desktop first-person look-down and tracked controller help are implemented. Mouse look, orbit/zoom, camera-radius/smoothing, gamepad, complete HUD and settings remain. |
| AI riders and other players | Outstanding: AI path following/field behavior and shared play-session movement. These are not satisfied by rendering static props. |
| Sound / music | Independent codecs, PCM mixer, Windows/Quest output, Maps sound routes, contact/ambient/board gates and queued music graph playback have CPU and actual-host evidence. Normal ISO import stages config-driven banks, ADL bindings, fixed/crowd routes, music triplets and intro stems; all eleven local imports compare against existing output. See audio-playback.md and audio-import.md. Executable collision/board resolver extraction, dynamic chants, regional route verification, exact signal/pitch/ambient parity, race/intro/trick lifecycle, async layers, speech/announcer and wider platform/device behavior remain outstanding. No retail media may enter source control or the application package. |
| Effects | Fixed-tick carve, powder and landing/skid clouds use extracted sprite art and a shared additive Vulkan pass; see riding-effects.md. A bounded paired wake follows terrain/rideable props and draws in two alpha passes; see carved-wake.md. Connected four-rail spray now throws outward during a carve and curls/fades over 0.9 s; see spray-sheet.md for application tuning and validation. Per-surface chunks/sparks, airborne puffs, exact sheet/wake bindings, boost afterimages, crash/pickup/breakable effects and authored effect lifecycle remain outstanding. |
| World graphics | Independent ISO sky conversion, model-only existing/custom sky loading, camera-centred stereo backdrop, open-top seam colour and distance fog have portable and actual Vulkan evidence; see world-appearance.md. Original executable colour recovery, full world settings, celestial/glare, snow, billboards and texture animation remain outstanding. |
| Culling / anti-aliasing / image quality | Prop distance/frustum culling, diffuse mipmaps/trilinear minification, desktop/XR MSAA and Quest resolution/smoothing settings are implemented. Actual UNORM/sRGB GPU fixtures verify coverage and queued stereo isolation; see graphics-quality.md. Hierarchical terrain frustum selection/adaptive submission have all-course pixel-equivalence evidence; see terrain-culling.md. Terrain LOD/stitching, prop spatial gathering, atlas-safe lightmap filtering, anisotropy, cutout coverage and broader hardware validation remain. |
| Performance | Android Debug native code is optimized and XR submission defers completion until renderer resource reuse, with separate placement buffers per eye. Five-second phase/timestamp logs show 71.5–72 fps at 72 Hz on Quest 3 ALASKA with 4x MSAA, versus 31–36 fps in the preceding live build. See graphics-quality.md for sampling limits. Terrain submission also has two-course fixed-replay measurements. Worst-case full-course baselines, memory profiling, batching/upload work and wider trajectories remain. |
| VR | The user confirms walking, mounting and much improved performance on Quest. Build 0.21.0 has focused ALASKA rendering at 72 Hz, runtime full-body poses and actual high fidelity, with per-joint/procedural fallback. 55 device JNI/custom-library/SAF checks and 52 avatar Vulkan checks pass. User-imported ALASKA is preserved. Targeted comfort, wider quality/device coverage, all controls and lifecycle checks remain. |

Milestones use a descriptive commit subject and bullet-point body. Each milestone
records its supported behavior, tests, comparison evidence and remaining limits.
Playable test EXEs are versioned in ignored build folders so a later change does
not silently replace a build the user is testing. No public distribution of local
course data is part of the work.

The next sequence is rider controls/start placement, authored collisions and world
interaction, rails/races/tricks, presentation/camera, audio/music/effects and the
remaining rendering/performance work. Evidence may change the order, but cannot
remove requirements from this matrix merely because an easier slice is complete.
