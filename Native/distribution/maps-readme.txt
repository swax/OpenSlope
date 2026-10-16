Add portable OpenSlope maps here as Maps/NAME/Patches.json, with the course's
other files and subfolders beside Patches.json. OpenSlope lists these at startup
and in its map library. Use Refresh after adding courses. Custom maps work without a disc image.

For in-app setup, place your supported SSX Tricky PS2 ISO beside OpenSlope.exe,
then open ISO Sources in the library. Click Extract beside any courses you want;
they queue and extract one at a time. Progress stays in each row, which becomes
Play when ready. X cancels that queued/active row. Extraction does not start the
game. Lists scroll with the wheel or scrollbar. Existing map folders and local edits are preserved. No ISO is
copied into the app. SSX 3 and other titles/platforms are not supported yet.

The optional "Import courses.cmd" launcher also accepts an ISO elsewhere on
your computer, or an ISO dropped onto it. It can import a listed course or ALL.
Import may take several minutes and needs free space for the selected maps.

Advanced, from the parent folder:
  openslope_import.exe list "C:\path\game.iso"
  openslope_import.exe extract "C:\path\game.iso" COURSE "Maps"
  OpenSlope.exe --map "Maps\COURSE" --on-foot

Keep imported disc content private. It is not part of the application license
and must not be uploaded with bug reports or redistributed in release packages.
