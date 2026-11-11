# 073 — Map library, local saves and offline use

The homepage is the map library. Use it to create a mountain, resume editing, ride a course,
or load courses from your own supported disc image or ROM. For a first local installation,
see the [Slopesmith README](../README.md).

## Find or create a map

The sidebar offers **All maps**, **Public**, **Private**, and game views. Search and the
**Local / Server** source filters narrow the list. A game map with both local and server
copies uses one row with an icon for each source.

- **All maps** includes custom mountains and game maps available to this browser.
- **Public** contains published server mountains and reference listings.
- **Private** contains browser-saved mountains, linked folders and, for signed-in members,
  unpublished server mountains. Game maps stay in All maps and their game views.

Choose **New map**, give the mountain a name, and choose Local or Server storage where available.
The default **Blank — no terrain** starts empty; choose **Generated course** to start with terrain.
Local creation and editing work without signing in. Server creation requires an account with
permission to create maps.

Map rows offer **Play**, **Edit** for custom mountains, and **Inspect** for imported references.
The player preview also offers **Play in VR** and **View map**. Click the preview to choose a
local start point; **Reset start** restores the default. View map displays the camera controls.

**Load map**, beside New map, offers:

- **Import from file** — restore an editable `.slopesmith.zip` as a new Local or Server mountain.
- **Link folder** — add an existing mountain folder to Private maps and remember its connection.
  This needs a browser with a directory picker, such as desktop Chrome or Edge.

Linked maps check for folder changes before opening. A folder icon identifies them; browser-only
maps use a browser icon. Private server entries use a cloud and public entries use a globe.
The [local-project contract](035-local-projects.md) describes identities, revisions and folder recovery.

## Save and back up an editable mountain

Signed-out edits stay on this device. Editing a public mountain creates an independent local copy,
with a name such as `MyMountain_REV_1`; reopening that local tile resumes the copy. Signing in does
not upload local mountains automatically. Server mountains use the server's project storage and
[history and recovery](040-history-and-recovery.md).

Click the editor's save icon to see the location, last save time and backup actions:

| Action | Result |
|---|---|
| **Save to folder…** | Keeps `mountain.slopesmith.zip` and custom assets in a chosen folder, updating it after browser saves. |
| **Resume folder autosave** | Restores permission to an existing folder connection. |
| **File → Export… → Another Slopesmith instance** | Downloads an editable ZIP with the mountain-local asset library. |
| **Load map → Import from file** | Restores that ZIP as a new mountain. |
| **Load map → Link folder** | Reconnects an existing folder copy from the library. |

Folder autosave needs the directory-picker API. Other browsers can use editable ZIP downloads
and imports. Browser storage belongs to this browser profile and site address; clearing site data
can remove it. Folder copies and downloaded archives provide independent backups.

Use **File → Rename mountain…** to rename a local copy. Local **Delete** asks for confirmation
and removes its browser copy and assets; folder copies and downloads remain. The **Home** icon,
**File → Library**, and **File → Exit editor** save pending changes before returning to the library.

## Load courses from a disc image or ROM

Select a game, then choose **Load PS2 image…**, **Load GameCube image…**, or **Load GBA ROM…**
beside its name. Scanning discovers courses without loading them all. Choose **Load** on a course
to import it; several courses can be queued and load one at a time. Each row shows progress and
offers **Cancel**. Leaving during a scan or import asks before cancelling active and queued work.

The Native importer runs as WebAssembly in a browser worker. The source image and imported assets
stay on this device in IndexedDB and are never uploaded. Supported games and their current limits
are documented in the [Native import guides](../../Native/docs/README.md#game-imports).
Older cached courses may need reloading for newly supported channels. A scan can also repair old
collision-sound metadata without replacing the cached course assets.

A game's three-dot menu manages its saved image and loaded courses:

- **Refresh image** rescans course names and inventory without re-extracting loaded courses.
- **Remove image…** forgets the source image and keeps imported courses playable.
- **Unload game…** removes that game's saved image and imported courses after confirmation.
- A course's **Unload** removes just that imported course. **Device storage** offers broader cleanup.

If only imported courses remain, the game's Load action can restore the source image.
Browser storage may also evict local data, so retain your source image separately.

Custom mountains that borrow game assets can be labelled **ISO optional**. They still play without
those assets: missing game textures become plain surfaces and missing props are omitted. Custom
textures, models and uploaded skies remain available. The requirements display identifies donor
maps; loading those maps restores the borrowed assets locally. A sky that borrows only an export
ring does not need an ISO label; see the [sky export contract](025-skybox.md#export-contract).

For server-side reference folders produced by Snowknife, follow the
[import-to-browser guide](../../Snowknife/docs/browser-play.md). No glTF step is needed.
In the editor, choose **Scene → Reference**, load the map, then choose **Test → Reference → Play**.
References remain read-only; see [authored map references](036-authored-map-references.md).

## Export for another tool

The map row's **Export…** menu is available for authored mountains and loaded game courses.
For an editable backup, choose **Another Slopesmith instance**. To build a custom disc or mod,
choose **Snowknife — Custom ISO** or **Snowknife — Mod Manager**. These download a
`.snowknife.zip` with portable map data, provenance and build instructions. Imported courses
export their portable map files.

Snowknife accepts the `.snowknife.zip` directly for `repack` and `texture-plan`. Follow
[REPACK.md](../../Snowknife/REPACK.md), including the special rules for
[GBA courses](../../Snowknife/REPACK.md#gba-courses-exported-by-slopesmith).
For Blender or Unity, extract the Snowknife ZIP to a portable map folder, then follow the
[Blender instructions](../../Blender/README.md) or [Unity setup guide](../../Unity/README.md).
See [export preflight](011-export-target.md) and the [export contract](003-export-contract.md)
for file layout, coordinates and downstream requirements.

## Publish and ride together

Server maps start private. An owner or moderator can use **Users → Map permissions → share publicly**
to make an editable mountain available for guest riding. **Copy public link** opens it at
`/play/<mountain-name>` without requiring sign-in or a rider name. Private or deleted links show
an unavailable message. Public reference listings are managed separately; their menu is currently hidden.

Guests can ride with members, share world interactions and join server chat. Their local editor
does not connect to a server editing session. Server project editing and private-map access require
membership and the relevant permissions. Public reference listings expose names and slots; they
do not distribute retail terrain or art. Each visitor supplies their own image for disc courses.
Unpublishing removes the server listing and closes its guest sessions; a visitor's local disc
courses and their shared riding rooms remain available.

Public mountains omit imported retail effect graphs. A reference export mixing authored and
retail files must be shared through its editable mountain, where those sources can be separated.
See [hosted sessions](038-hosted-sessions.md) for permissions and content handling, and
[multiplayer setup](../multiplayer/README.md) for riding rooms and service limits.

Click the online-user count to open **Users / Chat**, then choose **Join chat** (or **Join as**
for an account). Closing the panel keeps the chat session joined; **Leave chat** ends it.
Map links in the user list preserve the map source and play room. During an editor Test ride,
**Enter** focuses chat; sending or pressing **Escape** returns the keyboard to riding.

Optional [voice chat](048-voice-chat.md) and the [Jukebox](063-video-bridge.md) have separate guides.
Jukebox playback starts off; enable it in **Users → Jukebox**. Queue and timing are shared,
while volume and mute stay local. YouTube panel playback needs no media-server setup;
putting video on course screens uses the optional local media server.

## Use Slopesmith offline in Chrome

1. Open the production site while connected. Open its info panel and wait for **Ready for offline use**.
2. Load the courses you want on this device. For a server mountain, use
   **File → Save offline copy…** while connected to create an independent browser copy with its assets.
3. Reopen the same site or installed Chrome app without internet. Local mountains offer **Play**
   and **Edit**; loaded game courses remain playable. Direct local editor and player links also work.

ISO scanning and extraction work offline once the app is prepared. Local ZIP imports and folder
copies need no server. Keep an editable ZIP or folder backup separately from browser storage.
Multiplayer, chat and server tools require a connection; live player status reconnects when it returns.
Reopen the site to switch back to a server workspace.

Offline support requires HTTPS (localhost also works) and a production build. The development
server does not register a service worker. The worker caches versioned app chunks, built-in riders
and importer WASM; it does not cache account responses, project APIs or retail files. Projects and
image data remain in their existing IndexedDB stores.

Updates prepare in the background. Open tabs keep their current assets and show **Reload to update**
when a complete release is ready. Finish open dialogs and drafts, and finish or cancel image imports,
then use that action to save the current mountain and folder copy before reloading. Other tabs keep
running, and saved mountains and image data remain on the device.
