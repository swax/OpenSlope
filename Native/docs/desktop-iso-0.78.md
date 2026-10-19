# Desktop ISO setup, build 0.78

Put `.iso` files beside the desktop EXE and launch it. With no explicit `--map`,
the library opens first. It shows installed/custom maps, or ISO sources when
there are no installed maps. **ISO Sources** switches to the source list.
Choose an ISO, then **Extract <course>** on any courses you want. They queue and
extract one at a time. Each row shows Queued or Extracting with its current
stage and an X cancel button. A completed row becomes **Play <course>**. Playing
is a separate click; extraction never starts a course. The existing independent
native importer writes the shared `Maps/<name>` format beside the EXE. No command line, PowerShell
script, external converter process or duplicate ISO copy is required.

Source discovery is nonrecursive, accepts case-insensitive `.iso` extensions and
uses the running executable's directory. It does not infer support from the
filename. The present format reader accepts SSX Tricky PS2, as documented by
the clean Trailmap 200/210/220 format contracts. The shared reader also supports
SSX (including raw BIN images) and SSX 3 PS2 events/peaks. See
[SSX import](ssx-import.md) and [SSX 3 import and limits](ssx3-import.md).
On Tour PS2 day/night tracks also use this flow; see [On Tour import](ontour-import.md).

Imported maps remain normal course folders. They are usable after the ISO is
moved or removed; existing folders and local edits are preserved. Source files
are read only. Custom Maps folders remain usable through the library and the
existing `--map` option. An explicitly selected course still launches directly.
**Refresh** finds newly added ISOs and maps without restarting the app.

ISO inspection and extraction run off the UI thread. Inspection has a cancellable
progress screen; extraction leaves the list usable and shows stages in each row.
You can queue additional courses, switch sources, cancel queued/active work and
retry failures while other jobs continue. Wheel scrolling and a draggable scrollbar
replace desktop Previous/Next paging. Quest retains its existing navigation.
An explicit Play click uses the normal asynchronous course-loading bar.
Extraction owns a unique hidden
staging folder and publishes only a validated complete course. Failure or
cancellation cleans that staging folder; completed courses remain available.
Closing the app cancels the worker before waiting for it to finish. Unsupported
or corrupt sources report an in-app error and retain the installed library.

The native implementation remains separate from differently licensed library
code. No retail assets or ISOs enter application/release packages. Quest retains
its existing system-picker import flow. The broader parity goal remains paused.

The Windows playtest checks six real Vulkan window/library flows from a
different working directory: empty setup, corrupt ISO, unsupported PBD version,
queued extraction with scrolling and explicit Play, existing-map reuse and playback after removing the ISO. These
use independently authored synthetic discs and verify map publication, unchanged
source images, preserved local edits and absent staging leftovers.

The portable library suite passes six scenarios, including cancellation during
texture extraction, refusal to overwrite an existing incomplete/custom directory,
cross-ISO serial queueing, duplicate-click protection and retry after failure.
UI checks cover inline status, per-row cancellation, fractional wheel input,
scroll limits and dragging the scrollbar. Existing import, equipment and Quest
control suites also pass. Six distribution-boundary checks pass, and the EXE's
DLL imports pass the release allowlist. No retail media is packaged.

The Native source-boundary audit passes for 447 files. All 58 Native suites
pass. The complete repository gate passes (695.7 s), including
1,002 synthetic .NET checks, all 232 covered web test files, production
build and export smoke test. This desktop change has no new Quest
installation or worn-device claim.

```text
python Native/tests/desktop_library_replay_test.py <path-to-openslope_player.exe>
```
