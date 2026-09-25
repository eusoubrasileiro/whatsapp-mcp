# whatsapp-mcp stack — ops runbook

Long-lived `whatsapp-mcp` container on a VPS behind Traefik. With `MCP_DOMAIN=mcp.example.com` and `QR_DOMAIN=wa.example.com` in `deploy/.env` (substitute your own hostnames), it publishes:

- `https://mcp.example.com/mcp` — Bearer-auth MCP endpoint (whatsapp-mcp:39001)
- `https://mcp.example.com/upload` — Bearer-auth host-disk upload endpoint (whatsapp-mcp:39003). Agents POST raw bytes here, get back `{url}`, then pass it to `send_file`. Same `MCP_AUTH_TOKEN` as `/mcp`. See [`docs/tools.md`](../docs/tools.md#sending-host-disk-files-the-upload-endpoint).
- `https://mcp.example.com/media/<key>` — public media URLs served by a sibling RustFS container (path-rewrite via Traefik to `minio:9000/amiticia-media/<key>`). No extra DNS record — same host, same TLS cert.
- `wss://mcp.example.com/stream` — `follow_chat` WebSocket presence stream (whatsapp-mcp:39004). Scoped short-lived token gate enforced inside the app; the token rides the query string (`?token=…`). See [`docs/agent-presence-stream-recipe.md`](../docs/agent-presence-stream-recipe.md).
- `https://wa.example.com/` — public QR page

Audience: whoever operates the stack — which network, which certresolver, which token. Start here.

## Prerequisites

- Docker 28+ on the VPS (`ssh <vps>` below)
- Traefik v3 running, certresolver named **`myresolver`** (ACME TLS-ALPN, Let's Encrypt), attached to `network_public` — or edit the compose labels to match yours
- If `image:` points at a private registry, the VPS's docker is logged in to it
- DNS: `mcp` and `wa` records (your `MCP_DOMAIN` / `QR_DOMAIN`) pointing at the VPS
  - If the zone is on Cloudflare, keep both records **DNS only (grey cloud)** — Traefik uses the TLS-ALPN challenge, which the CF proxy would break.

## First-time deploy

```bash
ssh <vps>

# 1. clone both repos side by side
cd /opt
git clone https://github.com/eusoubrasileiro/whatsapp-mcp.git
git clone https://github.com/eusoubrasileiro/baileys-client.git

# 2. build image (baileys-client is linked via BuildKit --build-context)
cd /opt
DOCKER_BUILDKIT=1 docker build \
  --build-context baileys=/opt/baileys-client \
  -t ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /opt/whatsapp-mcp

# 3. create .env
cd /opt/whatsapp-mcp/deploy
cp .env.example .env
chmod 600 .env
vi .env
# fill:
#   MCP_DOMAIN=mcp.example.com         # your hostnames — compose refuses to start without them
#   QR_DOMAIN=wa.example.com
#   MCP_AUTH_TOKEN=<openssl rand -hex 32>
#   NTFY_TOPIC_URL=https://ntfy.sh/<long-random-topic>
#   EXPECTED_WA_NUMBER=                # leave empty on first boot (we don't know the JID yet)
#   MINIO_ROOT_USER=<openssl rand -hex 8>       # env name kept; compose remaps to RUSTFS_ROOT_USER
#   MINIO_ROOT_PASSWORD=<openssl rand -hex 32>  # env name kept; compose remaps to RUSTFS_ROOT_PASSWORD
#   SEND_COLD_OVERRIDE / SEND_COLD_ALLOWED_JIDS  # per-instance send policy — see docs/account-restrictions.md
# (S3_ACCESS_KEY/S3_SECRET_KEY in compose.yaml use ${MINIO_ROOT_USER}/${MINIO_ROOT_PASSWORD}; no second pair to manage.)

# 4. prepare the bind mounts and deploy
mkdir -p /storage/whatsapp-mcp /storage/whatsapp-mcp/minio
chown -R 10001:10001 /storage/whatsapp-mcp/minio
docker compose up -d

# 5. wait + verify
until [ "$(docker inspect -f '{{.State.Health.Status}}' whatsapp-mcp 2>/dev/null)" = "healthy" ]; do sleep 2; done
docker logs whatsapp-mcp | tail -20

# 6. check endpoints externally (Traefik + Let's Encrypt)
curl -sS https://wa.example.com/health
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/mcp \
  -H 'Authorization: Bearer WRONG' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}'
# expect 401

# 7. scan QR
# open https://wa.example.com/ on phone, WhatsApp > Linked Devices > Link

# 8. lock down EXPECTED_WA_NUMBER — after first successful pairing
docker exec whatsapp-mcp grep -E 'username|myPN' /data/wa-logs.txt | tail -3
# find your JID, then:
vi /opt/whatsapp-mcp/deploy/.env
#   EXPECTED_WA_NUMBER=<your full JID prefix, e.g. 5511999999999>
docker compose up -d --force-recreate
```

## Update / redeploy (after code change upstream)

```bash
ssh <vps>
cd /opt/whatsapp-mcp && git pull
cd /opt/baileys-client && git pull   # only if baileys-client changed
DOCKER_BUILDKIT=1 docker build \
  --build-context baileys=/opt/baileys-client \
  -t ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /opt/whatsapp-mcp
cd /opt/whatsapp-mcp/deploy
docker compose up -d --force-recreate
docker logs -f whatsapp-mcp   # watch it recover
```

Auth state in `/data/auth_info/` and the SQLite DB at `/data/data/whatsapp.db` are preserved across recreates via the host bind mount `/storage/whatsapp-mcp:/data`. You do NOT re-scan the QR on updates.

> **Upgrading from a compose file with hard-coded hostnames?** Before the `git pull`, copy the
> hostnames and any `SEND_COLD_OVERRIDE` / `SEND_COLD_ALLOWED_JIDS` values from the deployed
> `docker-compose.yaml` into `.env` as `MCP_DOMAIN`, `QR_DOMAIN`, `SEND_COLD_OVERRIDE` and
> `SEND_COLD_ALLOWED_JIDS`. Missing hostnames make `docker compose` refuse to start (nothing is
> touched); a missing allowlist fails safe — sends to those numbers are refused until it is set.
> `docker compose config` shows the result before you apply it.

## Rotate MCP_AUTH_TOKEN

```bash
ssh <vps>
NEW=$(openssl rand -hex 32)
cd /opt/whatsapp-mcp/deploy
sed -i "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$NEW/" .env
docker compose up -d --force-recreate

# then update every MCP client:
echo "new token: $NEW"
# - ~/.claude.json on every dev machine
# - Claude Desktop config on every machine
# - Cursor config on every machine
# Until updated, those clients hit HTTP 401.
```

## Logs

```bash
ssh <vps>

# FastMCP stdout (sparse — mostly startup messages)
docker logs -f whatsapp-mcp

# MCP server pino logs (tool invocations, auth, session)
docker exec whatsapp-mcp tail -f /data/mcp-logs.txt

# Baileys + ntfy + connection-notifier pino logs (QR, pairing, disconnect, push attempts)
docker exec whatsapp-mcp tail -f /data/wa-logs.txt

# Find something specific
docker exec whatsapp-mcp grep -iE 'ntfy|error|loggedOut' /data/wa-logs.txt | tail -20
```

## Media plane (RustFS sidecar)

Media downloaded by the `download_media` tool is uploaded to a `minio` service (runs RustFS) in this same compose file. The bucket `amiticia-media` is created by a one-shot `minio-init` (`rustfs/rc`) container and set to anonymous-read. Public URLs look like:

```
https://mcp.example.com/media/t/default/<sanitizedJid>/<msgId>.<ext>
```

Traefik strips the `/media/` prefix and forwards to `minio:9000/amiticia-media/<key>` via a `replacepathregex` middleware. There is **no** new DNS record, **no** subdomain, **no** managed cloud bucket — just one extra container on the same `network_public`.

Storage is bind-mounted at `/storage/whatsapp-mcp/minio`, so an offsite backup of the `/storage/whatsapp-mcp` tree covers it.

Sanity-check after deploy:

```bash
ssh <vps>
docker compose -f /opt/whatsapp-mcp/deploy/docker-compose.yaml ps
# expect: whatsapp-mcp Up (healthy), whatsapp-mcp-minio Up (healthy), whatsapp-mcp-minio-init Exited (0)

# bucket exists and is anon-readable
docker run --rm --network network_public \
  -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
  rustfs/rc:latest \
  sh -c 'rc alias set local http://whatsapp-mcp-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && rc anonymous get local/amiticia-media'
# → "download" (or "public")

# Traefik route
curl -sS -o /dev/null -w "%{http_code}\n" https://mcp.example.com/media/probe-does-not-exist
# expect 404 (Not Found from RustFS) — proves routing is wired
```

After a backfill (`scripts/backfill-media.sh`, only for deployments older than the media plane), pick any row with `media_object_key IS NOT NULL` and `curl -I` its public URL — should return `HTTP/2 200`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `https://wa.example.com/` returns TLS error | CF proxy on (orange cloud) blocks Let's Encrypt TLS-ALPN | Flip CF record to DNS-only (grey); wait a few minutes for Traefik to retry |
| `https://mcp.example.com/mcp` returns 404 from Traefik | Container exited, or label typo | `docker ps --filter name=whatsapp-mcp`; verify labels match Traefik entrypoints (`websecure`) and certresolver (`myresolver`) |
| `/media/<key>` returns 404 but the key exists | `rc anonymous` not set, or wa-media router has lower priority than wa-mcp | `docker logs whatsapp-mcp-minio-init`; ensure `priority=100` on `wa-media` router; `docker run --rm --network network_public rustfs/rc:latest sh -c 'rc alias set local http://whatsapp-mcp-minio:9000 ... && rc anonymous set download local/amiticia-media'` |
| `/media/<key>` returns 403 / `AccessDenied` | Bucket policy not applied | The app's `ensureBucketReady()` runs at boot and sets the policy; check `docker logs whatsapp-mcp` for `setBucketPolicy` errors. As a fallback: `docker run --rm --network network_public rustfs/rc:latest sh -c 'rc alias set local http://whatsapp-mcp-minio:9000 ... && rc anonymous set download local/amiticia-media'` |
| HTTP 401 with the correct Bearer | `.env` drifted from clients | Rotate + resync all clients |
| ntfy push never arrives | Topic unsubscribed, `NTFY_TOPIC_URL` empty, or non-ASCII in title | Check `.env`, subscribe topic in ntfy app, `grep ntfy /data/wa-logs.txt` |
| "Linked as ?" in QR page after first pair | Old baileys-client — `state.user` was only populated after the first `creds.update` | Fixed in baileys-client (falls back to the JID's number until the name arrives); rebuild the image against a current checkout |
| Unexpected auto-logout + purge + push | `EXPECTED_WA_NUMBER` mismatch — someone else scanned the QR, or you paired a second device with a different number | Verify the expected number, re-scan from correct phone |
| Sync seems stuck / no messages | `wa-logs.txt` usually shows what step it's on (`history sync complete` is the success line) | If stuck, restart container. Creds preserved. |

## One-time migration: named volume → bind mount

If this stack was running before the `/storage/whatsapp-mcp` bind mount landed, it used a named volume (`whatsapp-mcp_whatsapp-mcp-data`). Migrate once:

```bash
ssh <vps>
cd /opt/whatsapp-mcp/deploy
docker compose down
mkdir -p /storage/whatsapp-mcp
docker run --rm \
  -v whatsapp-mcp_whatsapp-mcp-data:/from \
  -v /storage/whatsapp-mcp:/to \
  alpine cp -a /from/. /to/
ls -la /storage/whatsapp-mcp   # sanity check: auth_info/, data/, logs
docker compose up -d
# after verifying everything works:
docker volume rm whatsapp-mcp_whatsapp-mcp-data
```

## Backups (hourly snapshot + daily rotation)

`backup.sh` ships inside the image at `/app/whatsapp-mcp/scripts/backup.sh`. It uses `sqlite3 .backup` so the DB stays consistent even while the container writes (a plain `cp whatsapp.db` would capture a WAL-inconsistent file). Wire the host cron:

```bash
ssh <vps>
crontab -e
# add:
0 * * * * docker exec whatsapp-mcp /app/whatsapp-mcp/scripts/backup.sh >> /var/log/whatsapp-mcp-backup.log 2>&1
```

Output lands on the host thanks to the bind mount:

```
/storage/whatsapp-mcp/backups/hourly/whatsapp.db           # overwritten each hour, 48h retention
/storage/whatsapp-mcp/backups/daily/whatsapp-YYYY-MM-DD.db # once per day, 14d retention
/storage/whatsapp-mcp/backups/daily/auth_info-YYYY-MM-DD.tar.gz
```

## Restoring a DB — overwrite vs merge

Two different operations:

- **`restore.sh`** — replace the target DB with the source. Good for disaster recovery or restoring from a known-good backup.
- **`merge-db.sh`** — fold the source's chats/messages/contacts into the target, keeping everything that's already there. Good for importing long-lived history (e.g. a local bridge DB) into a VPS that's already running.

Both require the container to be stopped (WAL lock). The whatsapp-mcp image already ships `sqlite3` + both scripts at `/app/whatsapp-mcp/scripts/`, so we don't need a separate alpine container.

### Overwrite with restore.sh

```bash
ssh <vps>
cd /opt/whatsapp-mcp/deploy
docker compose stop
docker run --rm \
  -v /storage/whatsapp-mcp:/data \
  -v /tmp:/src \
  -v /opt/whatsapp-mcp/scripts:/scripts \
  --entrypoint sh \
  ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /scripts/restore.sh /src/source.db
# (add /src/auth_info.tar.gz as a 2nd arg to also restore auth — only if
#  you really want to displace the currently-paired linked device)
docker compose start
```

### Merge (additive, preserves current data + imports missing rows)

```bash
# 1. on the source machine (e.g. laptop with a long-running local bridge)
sqlite3 /path/to/source/data/whatsapp.db ".backup /tmp/old-wa.db"
tar czf /tmp/old-wa-media.tar.gz -C /path/to/source/data media
scp /tmp/old-wa.db /tmp/old-wa-media.tar.gz <vps>:/tmp/

# 2. on the VPS
ssh <vps>
# extract media first (-k keeps existing files on name collision):
tar xzkf /tmp/old-wa-media.tar.gz -C /storage/whatsapp-mcp/data/
cd /opt/whatsapp-mcp/deploy
docker compose stop
docker run --rm \
  -v /storage/whatsapp-mcp:/data \
  -v /tmp:/src \
  -v /opt/whatsapp-mcp/scripts:/scripts \
  --entrypoint sh \
  ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /scripts/merge-db.sh /src/old-wa.db
docker compose start
# cleanup:
rm -f /tmp/old-wa.db /tmp/old-wa-media.tar.gz
```

**Always restore DB only (not auth_info)** unless you really want to swap linked devices. Chats/messages reference contacts by JID (account-scoped), so an older DB is valid under the currently-paired device.

## Rollback after a bad restore/merge

The hourly cron wrote `/storage/whatsapp-mcp/backups/hourly/whatsapp.db` just before you touched anything. Step back to it:

```bash
docker compose stop
cp /storage/whatsapp-mcp/backups/hourly/whatsapp.db /storage/whatsapp-mcp/data/whatsapp.db
rm -f /storage/whatsapp-mcp/data/whatsapp.db-wal /storage/whatsapp-mcp/data/whatsapp.db-shm
docker compose start
```

Daily snapshots under `/storage/whatsapp-mcp/backups/daily/` give you 14 days of granularity.

## Cron alternatives (prefer these to root crontab)

Today the hourly snapshot runs from root's crontab. Not ideal — dedicated ops tooling is better:

### systemd timer (recommended upgrade path)

Run as a dedicated `whatsapp-mcp` system user with minimal privileges. Two units at `/etc/systemd/system/`:

```
# whatsapp-mcp-backup.service
[Unit]
Description=whatsapp-mcp hourly DB snapshot
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
# docker socket access requires group membership; adjust to your ops user
User=root
ExecStart=/usr/bin/docker exec whatsapp-mcp /app/whatsapp-mcp/scripts/backup.sh

# whatsapp-mcp-backup.timer
[Unit]
Description=Run whatsapp-mcp backup hourly

[Timer]
OnCalendar=hourly
Persistent=true
# lets it catch up if the host was offline at :00

[Install]
WantedBy=timers.target
```

Enable: `systemctl daemon-reload && systemctl enable --now whatsapp-mcp-backup.timer`. Logs land in the journal (`journalctl -u whatsapp-mcp-backup`), freshness is visible via `systemctl list-timers`, and failures trigger the unit's `OnFailure=` handler if wired (e.g. ntfy).

### docker-compose cron sidecar (ofelia)

If you want everything self-contained in the stack, add an `ofelia` sidecar that reads labels from the `whatsapp-mcp` container. No host privilege escalation. Tradeoff: one extra container running 24/7 just to fire one job.

### Keep root cron (current state)

Works. Root's socket access is already required to `docker exec`, so the blast radius is the same as running compose commands. Downside is visibility — failures go to `/var/log/whatsapp-mcp-backup.log` on disk and don't page anyone. If the container is down when cron fires, the docker exec just errors silently.

## Offsite backups (manual)

Backup directory is at `/storage/whatsapp-mcp/backups/` on the host. Point an offsite backup tool at it — Borg shown here. **No cron is wired for it in this stack today** — run it from wherever holds the backup repo (laptop, second disk, remote). Something like:

```bash
# example only — adapt to your Borg repo layout
borg create \
  --compression lz4 \
  /path/to/borg-repo::whatsapp-mcp-{now} \
  /storage/whatsapp-mcp/backups /storage/whatsapp-mcp/auth_info
```

## Related

- Image source: `github.com/eusoubrasileiro/whatsapp-mcp` (branch `main`)
- Shared client lib: `github.com/eusoubrasileiro/baileys-client` (branch `main`)
- User docs: [`README.md`](../README.md) and [`docs/`](../docs/)
