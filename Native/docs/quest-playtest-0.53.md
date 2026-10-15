# Quest play-test follow-up, build 0.53

The wrist panel now follows the left grip's full orientation instead of
billboarding toward the eyes. Its nearest edge is 17 cm beyond the grip, with
the controller and hand in front. World-space UI tests depth against the scene;
desktop screen UI retains its overlay pipeline. Visible menus also show the
contextual instructions beside the controllers. The same presentation offset
is applied to controllers, pointer and menu in third person.

Both hands render the requested first-party Slopesmith Quest Touch Plus art,
baked through its public art API into a 652-triangle GLB. The native build embeds
that asset, with Apache attribution and binary provenance, and links no authoring
runtime. The left model mirrors the right in grip space. A/B and X/Y face glyphs
are drawn with Native's font. The optional `XR_META_touch_controller_plus` profile
is enabled when advertised, alongside the existing Oculus Touch fallback.

Per-hand trigger touch, face-button/stick/thumbrest touch, trigger amount and
grip amount drive the stick figure's existing finger bones. Thumb, index and
the other three fingers move independently. These inputs are visual: touching
A/B does not jump or boost. Missing/inactive tracking produces a fresh fallback
instead of retaining a stale sensor pose. The sensor grouping corresponds to
the [VRChat Touch pose reference](https://docs.vrchat.com/docs/touch); bindings use
the [registered OpenXR Touch Plus paths](https://github.com/KhronosGroup/OpenXR-Docs/blob/main/specification/sources/chapters/extensions/meta/meta_touch_controller_plus.adoc).

Walking records the actual blocking collision before the solver's separation
margin can hide it from later overlap queries. That contact reaches the same
graph, fragile-break, sound and movable-body routes as mounted contact. Room
movement sweeps the body at the tracked horizontal offset. Tracking-origin
changes reset that sweep history. Walking interactions are available while
Race/Showoff is waiting for a mount, without starting the run clock.

Application play defaults to continuous control through impacts and awkward
landings, as requested. Bounce, collision separation and hard-impact accounting
remain active; knockdowns are disabled by default. The clean recovery behavior
remains an explicit `PlayTuning::knockdowns` option for its conformance tests.
Head aiming eases out of its dead zone, and VR board rotation interpolates
between simulation ticks alongside its position. Physics and manual steering
continue to use the current fixed-tick pose.

Multiplier pickups use faceted geometric normals as an explicit presentation
choice. Their models are identified through multiplier graph metadata, without
course names or fixed effect-slot indices. Source geometry is unchanged.
Per-instance ambient and directional keys still shade the mesh in the authored
byte domain. Other models retain their supplied normal splits. The user's wider
report of overly bright props on all courses remains open; it is not claimed
fixed by changing pickup normals.

The owned MERQUER train remains active on its 253.05 m path at 35 m/s. A full
loop produces real Vulkan train draws from its hidden template. This establishes
the desktop simulation/render path, not the user's missing-train behavior on
Quest. New XR timing lines include visible-prop and route-copy counts for the
next device comparison.

## Verification

All 48 portable Native suites pass. Owned runs pass 98 world-logic checks and
22 mesh/shatter checks. Vulkan avatar/UI checks pass 222 assertions, including
both target colour spaces, controller tracking, wrist depth occlusion, a full
owned train loop and rotating GARI pickup captures. Interaction restoration has
additional production Vulkan/PCM replay coverage described in
`interaction-resets.md`.

The Android main/test APKs build for ARM64. USB is absent during this follow-up,
so these controls, images and frame pacing have not been validated while worn.
Build 0.52 remains the last verified headset installation. Tokyo Megaplex vents,
button cues and the requested graphics defaults are subsequent follow-up work.
