# Breakable barriers and transparent overlays

Build 0.37 fixes the black GARI screen reported in the desktop playtest and
implements the sub-20 mesh throw used by its break graph. Both hosts use the
same renderer and effect runtime.

## Rendering

The screen was covered by its separate scanline sheet. That sheet's material
has bit 17 (priority) and a texture with alpha, while the Native renderer only
admitted bit-18 materials to its alpha passes. Slopesmith's public
`texture-array.test.ts` fixtures establish that priority materials respect
partial alpha too. Native now classifies either flag through its independent
texture analysis. A material with neither flag still ignores PNG alpha.

Translucent prop draws depth-test against the opaque world but leave depth
unchanged. This also preserves overlapping transparent faces inside a single
material packet, where sorting whole instances cannot order the faces. Opaque
and cutout geometry still write depth. Synthetic UNORM/sRGB pixel fixtures
cover both priority alpha and a front-before-rear transparent packet at 1x/4x
sampling. A private GARI capture shows the lit blue screen and moving scanline
instead of the black rectangle.

## Contact and fragments

Clean Trailmap 230's sub-20 record and 370's break-chain description supply the
field meanings: frame step, duration, authored direction, per-axis centimetres
per second and a direction multiplier. An all-zero direction uses the actual
impact direction. That context now survives nested named functions, targeted
instance graphs, waits and deferred crack triggers. This does not replace an
authored zero direction with a fixed level-specific vector.

Each decoded model object gets an independent rigid transform around its baked
bounding-box centre. The original hierarchy/rest frame is already baked into
that geometry. Sampling follows the authored step, and the pieces disappear at
the authored duration. Revealing debris clears its collision gate; retiring it
does not restore the intact source or its collider. Run restart restores initial
presence. Directional motion uses the decoded fields; radial piece spread,
deterministic tumble and 9.81 m/s² world gravity are explicitly application
presentation choices, not recovered original trajectories. Local gravity is
transformed from world down for rotated placements.

The importer now decodes all three throw-direction fields as float32, as the
clean record specifies. Earlier Native Effects files preserved these as integer
words; load-time compatibility reads their packet words or recognizable saved
float encodings. Legacy behavior documents also receive that normalization.
Existing maps need no material/mesh reimport for these fixes.

Walking contacts now publish the same Begin/Stay/End events used by riding.
Previously on-foot traversal dispatched the graph but omitted the audio contact
stream. A synthetic eight-piece barrier verifies walking and riding through the
production Vulkan host, the visible fragments, retirement, and one mapped break
sound in captured stereo PCM. Portable tests additionally exercise delayed
function-to-instance handoff, source/twin isolation, restart and old documents.
The private GARI check verifies all 23 render pieces plus their root object.

## Remaining work

Build 0.44 independently recovers executable collision routes during normal ISO
import; see collision-audio-import.md. Actual GARI's event 63 now reaches its
configured course-bank clip. Walking and riding captures each produce one
contact sound, with PCM differences against a deliberately unresolved comparison
and identical rider physics. No event-to-slot retail table is compiled.

Rigid-body knock-off props and authored fireworks have subsequent implementation
evidence in rigid-props.md and world-particles.md. Fence flex, complete breakable
respawn/latch behavior, exact fragment trajectories and broader interaction parity
remain open. Worn Quest listening is not established by the APK build.

## Validation

The full repository gate passes (448.9 s); the final portable and desktop build
trees each pass 37 native suites. The mesh-throw suite passes 18 checks including
the private GARI graph, and the existing glass/counter comparison passes 70
checks across the eleven local map sets. Eleven production replay groups pass
4,301 gameplay frames, including 319 new shatter/PCM frames. Final GPU runs pass
13,772 appearance channel checks and 157 avatar/HUD/stereo checks. Real GARI
walking and mounted captures both reach the fragment graph.

The ARM64 app and instrumentation APKs build and verify their signatures at
version 0.37.0/code 38. Lint has zero errors and four existing warnings. All 15
notice assets match their sources; the app contains no course media. The Native
source boundary audit checks 274 files without forbidden references, and the
pinned formatter and diff-whitespace checks pass. No headset installation or
worn-device performance claim is part of this milestone.

```powershell
./temp/native/Release/openslope_mesh_throw_tests.exe temp/native-rails-0.17.0/Maps
python Native/tests/shatter_replay_test.py temp/native/Release/openslope_player.exe
python Native/tests/appearance_test.py temp/native/Release/openslope_render_tests.exe
```
