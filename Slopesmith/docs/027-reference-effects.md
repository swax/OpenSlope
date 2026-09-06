# 027 — Reference effects and preview

Effects mode has a **`<mountain name>` / Reference** switch. The first is the editable P2 document; the second mirrors
the same document, graph/function, node-inspector, and validation foundations with every mutating control
omitted or disabled; selection, filtering, export, attached-prop inspection, preview, and camera focus remain
available. The switch stays at the top of the toolbox while the rest of the panel shows only the chosen
mountain's home or selection details; clicking an effect or fog volume in either world switches that context
automatically. Reference reads the level loaded under Scene ▸ Reference and joins either the extracted retail
tables or an authored export:

The selected graph/function, node list, and semantic/raw inspector are the same renderers the authored mountain uses,
configured as a read-only subset. Reference does not render the graph/node creation controls, edit-action icons,
raw apply action, or the **Attach to level object** editor. Its home view is the same prop-centric
**Attached props** list, followed by an **Unassigned** catch-all for dormant graphs and shared functions.

- `Effects.json` supplies stable-ID slots, graphs, functions, nodes, properties and resources.
- For an extracted retail map, `Instances.json[].EffectSlotIndex` says which original level object owns each slot.
- For an authored export without `Instances.json`, `extensions.slopesmith.attachments` and `bakedGroups` join a
  stable prop id to its `Props.obj` group. The group's file-order source index is shared with the prop renderer.
  `propPivots` restores model-local movement; a legacy `gltf/manifest.json` diverted-mover center supplies that
  pivot for older exports such as MOUNTAIN47.

The join is by the slot's `originalIndex`, never by its current array position. The instance list also keeps the
original zero-based `Instances.json` index for retail maps, including effect-only/animated hosts that have no
static prop mesh, or the deterministic `Props.obj` object index for authored exports.
Clicking an attachment marks that native placement; **Focus prop** or double-clicking its list row frames it,
and each circumstance row opens the graph that the object runs for `persistent`, `collision`, `trigger`,
`Region exit` (column 3, runs on world-grid region deactivation), or `Effect end` (column 4, runs when an
installed node self-ends) — the last two are suppression latches whose retail form is an empty graph, shown as
a `⟨latch⟩` row [Trailmap: 150-logic §slot-columns]. Authored effect-attachment rows and the Props multi-selection list use the same
double-click-to-frame convention. Clicking a visible native prop directly in the Effects-mode viewport performs
the same original-index join, switches the panel to Reference, and opens its particle graph/emitter when present;
a native object without a valid effect slot does not disturb the current selection and shows the standard
switch-to-Props hint. Reference graph labels combine the native graph identity with its humanized slot
circumstance, such as `Effect 5 · Trigger`; the original P1 graph name remains visible as the read-only source
name. The Reference home toolbox contains export, attached-prop browsing, the
Unassigned catch-all, and validation. Selecting a prop keeps all of that prop's circumstances and their node
children visible in a tree while the selected node's read-only details and preview/focus actions update below.
Unassigned uses the same persistent list-and-detail layout. Escape returns home.

## Boost push arrows

A purple outline says a prop carries an effect. For the MainType-0 boost family that is only half the data,
because the node's point is a *direction*: an exhaust vent, a conveyor, an air shaft and a finish tube are the
same node pointing different ways. So every attached boost node also draws a cyan arrow from its host
instance's origin along the push axis, on the same Effects overlay toggle as the outlines. A boost node in an
unassigned graph has no host to anchor on and draws nothing.

The axis is the authored world-space one, deliberately not turned by the host's rotation
([Trailmap: 360-node-fields]) — Megaplex's twin air shafts carry ~40° of yaw that would otherwise skew them.
Shaft length scales with the authored target speed between a 6 m floor and a 24 m cap; it is a legibility
scale, not a distance the rider travels. The tube-end launch draws all three of its staged directions, barbed
once, twice and three times so the stage a rider gets is readable off the arrow. Arrows belonging to the
selected host draw brighter and thicker, and the part of an arrow buried inside its own tube or vent draws
dim rather than disappearing.

That covers retail's whole boost vocabulary: MEGAPLEX draws 44 arrows (exhaust vents, conveyors, the twin air
shafts and the finish tube's lift/launch pair), MERQUER 18 (its sand boosts and two ramp boosts), ALASKA 7,
and every other shipped level none.

## Standalone fog volumes

The PBD's `ParticleInstances.json` / `ParticleModels.json` pair is a separate effect family from both ordinary
props and SSF timer emitters. GARI carries 10 such placements (102 puffs), ELYSIUM 59, and MERQUER 9. Each
placement supplies a world transform and bounds; its paired particle model supplies model-local puff centres,
near-uniform per-puff scales, and radii. Slopesmith joins the tables through the recovered model index
(`ParticleModelIndex`) and keeps the native quaternion, puff values, bounds, and unknown integers intact.

Effects mode draws every volume as a thin purple box and makes that box directly clickable on either mountain.
Reference fog is read-only and can be copied into the authored mountain. Authored fog supports translation,
per-axis scale, rename, focus, duplication, and deletion; a new native-shaped nine-puff fog template is placed
above the course start. The top-bar **Effects** view toggle renders the actual static `fog0` billboard cluster
independently of the editor bounds. Fog sprites never participate in prop picking and do not accept SSF graph
attachments.

All measured retail placements use unit instance scale. For non-unit authored scale, puff centres transform
per-axis while the spherical puff radius uses the largest absolute axis in both Slopesmith and Snowknife. This is
an explicit editor/Unity convention, not a claimed recovered game rule.

The mountain document stores these objects under `particleVolumes`. Level export writes the repackable native
pair again: SSX-Library consumes it for PBD/ISO output, while Snowknife's existing `ParticleBundle` flattens the
same puff placements into the Unity manifest. Per-volume tint, alpha, and drift are deliberately not authored:
those values are not represented in the recovered native records.

## Preview runtime

The top-bar **Effects** view button enables always-on world animation independently of Effects mode.
It resolves each visible prop through the same native instance → slot → graph join, then previews recovered
`property.uv-scroll`, `property.texture-flip`, and `property.crowd-box` material animation. This covers river
water (including `Mdl_Water_River_6002`), boost chevrons, LCD scanlines, directional/warning signs, and crowd
billboards without model-name rules. Ordinary flipbooks use the measured native `speed` fps rate and direction;
two-frame warning screens use the measured randomized dwell / 0.1-second flash behavior. Crowd boxes use the
extracted shared `cd00`–`cd15` bank at 8 fps, matching the current Unity pipeline while the native fixed rate
remains open. Props and Tricks still control whether the geometry is visible. Authored props use the same
renderer through their stable prop attachment.

A `property.texture-flip` carrying an authored `Length` is not ambient motion at all. That node is a one-shot:
a graph builds it, it advances for `Length` seconds, and its death frees the private material override so the
placed material comes back ([Trailmap: 410-texture-animation]). It therefore rests on frame zero here — Tokyo
Megaplex's 77 ride-over buttons sit green until something runs them — and steps only while a node is live,
including with the Effects toggle off, because stopping a running node mid-flight would strand the material on
the pulsed frame. Preview and Play both build one: the trigger volume's MainType-7 hop reaches the button's
graph, whose flip property and MainType-3 frame select run in the same tick to paint the red frame.

What decides whether Preview may run a control message at all is whether the material can be put back
afterwards, and there are two ways it can. A one-shot puts itself back. Every other receiver is rested by
**Stop** — Preview claims the host's material when it runs one, the same claim a UV scroll makes, and Stop or
Escape rests everything it claimed. So a **Set UV phase** reaches its receiver here too, which matters because
on Merqury City's strike sign the receiver's own rates are zero and the phase that command writes is the
entire visible effect. What remains Play-only is a receiver no material carries: a control aimed at an
instance the renderer built no animated material for still draws its ring.

Persistent `property.anim-object` also plays a model's own clip. Simple models retain the compact merged-renderer
form: every visible mesh lives under one animated object, translation channels are preserved, and at most one
X/Y/Z rotation channel may move. This covers every shipped
`Gem_TrickMultiplier` variant in GARI as well as MERQUER's `Mdl_Blimp_SSXANIM_0` body and screen twin: the gems
spin in place, while the blimp's shared subtree follows its recovered XYZ travel and raw-Z turn. Models outside
that subset use the full hierarchy form already proven by the Unity bundle: each material submesh retains its
native ModelObject index, the payload carries every parent/rest transform and all six possible cubic pose channels,
and the viewport applies animated-world × inverse-rest per object. MESA's `Mdl_MineCart_RustedANIM_3000`
therefore keeps its static siblings while object 2 and its descendants follow Effect 177's XYZ translation and XYZ
rotation tracks. The effect wireframe and per-object selection outline follow the animated pose. Turning Effects
off restores the exact baked rest pose.

`property.anim-combo` rides the same player. Its first window is ambient motion like any AnimObject's, and
Aloha's five `Mdl_BarrierDynamic_SideToSide_*` slide side to side under the Effects toggle exactly that way — each
with its own random start phase, so they are out of step with each other as they are on hardware. What sub 258
adds is the second window, which the barrier's own collision effect plays with **Trigger anim combo** (control
command 3). The viewport composes it: the pose every animated object is holding when the command arrives is
snapshotted, and while the reaction runs each object draws as `snapshot × reaction pose` with the idle clock
frozen [Trailmap: 230-level-ssf sub 258]. That is what makes the barrier fall over where it stands, and it is
faithful rather than cosmetic — the reaction's own translation is authored at zero precisely because the engine
composes it. When the window ends the idle carries on from where it stopped; the two latching end behaviours are
implemented but nothing in the corpus authors one. Preview on the combo node itself plays the IDLE half only,
the same split **Model clip (budgeted)** and **Grant clip budget** already have — the reaction belongs to the
trigger, not to the receiver.

The graph inspector's **Preview effect** action restarts a compatible AnimObject at its authored play window and
rate, then runs one complete wrap/ping-pong cycle independently of the global Effects toggle. A **play-once**
clip on a slot whose **Effect end** latch (column 4) is populated instead holds its final frame when the clip
finishes — the Elysium iris door slides open and stays open — because the native latch keeps the finished node
alive instead of destructing back to the bind pose [Trailmap: 150-logic §slot-columns]. Stopping the preview,
changing selection, or leaving Effects mode restores the rest pose (or the current ambient pose when Effects is on).
Models with recovered clips remain preview-capable even when the AnimObject law arrives only through a one-shot
instance call rather than the target's persistent slot. Selecting a Run row resolves that target and called graph
directly; MERQUER's EndSubway → TrainLeft → Effect 756 path therefore opens and plays the train clip in place.
The root model action previews every graph attached through that instance's slot as one set, independent of the
node highlighted below it. This preserves sibling graphs as well as sibling nodes: MERQUER's
`Mdl_RoadBarrier_2049` starts persistent texture-flip Effect 722 and collision mesh-animation Effect 723 together.
Selecting that `property.anim-object` node also opens a read-only **Model animation** viewer. It reports the native
30 fps clip length beside the resolved effect playback duration/rate, lists each recovered translation/rotation
channel (prefixed with its ModelObject number for a hierarchical clip), and draws channel-specific markers at the
recovered cubic segments' boundaries. Those markers are explicitly
derived curve boundaries, not claimed to be the source modeller's original keys. Opening the viewer pauses the
instance at its resolved initial frame; its range scrubber and
play/pause/restart/loop controls hold the reference instance at the sampled pose without requiring the global Effects
toggle. A cyan viewport trajectory samples model-local translation after the instance transform; pale dots mark the
union of translation-segment boundaries and an amber bead follows the current frame. Leaving the node releases the
held pose and removes the path. Exact-transform peers with the same clip/player law scrub together, keeping native
multi-model props such as the blimp body and screen synchronized.

Selecting a `spline.animation` node opens a separate read-only **Spline motion** viewer because this motion lives in
the level's world-space spline table rather than inside the prop model. The level API preserves each spline's native
table index—including animation-only style `-1` routes—while the ride layer independently applies the rail
candidacy rule (styles 12/13 or a name containing `Rail`) for grinding. The viewer reports the stable spline number, cubic count, sampled length, one-way time, named native end
behavior (`One-shot`, `Loop`, `Ping-pong`, or `Hold at end`) and orientation (`Follow yaw + pitch`, `Follow yaw,
stay level`, `Fixed yaw, follow pitch`, or `Fixed orientation`), speed, yaw offset, and instance count. Its distance scrubber and play/pause/restart/loop controls
hold the complete reference prop on the recovered route. Purple viewport lines show the cubic path, dark lines its
control handles, pale dots the cubic boundaries, and an amber bead/tangent the current pose. This covers MERQUER's
`Mdl_Subway_Train_1000` graph on `spline:0038`; `Mdl_Subway_TrainLeft_0` effect 756 remains correctly presented by
the model-animation viewer because that train uses an internal clip instead.

Native V-scroll is negated at the renderer boundary because prop OBJ UVs are bottom-left while Three's default
texture upload flips image Y; U-scroll keeps its native sign. This mirrors `MaterialBundle`'s Unity conversion
and keeps V-driven river families such as `Mdl_Water_River_5000` flowing with the U-driven families.

The same toggle runs persistent graphs that can reach a `particle.timer` node, for both native reference
instances and authored stable-ID prop attachments. Every 150 ms the runtime considers emitters within 180 m of
the active camera, sorts them nearest-first, and schedules at most 48. Authored and reference particles share
one 1,200-particle buffer; ambient effects may use 1,008 entries, reserving 192 for a manual preview or Play
event so a dense vista cannot starve direct feedback. Disabling Effects cancels and clears ambient particles,
while manual **Preview effect** and Play events retain their existing independent behavior. Persistent graphs
without a reachable timer emitter stay with their dedicated material/model renderers and do not create generic
placeholder pulses. This covers the timer-emitter families used for sparkles, smoke, fire, water sprays, and
some fireworks without a model-name allowlist.

Persistent timer nodes emit continuously rather than replaying one large editor burst. The preview keeps the
authored relative count (`U0`, calibrated at ×0.55 particles/second and capped per layer), size and growth
(`U4/U6/U8`), four colour stops (`U33..U48`) exposed consistently as RGBA by every named editor/preview API,
and the full six-vector launch envelope (`U12..U29`). Only the lossless Raw payload retains SSF-native A,R,G,B.
At the viewport
boundary all six velocity vectors and gravity (`U30..U32`) transform through the owning instance with `w=0`;
the longest vector supplies the directed jet and the other vectors determine a bounded cone spread. Persistent
velocity uses the Unity preview's ×0.25 calibration, and persistent gravity ×0.075. A negative `U2` is the retail
continuous-emitter sentinel, not a negative duration: it becomes a randomized 2.4–3.6 second editor lifetime.
This makes Snowdream slot 36's two `Mdl_SnowBlower_Top` layers a continuous, directed, falling plume (about
110 + 27.5 particles/second) while retaining the same data-driven path for flares and lanterns.

The authored `U50` blend selector is honored at the framebuffer, not just in the inspector. It is remapped
through the engine's own table (the one `SsfLogic.BlendMode` carries for the Unity bundle) and lands in one of
three laws: additive, alpha, or **darkening** — the mode that multiplies the frame toward black by the
particle's alpha and ignores its colour entirely. Because blend state belongs to a draw call rather than a
vertex, the viewport keeps two batches over one shared buffer set and splits them by draw range: additive
sprites packed at the front, alpha and darkening ones behind, the latter drawn second so a plume darkens the
glow it hangs in front of. A darkening particle is packed black, exactly as the Unity importer drops that
colour. This is what puts Snowdream's road flares on screen — slot 46's plume is authored near-black at alpha
0.08, so an additive draw contributes nothing and the smoke is simply absent. `particle-blend-webgl.test.ts`
renders the real batches and reads the pixels back, including the additive control that reproduces that
absence.

**Preview effect** runs a non-looping selected graph once at the attached instance. A persistent graph that can
reach a timer emitter instead shows **Play effect**, changes to **Stop effect** while it emits continuously, and stops its
own pending tasks and particles when stopped, deselected, or when Effects mode closes. This manual preview is
tracked separately from ambient Effects-toggle particles and Play events. The bounded editor runtime supports:

- graph order and Wait delays;
- function calls and instance/graph calls;
- timer-emitter origins transformed through the native prop location, rotation and scale;
- lightweight particle bursts for timer emitters;
- colored pulses for sound, boost, trick and not-yet-visualized opcodes.

## Play execution

Play runs the gameplay-bearing graph subset on either the authored or reference mountain. It preserves graph
order, Wait delays, function and instance/graph calls, and main-type-5 gates (speed, random, human-rider, and
no-live-node). Collision circumstances and per-instance `CollisonSound` one-shots fire only from the fixed-tick
board sweep's exact solid or ride-through contact, using the contacted instance's stable identity. This includes
invisible collision twins and excludes nearby mode-0 scenery. Trigger circumstances remain entry/re-arm volumes;
their radius uses the rendered host's bounds when available, with a small proximity floor for effect-only hosts.

The ride runtime currently applies:

- MainType 13 course reset to the closest point on the mountain's course line;
- MainType 17 timed speed boost through the existing boosted cap/thrust path;
- MainType 18 trick-window state and MainType 14 max-not-stack score multiplier, both visible in the ride HUD;
- MainType 24 teleport through its stable destination-instance reference and the board's warp path;
- graph-driven source hide / hidden-twin reveal for breakable chains.

The **MainType-0 boost family** is deliberately absent from that list, because a collision dispatch is the
wrong shape for it. These are containment volumes: the engine re-tests which riders are inside the host's
bounding box every tick and pushes each of them once per tick ([Trailmap: 360-node-apply]). This runtime
rate-limits a collision graph to one firing per debounce interval, so the only push it could deliver from
here is the lag integrated in closed form over that whole interval and applied in a single frame — which at
Megaplex's own exhaust-vent tuning (rate 3, target 100 m/s) is 92% of the target in one tick, regardless of
how briefly the rider was actually inside. The dwell the engine's whole model turns on stops mattering.

So the family travels to the ride as **geometry** instead: `boostVolumeSpecs()` resolves every authored
payload into editor world space, `ride/boost-volumes.ts` owns the per-tick behaviour, and the play command
survives only to describe the node's data for the effects editor. Measured both ways against PS2 in
`Slopesmith/tools/ride-study/boost-throw.ts` and the autotest cell `vent-throw`.

A collision- or trigger-fired Sub256 `AnimObject` runs the same bounded clip player Preview uses: the native
contact walk constructs a fresh node per dispatch, so re-crossing a trigger replays the clip from frame 0, and a
play-once clip on an Effect-end-latched slot holds its final frame. This is the Elysium iris-door chain end to
end — crossing any `Mdl_Trigger_iristrigger` volume runs `MainType 7 → effect 100` on the door, the 1.33 s
open clip plays once, and the door stays open through slot 34's two empty latch columns
[Trailmap: 150-logic §slot-columns].

Persistent Sub257 `AnimDelta` installs a frozen native model-clip player. MainType 3/9 control command 2 is
delivered to that instance's installed receiver and grants `value / 30` seconds of animation budget. This covers
ELYSIUM's up/down kickers: the landing-trigger graph grants one 1-second half-cycle to all three ramps, while the
centre ramp's persistent graph supplies its extra half-cycle and can therefore sit opposite the locked outside pair.
The receiver check is deliberate—command 2 is not globally an animation opcode and remains ignored for instances
without an AnimDelta property.

Reference Play also invokes the retail `StartCountDown` lifecycle function when present. That function installs
the otherwise-unattached start light's Sub11 `TexFlip` receiver and follows its native Wait chain (1.0 seconds,
then three 0.5-second steps), delivering MainType-9 command 2 to select flipbook frames 1 through 4. Controlled
materials receive a private texture wrapper per native instance, so the countdown cannot change unrelated props
that share the same material. The same receiver-aware path supports retail UVScroll command 6 (set V phase).
That covers MERQUER's strike sign and ten numbered strike-light instances, including their zero-rate,
phase-only UVScroll receivers.

Ambient UVScroll preview also follows the recovered native mode/timing state:
mode 0 is same-direction linear motion, mode 1 is eased ping-pong, and mode 2 is
constant-speed ping-pong. `U3` is the active interval, `U4` the pause, and `U5`
the optional total lifetime, all in seconds—not horizontal/vertical wrap
lengths. The reference inspector presents modes 0–2 by name and keeps any other
native value as a numbered fallback; the native routine treats those fallbacks
like mode 0.
With Play's persisted **Race countdown** option enabled, the same recovered Wait/frame sequence drives the race
gate: the player and optional AI field remain seated through READY, 3, 2 and 1, release as frame 4 selects GO at
2.5 seconds, and collision/trigger graphs stay dormant until that release. The option defaults off for rapid test
runs. This is structural rather than name-only inference: a function without the consecutive absolute frame
commands does not delay Play. Stopping Play restores frame/phase zero. Test setup invokes the selected mode's exact
named entry point (`RaceMode`, `ShowoffMode`, or `FreerideMode`) as soon as the target/mode is selected, before a
race starts; late-loading reference effects resume that preview when their data arrives. Its ordinary function
calls run through the existing effect scheduler, so `HideShowOff` / `HideRace` hide their targeted props; reachable
`MainType 25 Effect 0` spline targets are also omitted from that run's grind network. The native LTG `GemIndex`
layer is additionally treated as Showoff-only even though its instances do not occur in `HideShowOff`; this
includes both multiplier gems and their solid `Gem_RailSupport_*` placements, matching live retail mode
verification. Authored props can opt into that same proven layer through Prop Details' semantic **showoff
only** setting; setup hides their render and ride collider even on a fresh mountain with no Effects document,
and canonical export writes LTG state 2 for the Unity/PS2 pipelines. Raw state 1 is inspectable on reference
props but is not offered as a general race-only authoring choice. Stopping or starting another run restores
the reference world before applying the new mode.

Persistent emitters retain the camera/rider budgets above. Play installs continuous flag and spline-motion
properties even when the editor Effects view toggle is off. Reference hidden instances keep zero-scale textured
geometry in their native prop batch, allowing a graph to reveal the actual broken twin or subway model without a
mid-ride asset rebuild. A spline mover's `InstanceCount` uses that same native placement as copy zero and adds
render-only shared-model copies at `spline length ÷ count` arc-length offsets. Each copy samples its own tangent,
so Snowdream's 15 gondola chairs circulate around the complete wire without inventing extra `Instances.json` IDs
or collision bodies. When the mover's generic native route-line flag is set, the same runtime draws its recovered RGB/alpha
as an untextured one-pixel line over the route, using the original ten samples per cubic segment; Snowdream's
opaque 0.1-grey lines are therefore the actual three gondola cables rather than inferred tower connections.
Turning the world **Effects** view on installs persistent spline movers immediately, following
the same instance/function hand-offs as Test; turning it off restores their source placements. Test takes ownership
of an already-running ambient mover so the visibility toggle cannot stop it mid-ride, then ambient motion resumes
when Test ends if the view remains enabled. Runtime copy draws reconcile with the progressive prop build, so an
ambient mover that starts before its model geometry arrives gains all of its copies as soon as that geometry is ready.
Live movers also reassert their visibility with their matrices every frame: this matters for Snowdream's natively
hidden `Mdl_Gondola_Chair_4000` template when a refresh rebuild clears the initial runtime visibility override.

The higher-risk motion subset has bounded transform simulations: Roller nodes launch, tumble, gravity/bounce and
settle the target; mesh-throw nodes use the recovered direction/scales for their authored duration, preserving
decoded multi-object targets as independently tumbling pieces around their own centroids (MERQUER Effect 104's
21 mailbox letters) and falling back to whole-target motion when no piece structure survives extraction; fences run a damped collision rattle; flags sway continuously; and spline-animation nodes follow the
recovered cubic path at the authored metres/second speed. Their shared preview law distinguishes one-shot
completion (the moving copy disappears), wrap, ping-pong reversal (including the native 180° return-leg yaw),
and a live node holding at the endpoint. Invalid orientation values alias follow-yaw-plus-pitch and invalid end
values take the native forward-wrap fallback. Reverse travel clamps at the starting end except in ping-pong mode.
Roller Preview bakes in the missing collision context: it restores the prior pose, applies a fixed 12 m/s
horizontal hit from a newly randomized direction, adds the node's authored Roller launch, simulates for five
seconds, and restores the instance automatically. It needs no projectile, strength control, or extra inspector UI.
The shipped
MERQUER subway is the single-copy direct spline case; Snowdream's handed 15-copy gondolas use the same motion law
with evenly spaced render copies. Per-piece mesh deformation, vertex-weighted flag/fence bending, and moving prop
collision bodies remain separate follow-up work.
The editor currently installs persistent receivers level-wide for a test ride; it does not yet reproduce the PS2's
3x3 player/camera cell activation lifecycle, so leaving an object's region does not reset its AnimDelta pose mid-ride.
That accidental keep-everything is exactly what a populated **Region exit** latch (column 3) authors on the PS2, so
objects carrying it (the iris door, Mesa's fallen tree trunks) behave faithfully; everything else stays animated
where the original would have snapped back to its rest pose. When the region lifecycle lands, column 3 is the
authored opt-out to read [Trailmap: 150-logic §slot-columns].

This is not a byte-for-byte PS2 renderer. It intentionally caps particles, uses proximity bounds for trigger hosts
with no rendered shape, and keeps the higher-risk motion approximations visual-only rather than mutating the ride's
terrain collider. Unsupported render/audio nodes produce diagnostics only during manual Preview. The exact node
JSON remains visible beside the approximation, so the UI does not imply that an inferred visual is native fidelity.
