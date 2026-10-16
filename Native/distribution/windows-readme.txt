OpenSlope Native - Windows portable preview

1. Extract the entire ZIP into a writable folder, such as Documents/OpenSlope.
2. Put any supported SSX Tricky PS2 ISO files beside OpenSlope.exe (optional).
3. Double-click OpenSlope.exe or "Play OpenSlope.cmd". The app opens its library.
   Choose an installed/custom map, or an ISO and queue courses with Extract.
   Progress appears in each row. Completed rows become Play buttons.
   Scroll with the wheel or scrollbar; X cancels a queued/active extraction.
   Imported courses stay in Maps beside the program and play without the ISO.
   Use Refresh after adding files while the app is open. See Maps/README.txt.

Requires 64-bit Windows 10/11 and an up-to-date Vulkan graphics driver. The C++
runtime is linked into the programs; Visual Studio and Python are not required.
For PC VR, select your headset's active OpenXR runtime and use "Play in VR.cmd".
PC VR device coverage is still limited; Quest standalone uses the separate APK.

Controls: A/D strafe on foot or steer riding, W/S move/tuck/brake, Space jump,
Shift boost, E dismount or spawn and mount at your feet (also in mid-air),
left-drag look/turn on foot, right click carry/throw, wheel zoom, F/V camera,
R recover, T restart, Q exit rail, P/Escape menu. On foot, jump again in the air
to fly. The menu includes controls, graphics, audio, map library and opponents.

Graphics default to 150% scene resolution and 4x MSAA. Reduce these in Graphics
if needed. Opponents are optional, 0-16, and require a course with AI paths.

Updates: extract each release into a new folder and copy your Maps folder over,
or use the new program with --map "C:\path\to\Maps\YOURCOURSE". Keep a copy of
your maps. Do not overwrite a populated installation with a partial ZIP extract.

This is an experimental player with incomplete gameplay parity. Only Quest 3
has current device evidence. Share bugs at https://github.com/swax/OpenSlope/issues
and include the version, course, platform and steps. Licenses are in licenses/.
No game content is bundled. Imported disc content stays local to your machine.
The native ISO reader currently supports SSX Tricky PS2 only. SSX 3 and other
titles/platforms are not supported. Filename changes do not add format support.
