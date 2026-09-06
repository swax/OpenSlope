# 038 — Hosted servers

How several people edit maps together, and how one person edits from several machines. The design in two
lines: **the browser is the client and talks to exactly one server**, and **a member is a username and a
password, usable from any machine.** There is no local install in the path and no peer-to-peer transport.

`037` is what makes this possible: once the browser assembles the map folder itself and discs are built by
`snowknife`, nothing about export needs a local process, so the browser can be the whole client. How several
people edit at once once connected is `039`; going back when something goes wrong is `040`.

## The shape

```
browser ──HTTPS + WebSocket──▶ slopesmith server
                                 ├── projects, revisions, checkpoints
                                 ├── assets — textures, props, models, sounds, music
                                 ├── users, sessions, invites
                                 └── presence, write leases, chat
```

Running Slopesmith locally is one of these, not a different thing: the service on `127.0.0.1` owning the
workspace folder it already owns. Editing alone means being the only member of a server that happens to be
yours.

## Why the browser talks straight to the server

The alternative is a local Slopesmith acting as the client and federating upward, so each participant keeps a
durable replica. It buys one real thing — working while the server is down — and costs a whole architecture:
a second process to install and keep running, a local API that has to be authenticated once it is no longer
alone on the machine, and an offline divergence path that has to be resolved on reconnect.

That trade only made sense while export needed a local disk. It no longer does.

## One kind of project

There is no local project and no server project. **Every project belongs to a server**, and editing alone
means the server is the one on your own machine. This is the simplification everything else follows from, and
it is mostly a distinction being deleted rather than machinery being built: `slopesmith serve` already owns
the workspace, the revisions and the checkpoints, and the browser already reaches them over HTTP.

Two kinds of project would have meant two storage paths, two histories, and every feature working twice — a
second shape to get right and a second shape to regress. One kind costs a running loopback service to edit,
which is what `npm run dev` already starts, and which autosave already depends on.

A browser profile with no remembered active project does not imply an empty server. If the server has one
project, a fresh phone or computer opens it; if it has several, the editor requires an explicit choice. Only
a genuinely empty server turns that browser's recovery document into a new project.

**Every route sees a member.** The one branch in the whole design is where that member comes from: a server
configured for accounts resolves a session, and a server that is not injects its owner with the admin role.
Downstream of that single function nothing asks whether accounts are switched on, so a route is written once
and a new one is closed by default rather than open by default. Alone at a loopback server there is no login,
no account file and no enrolment step — and no second code path either.

The one rule that outranks the rest: **the auth layer must never be able to lock you out of your own files.**
Failing to resolve a member on a server with no accounts configured means editing as the owner. It never
means refusing to open a project.

That owner identity is safe only on loopback. An account-free server refuses a non-loopback bind unless the
operator supplies the deliberately alarming `--unsafe-open-network` escape hatch; the normal network shape is
`--accounts`, with TLS (usually through `--behind-proxy`) for every password-bearing request.

Moving a mountain between servers is a file transfer, not a handshake, and the local service is simply the
`127.0.0.1` one. **Export mountain** takes the current durable revision and its custom assets as a
`.slopesmith.zip`; **Import mountain** asks for the destination name, creates a fresh project on another server,
and switches the editor to it. **Duplicate mountain** asks for the copy's name and follows the same creation path.
Custom assets ride along by content hash: a direct server transfer can send a manifest first, let the receiver
name the hashes it lacks, and send only those bytes. A file archive is self-contained so it remains usable when
the source server is offline.

A remote server being down means its maps wait until it is back. That is the honest price of having no
replica, and it buys the deletion of the entire reconnect-conflict path.

## Accounts

Everything here applies to a server **configured to require accounts**. One that is not serves its owner and
asks nothing, which is what editing alone looks like — the difference is the single function that resolves a
member, never a second path through the routes below it.

An **invite link** is the only way in. A moderator gives each single-use link a private **invite handle** such
as `discord:joe123` or `email:joe@example.com`, recording who they meant to invite and where they contacted
them. Redemption attaches that handle to the new account, but never shows it to the member; only moderators
can see or change it. The member chooses their public username and password, and that pair works from any
machine — no per-device enrolment, nothing to move between computers. They may later change the username in
Settings without changing the account's stable identity.

What the server stores is a username, an invite handle, a password hash, and a role. Five properties keep that
from becoming a liability, and each is cheap:

- **HTTPS is required, not recommended.** A password to a VPS over plain HTTP is the actual exposure in this
  design, so the server refuses to accept a login over a non-secure origin rather than leaving the shortcut
  available. A reverse proxy terminating TLS is the expected deployment.
- **argon2id** (or scrypt) password hashing. The server holds nothing recoverable; an admin can disable an
  account or force a reset, never read a password.
- **Opaque server-side sessions** in httpOnly cookies. That is what makes "sign out everywhere" and a role
  change take effect immediately instead of whenever a token happens to expire. HTTP use slides both the
  server expiry and the browser cookie, an open editor periodically renews it, and revocation or a role change
  closes already-open WebSockets too. The channel also rechecks the account file so a separate CLI process
  cannot leave captured authority alive.
- **Personal access keys** for programs that are not browsers — the Blender add-on
  ([046](046-blender-bridge.md)). Same digest-only storage, same per-request role resolution, same
  immediate revocation; what differs is that a key gets its own identity kind, so it cannot open the session
  channel, cannot mint another key, and can never satisfy the admin role however senior its owner is. A key
  authors; it does not administer.
- **Rate-limited login and redemption**, with failures logged. The three routes that establish a session —
  enrolling the first admin, redeeming an invite, signing in — are the only ones that answer without one.
  Everything else, signing out and changing a password included, asks for a session like any other route.

Users change their own password. Losing one is an admin reset, which is a duty a purely local tool does not
have — see *Costs*.

### The login page

A server that requires accounts answers a browser it does not know with a **login page**, not with the editor
and a dialog over it. That is a property of the boot order rather than of the UI: `index.html` names
`src/app/boot.ts`, which asks `/api/auth/session` who this browser is and only then imports the editor —
importing `main.ts` IS booting it, so the question cannot be asked afterwards. Somebody who cannot use this
server therefore never downloads the editor, never watches every library it opens come back 401, and is not
looking at a map behind a form that they may not have.

The gate has three properties worth stating, because each is a way it could be wrong:

- **A failed probe means "no accounts".** An API that answers nothing is read as a server that never asked for
  one, which costs an editor whose requests are refused and say so. The other reading — a password prompt in
  front of somebody's own workspace, with nothing behind it a password would open — is the same lockout the
  identity layer is forbidden to cause, so the asymmetry is deliberate.
- **A password accepted here does not reload.** The editor has not booted, so there is nothing stale to throw
  away: the member the server just returned becomes this browser's account and the editor starts on top of it.
- **The cost is one round trip** before the editor's bytes are requested, paid on every load including by the
  owner of a loopback server who will never see a login page. On that server the route resolves nothing and
  touches no file, so what is spent is a round trip rather than work.

Getting IN lives entirely on that page — enrol, redeem, sign in. The upper-right toolbar button is only the
member's username; its menu opens **My profile**, **Settings**, or **Sign out**. Settings' Account page owns
the public username, profile picture and optional 500-character bio, this browser's device name, password
changes, access keys, and signing out every device.
The same Settings dialog also remains in File so it is reachable from either end of the toolbar.

### Invites

The server mints a random token, stores only its hash, and records who minted it, the role it grants, and an
expiry (a week by default). Redemption creates the user and marks the invite spent.

The honest security property: **the link is the credential until it is redeemed, and worthless afterwards.**
Anyone holding it can redeem it, so single use plus a short expiry is what makes a leaked link a bounded
problem — the intended person finds it already spent and says so immediately. Unredeemed invites left lying
around are the actual risk, which is why they expire by default rather than on request.

Because the role and private handle travel with the token, "here is the editor link for the person I know as
discord:joe123" is one action rather than invite-then-identify-then-grant. Every link is single-use, keeping
the intended person and resulting account unambiguous.

**First run.** The server prints a one-time admin-enrolment code to its log and refuses every other request
until it is redeemed. There is no default password and no window in which whoever finds the URL becomes admin.
A CLI flag regenerates the code.

## Roles

Four roles remain the server-wide floor, with a deliberately small per-map layer: the creator is recorded as
owner, and an owner may replace "all editors" with an allow-list of editor account ids.

- **Admin** — manages the server and privileged accounts and has the moderator override on every mountain.
- **Moderator** — retains editor access, manages/renames/deletes any mountain, mints viewer/editor invites, switches
  viewer/editor accounts between those roles, and disables or re-enables them. Moderator and admin accounts
  are outside their reach.
- **Editor** — may create/import/duplicate a mountain and becomes its owner. They edit every unrestricted map,
  plus restricted maps whose owner selected them.
- **Viewer** — follows read-only.

Every map remains visible to every member. Ownership grants rename, delete, and permission management; a
moderator/admin can do those things on any map. Editing is unrestricted by default. A restricted map admits its
owner, selected editor ids, and moderator/admin overrides, while the server role remains the floor — selecting a
viewer does not turn them into an editor. This is editing policy, not privacy; private map visibility would still
be a separate flag enforced at map-open.

## Assets, and what the server holds

There is no transferable/non-transferable boundary. A server holds whatever its operator put on it, including
extracted retail data if they want authors to place retail props and tiles, and every member resolves assets
from that one library — so everyone sees the same map, and the "who is missing which level" diagnostic has
nothing to report.

Two properties make that a reasonable place to land:

- **A server is private and invite-only.** There is no anonymous access and no public listing.
- **A server cannot build a disc or an export.** After `037` this is structural rather than a policy: the
  export path lives in the client and disc packing lives in `snowknife`, so there is no code on the server that
  could produce either.

Catalogue mutations are pushed over the session channel. Other open devices refetch authored textures,
props, characters, sounds, music, or skies without needing a page reload; immutable asset byte URLs retain
their ordinary cache lifetime.

The long-term direction is that authored maps and authored assets are the normal case and retail data is
reference and history, which is the same place a wire boundary was trying to reach — without provenance
stamping every import, auditing every upload path, and reporting what was withheld.

### Map origin

What that paragraph rules out is a per-asset audit. What did land is narrower and purely descriptive: every
map folder says what it is, and the editor shows it. There is no per-member gate on the reference library —
what a server holds and who it serves are its operator's decisions, and the origin record is what makes them
informed ones rather than something the software pretends to police.

It rests on two facts recorded per map folder, in an `Origin.json` beside the geometry
(`Snowknife/schemas/course/origin-v1.schema.json`, written by both producers):

| | `Origin` | `RetailData` |
|---|---|---|
| `snowknife import` of a course | `retail` (with the `Course` slot) | always true |
| a Slopesmith export | `slopesmith` | whatever `classifyExportProvenance` found |

They are separate questions on purpose. An authored mountain that places one borrowed tree is `slopesmith`
**and** retail, and that pair is the whole reason a single boolean would not do. Only the `retail-` half of
the export's provenance reasons travels: a `user-` reason is a rights question with its own answer
(`--confirm-rights` on `snowknife unity --public`), not a statement about the game.

A folder with no `Origin.json` is read as retail. That is the conservative direction and it is what every
library extracted before this contract existed looks like — an export manifest still identifies its folder as
authored, and one written before the provenance guard is treated as carrying data rather than as clean.

`/api/levels` carries each map's summary — `origin`, `course`, `retailData`, `reasons` — and the Scene
toolbox's Reference picker shows it as an **origin** row under the loaded mountain: *SSX Tricky extract ·
GARI*, *authored in Slopesmith · no retail data*, *authored in Slopesmith · borrows retail prop-art, sky*, or
the honest fallbacks for an unclassified legacy export and an unidentified folder. Nothing about rendering or
export reads it; it is there so the person looking at a reference knows what they are looking at.

### Names never overwrite

Uploading anything whose name is already taken — a texture, a sound, a sky, an imported prop, a map — stores
it beside the original as `name_2`, never over it, and the uploader is told which name it landed under.

Deleting an asset **retires** its name instead of returning it to the pool. Each library keeps a list of its
retired stems beside itself, and an upload called `snow` after `snow` was deleted lands as `snow_2`, exactly as
it would have while the original was still there. A reissued name is a URL that answers with different bytes
than it did yesterday — the very thing immutable names exist to rule out — so names never overwrite and names
are never reused. Rename and Replace free a name the same way and retire it the same way.

A retired name is taken by everything **else** in its library, and free to the thing that retired it. Handing a
name back to what gave it up names the same bytes it always did, so nothing is reissued — and without that
nothing could ever return to a name it has passed through, which is what a map restored to a revision authored
under an older name needs. It is also what keeps restoring the same checkpoint twice from walking the name up
a suffix each time.

This is the one rule that makes a shared library safe, and it removes more than it adds:

- **Asset URLs become immutable**, so the content-revision cache-busting in `net/asset-paths.ts` has nothing
  left to bust — a ref names bytes that cannot change. `setAssetRevision` and its call sites go with it.
- **History stops lying at the source.** `040` needs a checkpoint to know which assets it was authored
  against, because art overwritten in place makes last week's document render in this week's textures.
  Immutable names make that true by construction instead of recording hashes to detect the drift afterwards.
- **What it costs** is the deliberate re-upload loop. Overwrite-by-name is a documented contract today
  (`server/routes/textures.ts`: re-loading art updates every model and painted cell wearing the ref), and it
  is genuinely useful while iterating on one tile. That case keeps an explicit **Replace** action on the asset
  itself — one that names what it will affect, announces it in the feed, and is refused to anyone without the
  editor role. Accidental collisions get `_2`; deliberate replacement stays possible and stays visible.

With names immutable, **the `035` asset migration stops being load-bearing** — the collision it was needed to
prevent cannot happen. It stays worth doing for scope rather than correctness: a library that accumulates
across every map on a server is one nobody can browse, deleting a map should reclaim its art, and downloading
a map should be able to bring its assets with it.

## Sessions, authority, revisions

The server is the authority for the maps it holds, in a star: it orders accepted edits, advances the revision,
and broadcasts. Ordering is free because there is exactly one applier.

- **Presence.** `mapId → [{userId, sessionId, deviceLabel, lastSeen}]`, TTL'd, pushed to every client. It is
  keyed by session and displayed by user, because one person may have two tabs or devices open. The label is
  browser-local (computer/phone/tablet by default and editable in the account panel). Opening the same map as
  the same account twice warns that changes are live and Undo can reassert a value the other device changed.
  Presence never enters
  `mountain.slope.json`. The per-client active project already exists (`server/projects.ts` —
  `clients[clientId].activeProjectId`), so "which map is this person on" reads off something real.
- **Write lease.** One writer at a time to begin with: first claim holds the pen, heartbeat-renewed, released
  on close or idle, takeable with a confirmation once expired. Everyone else follows read-only and applies
  pushed revisions as a whole-document replace — safe by construction, and exactly what `accept()` in
  `project-sync.ts` already does, triggered by a push instead of a response. Following resets undo history,
  the same rule project switching uses.
- **No offline path.** A disconnected client is a disconnected client: it stops holding the lease and rejoins
  at the current revision. There is no second revision line, so there is nothing to reconcile.

Concurrent editing (`039`) replaces the single lease with per-register sequencing. Its prerequisite is stable
vertex and quad ids in the document, which is naturally assigned the first time a map is uploaded.

## Users mode and chat

**Users** is its own mode, reached from a toolbar button beside the numbered mode row rather than inside it —
it is about the server rather than about the map, and it should not consume a mode number or a shortcut digit.
The right dock is already mode-owned (`ui/chrome/tools-panel.ts` swaps its content per mode and hides it in
Scene), so the user list simply takes the dock while the mode is active.

The list shows every member of the server, not only the connected ones. Connected members are grouped under
Admin, Moderator, Editor, and Viewer headings in that order, followed by one Offline section for everyone
who is disconnected. Each row shows the username and effective status: Online (green), automatically Idle
after five minutes without browser input (yellow), manually Away (orange), manually Do Not Disturb (red), or
Offline (gray). Available/Away/Do Not Disturb is an account preference selected at the top of Users; Away and
Do Not Disturb stay set until changed. Idle is ephemeral per browser tab, and a member becomes Idle only when
all of their connected tabs are idle. A disconnected member always appears Offline while retaining the manual
preference for their next connection. Status is initially informational: it does not hide maps, stop voice,
or change collaboration permissions. For anyone connected, each row also shows which authored map and
Reference mountain each tab has open. Clicking a username or
picture opens a compact profile with the member's picture, bio, role, joined date, status, last-seen time, and a
comma-separated list of the devices currently detected for them. A
moderator also sees the private invite handle there and can correct it; ordinary members never receive that
field from the server. Each row's options menu also opens that profile; for another connected member it can
open a private message or go to their live avatar, opening their map if necessary and placing the camera four
metres in front of them facing back at them. A live avatar carries the account username, centred above their
head without the device label; each new visible chat line appears above it in a speech bubble for six seconds.
Open maps appear as
`map / reference`: clicking the map opens it, while clicking the reference loads it into this tab's read-only
Reference slot. A green play icon appears immediately before whichever name one of the member's tabs is
actively playing — authored map or Reference mountain; merely opening Test setup or watching AI riders does
not count.
The creator of the open map carries an **owner** badge. A **Map permissions** panel sits
directly above the list: owner/moderator controls
switch the map between all editors and a selected editor allow-list, so the people being granted access remain
visible beside the policy.

**Chat** is a bottom-left box in the shape game chat converged on — recent lines fade out over the viewport, a key opens
the input, and scrollback is there when you want it. It is **server-wide**, because a crew this size is one
room, and it carries **system events in the same stream** rather than a separate log: *"Jed took the pen"*,
*"Alice restored the checkpoint from 14:02"*, *"Bob created MOUNTAIN01"* and *"back in 10, don't touch the
halfpipe"* are the same question answered. System events are generated by the server, so they are facts rather
than something a client can claim. The last few hundred lines are retained and replayed on join.

Chat takes focus explicitly — a shortcut opens it, and clicking the box does too — and while it holds focus
**every editor shortcut is suppressed.** This is the rule that bites immediately if it is missed: the editor
binds bare single keys for modes and tools, so a chat box that is typed into without holding focus turns a
sentence into a burst of mode switches. A **Text chat** launcher above voice in Users opens and focuses this
same lower-left box; it is a second way into the room, not a second chat surface. Escape closes it and returns
the keys to the viewport.

The room is global, and two slash commands cover the rest: `/msg <user> <text>` sends a private line and
`/r <text>` replies to whoever messaged you last. Private messages are drawn distinctly from room traffic so
the two are never mistaken for each other, and they are relayed and retained by the server like any other
message — private from other members, not from whoever runs the machine. Worth saying once in the interface
rather than leaving people to assume otherwise.

## Management surface

The CLI is the source of truth and always works, including when nothing can connect: mint an invite, list
users, disable an account, reset a password, list and delete maps. Account actions sit inside each profile in
Users mode, with the editable role presented as one dropdown rather than a row of role buttons. Ordinary
invites, roles, and account access are available to moderators and the rest remains behind the admin role.
Actions on the open project sit together under File → `<mountain name>`; Rename and Delete Mountain belong to
its owner or a moderator, and deletion carries an explicit destructive confirmation. Changing your own role or disabling yourself remains the CLI's, since
a panel inside the editor is the wrong place to lock yourself out of it.

## Costs

- **The server holds people's work**, so hosting one carries backup, retention (`040`) and account-recovery
  duties a purely local tool does not.
- **Editing needs a service running.** One kind of project means the loopback service is in the path even when
  nobody else is. `npm run dev` starts it, and autosave already depended on it, so the change is that a
  project cannot be opened without it rather than merely not saved.
- **A remote server's maps need that server.** Accepted deliberately, and the price of having no replica.
- **Every route is written against a member**, so the injected-owner path is load-bearing rather than a
  convenience. Its failure mode must be *edit as owner*, never *refuse the project* — a bug there locks an
  author out of their own files, which no other bug in this design can do.
- **Do not point two machines at one synced workspace folder.** Putting a workspace on OneDrive or Dropbox is
  the other way people will try to solve this, and it corrupts projects: `snapshotFromDirectory` reads
  half-synced files as external edits and bumps revisions under them. The supported answer is a server.

## Staged path

The conflict dialog and history panel (`040`), the standalone service, immutable asset names, the session
channel — map listing, upload and download, presence, the write lease and following — and Users mode with the
room are built. What is left, in order:

1. **Project-owned assets** (`035`) — scoping and reclamation, once one shared library is too big to browse.
2. **Concurrent editing** (`039`) — stable ids, independently versioned registers, server sequencing. Its two
   standing prerequisites are incremental rebuild instead of re-tessellating on every remote change, and
   per-participant undo.

A broadcast when a new asset name appears, so other clients refresh their library lists, rides the same
channel as presence — immutable names already removed the stale-bytes half of that problem, leaving only a
list refresh.
