# 041 — Production deployment

Slopesmith is a stateful, single-process collaboration service. A small Linux VM is the intended production
shape: Apache or Caddy serves the static editor and terminates TLS, one Node process owns `/api` and every
WebSocket, and the workspace and reference map library live on persistent local SSD storage.

This guide follows an audited production deployment as of 2026-08-21: a DigitalOcean Droplet running Ubuntu
22.04 LTS, Apache, Node 24, LiveKit and systemd. Ubuntu 24.04 and Caddy remain supported choices; their
differences are called out instead of being mixed into the reference commands.

## Reference deployment

The live host gives this guide a concrete baseline rather than a hypothetical layout:

| Component | Reference host |
|---|---|
| VM | 2 vCPUs, 4 GiB RAM, 80 GiB local SSD |
| Public edge | Apache on TCP 80/443; HTTP redirects to HTTPS |
| Slopesmith | one `slopesmith.service`, Node 24, `127.0.0.1:5180` |
| Releases | root-owned `/opt/slopesmith/releases/<commit>` selected by `/opt/slopesmith/current` |
| Durable state | `/srv/slopesmith/workspace` and `/srv/slopesmith/maps` |
| Updates | root-owned deploy helper plus `slopesmith-update.path` |
| Voice | separate `livekit-server.service`; signaling on loopback, WebRTC on its dedicated media ports |

The audit deliberately does not read secret environment files. Provider firewall rules, DNS ownership and
provider-level backups must be verified in their own control planes; a running unit does not prove those
external controls exist.

## Capacity

Start with a **Basic 2-vCPU / 4-GiB Droplet** for roughly 25 registered or concurrently connected users. Choose
a Premium AMD/NVMe Basic CPU when it is available at a reasonable regional price. Slopesmith renders terrain,
physics and the ride in each browser; the service handles files, collaboration, compression and occasional
CPU-heavy reference builds.

Do not start on one vCPU. A cold reference build and a durable document snapshot intentionally use separate
workers so the former cannot postpone the latter. Four GiB leaves room for the 256-MiB response cache, worker
isolates, native image processing and temporary copies of uploaded assets.

Move to 4 vCPUs / 8 GiB when measurements show one of these at the expected peak:

- CPU remains above 70% or shared-CPU latency is visibly variable;
- event-loop p95 repeatedly exceeds 100 ms;
- API p95 exceeds 500 ms outside a known cold reference build;
- RSS approaches 3 GiB, or the VM swaps;
- several users commonly open different uncached reference levels at once.

If only CPU consistency is poor and memory stays comfortably below 4 GiB, compare a 2-vCPU CPU-Optimized
Droplet before doubling both CPU and memory. DigitalOcean supports resizing a Droplet upward.

Choose a region near the majority of editors. Cursor and edit traffic is small, so network round-trip latency
usually matters more than bandwidth.

## One process is a correctness requirement

Run exactly one Slopesmith API process. Do not enable Node cluster mode, PM2 cluster mode, multiple containers,
or a load-balanced replica.

The process owns each live room's authoritative document, sequence, presence table, awareness batches and
WebSocket fan-out. Splitting participants across processes would create separate rooms bearing the same project
id. Horizontal scaling first requires an external room sequencer/pub-sub layer and a shared durable store; that
is not part of the current architecture. Worker threads already provide bounded CPU parallelism inside the one
correct process.

## Host and directory layout

Create the Droplet with SSH keys, monitoring and IPv6 enabled. Point an `A`/`AAAA` record such as
`slopesmith.example.com` at it. In both the DigitalOcean Cloud Firewall and the host firewall, allow:

- TCP 80 and 443 from everywhere;
- the chosen SSH port only from administrator addresses;
- no public access to 5179, 5180 or LiveKit's loopback signaling port 7880;
- when voice is installed, the media ports listed in [048 — Voice Chat](048-voice-chat.md).

Install Node 24 LTS from an official distribution. Avoid an interactive `nvm` installation for a system
service: the unit and deploy helpers need the same stable absolute path. The reference host keeps a versioned
installation behind `/opt/node24`:

```sh
/opt/node24/bin/node --version
/opt/node24/bin/npm --version
readlink -f /opt/node24
```

The supplied service and deployment helpers use `/opt/node24/bin`. If Node lives elsewhere, change
`deploy/slopesmith.service`, `deploy/deploy-slopesmith` and `deploy/slopesmith-update-runner` together.

Use immutable application files and a separate mutable state tree. This is the live layout:

```text
/opt/node24 -> <versioned Node 24 installation>
/opt/slopesmith/
  current -> releases/<commit>/  atomic active-release link
  releases/
    <commit>/
      dist/                      built browser editor
      dist-server/               bundled Node entry and workers
      node_modules/              production dependencies
/srv/slopesmith/
  workspace/                     accounts, projects, checkpoints, libraries, cache and logs
  maps/                          extracted and exported reference maps
/var/lib/slopesmith-update/
  inbox/                         only update state writable by the web service
  logs/                          root-owned deployment logs
  repository                     configured source shown only to administrators
/etc/slopesmith.env              non-voice machine paths and tuning
/etc/slopesmith-update.env       root-owned update repository and unprivileged build identity
/etc/livekit/                    optional voice config and private environment
```

Create the service identity and state directories:

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin slopesmith
sudo install -d -o root -g root -m 0755 /opt/slopesmith /opt/slopesmith/releases
sudo install -d -o slopesmith -g slopesmith -m 0750 \
  /srv/slopesmith /srv/slopesmith/workspace /srv/slopesmith/maps
sudo chown -R slopesmith:slopesmith /srv/slopesmith
```

Copy the extracted reference library into `/srv/slopesmith/maps`. It must already exist when the API starts;
Slopesmith refuses a misspelled map path rather than silently presenting an empty library.

## Bootstrap the first immutable release

The repository pins Node 24 in `.nvmrc` and `package.json`. The build produces two independent artifacts:

- `dist/`: the Vite browser application;
- `dist-server/`: bundled ESM for the API and its workers.

Build a reviewed commit in a temporary unprivileged checkout, stamp its exact revision, and only then copy the
finished application into the root-owned release tree. The following is for the first installation, before
`/opt/slopesmith/current` exists; replace the clone URL here and in the updater configuration below when the
deployment follows a fork:

```sh
git clone https://github.com/swax/OpenSlope.git /var/tmp/OpenSlope-bootstrap
cd /var/tmp/OpenSlope-bootstrap/Slopesmith
revision=$(git rev-parse HEAD)

/opt/node24/bin/npm ci --no-audit
/opt/node24/bin/npm run typecheck
/opt/node24/bin/npm run test:full
/opt/node24/bin/npm run build
/opt/node24/bin/npm prune --omit=dev --no-audit
printf '%s\n' "$revision" > .slopesmith-revision

release="/opt/slopesmith/releases/$revision"
sudo install -d -o root -g root -m 0755 "$release"
sudo cp -a -- . "$release/"
sudo chown -R root:root "$release"
sudo chmod -R go-w "$release"
sudo ln -s "$release" /opt/slopesmith/current
```

`npm prune` is safe after the build: the server bundle externalizes only production dependencies, while `tsx`,
Vite, TypeScript and esbuild are build-time dependencies. Validate the packaged entry before starting the
service:

```sh
NODE_ENV=production \
SLOPESMITH_APP_ROOT=/opt/slopesmith/current \
SLOPESMITH_WORKSPACE_ROOT=/srv/slopesmith/workspace \
SLOPESMITH_MAPS_ROOT=/srv/slopesmith/maps \
/opt/node24/bin/node --preserve-symlinks-main --enable-source-maps \
  /opt/slopesmith/current/dist-server/main.js help
```

Never run `npm run dev` or expose Vite's port in production.

## Environment and systemd

Install the supplied environment and unit after the `current` link exists. Review `/etc/slopesmith.env`; in the
release layout its application root must be `/opt/slopesmith/current`, never the parent release directory:

```sh
sudo cp deploy/slopesmith.env.example /etc/slopesmith.env
sudo editor /etc/slopesmith.env
sudo chmod 0640 /etc/slopesmith.env
sudo chown root:slopesmith /etc/slopesmith.env
sudo install -o root -g root -m 0644 deploy/slopesmith.service \
  /etc/systemd/system/slopesmith.service
sudo systemctl daemon-reload
sudo systemctl enable --now slopesmith
```

The unit matches the reference host: it starts `/opt/node24/bin/node` from the `current` release, binds the API
to `127.0.0.1:5180`, requires accounts and trusts forwarded TLS only because Apache or Caddy is the sole caller.
It emits a health line every minute and logs individual requests when they take at least one second.
`--behind-proxy` must never be paired with a publicly reachable API port.

Set `SLOPESMITH_ALLOWED_HOSTS` in `/etc/slopesmith.env` to the exact public editor hostname (comma-separated
when the same service deliberately has more than one). This list is an API authority boundary as well as a
Vite development setting: matching `Origin` and `Host` headers do not make an arbitrary DNS name acceptable.
An entry may include a port to pin it to that authority; a leading dot deliberately includes subdomains.
Loopback names and literal IP addresses are accepted without an entry so the direct CLI and editor proxy work.

`SLOPESMITH_LOG_LEVEL` sets how much the service says in the journal: `debug`, `info`, `warn` or `error`, default
`info`; anything else is reported once and treated as `info`. `SLOPESMITH_LOG_FORMAT=json` makes every line one
JSON object for a log collector; the default is a text line, `<time> <LEVEL> <component> <message> key=value…`.
Both are read once at start, so a change in `/etc/slopesmith.env` takes a restart.

`ProtectSystem=strict`, an empty capability set and the other unit restrictions make the release and host
filesystem read-only to Node. The base unit grants writes only under `/srv/slopesmith`. Optional root-owned
drop-ins add the updater inbox and LiveKit environment without weakening the rest of the sandbox.

The worker settings normally stay commented out. Defaults are derived from `availableParallelism()` using one
host-wide budget and retain a separate document worker. On a 2-vCPU Droplet this means one reference worker and
one document worker; they overcommit only during the uncommon overlap between a cold reference build and a
snapshot. Explicit values are clamped to the same safe budget.

Inspect startup and obtain the one-time admin-enrolment code:

```sh
sudo journalctl -u slopesmith -n 100 --no-pager
```

The log names the loopback service because that is what Node binds. Open the public HTTPS site in a browser and
enter the printed code there. After the first admin exists, restarts do not issue another code.

Confirm the installed unit rather than assuming the template was copied unchanged:

```sh
systemctl show slopesmith --no-pager \
  -p User -p Group -p WorkingDirectory -p ExecStart -p Environment -p DropInPaths -p Restart
systemctl cat slopesmith --no-pager
ss -lnt | grep ':5180'
```

The listener must be `127.0.0.1:5180`, `Restart` must be `on-failure`, and the working directory and executable
must point through `/opt/slopesmith/current` and `/opt/node24` respectively.

## HTTPS, static files and `/api`

The public server owns only static files and TLS. It must proxy `/api/*`—including WebSocket upgrades—to
`127.0.0.1:5180`, serve `current/dist`, fall back to `index.html` for browser routes, revalidate the HTML shell,
cache Vite's fingerprinted `/assets/*` and revisioned `/characters/*` indefinitely, and negotiate HTTP/2 at
the public TLS edge. Immutable uploaded texture, sky, model and audio responses under `/api` set their own
one-year policy. Replaceable reference tiles and skies carry content digests in their URLs and receive the
same immutable policy; an older unversioned client uses a one-hour fresh lifetime followed by ETag revalidation.

### Apache (reference host)

The live host is an existing multi-site Apache server. Its Slopesmith virtual host is represented by
`deploy/apache-slopesmith.conf.example`; replace the example hostname and certificate paths, then install it:

```sh
sudo apt install apache2 certbot python3-certbot-apache
sudo a2enmod headers http2 proxy proxy_http rewrite ssl
sudo install -o root -g root -m 0644 deploy/apache-slopesmith.conf.example \
  /etc/apache2/sites-available/slopesmith.conf
sudo editor /etc/apache2/sites-available/slopesmith.conf
# Obtain the referenced certificate before enabling the TLS virtual host.
sudo a2ensite slopesmith.conf
sudo apache2ctl configtest
sudo systemctl reload apache2
```

The reference virtual host also sets HSTS, `nosniff`, same-origin referrer policy and same-origin framing. It
clears any `X-Forwarded-For` the client sent before proxying, so the address the API counts login failures
against is the one Apache appended rather than one the client chose (the service reads the last entry). Its
access-log format uses `%U` instead of the standard `combined` format's `%r`, so the short-lived LiveKit token in
a signaling query string is not retained. Preserve that path-only logging rule when merging the example into an
existing Apache site. Apache must be able to traverse the root-owned release directories, but it never receives
write access to them.

### Caddy alternative

Copy `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile`, replace `slopesmith.example.com`, validate and reload:

```sh
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo editor /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate and implements the same static/cache/proxy contract. Node remains on
loopback with either public server.

### Verify the public edge

Verify both halves through the public origin:

```sh
curl --fail --http2 --head https://slopesmith.example.com/
curl --silent --output /dev/null --http2 --write-out 'HTTP %{http_version}\n' https://slopesmith.example.com/
curl --fail --head https://slopesmith.example.com/characters/blocky-rider-rigged.glb
curl --include https://slopesmith.example.com/api/auth/session
```

The version check must print `HTTP 2`; the character response must include the one-year immutable cache
policy. The final request may return `401` before sign-in; that still proves HTTPS reached the API. A `404` HTML page
means the `/api/*` proxy matcher is wrong.

## Observability

DigitalOcean Monitoring covers VM CPU, memory, disk and bandwidth. Slopesmith writes one heartbeat every
`SLOPESMITH_METRICS_INTERVAL_MS`: an info-level log line from the `telemetry` component with the message
`heartbeat` and the metrics as its fields — one flat JSON object under `SLOPESMITH_LOG_FORMAT=json`. It includes:

- process CPU percentage and RSS/heap/external memory;
- event-loop p95 and maximum delay;
- request count, failures, active requests, average/p95/maximum duration;
- connected browser sockets;
- response-cache size, hits, misses, evictions and compression work;
- reference/document worker capacity, active workers and queues.

Read recent heartbeats with:

```sh
sudo journalctl -u slopesmith --since '30 minutes ago' | grep 'telemetry heartbeat'
```

The heartbeat is an info line, so `SLOPESMITH_LOG_LEVEL=warn` silences it with everything else below warn;
`SLOPESMITH_METRICS_INTERVAL_MS=0` turns it off alone.

Alert at the host level for low disk, swapping, sustained CPU and service restarts. At the application level,
watch event-loop delay, worker queues, cache evictions and HTTP 5xx counts. A cache miss followed by hits is
normal; a growing worker queue or repeated cold build for the same fingerprint is not.

Do not set `--max-old-space-size`, `--max-semi-space-size`, or `UV_THREADPOOL_SIZE` pre-emptively. Buffers,
native canvas allocations and worker heaps live outside the main V8 old-space limit, while filesystem work,
scrypt and response compression share libuv. Change one setting only against a representative 25-client load
test and retain it only when latency improves without increasing event-loop delay or RSS.

For a one-off CPU profile on a staging host, stop the service and run the packaged entry with Node's
`--cpu-prof` flag. Do not expose the inspector port on a public interface.

## Backups and recovery

The Droplet's local SSD is the live store, not the backup. Use two complementary layers:

1. a short-retention, usage-based DigitalOcean backup for fast whole-VM recovery; and
2. an encrypted Restic repository in Cloudflare R2 for independent, longer-lived file recovery.

Do not buy the percentage-based Daily Backup plan or a DigitalOcean Spaces subscription solely for this
deployment. As of August 2026, [usage-based Droplet backups](https://docs.digitalocean.com/products/backups/details/pricing/)
charge by restorable data (daily is `$0.03/GiB-month`), while
[R2 Standard](https://developers.cloudflare.com/r2/pricing/) includes 10 GB-month and normal backup request
volumes for free, then charges `$0.015/GB-month` with no egress fee. Check the current prices before provisioning.

For example, 20 GiB of restorable Droplet data costs about `$0.60/month` on the published daily rate. An R2
repository that stays under 10 GB is free; 100 GB averages about `$1.35/month` after the free allowance. Actual
Droplet backup cost depends on the retained change set, and taxes are not included.

### Layer 1: short-retention Droplet backup

Select **Usage-Based**, not the percentage-priced Basic plan. Start with daily backups and seven days of
retention. This is the quick path when an operating-system update, package change or disk failure makes the
whole VM unusable. If losing up to one day of machine state is unacceptable, select a six-hour schedule; the
R2 backup below is still the authoritative long-term copy.

DigitalOcean stores a Droplet's backups in the same datacenter as the Droplet. Treat them as a recovery
convenience, not as the independent disaster-recovery copy. Usage-based backups are incremental after the
first full image, but the restored image is only crash-consistent.

### Layer 2: Restic to Cloudflare R2

Create a private R2 Standard bucket such as `slopesmith-backups` and a bucket-scoped API token. Do not expose
the bucket publicly. Configure Restic's S3-compatible backend using an environment file readable only by root:

<!-- repo-hygiene: allow[config-listing] -- project-authored Restic deployment example, not retail configuration -->
```ini
# /etc/restic/slopesmith.env (mode 0600)
RESTIC_REPOSITORY=s3:https://CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com/slopesmith-backups
RESTIC_PASSWORD_FILE=/etc/restic/slopesmith-password
AWS_ACCESS_KEY_ID=replace-with-r2-access-key-id
AWS_SECRET_ACCESS_KEY=replace-with-r2-secret-access-key
```

Generate a long random Restic repository password. Put one copy in `/etc/restic/slopesmith-password` with mode
`0600` and another in the team's password manager. Losing this password makes the encrypted repository
unrecoverable. Never commit the environment, password or R2 credentials.

Initialize the repository once, then schedule this backup every six hours with a root-owned systemd timer.
Omit `/etc/livekit` when voice is not installed and `/etc/slopesmith-update.env` when automatic updates are not
installed:

```sh
set -a
. /etc/restic/slopesmith.env
set +a

restic init
restic backup \
  /srv/slopesmith/workspace \
  /srv/slopesmith/maps \
  /etc/slopesmith.env \
  /etc/slopesmith-update.env \
  /etc/livekit \
  --exclude=/srv/slopesmith/workspace/cache
```

Run retention once per day, after a successful backup:

```sh
restic forget --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6
```

Those paths contain the durable data:

```text
/srv/slopesmith/workspace/
/srv/slopesmith/maps/
/etc/slopesmith.env
/etc/slopesmith-update.env
/etc/livekit/                    when voice is installed
```

Exclude `/srv/slopesmith/workspace/cache/`; it is fingerprinted derived data and can be rebuilt. If the map
library has a separate, tested source-of-truth, it can be backed up less often, but never omit unique uploaded
maps. The optional LiveKit directory contains private credentials, so it belongs only in the encrypted backup
and must not be copied into the repository. Restic encrypts and deduplicates the data before sending it to R2.

Project and account files are written by atomic rename, so a live file-level backup sees either the preceding
or following complete file. A live Restic run is therefore appropriate. For a disaster-recovery rehearsal or
provider snapshot, stop the service first so all rooms write their final durable snapshot:

```sh
sudo systemctl stop slopesmith
# take or restore the snapshot
sudo systemctl start slopesmith
```

SIGTERM uses Slopesmith's graceful close path and waits for room snapshots before the process exits. systemd
allows 90 seconds before escalating.

Backups are only complete when they can be restored. Check repository metadata weekly and perform a real test
restore into a disposable directory or VM at least monthly:

```sh
restic snapshots
restic check
restic restore latest --target /srv/slopesmith-restore-test
```

Confirm that projects, accounts and representative maps open from the restored copy, then remove the test copy.
Alert when the backup timer fails or when no new Restic snapshot has appeared in the expected six-hour window.

## Updates and rollback

Use a maintenance window: active collaboration state belongs to the running process even though accepted work
is snapshotted frequently.

The live host does not pull or build inside `/opt/slopesmith/current`. Its root-owned
`/usr/local/sbin/deploy-slopesmith` accepts only a full commit reachable from the configured repository's
`main` branch, clones into a temporary directory as the unprivileged build account, runs the release gates,
installs a root-owned immutable release, and atomically switches `current`.

The source is machine configuration, not an update-request field. Install the example once and point it at
your fork before installing the helpers; leave the default to follow OpenSlope itself:

```sh
sudo install -o root -g root -m 0600 deploy/slopesmith-update.env.example /etc/slopesmith-update.env
sudo editor /etc/slopesmith-update.env
```

`SLOPESMITH_UPDATE_REPOSITORY` may be an HTTPS or SSH Git remote. Do not embed credentials in its URL. The
unprivileged build account's protected Git credential store or SSH configuration supplies private access.
The updater intentionally fixes the branch at `main`; an administrator can ask for latest or a full commit,
but no browser request can change the repository or ref that root trusts.

Install helper changes separately from an application release:

```sh
sudo install -o root -g root -m 0755 deploy/deploy-slopesmith /usr/local/sbin/deploy-slopesmith
```

The example and both privileged helpers default to a `slopesmith-build` account with a home directory at
`/home/slopesmith-build`. Create it, or set `SLOPESMITH_BUILD_USER` and `SLOPESMITH_BUILD_HOME` in
`/etc/slopesmith-update.env` to an existing unprivileged account; both helpers read that same root-owned file.

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin slopesmith-build
```

That account owns Git/network credentials and the temporary build—not the installed release or service state.

An operator can deploy an exact reviewed revision directly:

```sh
revision=<40-character-commit-on-the-configured-main-branch>
sudo deploy-slopesmith "$revision"
readlink -f /opt/slopesmith/current
systemctl is-active slopesmith
curl --include http://127.0.0.1:5180/api/auth/session
```

The final request may answer `401`; that is a healthy unauthenticated API response. The helper rolls back the
`current` link automatically when activation or the loopback readiness check fails.

To let a signed-in Slopesmith administrator request the same guarded deployment from **Settings → Server**, install
the root-owned update runner once from a reviewed release:

```sh
sudo deploy/install-updater.sh
```

Run the same installer again after a release changes `install-updater.sh`, `slopesmith-update-runner`, or the
updater's systemd units. It preserves `/etc/slopesmith-update.env` while refreshing the root-owned helpers and
the administrator-visible repository record.

The installer preserves an existing `/etc/slopesmith-update.env`, or installs the OpenSlope defaults when the
file is absent. It keeps the web service under `NoNewPrivileges` and gives Slopesmith write access only to
`/var/lib/slopesmith-update/inbox`; a systemd path unit claims the exact 40-character commit and hands it to the
root-owned deploy helper. Branch names, command arguments and commits outside the configured repository's
`main` history are refused. The current service remains available while the candidate is cloned, tested and
built, then restarts during the atomic symlink switch. Deployment status is retained in
`/var/lib/slopesmith-update/status.json`, and detailed root-owned logs are kept under
`/var/lib/slopesmith-update/logs/`. The runner publishes only the configured repository identifier into a
group-readable state record so **Settings → Server** can show administrators which source it follows; the
root-owned update configuration and the build account's Git credentials remain unreadable to the web service.
At the switch, established editor sockets receive WebSocket code 1012 (service restart), allowing systemd to
stop promptly while browsers reconnect to the activated release.

For a private repository, the same runner resolves the fixed `main` ref with the deployment account's Git
credentials. It returns only the resulting commit hash in a root-owned record; the web service cannot read the
credentials, choose another repository or ref, or run Git with arbitrary arguments.

To change sources later, edit `/etc/slopesmith-update.env` as root. The root runner and deploy helper read the
file afresh for each request; neither the updater nor Slopesmith needs a restart:

```sh
sudo editor /etc/slopesmith-update.env
```

The same installation enables **Restart server** in **Settings → Server**. That action does not install a
release: it gracefully closes collaboration sessions and exits with a failure status so the existing systemd
`Restart=on-failure` policy constructs a fresh service. Startup then re-reads the storage paths and recreates
the maps watcher and derived-response caches, which is useful after placing newly extracted data in the maps
folder. An unsupervised production process does not offer the button because it cannot promise to return.

Downgrading to a revision from before this Settings control existed is supported, but that older browser/API
cannot request the return trip. Restore a newer release with `sudo deploy-slopesmith <revision>` in that case;
the root-owned runner remains installed throughout.

Inspect the updater and its retained result without reading private Git credentials:

```sh
systemctl is-enabled slopesmith-update.path
systemctl status slopesmith-update.path slopesmith-update.service --no-pager
sudo journalctl -u slopesmith-update.service -n 100 --no-pager
sudo ls -l /var/lib/slopesmith-update/logs
```

For rollback, pass a previously installed commit that is still reachable from the configured repository's
`main` branch to the same deploy helper. It reuses the root-owned release directory, switches `current`, and
runs the same readiness check. Never rewrite `/opt/slopesmith/current` by hand while the service is running.
`/srv/slopesmith` remains outside every release, so changing code does not replace projects, accounts or
reference maps.

Before making a commit available to production, CI or local review should run at minimum:

```sh
npm run typecheck
npm run test:full # the whole gate, which includes the cache, accounts and session checks
npm run build
```

The deploy helper repeats the production-critical server tests and build in its isolated checkout before
activation. The API must remain a single systemd instance after an update.

## Optional voice chat

Slopesmith can run a self-hosted LiveKit process on the same VM without exposing its signaling listener. The
application authenticates each browser and proxies signaling through the existing `/api/*` route; WebRTC media
uses separate public UDP/TCP ports. See [048 — Voice Chat](048-voice-chat.md) for the pinned installer, firewall
rules, security model, and verification procedure. The reference host runs `livekit-server.service` as its own
`livekit` identity, listens for signaling on `127.0.0.1:7880`, and supplies Slopesmith's private voice environment
through `/etc/systemd/system/slopesmith.service.d/voice.conf`. When Apache is the public edge, use the path-only
access-log format above before enabling voice.

## Viewer-side video bridge

Yattee is not a companion process on the production Slopesmith host. Each viewer who wants Jukebox video on
WebGL course screens runs a separate, viewer-managed bridge. A desktop browser may reach it over loopback; a
standalone Quest, phone, or tablet may reach the viewer's workstation through a dedicated HTTPS ngrok endpoint.
The bridge URL and Yattee credentials stay in that browser profile and never enter the production environment,
systemd unit, backup set, or Slopesmith access logs. See
[063 — Jukebox Playback](063-video-bridge.md#reaching-a-local-server-from-quest-or-mobile) for the
two-endpoint local workflow and the one-endpoint variation used with an already hosted Slopesmith site.
