# 041 — Production deployment

Slopesmith is a stateful, single-process collaboration service. A small Linux VM is the intended production
shape: Apache or Caddy serves the static editor and terminates TLS, one Node process owns the editor/API,
a separate Rust process relays play sockets, and workspace and reference data live on persistent local SSD.

This guide follows an audited production deployment as of 2026-08-21: a DigitalOcean Droplet running Ubuntu
22.04 LTS, Apache, Node 24, LiveKit and systemd. Ubuntu 24.04 and Caddy remain supported choices; their
differences are called out instead of being mixed into the reference commands. New installations and
updates use [060 - Packaged deployment](060-packaged-deployment.md). The existing Apache host has not yet
been migrated to packaged services or Caddy.

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
- no public access to 5179, 5180, 5181 or LiveKit's loopback signaling port 7880;
- when voice is installed, the media ports listed in [048 — Voice Chat](048-voice-chat.md).

Use the installer in [060 - Packaged deployment](060-packaged-deployment.md) to create the application
identity, immutable release tree and separate persistent storage. Packages contain the exact Node runtime
and production dependencies; updates need no build tools on the shared host.

```text
/opt/slopesmith/current -> releases/<commit>/
/opt/slopesmith/releases/<commit>/  frontend, API, Node runtime, Rust relay, notices
/srv/slopesmith/workspace/         accounts, projects, checkpoints, libraries, cache and logs
/srv/slopesmith/maps/              extracted and exported reference maps
/etc/slopesmith.env                API paths, public hostname and tuning
/etc/slopesmith-multiplayer.env    persistent admission secret and loopback relay URL
/etc/slopesmith-update.json        root-owned signed release policy
/etc/slopesmith/                   publisher public key and prepared proxy snippet
/var/lib/slopesmith-update/        root state and API-writable inbox
/etc/livekit/                     optional voice configuration
```

Copy the separately obtained reference library into `/srv/slopesmith/maps`. The installer creates the
folder but does not distribute retail data. Keep workspace and map data outside every release.

The service watches the maps library and the workspace's projects folder with one inotify watch per
**directory**, never per file (`src/server/watch-tree.ts`), so a library of about 58,000 files costs about 500
watches against the kernel's per-user `fs.inotify.max_user_watches`, which defaults to roughly 30,000 on a 4-GiB
host. Node's own `recursive: true` watch on Linux opens a watch per file and ran out on that library, without
saying so at startup. If the journal shows `maps watch incomplete` or `projects watch incomplete`, raise the limit
and restart:

```sh
echo fs.inotify.max_user_watches=262144 | sudo tee /etc/sysctl.d/60-slopesmith-inotify.conf
sudo sysctl --system
sudo systemctl restart slopesmith
```

## Bootstrap and systemd

Follow [060 - Packaged deployment](060-packaged-deployment.md) to verify the publisher identity, prepare the
host, review routing and activate a published commit. Existing source-built hosts need a consistent backup
and the explicit `--adopt-existing` installer option. Never run `npm run dev` or expose Vite in production.

`slopesmith.target` groups `slopesmith.service` (Node, loopback 5180) and
`slopesmith-multiplayer.service` (Rust, loopback 5181). They have separate restart policies and share resource
accounting under `slopesmith.slice`. LiveKit remains an independently managed service. Run exactly one
instance of each application process. Each relay owns its rooms in memory; replicas require room routing.

The API launcher resolves the selected immutable release and starts its bundled runtime with `--accounts`
and `--behind-proxy`. Trust forwarded TLS only when Apache or Caddy is the sole public caller. Node emits a
health line every minute and logs requests taking at least one second.

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
must select `/opt/slopesmith/current` and `/usr/local/lib/slopesmith/run-api` respectively. The launcher
resolves the current release once, including paths used by later worker creation.

## HTTPS, static files and `/api`

The public server owns static files and TLS. Route `/api/play/session` to Rust at `127.0.0.1:5181`
before the general `/api/*` route to Node at `127.0.0.1:5180`, with WebSocket upgrades on both. Serve `current/dist`, fall back to `index.html` for browser routes, revalidate the HTML shell,
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

### Shared Caddy

Keep one Caddy instance for the shared host, with one imported configuration per application. The packaged
installer prepares Slopesmith's snippet for review; `--proxy caddy` writes it under
`/etc/caddy/sites.d/`. Import that directory from the host's Caddyfile. Validate the complete configuration
before a separate reload:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews certificates. The example uses `stream_close_delay` to spread WebSocket reconnects
when configuration changes. Normal Slopesmith releases keep stable ports and do not reload the proxy.
Migrate the existing Apache host separately, including its other sites, PHP-FPM, protected paths, certificate
renewals and log-dependent Fail2Ban rules. The application installer does not perform that host-wide cutover.

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
Omit `/etc/livekit` when voice is not installed. Retain the publisher key and multiplayer secret through
restores, alongside the workspace and machine configuration:

```sh
set -a
. /etc/restic/slopesmith.env
set +a

restic init
restic backup \
  /srv/slopesmith/workspace \
  /srv/slopesmith/maps \
  /etc/slopesmith.env \
  /etc/slopesmith-update.json \
  /etc/slopesmith-multiplayer.env \
  /etc/slopesmith/ \
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
/etc/slopesmith-update.json
/etc/slopesmith-multiplayer.env
/etc/slopesmith/
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

Use the signed artifact updater in [060 - Packaged deployment](060-packaged-deployment.md). It replaces the
previous host-side Git/build helpers. Settings retains its guarded inbox contract; root configuration pins
the HTTPS release feed and publisher public key. No build account, Git credentials or compiler is needed
on the production host. The privileged tooling is installed separately from reviewed source and is never
automatically replaced by an application release.

```sh
sudo deploy-slopesmith <40-character-published-commit>
readlink -f /opt/slopesmith/current
systemctl is-active slopesmith slopesmith-multiplayer
sudo journalctl -u slopesmith-update -n 100 --no-pager
```

The updater verifies metadata and payloads before stopping services, selects the release atomically, checks
readiness and restores the previous release if activation fails. Only changed components restart. Node
updates close editor sockets after checkpointing so browsers can reconnect; compatible relay-only updates
leave the editor running. LiveKit and the shared proxy remain running. Select an older signed release with
the same command to roll back within the same data-format generation. Software rollback does not undo
changes to user data; keep tested backups.

The existing Settings server restart control still gracefully closes editor sessions and exits so systemd's
`Restart=on-failure` policy starts a fresh Node process. This reloads storage paths, map watchers and derived
caches. An unsupervised process cannot offer the same restart guarantee.

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
