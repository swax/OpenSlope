# Quest course library and first use

Build 0.52 updates the Android panel shown before entering VR. Gameplay and the
immersive wrist UI use the existing runtime.

## Flow

The panel opens on Your courses. A populated library shows named Play buttons
and a labelled Freeride/Race/Showoff selector, with a short description of the
selected mode. Add courses, Ride settings, First run & controls and Folder
details expand in place. Android Back closes an open section before closing
the panel. Close OpenSlope is also an explicit action.

An empty library immediately explains both supported entry paths: Import from
ISOs, or Choose Maps folder for existing/custom maps. Both actions fit the
default 1024 by 640 dp viewport. Importing continues to populate the selected
Maps folder, preserving existing courses. Its course chooser starts with no
selection, shows an import count, supports select-all/clear, and has Back.
The old terrain-only import notice is replaced with the current scope.

The system file picker accepts multiple ISO/BIN files at once. Their courses
appear in one chooser with the source filename beside each course. Each chosen
course imports from its own disc, sequentially, without copying entire images.
Duplicate course slots use the first selected disc; existing maps are kept.
An unreadable disc is reported without hiding courses from other selected discs.
Cancel stops the batch and keeps completed maps. PS2 support is full for Tricky,
partial for SSX, and preliminary for SSX 3 and On Tour.

The default view hides raw folder identifiers and graphics options. Existing
render-scale, smoothing, head-steering and run-mode preferences retain their
keys and values. Opening the panel does not write default values over missing
preferences. An unavailable folder removes stale Play buttons, explains how
to recover, exposes folder details/refresh and prevents importing into that
unavailable destination. A course-launch error survives the initial resume
and refresh rather than disappearing immediately.

## Access and presentation

The panel uses standard Android buttons, spinners, dialogs and scrolling, with
60 dp minimum action targets, 18 sp body text, scalable wrapping text and
high-contrast dark surfaces. Focus/hover/pressed states have visible outlines;
labels do not rely on icons or color alone. Spinner labels use labelFor;
headings and disclosure states have accessibility semantics. Progress is
indeterminate rather than a fabricated percentage. Status is a polite live
region, with worker updates throttled and suppressed after cancellation.
Long operations retain Cancel and Close OpenSlope.

These choices follow the current [Meta Android panel requirements](https://developers.meta.com/vr/documentation/android-apps/design-requirements/)
and [Android Views accessibility guidance](https://developer.android.com/guide/topics/ui/accessibility/views/apps-views).
Standard views also retain the system's input/accessibility structure for
[Look and Pinch](https://developers.meta.com/vr/documentation/android-apps/gaze-and-hands/).
No new permissions or UI framework dependency is added. The immersive activity
keeps its existing theme and system lifecycle behavior.

## Verification

The repository gate passes (233.1 s), including all 48 Native suites. The APK
builds and the connected Quest passes 115 existing JNI/library/SAF checks and
144 additional launcher checks. Those cover empty and populated map discovery,
first-action viewport bounds, target sizes, focusability, disclosure/back,
busy/cancel/exit availability, explicit import selection and folder failures.
Picker failures survive automatic resume/refresh as well as course-launch errors.
A 360 dp panel with 150% font scale checks text wrapping and controls, including
a long custom course name. App-only panel previews are inspected separately.

The headset can suspend panel frames while unworn. Instrumentation therefore
measures/layouts the real Android views at the system-provided panel bounds
and captures them directly. This establishes layout and flow behavior; worn
visual comfort, controller/hand pointing and spoken screen-reader interaction
still need human checks. User-imported ALASKA geometry, world, instances, audio
sidecars, selected-library preferences and audio preferences retain their hashes.
The existing Horizon lifecycle check also passes Home pause, app-icon resume to
the same course, both exit destinations and repeated launch/teardown, with four
resumes, four pauses and three completed XR resource releases. Android lint has
zero errors and three warnings; the signed ARM64 APK retains all sixteen notices
and contains no course media.

```powershell
./Native/build-android.ps1 -Tests
adb shell am instrument -w -e launcher true org.openslope.nativeplayer.test/org.openslope.nativeplayer.NativeImportInstrumentation
```

Saved APKs and validation records use the `temp/native/*0.52.0-launcher*` and
`temp/native-launcher-0520-*` prefixes. Device view captures are app-private
under `cache/launcher-ui-checks` and are copied to the latter local prefix.
