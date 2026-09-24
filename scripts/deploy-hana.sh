#!/usr/bin/env bash
# Deploy Tanuki to a Podman host (default: jimmy@hana-server).
#
# Builds the image on the server (hana is amd64; a Mac is not) and runs it
# as a user Quadlet so it comes back after reboot.
#
# crypto-tax/risu/kura already own :8787-8789 on hana, so this defaults to :8790.
#
#   ./scripts/deploy-hana.sh
#   ./scripts/deploy-hana.sh --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-jimmy@hana-server}"
REMOTE_APP="${DEPLOY_REMOTE_APP:-tanuki}"
REMOTE_DATA="${DEPLOY_REMOTE_DATA:-tanuki-data}"
PORT="${DEPLOY_PORT:-8790}"
IMAGE="${DEPLOY_IMAGE:-localhost/tanuki:latest}"
# Every app on hana runs with Network=host, so risu is on localhost. Its
# LAN name (risu.hana-server) doesn't resolve on hana itself.
RISU_URL="${DEPLOY_RISU_URL:-http://127.0.0.1:8788}"
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run]

rsync this repo to ${HOST}:~/${REMOTE_APP}, podman build, install a Quadlet
unit, start it on :${PORT}. SQLite lives in ~/${REMOTE_DATA}/tanuki.db.

Env:
  DEPLOY_HOST          SSH target          (default: jimmy@hana-server)
  DEPLOY_PORT          host port           (default: 8790)
  DEPLOY_REMOTE_APP    remote source dir   (default: tanuki)
  DEPLOY_REMOTE_DATA   remote sqlite dir   (default: tanuki-data)
  DEPLOY_IMAGE         image tag           (default: localhost/tanuki:latest)
  DEPLOY_RISU_URL      risu's HTTP API     (default: http://127.0.0.1:8788)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

RSYNC_EXCLUDES=(
  --exclude .git
  --exclude .idea
  --exclude .claude
  --exclude .cursor
  --exclude .grok
  --exclude node_modules
  --exclude apps/*/node_modules
  --exclude packages/*/node_modules
  --exclude apps/web/dist
  --exclude apps/api/dist
  --exclude packages/core/dist
  --exclude data
  --exclude tmp
  --exclude coverage
  --exclude .env
  --exclude .env.local
  --exclude '*.db'
  --exclude '*.db-journal'
  --exclude '*.db-wal'
  --exclude '*.db-shm'
  --exclude .DS_Store
)

echo "==> rsync ${ROOT}/ -> ${HOST}:${REMOTE_APP}/"
rsync -az --delete --stats \
  "${RSYNC_EXCLUDES[@]}" \
  "${ROOT}/" \
  "${HOST}:${REMOTE_APP}/"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> dry-run: skip build and start"
  ssh -o BatchMode=yes "$HOST" "ls -la ${REMOTE_APP} | head; echo '--- Dockerfile ---'; test -f ${REMOTE_APP}/Dockerfile && echo ok"
  exit 0
fi

echo "==> build + start on ${HOST}"
# shellcheck disable=SC2087
ssh -o BatchMode=yes "$HOST" \
  env PORT="$PORT" IMAGE="$IMAGE" REMOTE_APP="$REMOTE_APP" REMOTE_DATA="$REMOTE_DATA" \
    RISU_URL="$RISU_URL" \
  bash -s <<'REMOTE'
set -euo pipefail

APP="${HOME}/${REMOTE_APP}"
DATA="${HOME}/${REMOTE_DATA}"
QUADLET_DIR="${HOME}/.config/containers/systemd"
UNIT_NAME="tanuki"

cd "$APP"
mkdir -p "$DATA" "$QUADLET_DIR"

echo "==> podman build ${IMAGE}"
podman build -t "$IMAGE" .

cat >"${QUADLET_DIR}/${UNIT_NAME}.container" <<EOF
[Unit]
Description=tanuki API + web UI

[Container]
Image=${IMAGE}
ContainerName=tanuki
Network=host
Volume=${DATA}:/data:Z
Environment=TANUKI_DB_PATH=/data/tanuki.db
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0
Environment=SERVE_WEB=1
Environment=NODE_ENV=production
Environment=WEB_DIST_PATH=/app/apps/web/dist
Environment=RISU_URL=${RISU_URL}

[Service]
Restart=always

[Install]
WantedBy=default.target
EOF

if podman container exists tanuki 2>/dev/null; then
  if ! systemctl --user is-active --quiet tanuki.service 2>/dev/null; then
    podman stop tanuki >/dev/null 2>&1 || true
    podman rm tanuki >/dev/null 2>&1 || true
  fi
fi

# Quadlet generates the unit; do not `enable` (fails: transient or generated).
systemctl --user daemon-reload
systemctl --user restart tanuki.service

echo "==> wait for /api/health"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

echo
systemctl --user --no-pager --full status tanuki.service | head -20
echo
podman ps --filter name=tanuki
echo
if [[ "$ok" -eq 1 ]]; then
  curl -fsS "http://127.0.0.1:${PORT}/api/health"
  echo
else
  echo "health check did not pass; last logs:" >&2
  journalctl --user -u tanuki.service -n 80 --no-pager >&2 || true
  podman logs tanuki 2>&1 | tail -80 >&2 || true
  exit 1
fi

linger="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)"
if [[ "$linger" != "yes" ]]; then
  echo
  echo "Linger is off — the container dies when you log out."
  echo "  sudo loginctl enable-linger $(id -un)"
fi

echo
echo "LAN:       http://tanuki.hana-server/   (Caddy :80)"
echo "Tailscale: http://hana-server.taile9bee4.ts.net:${PORT}/"
echo "SQLite: ${DATA}/tanuki.db"
echo
echo "UFW Tailscale only (not LAN, not Anywhere):"
echo "  sudo ufw allow from 100.64.0.0/10 to any port ${PORT} proto tcp comment 'tanuki tailscale'"
echo "Caddy: http://tanuki.hana-server { reverse_proxy 127.0.0.1:${PORT} }"
echo "Index: /var/www/hana/index.html"
echo "Mac /etc/hosts: 192.168.50.92 … tanuki.hana-server"
REMOTE

echo "==> backup timer (hana -> this Mac)"
"${ROOT}/scripts/install-hana-backup.sh"
