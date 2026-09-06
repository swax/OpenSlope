# 048 — Voice chat

Slopesmith can add opt-in, server-wide voice chat through a self-hosted LiveKit server. Voice is optional:
without the LiveKit environment values the editor, collaboration, and text chat continue to work and the
voice control reports that the server has not enabled it.

## Architecture and trust boundary

The signed-in browser asks `POST /api/voice` for a short-lived participant token. Slopesmith verifies the account
session and browser client id, then chooses its configured deployment room itself. The token can join only that room,
can publish only a microphone, cannot publish data, and expires after 15 minutes. A personal Slopesmith API key
cannot mint a voice participant.

The browser connects to the same public origin at `/api/livekit`. The Slopesmith process proxies that HTTP and
WebSocket signaling traffic to LiveKit on `127.0.0.1:7880`; the existing TLS reverse proxy therefore needs no
new route. WebRTC audio takes the direct UDP or TCP path advertised by LiveKit.

```text
browser -- HTTPS/WSS 443 --> Caddy or Apache --> Slopesmith :5180 --> LiveKit 127.0.0.1:7880
browser -------------------- WebRTC UDP/TCP ------------------> LiveKit media ports
```

API secrets exist only in root-owned host files and the Slopesmith service environment. They are never sent to
the browser. Participant tokens do travel in the signaling URL. Apache's standard `combined` access-log format
uses `%r`, which includes that query string; use the `%m %U %H` path-only format in
`deploy/apache-slopesmith.conf.example` instead, and never add `%q`. The supplied Caddy example does not enable
access logging; redact queries or exclude `/api/livekit` if logging is added. The 15-minute token lifetime limits
the value of an accidentally retained join URL; connected sessions are refreshed by LiveKit.

LiveKit encrypts transport with TLS and WebRTC's DTLS-SRTP. This deployment is not end-to-end encrypted from
the media server. Add LiveKit's client-side E2EE support before making that stronger privacy claim.

## Install on a systemd host

Build or copy a release containing this repository, then run the pinned installer with the editor's public
HTTPS host expressed as a WebSocket URL:

```sh
sudo bash deploy/install-livekit.sh wss://slopesmith.example.com/api/livekit slopesmith-prod
```

The idempotent installer:

- verifies and installs the pinned LiveKit binary;
- runs it as a dedicated login-disabled `livekit` identity under a restricted, automatically restarting
  `livekit-server.service`;
- binds signaling to loopback while exposing only the explicitly configured WebRTC/TURN ports;
- creates random API credentials in `/etc/livekit` without printing them;
- adds a Slopesmith systemd drop-in for the private environment file;
- enables embedded UDP TURN and a bounded media range; and
- restarts Slopesmith when it is already active.

The optional second argument selects this Slopesmith deployment's room. It defaults to `slopesmith-server` for
backward compatibility, and an idempotent rerun without that argument preserves an existing configured room.
It also preserves credentials on a rerun. To rotate them, stop both services, remove
`/etc/livekit/slopesmith-voice.env`, rerun the installer, and start Slopesmith again. Existing voice sessions
will disconnect during a rotation.

Allow these inbound ports in both the host firewall and any provider/cloud firewall:

| Protocol | Port | Purpose |
| --- | ---: | --- |
| TCP | 443 | existing Slopesmith HTTPS and LiveKit signaling |
| TCP | 7881 | WebRTC fallback when direct UDP is unavailable |
| UDP | 3478 | embedded TURN/UDP |
| UDP | 50000–50199 | direct WebRTC media |

Keep TCP 7880 private. It listens only on loopback in the installed configuration. The 200-port UDP range is
appropriate for a small audio-only Slopesmith host and avoids opening LiveKit's much larger default range.

Embedded TURN/UDP helps with ordinary NAT traversal, but it does not replace TURN/TLS for networks that permit
only TLS-like traffic. A separate TURN hostname and certificate is required if strict corporate networks must
be supported; do not reuse TCP 443 while the Slopesmith web proxy owns it.

## Configuration

The application recognizes these environment values:

| Variable | Meaning |
| --- | --- |
| `SLOPESMITH_LIVEKIT_URL` | Public `wss://` signal URL given to browsers |
| `SLOPESMITH_LIVEKIT_API_KEY` | LiveKit signing key, server-side only |
| `SLOPESMITH_LIVEKIT_API_SECRET` | LiveKit signing secret, server-side only |
| `SLOPESMITH_LIVEKIT_ROOM` | Optional deployment-specific room; defaults to `slopesmith-server` |
| `SLOPESMITH_LIVEKIT_UPSTREAM` | Optional loopback HTTP origin; defaults to `http://127.0.0.1:7880` |

All of the first three values are required to enable voice. Production refuses a non-TLS public URL, and the
upstream setting accepts only a loopback HTTP origin to prevent turning Slopesmith into an open proxy.

One LiveKit process can serve several Slopesmith deployments. Give each deployment a different room, such as
`slopesmith-prod` and `slopesmith-test`, while keeping the same public URL and media ports. LiveKit keeps their
participants and audio separate. API keys are server-wide rather than room-scoped, so every Slopesmith process
that holds a key must remain trusted; use separate LiveKit instances when that trust boundary also needs isolation.

A trusted local Slopesmith process can therefore reuse a hosted LiveKit service for manual testing: copy the
host's URL, API key, and API secret into process-scoped local environment values, set
`SLOPESMITH_LIVEKIT_ROOM=slopesmith-test`, and leave `SLOPESMITH_LIVEKIT_UPSTREAM` unset. The browser connects
to the hosted public WSS URL, while production remains in its separately configured room. Do not save the API
secret in the repository or expose this workflow to an untrusted development machine.

## User behavior

Voice is shared across the whole server, regardless of which mountain anybody has open. Its status and controls
sit at the top of **Users**, above the server roster. Press **Join voice** to join and start the microphone,
**Mic on** to mute, and **Leave** to disconnect.
The member list is also the voice roster: people in voice sort above other online members, who sort above offline
members. A microphone beside a name shows who joined, changes to a speaker while they talk, and shows a slash
when they are muted or listen-only. Click somebody else's voice icon to mute that account locally — all of their
tabs go silent only for you, including a tab that reconnects — and click the crossed-out speaker to restore them.
If browser autoplay policy blocks incoming sound, a **Hear** control appears. A denied microphone leaves the
participant connected in listen-only mode.

Changing or closing a mountain does not affect voice. Closing Users hides the controls but does not leave the
call. Voice audio also remains connected during a test ride; the passive chat HUD continues to show recent
messages and names each active voice speaker with a speaker icon, while the dock and its controls return when
the ride ends.

## Verification and operation

An administrator can open **Settings → Server → Voice server (LiveKit)** and choose **Run self-test**.
The check uses a temporary participant to verify the public WebSocket signaling path, WebRTC/ICE connectivity,
and the TURN relay without requesting microphone permission. A TURN-only failure usually means UDP 3478 is not
open in the host or provider firewall; a WebRTC failure commonly points to TCP 7881 or UDP 50000–50199.

On the host:

```sh
grep '^LIVEKIT_VERSION=' deploy/install-livekit.sh
/usr/local/bin/livekit-server --version
systemctl status livekit-server slopesmith --no-pager
systemctl show livekit-server --no-pager \
  -p User -p Group -p Restart -p NoNewPrivileges -p ProtectSystem \
  -p RestrictAddressFamilies -p MemoryDenyWriteExecute
systemctl show slopesmith --no-pager -p EnvironmentFiles -p Wants -p After
curl --fail http://127.0.0.1:7880/
journalctl -u livekit-server -u slopesmith -n 100 --no-pager
ss -lnt | grep -E ':(7880|7881)\b'
ss -lnu | grep -E ':3478\b'
```

The installed version must match the script pin; the service must run as `livekit`, use `Restart=on-failure`,
and retain the listed sandbox controls. Port 7880 must be loopback-only, while TCP 7881 and UDP 3478 listen for
remote media/TURN clients. A `200` from 7880 proves only that the local signaling process is alive—it does not
test the public WebSocket, ICE or media path. The UDP 50000–50199 sockets are allocated as sessions need them,
so an idle `ss` listing is not a firewall test for that range.

From outside the host, confirm TCP 7881 is reachable and then join voice from two browsers on different
networks. Each browser should show two people, hear the other microphone, update its active-speaker
indicator, and survive a short network interruption. A signaling connection with no audio usually means the
provider firewall is missing the UDP range; clients that work on home networks but not locked-down corporate
networks usually need TURN/TLS.
