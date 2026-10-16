Add portable OpenSlope maps here as Maps/NAME/Patches.json, with the course's
other files and subfolders beside Patches.json. Start or restart OpenSlope,
then open Maps in its menu. Custom maps work without a disc image.

To convert your own supported SSX Tricky PS2 ISO, double-click "Import courses.cmd"
in the parent folder. Choose the ISO, then type a listed course name or ALL.
You can also drag an ISO onto that launcher. Existing map folders are skipped.
Conversion progress appears in the console. Import can take several minutes
and needs enough free space for the selected maps. No ISO is copied into the app.

Advanced, from the parent folder:
  openslope_import.exe list "C:\path\game.iso"
  openslope_import.exe extract "C:\path\game.iso" COURSE "Maps"
  OpenSlope.exe --map "Maps\COURSE" --on-foot

Keep imported disc content private. It is not part of the application license
and must not be uploaded with bug reports or redistributed in release packages.
