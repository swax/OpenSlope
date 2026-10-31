# Desktop ISO setup, build 0.78

Use **ISO Sources → Choose disc** to open an image anywhere on the PC. The chooser accepts `.iso`, `.bin`,
`.gcm` and `.rvz`; selected external images remain in the source list for the current session. Images beside
the EXE are also discovered automatically. With no explicit `--map`,
the library opens first. It shows installed/custom maps, or ISO sources when
there are no installed maps. Installed maps are grouped by **Game → Map**; **Games** returns to the
game chooser, and scrolling/paging applies only to the selected game. Groups use `Origin.json.Game`, then
`Import.json.Game`, with legacy IDs as a fallback. **Custom / Authored** and **Unknown** retain courses
without imported game metadata. **ISO Sources** switches to the source list.
Choose an ISO, then **Extract <course>** on any courses you want. They queue and
extract one at a time. Each row shows Queued or Extracting with its current
stage and an X cancel button. A completed row becomes **Play <course>**. Playing
is a separate click; extraction never starts a course. The existing independent
native importer writes the shared `Maps/<name>` format beside the EXE. No command line, PowerShell
script, external converter process or duplicate ISO copy is required.

Automatic source discovery is nonrecursive, accepts case-insensitive `.iso`, `.bin`, `.gcm` and `.rvz` extensions and
uses the running executable's directory. It does not infer support from the
filename. PS2 import support is full for SSX Tricky, partial for SSX, and
preliminary for SSX 3 and SSX On Tour. Keep images for multiple games together
and switch between them under **ISO Sources** to queue courses from each disc.
The shared reader accepts SSX (including raw BIN images) and SSX 3 events/peaks. See
[SSX import](ssx-import.md) and [SSX 3 import and limits](ssx3-import.md).
On Tour PS2 day/night tracks also use this flow; see [On Tour import](ontour-import.md).

Course rows use titles recovered from the disc. Installed maps prefer `Import.json.DisplayName`, with
legacy fallback labels where that metadata is absent. IDs and source paths remain unchanged.
SSX 3 initially lists the 17 named event runs. **Show all types** also reveals stations, connectors and
peak bundles; **Show named runs** restores the default and resets scrolling/paging. The same rule applies
to the wrist picker. See [map layout metadata](course-titles.md#map-layout-metadata).

Quest's **Import ISO** picker accepts one or more granted disc URIs and displays the same source titles.
Its **Include stations, connectors and peak bundles** checkbox reveals the advanced SSX 3 entries.
Selections are retained by map ID when toggling the filter; Select all and Import apply to visible rows,
so hidden advanced entries are not silently imported. Each choice retains its own source disc.

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
