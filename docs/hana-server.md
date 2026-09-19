# hana-server deployment

Deployed alongside crypto-tax, risu, and kura. Procedure: `hana-deploy` skill
(`~/.grok/skills/hana-deploy`). Site content (landing page, Caddyfile) lives
in its own repo, `~/Developer/hana-server` — not here.

- **Port**: `8790` (LAN Caddy `:80` → `127.0.0.1:8790`; Tailscale direct)
- **LAN**: http://tanuki.hana-server/
- **Tailscale**: http://hana-server.taile9bee4.ts.net:8790/
- **SQLite**: `~/tanuki-data/tanuki.db` on hana-server (container volume `/data`)
- **Mac backups**: `~/Documents/Finances/tanuki-backups/`, daily timer ~01:30 UTC
  (staggered after crypto-tax ~00:00, risu ~00:30, kura ~01:00)
- **Quadlet**: `~/.config/containers/systemd/tanuki.container`, image `localhost/tanuki:latest`
- **Redeploy**: `./scripts/deploy-hana.sh` from repo root (rsyncs, rebuilds, restarts)

## Notes

- The Dockerfile already defaults `PORT=8790`, `TANUKI_DB_PATH=/data/tanuki.db`,
  `HOST=0.0.0.0` — deploying to a different port needs `DEPLOY_PORT` env on
  `deploy-hana.sh` *and* matching `Environment=PORT=` in the Quadlet it writes.
- `scripts/install-hana-backup.sh` tests both the LAN `macbook` SSH alias and
  the Tailscale hostname before installing the timer, and proceeds if either
  works (the actual nightly `hana-backup.sh` already tries both at push time).
  If the LAN alias is stale (this Mac's IP drifts — it's DHCP, not reserved),
  Tailscale alone is enough; the timer still gets installed.
