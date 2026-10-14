# Desktop gameplay parity work

The active objective is feature parity with playing in Slopesmith, including
sound, music, effects, collisions, culling, anti-aliasing, graphical improvements,
performance work and the VR path. Desktop behavior is the current verification
target. Headset behavior remains unverified until hardware is available. This
matrix tracks the full scope; a committed milestone is not completion of the goal.

Slopesmith's gameplay controls, public contracts and tests establish the feature
inventory and comparison behavior. Clean Trailmap bodies establish recovered
behavior; native implementation remains independently authored. Generated maps
can validate interoperability, never supply decoder implementation. Source-boundary
checks apply to every milestone. The shared ride contract is retained unchanged.

| Feature | Current evidence / remaining work |
|---|---|
| Custom and imported Maps playback | Quest library and desktop CLI work. Desktop map selection/menu and wider existing-map compatibility still need coverage. |
| Textured terrain / static props | Committed `b8579a9`; authored CPU/Vulkan checks and generated-output comparison. Full material fidelity, translucency in sRGB, mipmaps and live props remain. |
| Start placement and path data | Independent AIP/SOP reader and start-row selection pass authored fixtures and all eleven generated-output comparisons. Middle slot and heading baseline replace terrain-height guessing when paths exist. Race/event/reset consumption remains. |
| Fixed-step carving / surface response | Portable scalar and geometry checks, shaped lean, cruise alignment and switch stance are verified. Full trajectory equivalence remains unproven. |
| Charged jump / air control / touchdown | Separate charge/release, launch carry, spins/flips, landing bands and swept floor contact pass CPU checks and a 269-frame actual Vulkan replay. Prewind, complete crash/recovery and trajectory comparison still need work. |
| Tuck / brake / boost / pause | Keyboard controls and focus handling are implemented; tuck is a pose field until the visible rider exists. Boost remains binary; meter/tier/trick energy behavior is outstanding. |
| Body and prop collisions | Independent import, box/triangle/occupancy queries, BVHs and Quest asset caching are connected to the shared rider. CPU and actual Vulkan cases cover rebound, pass-through and elevated ride surfaces; see world-contacts.md. Exact skeleton poses/masks, all trajectories, dynamic bodies and general grazing-shape fidelity remain outstanding. Render meshes do not replace triangle collision assets. |
| Crash, breakables and world interaction | Hard prop impacts enter wipeout and suppress riding input; R resets. Animation-driven recovery/tumble, hard-landing/surface triggers, reset volumes, authored effect dispatch, break/rearm, debris, scripted forces, moving props and runtime visibility remain outstanding. |
| Rails / splines | Outstanding: independent PBD spline extraction, grind capture/travel/exit, jump/boost and rail presentation. |
| Race / showoff / freeride | Outstanding: course progress, checkpoints, finish/laps, countdown, score, pickups, path-driven respawn and run HUD. |
| Tricks and scoring | Outstanding: completed spins/flips, grabs, strings/combo banking, landing/crash outcomes and meter integration. |
| Rider and equipment presentation | Outstanding: visible rider pose/animation, crouch, gear/stance choices, snowboard/skis and equipment art. Current board is a diagnostic quad. |
| On-foot / boarding | Outstanding: walking, crouch/jump/flight, stepping off and recalling/mounting/handling the board. |
| Camera and input | Tests confirm trick rotation stays out of the camera frame; desktop chase-camera rays avoid solid props/terrain. Mouse look, orbit/zoom, camera-radius/smoothing, gamepad, HUD/control help and settings remain. |
| AI riders and other players | Outstanding: AI path following/field behavior and shared play-session movement. These are not satisfied by rendering static props. |
| Sound / music | Independent codecs, PCM mixer, Windows/Quest output, Maps sound routes, contact/ambient/board gates and queued music graph playback have CPU and actual-host evidence. Normal ISO import stages config-driven banks, ADL bindings, fixed/crowd routes, music triplets and intro stems; all eleven local imports compare against existing output. See audio-playback.md and audio-import.md. Executable collision/board resolver extraction, dynamic chants, regional route verification, exact signal/pitch/ambient parity, race/intro/trick lifecycle, async layers, speech/announcer and wider platform/device behavior remain outstanding. No retail media may enter source control or the application package. |
| Effects | Outstanding: snow spray, carve wake, boost afterimages, landing/crash bursts, pickups, breakables and authored effect lifecycle. |
| World graphics | Outstanding: sky/background, fog, celestial/glare, snow, billboards and texture animation. |
| Culling / anti-aliasing / image quality | Prop distance/frustum culling exists. Diffuse mipmaps/trilinear minification pass portable and actual Vulkan checks. Desktop MSAA has actual geometric edge/resolve evidence at 1x/4x; see graphics-quality.md. Hierarchical terrain frustum selection and adaptive index submission have all-course pixel-equivalence evidence; see terrain-culling.md. Terrain LOD/stitching, prop spatial gathering, atlas-safe lightmap filtering, anisotropy, cutout coverage, configurable quality UI and hardware VR validation remain. |
| Performance | Timestamp samples and shared stereo geometry exist. Terrain submission has two-course fixed-replay measurements and a reproducible benchmark. Whole-frame baselines, memory profiling, reduced stalls, batching/upload work and wider trajectory measurements remain. |
| VR | OpenXR hosts compile; shared core and controller mapping need continued build checks. Stereo comfort, rendering quality, input, performance and lifecycle need hardware verification. |

Milestones use a descriptive commit subject and bullet-point body. Each milestone
records its supported behavior, tests, comparison evidence and remaining limits.
Playable test EXEs are versioned in ignored build folders so a later change does
not silently replace a build the user is testing. No public distribution of local
course data is part of the work.

The next sequence is rider controls/start placement, authored collisions and world
interaction, rails/races/tricks, presentation/camera, audio/music/effects and the
remaining rendering/performance work. Evidence may change the order, but cannot
remove requirements from this matrix merely because an easier slice is complete.
