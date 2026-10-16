OpenSlope Native - Windows portable preview

1. Extract the entire ZIP into a writable folder, such as Documents/OpenSlope.
2. Double-click "Play OpenSlope.cmd". The included procedural slope needs no ISO.
3. Open Maps in the menu to select a course. See Maps/README.txt to add courses.

Requires 64-bit Windows 10/11 and an up-to-date Vulkan graphics driver. The C++
runtime is linked into the programs; Visual Studio and Python are not required.
For PC VR, select your headset's active OpenXR runtime and use "Play in VR.cmd".
PC VR device coverage is still limited; Quest standalone uses the separate APK.

Controls: WASD move/steer, Space jump, Shift boost, left click mount/dismount,
E recall board, right click carry/throw or drag to orbit, wheel zoom, F/V camera,
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
