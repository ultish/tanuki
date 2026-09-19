#!/usr/bin/env bash
# Run from the Mac. Sets up hana → Mac sqlite backups for Tanuki:
#   1. reuse the existing hana → macbook backup key
#   2. daily systemd user timer on hana (snapshot + rsync)
#
# Live sqlite on hana: ~/tanuki-data/tanuki.db
# Mac archive:         ~/Documents/Finances/tanuki-backups
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-jimmy@hana-server}"
REMOTE_APP="${DEPLOY_REMOTE_APP:-tanuki}"
MAC_USER="${BACKUP_MAC_USER:-jxhui}"
MAC_TS="${BACKUP_MAC_TS:-jimmys-macbook-pro-16}"
MAC_DIR="${BACKUP_MAC_DIR:-Documents/Finances/tanuki-backups}"
AUTH_KEYS="${HOME}/.ssh/authorized_keys"

echo "==> rsync backup scripts to ${HOST}:${REMOTE_APP}/scripts/"
ssh -o BatchMode=yes "$HOST" "mkdir -p ${REMOTE_APP}/scripts"
rsync -az \
  "${ROOT}/scripts/backup-sqlite.py" \
  "${ROOT}/scripts/hana-backup.sh" \
  "${HOST}:${REMOTE_APP}/scripts/"

echo "==> ensure backup ssh key + macbook alias on hana"
ssh -o BatchMode=yes "$HOST" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p ~/.ssh
chmod 700 ~/.ssh
key="$HOME/.ssh/id_ed25519_cryptotax"
if [[ ! -f "$key" ]]; then
  ssh-keygen -t ed25519 -N "" -f "$key" -C "hana-backup@hana-server"
fi
chmod 600 "$key" "$key.pub"
if [[ ! -f "$HOME/.ssh/config" ]] || ! grep -q '^Host macbook$' "$HOME/.ssh/config"; then
  umask 077
  cat >>~/.ssh/config <<EOF
Host macbook
  HostName 192.168.50.160
  User jxhui
  IdentityFile ~/.ssh/id_ed25519_cryptotax
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new

Host 192.168.50.160 jimmys-macbook-pro-16 jimmys-macbook-pro-16.taile9bee4.ts.net 100.113.170.47
  User jxhui
  IdentityFile ~/.ssh/id_ed25519_cryptotax
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
fi
REMOTE

PUB="$(ssh -o BatchMode=yes "$HOST" 'cat ~/.ssh/id_ed25519_cryptotax.pub')"
if [[ -z "$PUB" ]]; then
  echo "failed to read pubkey from hana" >&2
  exit 1
fi

mkdir -p "$(dirname "$AUTH_KEYS")" "$HOME/$MAC_DIR"
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"

if grep -Fq "$PUB" "$AUTH_KEYS"; then
  echo "==> pubkey already in ${AUTH_KEYS}"
else
  echo "==> authorize hana backup key on this Mac"
  printf 'restrict %s\n' "$PUB" >>"$AUTH_KEYS"
fi

echo "==> test hana -> ${MAC_USER}@macbook (LAN alias)"
lan_ok=1
ssh -o BatchMode=yes "$HOST" \
  "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new macbook 'mkdir -p ~/${MAC_DIR} && echo lan-ssh-ok'" \
  || lan_ok=0
echo "==> Tailscale fallback ${MAC_USER}@${MAC_TS}"
ts_ok=1
ssh -o BatchMode=yes "$HOST" \
  "ssh -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519_cryptotax ${MAC_USER}@${MAC_TS} 'mkdir -p ~/${MAC_DIR} && echo ts-ssh-ok'" \
  || ts_ok=0

if [[ "$lan_ok" -eq 0 && "$ts_ok" -eq 0 ]]; then
  echo "Mac unreachable on both LAN (${HOME}/.ssh/config 'macbook' alias) and Tailscale (${MAC_TS})." >&2
  echo "hana-backup.sh will retry both nightly, so the timer is still worth installing," >&2
  echo "but neither path works right now — fix connectivity, or continue anyway." >&2
elif [[ "$lan_ok" -eq 0 ]]; then
  echo "(LAN unreachable — Tailscale is enough for now)"
fi

echo "==> install daily timer on hana"
# shellcheck disable=SC2087
ssh -o BatchMode=yes "$HOST" \
  env REMOTE_APP="$REMOTE_APP" \
  bash -s <<'REMOTE'
set -euo pipefail
APP="${HOME}/${REMOTE_APP}"
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "$UNIT_DIR" "${HOME}/tanuki-data" "${HOME}/tanuki-backups"
chmod +x "${APP}/scripts/hana-backup.sh" "${APP}/scripts/backup-sqlite.py"

cat >"${UNIT_DIR}/tanuki-backup.service" <<EOF
[Unit]
Description=tanuki sqlite snapshot + push to Mac
After=tanuki.service

[Service]
Type=oneshot
ExecStart=${APP}/scripts/hana-backup.sh
EOF

# 01:30 UTC so it does not collide with crypto-tax (00:00), risu (00:30), kura (01:00).
cat >"${UNIT_DIR}/tanuki-backup.timer" <<'EOF'
[Unit]
Description=Daily tanuki sqlite backup (no-op if unchanged)

[Timer]
OnCalendar=*-*-* 01:30:00
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now tanuki-backup.timer
systemctl --user start tanuki-backup.service
systemctl --user --no-pager --full status tanuki-backup.timer | head -15
echo
ls -la "${HOME}/tanuki-backups" 2>/dev/null || true
REMOTE

echo
echo "Timer is daily (~01:30 UTC). Unchanged DB = no new file. Mac asleep = retry next day."
echo "Live sqlite on hana: ~/tanuki-data/tanuki.db"
echo "Mac copies:          ~/${MAC_DIR}/"
echo "Hana spool:          ~/tanuki-backups/"
