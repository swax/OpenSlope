# Quest / Horizon OS integration

Build 0.49.0 (Android code 51) checks the native OpenXR app against Meta's
focus-awareness and single-player lifecycle requirements:

- [Input focus and Universal Menu](https://developers.meta.com/vr/resources/vrc-quest-input-4/).
- [Pause and resume](https://developers.meta.com/vr/resources/vrc-quest-functional-2/).
- [Immersive-to-panel navigation](https://developers.meta.com/vr/documentation/spatial-sdk/spatial-sdk-sample-hybrid/).
- [OpenXR session lifecycle](https://registry.khronos.org/OpenXR/specs/1.0-khr/html/xrspec.html).

The app retains its panel course picker and separate immersive activity. Normal
play removes the picker task. Relaunching the app icon while a live course
exists brings that activity forward. Returning to the map library explicitly
uses Horizon's Home + pending panel intent pattern. The wrist menu has separate
Map library and Exit app actions; Exit app and Android Back close the immersive
task without reopening the picker. Errors still return to the picker with a
message. Left Touch Menu and Y both open the wrist menu; the right Meta button
is reserved for the system.

OpenXR focus and Android resumed/window state gate simulation, input and audio.
The world keeps rendering when visible without input focus; avatar/controller
geometry, equipment highlights, wrist panels and pointers are hidden. Android
pause submits no scene layers. Focus/session gaps reset the frame clock so
returning to the course cannot simulate the time spent in Home. Held activation
buttons must be released before rearming input, preventing a system-menu
selection from activating an in-app button. AAudio uses the game usage category.

App-initiated exit uses xrRequestExitSession, handles STOPPING/xrEndSession, and
releases audio, body tracking, swapchains, graphics and the XR instance. The
native glue event thread then remains alive until Android's Destroy command,
acknowledging input/window teardown. On-device testing exposed the former early
thread return as a destroyTimeout; processing those final commands addresses
that ordering defect. SAF play caches are removed after native teardown.

Portable tests exercise paused physics, resumed clocks, reserved/menu bindings,
ray-selected exit destinations and held-trigger rearming. Device instrumentation
runs actual Home/task switching, app-icon resume into the same activity, Android
Back, both exit destinations, and repeated XR startup/shutdown. It uses a small
synthetic floor and preserves the user's imported maps. Worn Universal Menu
visibility/input and listening remain separate headset checks; an unworn
startup does not establish those or sustained frame rate.

Validation: the repository gate passes (326.5 s), followed by a final Native-only
gate after the teardown/rearm changes. All 46 Native suites pass; focused runs
cover 26,751 VR-control checks, 14,327 equipment/camera/UI checks and 96 production
Vulkan UI frames. The source boundary checks 333 files.

The installed Quest build passes 113 JNI/library/SAF checks and a separate real
task lifecycle sequence: Home pause, icon resume to the same course, app exit
without a picker, explicit picker return and repeated launch/exit. It records
four resumes/four pauses and three completed native resource releases, with no
Android fatal exception. An eight-second owned ALASKA startup initializes both
1680x1760 eyes at 4x MSAA and the runtime full-body tracker. Six checked map files
and selected-map preferences retain their hashes. Lint reports zero errors and
four existing warnings; the ARM64/v2-signed APK contains sixteen exact notices
and no private media.

Saved builds: `temp/native/desktop-quest-lifecycle-0.49.0` and
`temp/native/OpenSlopeNative-quest-0.49.0-quest-lifecycle-debug.apk`. The adjacent
build manifest records hashes, source commit and device evidence.
