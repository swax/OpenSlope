#!/usr/bin/env bash
set -euo pipefail

readonly HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly STATE_ROOT='/var/lib/slopesmith-update'
readonly UPDATE_CONFIG='/etc/slopesmith-update.env'

if [[ $(id -u) -ne 0 ]]; then
  echo 'usage: sudo install-updater.sh' >&2
  exit 77
fi
getent passwd slopesmith >/dev/null
getent group slopesmith >/dev/null

if [[ -L "$UPDATE_CONFIG" || ( -e "$UPDATE_CONFIG" && ! -f "$UPDATE_CONFIG" ) ]]; then
  echo "$UPDATE_CONFIG must be a regular file, not a link" >&2
  exit 65
fi
if [[ ! -e "$UPDATE_CONFIG" ]]; then
  install -o root -g root -m 0600 "$HERE/slopesmith-update.env.example" "$UPDATE_CONFIG"
  echo "Installed $UPDATE_CONFIG with the OpenSlope repository default. Edit it to follow a fork."
else
  chown root:root "$UPDATE_CONFIG"
  chmod 0600 "$UPDATE_CONFIG"
  echo "Preserved the existing $UPDATE_CONFIG."
fi

install -d -o root -g root -m 0755 "$STATE_ROOT"
install -d -o root -g slopesmith -m 0770 "$STATE_ROOT/inbox"
install -d -o root -g slopesmith -m 0750 "$STATE_ROOT/logs"
install -d -o root -g root -m 0755 /etc/systemd/system/slopesmith.service.d

# Give the web service only the source identifier needed by the admin UI, never the rest of the root config.
# The runner refreshes this record on every request, so later config edits appear after the next version check.
# shellcheck disable=SC1091 -- fixed, root-owned machine configuration validated above.
source "$UPDATE_CONFIG"
repository="${SLOPESMITH_UPDATE_REPOSITORY:-https://github.com/swax/OpenSlope.git}"
if [[ -z "$repository" || "$repository" == -* || "$repository" == *$'\n'* || "$repository" == *$'\r'*
      || "$repository" =~ ^https?://[^/]*@ ]]; then
  echo 'SLOPESMITH_UPDATE_REPOSITORY is invalid' >&2
  exit 65
fi
repository_temp=$(mktemp "$STATE_ROOT/.repository.XXXXXXXXXX")
printf '%s\n' "$repository" > "$repository_temp"
chown root:slopesmith "$repository_temp"
chmod 0640 "$repository_temp"
mv -Tf -- "$repository_temp" "$STATE_ROOT/repository"

# All privileged pieces are copied from the reviewed release into root-owned locations. The web service can
# write only an exact commit request into the inbox; it cannot replace any code that root executes.
install -o root -g root -m 0755 "$HERE/deploy-slopesmith" /usr/local/sbin/deploy-slopesmith
install -o root -g root -m 0755 "$HERE/slopesmith-update-runner" /usr/local/sbin/slopesmith-update-runner
install -o root -g root -m 0644 "$HERE/slopesmith-update.service" /etc/systemd/system/slopesmith-update.service
install -o root -g root -m 0644 "$HERE/slopesmith-update.path" /etc/systemd/system/slopesmith-update.path
install -o root -g root -m 0644 "$HERE/slopesmith-update.conf" \
  /etc/systemd/system/slopesmith.service.d/update.conf

systemctl daemon-reload
systemctl enable slopesmith-update.path
# Restart rather than only starting: a repeat installation must replace the active path unit's watched files.
systemctl restart slopesmith-update.path
if systemctl is-active --quiet slopesmith.service; then
  systemctl restart slopesmith.service
fi

echo 'Slopesmith automatic updates are installed.'
