# Multiplayer relay

The Rust relay owns guest play rooms, rider poses, ride interactions and room chat. Collaborative editing,
accounts, project storage and asset serving stay on Node. Browsers connect directly to Rust through the site's
reverse proxy: movement packets never pass through Node or a Node worker message channel.

## Local development

Install Rust 1.99+ and Slopesmith's locked npm dependencies, then run from `Slopesmith/`:

```text
npm run dev:multiplayer
```

This builds and starts Rust on an available loopback port, creates an in-memory development secret, and
starts the usual editor/API and Vite proxy. Open the printed site URL, load a public course, and join with a
display name. No account is needed for public play. **Invite friends** creates a separate room and copies its
play link. Members can also play from the editor; edits retain their existing independent connection.

`npm run dev` retains the existing setup unless relay environment variables are configured. Existing
installations do not silently require a Rust binary after an update. Once relay mode is configured, the old
public session endpoint refuses upgrades and the editor channel refuses rider payloads.

## Contracts

`src/protocol.rs` defines DTOs with Serde, ts-rs and Schemars derives. Rust imports these directly. Node and
browsers import generated TypeScript; AJV compiles schemas into standalone validators, so production does
not load the schema compiler. `core/session/player-pose.ts` re-exports the generated pose types while
retaining semantic sanitization and local-only types.

```text
npm run multiplayer:generate
npm run multiplayer:check
npm run multiplayer:test
npm run multiplayer:bench
```

Generated files are committed. CI checks regeneration, Rust tests and cross-language/browser integration.
Regenerate after changing DTOs; never edit generated files. Coordinates use metres, timestamps use epoch
milliseconds, and sequence/teleport counters use unsigned 32-bit integers. The play handshake is versioned
independently from document/core versions. Breaking changes require a new protocol version; additive
changes still need compatibility fixtures.

## Production

Use the [signed Slopesmith package](../docs/060-packaged-deployment.md), built and tested on a Linux build
machine matching the host architecture. It installs the frontend, API, Node runtime and Rust relay together.
The supplied `deploy/slopesmith-multiplayer.service` runs independently: a compatible relay-only update
restarts Rust while the editor remains running. Production hosts do not need Cargo or npm.

Give both services the same `SLOPESMITH_MULTIPLAYER_SECRET` (at least 32 random bytes). Set
`SLOPESMITH_MULTIPLAYER_URL=http://127.0.0.1:5181` on Node, and optionally set these on Rust:

| Variable | Default |
| --- | --- |
| `SLOPESMITH_MULTIPLAYER_BIND` | `127.0.0.1:5181` |
| `SLOPESMITH_MULTIPLAYER_ROOM_PLAYERS` | `32` connections per room |
| `SLOPESMITH_MULTIPLAYER_MAX_CONNECTIONS` | `1000` including pending upgrades |

The installer creates `/etc/slopesmith-multiplayer.env`, owned by root with mode `0600`, with the shared
secret and Node relay URL. It preserves that file on repeat installation. Both units load it; guest cookie
signing also derives from the secret, so keep it through upgrades. First activation needs the relay route
and a Node restart to enable admission. Subsequent compatible relay restarts leave Node running.

Enable `/api/play/session` in the Caddy or Apache example before the general API mapping. Keep config and
ticket HTTP requests on Node. The internal `/control` route requires the shared secret; `/health` reports
liveness. Neither needs public proxying. Keep Rust on loopback. The current Node control client deliberately
requires a loopback upstream; remote hosting needs an authenticated private control transport.

Node issues origin-bound, single-use tickets with 60-second admission leases. Browsers renew every 20
seconds. Node pushes account revocations and public-course withdrawal immediately; if that push fails, the
lease bounds stale access to 60 seconds. A Node outage therefore permits existing play only until leases
expire. Personal API keys cannot join as browser members. Guests may join published courses and built-in
disc reference rooms, matching existing public-play policy.

## Delivery and current limits

Each room has a bounded command queue. Reliable control/chat/interaction messages use a bounded queue per
connection. Poses use replaceable **full snapshots**, so skipping a pending snapshot never loses another
rider's latest state. Snapshots publish at most every 80 ms. Slow sockets disconnect rather than retaining
unlimited data. Movement and one-shot interactions are never replayed after reconnect. Empty rooms expire
after 30 seconds; room chat history is transient and capped at 50 lines.

Editor selection messages publish only when their selection changes, even while the same tab sends rider
poses to Rust. Clearing a pose removes the avatar without disconnecting the participant.

Compression negotiates no context takeover and bounds inflation before allocating a full decoded message.
The initial relay compresses per socket. Benchmark CPU and bandwidth before raising limits: the 32/1000
defaults are resource bounds, not measured capacity claims. Guest connections consume no editor seats.
Public-player chat is scoped to a play room; editor chat retains its existing server-wide behavior.

Rooms live in one relay process. Horizontal scaling needs consistent course/room routing and control-message
fan-out across instances; shared room state and automatic sharding are not part of this initial service.

Physics remains client-side. Competitive race authority, persistent lobbies and guest voice are separate
features. Course loading retains existing publication behavior; this change does not introduce immutable,
versioned course/asset releases. Running players keep their loaded world, so publish stable courses for play.

The optional benchmark runs 100 simulated clients in a separate process across four rooms, increases the
moving population through 0/10/25/50/100, and reports editor acknowledgement latency at each step. It uses
the local debug binary and a 10 ms polling client; results are a regression check, not production sizing.

## Distribution notices

Slopesmith's Apache-2.0 license covers this source. Cargo dependencies retain their own licenses. The release
build collects the exact locked dependency licenses into `target/release/ThirdPartyNotices/`; distribute
that directory alongside the binary. AJV's MIT notice covers generated JavaScript validation code and lives
under `Slopesmith/ThirdPartyNotices/`.
