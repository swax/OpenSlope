# Palm-directed finger curls, build 0.59

The Quest play test reported that the stick figure's fingers curled sideways.
The original per-chain hinge used the knuckle-to-wrist vector to choose its
plane. That vector lies in the palm rather than pointing into it, so closing
the fingers swept across their spread instead of folding into the hand.

The new hinge uses the anatomical palm normal from the unchanged first-party
figure's hand bind frame. Left and right normals have opposite signs. Each
chain keeps that hinge through its child joints and follows the controller's
full orientation. The separate thumb, index and other-finger sensor groups,
their existing ranges and the controller models/labels are unchanged.

This is an application pose choice. Clean Trailmap 300/400 continue to establish
the separation between gameplay and rendered rider presentation; they do not
claim a recovered retail finger rig. Only Native source, the existing
first-party GLB and standard vector geometry were used for this correction.

## Verification

The new portable regression uses independently measured distal end-cap
triangles from the bundled figure, rather than the posing code's axes. It
checks all five digits on both hands at 20%, 50% and full curl, through neutral,
yaw, pitch, roll and oblique wrist orientations. Each tip moves into its palm;
the four fingers retain their lateral spread. Other sensor groups and the
opposite hand remain unchanged, and release restores identical resting mesh
vertices. The old code fails the first inward-direction check.

The focused portable avatar suite passes 478,149 checks. Actual Vulkan captures
pass 233 avatar/controller/UI/stereo checks, including close-up open/closed
hands with controllers, visible sensor-driven closure and agreement between
UNORM and sRGB targets. Headset comfort and perceived physical grip alignment
remain a worn-device check; build/install or synthetic poses alone do not
establish those results.

All 50 portable Native suites pass. The same 478,149 avatar checks also pass
on the Quest ARM64 CPU, linked against the APK's core. The signed 0.59.0/code 62
APK is installed and passes 115 JNI/library/SAF plus 157 launcher/accessibility
checks. Checked sidecars for all eight imported courses and saved launcher/audio
preferences are unchanged. Android lint reports zero errors/three existing
warnings. Both APK signatures and all sixteen packaged notices verify; no
private course media is packaged.

Frozen artifacts are `temp/native/desktop-fingers-0.59.0` and
`temp/native/OpenSlopeNative-quest-0.59.0-fingers-debug.apk`. The build record
`temp/native/finger-curl-0.59.0-build.json` retains commit and artifact hashes.
