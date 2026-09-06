#!/usr/bin/env bash
# repo-hygiene: allow[config-listing] -- project-authored deployment units and examples, not retail configuration
set -euo pipefail

# Install a pinned LiveKit release beside an existing Slopesmith systemd service.
# Usage: sudo bash deploy/install-livekit.sh wss://slopesmith.example.com/api/livekit [room-name]

LIVEKIT_VERSION="1.13.1"
PUBLIC_URL="${1:-}"
REQUESTED_ROOM="${2:-}"
DEFAULT_ROOM="slopesmith-server"
ENV_FILE="/etc/livekit/slopesmith-voice.env"
CONFIG_FILE="/etc/livekit/livekit.yaml"
SERVICE_FILE="/etc/systemd/system/livekit-server.service"
DROP_IN="/etc/systemd/system/slopesmith.service.d/voice.conf"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root (for example, with sudo)." >&2
  exit 1
fi
if [[ ! "${PUBLIC_URL}" =~ ^wss://[^/?#]+/.+ ]]; then
  echo "Usage: sudo bash $0 wss://slopesmith.example.com/api/livekit [room-name]" >&2
  exit 1
fi
if [[ ! -d /run/systemd/system ]]; then
  echo "This installer requires a systemd-based Linux host." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64)
    LIVEKIT_ARCH="amd64"
    LIVEKIT_SHA256="e9f70e2e44f8fbe1c5ad109087d44964d2afebfccfe0e8282a92215cf332e028"
    ;;
  aarch64|arm64)
    LIVEKIT_ARCH="arm64"
    LIVEKIT_SHA256="59245ecffe27d82435d9389e51e9c54e978254eb2290c53d46a81543754d6c59"
    ;;
  *)
    echo "LiveKit ${LIVEKIT_VERSION} is not packaged by this installer for $(uname -m)." >&2
    exit 1
    ;;
esac

for command_name in curl tar sha256sum openssl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "${TEMP_DIR}"' EXIT
ARCHIVE="${TEMP_DIR}/livekit.tar.gz"
DOWNLOAD_URL="https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_${LIVEKIT_ARCH}.tar.gz"

echo "Downloading LiveKit ${LIVEKIT_VERSION} for ${LIVEKIT_ARCH}..."
curl --fail --location --silent --show-error "${DOWNLOAD_URL}" --output "${ARCHIVE}"
printf '%s  %s\n' "${LIVEKIT_SHA256}" "${ARCHIVE}" | sha256sum --check --status
tar -xzf "${ARCHIVE}" -C "${TEMP_DIR}"
install -o root -g root -m 0755 "${TEMP_DIR}/livekit-server" /usr/local/bin/livekit-server

if ! getent group livekit >/dev/null; then
  groupadd --system livekit
fi
if ! id livekit >/dev/null 2>&1; then
  useradd --system --gid livekit --home-dir /var/lib/livekit --create-home --shell /usr/sbin/nologin livekit
fi
install -d -o root -g livekit -m 0750 /etc/livekit

# Preserve the server identity across idempotent reruns so existing browser sessions are not invalidated.
API_KEY=""
API_SECRET=""
VOICE_ROOM="${REQUESTED_ROOM}"
if [[ -f "${ENV_FILE}" ]]; then
  API_KEY="$(sed -n 's/^SLOPESMITH_LIVEKIT_API_KEY=//p' "${ENV_FILE}" | tail -n 1)"
  API_SECRET="$(sed -n 's/^SLOPESMITH_LIVEKIT_API_SECRET=//p' "${ENV_FILE}" | tail -n 1)"
  if [[ -z "${VOICE_ROOM}" ]]; then
    VOICE_ROOM="$(sed -n 's/^SLOPESMITH_LIVEKIT_ROOM=//p' "${ENV_FILE}" | tail -n 1)"
  fi
fi
if [[ ! "${API_KEY}" =~ ^[A-Za-z0-9_-]{16,}$ || ! "${API_SECRET}" =~ ^[A-Za-z0-9_-]{32,}$ ]]; then
  API_KEY="$(openssl rand -hex 16)"
  API_SECRET="$(openssl rand -hex 32)"
fi
VOICE_ROOM="${VOICE_ROOM:-${DEFAULT_ROOM}}"
if [[ ! "${VOICE_ROOM}" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then
  echo "Room name must be 1-128 letters, numbers, dots, underscores, colons, or hyphens." >&2
  exit 1
fi

install -d -o root -g root -m 0755 /etc/systemd/system/slopesmith.service.d

cat >"${CONFIG_FILE}" <<EOF
port: 7880
bind_addresses:
  - "127.0.0.1"
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50199
  use_external_ip: true
turn:
  enabled: true
  udp_port: 3478
  tls_port: 0
room:
  empty_timeout: 60
  departure_timeout: 20
  max_participants: 32
logging:
  level: info
  json: true
keys:
  ${API_KEY}: ${API_SECRET}
EOF
chown root:livekit "${CONFIG_FILE}"
chmod 0640 "${CONFIG_FILE}"

cat >"${ENV_FILE}" <<EOF
SLOPESMITH_LIVEKIT_URL=${PUBLIC_URL}
SLOPESMITH_LIVEKIT_API_KEY=${API_KEY}
SLOPESMITH_LIVEKIT_API_SECRET=${API_SECRET}
SLOPESMITH_LIVEKIT_ROOM=${VOICE_ROOM}
SLOPESMITH_LIVEKIT_UPSTREAM=http://127.0.0.1:7880
EOF
if getent group slopesmith >/dev/null; then
  chown root:slopesmith "${ENV_FILE}"
else
  chown root:root "${ENV_FILE}"
fi
chmod 0640 "${ENV_FILE}"

cat >"${SERVICE_FILE}" <<'EOF'
[Unit]
Description=LiveKit real-time media server for Slopesmith
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=livekit
Group=livekit
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit/livekit.yaml
Restart=on-failure
RestartSec=5s
LimitNOFILE=65536
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectControlGroups=true
ProtectHome=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
EOF

cat >"${DROP_IN}" <<'EOF'
[Unit]
Wants=livekit-server.service
After=livekit-server.service

[Service]
EnvironmentFile=/etc/livekit/slopesmith-voice.env
EOF

systemctl daemon-reload
systemctl enable --now livekit-server.service

ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:7880/ >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "${ready}" != true ]]; then
  echo "LiveKit did not become ready. Recent service log:" >&2
  journalctl -u livekit-server.service -n 50 --no-pager >&2 || true
  exit 1
fi

if systemctl is-active --quiet slopesmith.service; then
  systemctl restart slopesmith.service
fi

if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 7881/tcp comment 'LiveKit ICE TCP'
  ufw allow 3478/udp comment 'LiveKit TURN UDP'
  ufw allow 50000:50199/udp comment 'LiveKit WebRTC UDP'
fi

echo
echo "LiveKit ${LIVEKIT_VERSION} is running and Slopesmith has its private credentials."
echo "Slopesmith voice room: ${VOICE_ROOM}"
echo "Allow these inbound ports in the provider/cloud firewall:"
echo "  TCP 7881"
echo "  UDP 3478"
echo "  UDP 50000-50199"
echo "Do not expose TCP 7880; signaling reaches it through Slopesmith on loopback."
