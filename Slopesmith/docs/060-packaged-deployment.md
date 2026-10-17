# 060 — Packaged Slopesmith deployment

Slopesmith is one versioned software release with two independently supervised processes: the Node API and
the Rust play relay. A release also contains the browser frontend, the exact Node 24 runtime, production npm
dependencies, protocol metadata, and distribution notices. LiveKit is an optional, independently upgraded
voice dependency. Caddy is shared host infrastructure and is configured separately from application updates.

This replaces the source-building deployment helper. It does not automatically convert an existing Apache
installation to Caddy. The live molten installation must be migrated deliberately after package verification.

## Build and publish

Build on the target architecture. The initial release workflow uses Ubuntu 22.04 x64, matching molten's
glibc baseline. The packager also recognizes Linux arm64, but that platform needs its own native build and
verification before publishing. Production hosts need Python 3.10+, OpenSSL with Ed25519 support and systemd;
they do not need npm, Cargo, a compiler or Git to install application updates.

From a reviewed checkout on the Linux build machine:

```sh
cd Slopesmith
npm ci
npm run typecheck
npm run lint
npm run release:test
npm run multiplayer:test
npm run build
npm run multiplayer:build
npm run release:package -- --revision "$(git rev-parse HEAD)"
```

The package command uses existing build output. CI performs the build and checks first. It copies only the
compiled frontend/API, resolved production dependency closure, runtime, Rust binary and notices, and an
explicit list of deployment files. Workspaces, map libraries, credentials and source-checkout build caches
are outside the package. Node's runtime license is copied from its distribution; use `--node-license <path>`
if the build machine installed that license elsewhere.

`temp/releases/` receives a versioned `.tar.gz` and JSON manifest. The manifest contains every payload file's
size, mode and SHA-256, aggregate API/frontend and multiplayer digests, exact source commit/runtime versions,
protocol versions, data-format generation and archive checksum. Tar metadata and gzip timestamps are
normalized. Builds must be performed on the target OS/architecture because npm includes native dependencies.

The **Package Slopesmith** GitHub workflow accepts only a full commit reachable from `main`. It runs source
checks, builds the Linux bundle, extracts it and exercises the bundled runtime against real API/editor/play
sockets in a temporary workspace. Building defaults to uploading CI artifacts only. Publishing requires the
explicit `publish` input and the `slopesmith-release` GitHub environment.

Create an Ed25519 publisher identity on a trusted administration machine, outside the repository:

```sh
openssl genpkey -algorithm ED25519 -out /secure/slopesmith-release.key
openssl pkey -in /secure/slopesmith-release.key -pubout -out publisher.pem
```

Store the private PEM as `SLOPESMITH_RELEASE_SIGNING_KEY` in that protected GitHub environment. Configure its
deployment policy/reviewers for whoever may publish software to your servers. Deliver the public key to
operators through a separately authenticated channel and compare its fingerprint. The application never
receives the signing key. Forks use their own workflow, publisher key and release-feed URL.

Publishing signs the versioned manifest and uploads immutable versioned assets to the `slopesmith-channel`
GitHub Release. The latest pointer is one JSON envelope containing the manifest and detached signature, so
readers never combine metadata from one publication with a signature from another. Versioned assets are not
overwritten. A partial publication does not advance latest; inspect and repair it before retrying publication.

An alternative HTTPS object store can serve the same flat filenames. The first implementation supports
public HTTPS feeds; private-feed authentication and automatic publisher-key rotation require separate work.

Manual signing uses the same implementation:

```sh
python3 deploy/release_manager.py sign temp/releases/slopesmith-<commit>-linux-x64.json /secure/slopesmith-release.key --latest
python3 deploy/release_manager.py verify temp/releases/slopesmith-<commit>-linux-x64.json publisher.pem
```

## Prepare the host

Obtain the deployment tooling from a reviewed source revision. This is the one-time host trust bootstrap;
automatic application updates never replace the privileged updater or service definitions themselves.

```sh
sudo python3 deploy/release_manager.py install \
  --feed https://github.com/swax/OpenSlope/releases/download/slopesmith-channel/ \
  --public-key /path/to/verified-publisher.pem \
  --domain snow.example.com \
  --revision <40-character-published-commit>
```

Preparation verifies the publisher's metadata before writing machine settings. It installs:

| Path | Ownership and purpose |
| --- | --- |
| `/opt/slopesmith/releases/<commit>/` | Immutable software, root-owned |
| `/opt/slopesmith/current` | Atomic selected-release link |
| `/etc/slopesmith-update.json` | Root-only feed and publisher-key policy |
| `/etc/slopesmith/release-publisher.pem` | Operator-pinned publisher public key |
| `/etc/slopesmith.env` | API paths, hostname and machine settings |
| `/etc/slopesmith-multiplayer.env` | Persistent shared admission secret and loopback relay URL |
| `/srv/slopesmith/workspace/` | Accounts, projects, assets and checkpoints |
| `/srv/slopesmith/maps/` | Separately populated map library |
| `/var/lib/slopesmith-update/` | Root-owned update state; only its inbox is writable by the API |
| `/usr/local/lib/slopesmith/` | Reviewed privileged updater and API launcher |

Existing environment files, admission secrets and content are preserved. The installer generates the admission
secret only once and never prints it. Retain it through upgrades: guest cookie signing is derived from it.
The current package reserves loopback ports 5180 for Node and 5181 for Rust. Additional instances require
separate paths, unit names and port configuration; this installer manages one Slopesmith installation.

`slopesmith.target` groups the API and relay; `slopesmith.slice` accounts their resource use. Operators can
add memory/CPU budgets through systemd drop-ins appropriate to the shared host. LiveKit's supplied installer
also assigns it to the slice, while voice upgrades/restarts remain separate from application activation.

Host prerequisites and service definitions are installed once. Routine updates never change Caddy, other
applications, firewall rules or persistent storage. Package updates refuse a data-format generation change;
they do not execute automatic data migrations. Back up and perform an explicit migration before changing
that compatibility boundary or updating the privileged deployment tooling.

## Routing and activation

Preparation writes `/etc/slopesmith/slopesmith.caddy` for review. With `--proxy caddy`, it writes the app's own
`/etc/caddy/sites.d/slopesmith.caddy`. If that file has local edits, the installer writes a `.candidate` file
instead of replacing them. The host's Caddyfile needs `import sites.d/*.caddy`. Validate the complete host
configuration and reload Caddy as a separate operator action. Normal application updates do not reload it.

Preserve this routing contract with Caddy, Apache or another existing edge:

| Path | Destination |
| --- | --- |
| `/api/play/session` | Rust `127.0.0.1:5181`, WebSocket upgrades |
| Remaining `/api/*` | Node `127.0.0.1:5180`, including editor and voice-signaling sockets |
| Static files and browser routes | `/opt/slopesmith/current/dist`, SPA fallback and cache policy |

LiveKit media uses its separate WebRTC ports. Keep its current firewall rules and service during the web
proxy migration. Slopesmith's API and relay ports must remain inaccessible from the public network.

Preparation does not restart the running application. Once routing, backups and settings are reviewed,
repeat the install command with `--activate`. On an existing source-built installation also add
`--adopt-existing`; take a consistent backup first. The API launcher retains `/opt/node24/bin/node` as a
rollback bridge for the previous source-built release, while packaged releases use their bundled runtime.
Do not remove that older runtime until the rollback window has closed.

If local LiveKit is configured, add `--voice-local` to include its loopback readiness endpoint in activation
checks. Install/update LiveKit separately with the existing reviewed `install-livekit.sh` procedure. Its
version is recorded in the release manifest; it is not restarted or automatically replaced by app updates.

## Updates and rollback

An administrator can continue using **Settings → Server**, or an operator can select a published commit:

```sh
sudo deploy-slopesmith <40-character-published-commit>
```

The updater resolves latest through the signed release channel rather than the Git branch tip. The web
process may request only a full commit; it cannot choose a feed, publisher key, shell command or archive URL.
The root-owned policy selects the source. Both direct and queued updates use the same deployment lock.

Before stopping anything, the updater verifies the signature, architecture, protocol/data-format boundaries,
archive checksum and inventory, and runs the packaged CLI as the unprivileged application user. Extraction
rejects links, traversal, duplicate paths, unexpected files, unsupported modes and oversized payloads.
Cached releases are checked again before reuse. No scripts from a candidate package run as root.

For a changed API/frontend/runtime it checkpoints and stops Node before selecting the new release. A changed
relay is stopped separately; unchanged components stay running. Readiness checks cover API, relay, and
explicitly configured local voice. A failed start/check restores the previous pointer and affected services;
other applications and LiveKit remain running. Node updates require editor reconnects because the live room
state belongs to that process. Compatible relay-only updates leave the Node editor process running.

Root publishes the selected release to `active.json`, so Settings reports the whole installation correctly
even when an identical API process survives a relay-only update. Queue status remains in `status.json` and
deployment diagnostics go to the systemd journal:

```sh
systemctl status slopesmith slopesmith-multiplayer slopesmith-update.path --no-pager
journalctl -u slopesmith-update -u slopesmith -u slopesmith-multiplayer -n 100 --no-pager
```

Rollback selects an older signed, compatible release with the same command. It changes software, not user
data. Initial legacy adoption is the only exception to the manifest requirement and must be requested by a
root operator, never by a browser update request. There is no automatic release pruning in this first version;
keep at least the previous known-good release and remove old inactive versions only after checking them.

Back up `/srv/slopesmith`, `/etc/slopesmith.env`, `/etc/slopesmith-multiplayer.env`, `/etc/slopesmith/`,
`/etc/slopesmith-update.json`, optional `/etc/livekit/`, and host proxy configuration. Test a restore to a
separate environment. Archives and signatures are downloadable software; backups contain private state.
