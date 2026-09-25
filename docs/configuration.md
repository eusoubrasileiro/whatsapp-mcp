# Configuration

All configuration is environment variables. The production values live in `deploy/.env`
(template: [`deploy/.env.example`](../deploy/.env.example)).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_MCP_DATA_DIR` | `.` | Base directory for `auth_info/`, `data/`, and pino log files |
| `LOG_LEVEL` | `info` | Pino log level |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `httpstream` (the Docker image sets `httpstream`) |
| `MCP_HOST` | `127.0.0.1` | Bind host when `MCP_TRANSPORT=httpstream` |
| `MCP_PORT` | `3001` | Bind port when `MCP_TRANSPORT=httpstream` (the Docker image sets `39001`) |
| `MCP_ENDPOINT` | `/mcp` | HTTP path for MCP when `MCP_TRANSPORT=httpstream` |
| `MCP_AUTH_TOKEN` | _(unset)_ | If set, HTTP MCP requires `Authorization: Bearer <token>`. If unset, endpoint accepts unauthenticated requests (stdio/local dev only — never run like this in prod). |
| `QR_SERVER_HOST` | `127.0.0.1` | Bind host for the public QR web page |
| `QR_SERVER_PORT` | `39002` | Bind port for the QR web page |
| `UPLOAD_SERVER_HOST` | `127.0.0.1` | Bind host for the host-disk upload endpoint (only started when `S3_ENABLED=true`) |
| `UPLOAD_SERVER_PORT` | `39003` | Bind port for the upload endpoint. Exposed publicly via Traefik at `mcp.example.com/upload`. Reuses `MCP_AUTH_TOKEN` for Bearer auth. |
| `STREAM_SERVER_HOST` | `127.0.0.1` | Bind host for the `follow_chat` WebSocket presence stream. |
| `STREAM_SERVER_PORT` | `39004` | Bind port for the stream server. Must be exposed publicly via Traefik at `mcp.example.com/stream` (WebSocket upgrade). |
| `STREAM_PUBLIC_URL` | _(derived: `ws://<host>:<port>/stream`)_ | Public base URL `follow_chat` embeds in the returned `ws_url`. Prod: `wss://mcp.example.com/stream`. |
| `STREAM_TOKEN_TTL_S` | `1800` | Lifetime (seconds) of a `follow_chat` stream token. In-memory only; scoped to the requested jids + flags; treated as a bearer secret. |
| `PUBLIC_QR_URL` | _(derived: `http://<QR_SERVER_HOST>:<QR_SERVER_PORT>/`, `localhost` for a wildcard bind)_ | URL sent in ntfy `Click` header and message text so tapping the push opens the QR page. Set it to the public QR page (e.g. `https://wa.example.com/`) in any deployment you pair from a phone |
| `NTFY_TOPIC_URL` | _(unset)_ | ntfy.sh topic URL; unset = notifications disabled |
| `NTFY_TOKEN` | _(unset)_ | Bearer token for protected ntfy topics |
| `EXPECTED_WA_NUMBER` | _(unset)_ | If set, only pairings whose JID starts with this prefix are accepted. A mismatch triggers `socket.logout()`, purges `auth_info/`, and fires an ntfy alert. Critical when the QR page is publicly reachable. |
| `S3_ENABLED` | `false` | Set to `true` to enable the S3-compatible media plane. Required for `download_media` to work in remote deployments. Prod uses RustFS running as a sidecar in the same compose stack — no managed cloud, no extra bill. |
| `S3_ENDPOINT` | `localhost` | S3 endpoint hostname (dev/prod: `minio` (runs RustFS; service name kept for DNS compat) — service name on the docker network). |
| `S3_PORT` | `9000` | Port for the S3 endpoint. Always `9000` for the RustFS sidecar. |
| `S3_USE_SSL` | `false` | Always `false` — Traefik terminates TLS in front of RustFS; the app talks to RustFS in-cluster over HTTP. |
| `S3_ACCESS_KEY` | `minioadmin` | S3 access key. Prod: same value as `MINIO_ROOT_USER`. |
| `S3_SECRET_KEY` | `minioadmin` | S3 secret key. Prod: same value as `MINIO_ROOT_PASSWORD`. |
| `S3_BUCKET` | `amiticia-media` | Bucket name. The `mc` init sidecar creates it on first boot. |
| `S3_REGION` | `us-east-1` | Bucket region (cosmetic for RustFS; SDK still requires it). |
| `S3_SKIP_POLICY` | `false` | Keep `false` — RustFS accepts `setBucketPolicy`, so the app sets the public-read policy at boot. |
| `MEDIA_PUBLIC_BASE_URL` | _(derived from endpoint)_ | Public base URL prefix for media. Dev: `http://localhost:9000/amiticia-media`. Prod: `https://mcp.example.com/media` (Traefik path-based route, see `deploy/docker-compose.yaml`). |
| `TENANT_ID` | `default` | Object key prefix: `t/{tenantId}/…`. One WhatsApp account per instance, so one tenant. |
| `MEDIA_INLINE_MAX_BYTES` | `5242880` | Max file size (bytes) for inline `imageContent`/`audioContent` in tool response. |
| `SEND_ACK_WAIT_MS` | `3000` | How long `send_message` / `send_file` wait for a server rejection ack before declaring the send accepted. Observed ack latency is ~40 ms, so the default carries ~75× headroom. `0` disables the wait (restores fire-and-forget: a refused send reports success again). |
| `SEND_PRESEND_CHECK` | `true` | Verify the recipient exists via `onWhatsApp()` before sending, and upgrade a phone JID to its canonical `@lid`. Set `false` to send to exactly the JID given, unverified. |
| `SEND_BLOCKLIST_ENABLED`, `SEND_COLD_CONTACT_GUARD`, `SEND_COLD_OVERRIDE`, `SEND_COLD_ALLOWED_JIDS`, `SEND_RATE_LIMIT_*`, `SEND_SIMULATE_TYPING`, `SEND_TYPING_MAX_MS` | see doc | The anti-ban guard chain. Defaults, effects and the per-instance policy: **[`account-restrictions.md`](./account-restrictions.md)**. These are risk-owner settings — don't change one to make a send go through. |
| `HEALTH_DISCONNECTED_GRACE_S` | `300` | How long the WhatsApp socket may be disconnected before `/health` returns 503. Guards against the failure where the container reported `healthy` through a 21-hour outage. |
| `OPENROUTER_API_KEY` | _(unset)_ | Enables `download_media`'s `transcribe` (Whisper `openai/whisper-large-v3`, the default audio route) and `describe` (vision model) flags. |
| `AUDIO_PROVIDER` | `openrouter` | Transcription route: `openrouter` \| `groq` \| `openai`. Rollback lanes kept deliberately; an unknown value throws rather than silently guessing. **Routing is never by key presence** — a leftover `GROQ_API_KEY` must not quietly keep traffic on a closed account. |
| `GROQ_API_KEY` | _(unset)_ | Only used when `AUDIO_PROVIDER=groq` (rollback; `whisper-large-v3`). |
| `OPENAI_API_KEY` | _(unset)_ | Only used when `AUDIO_PROVIDER=openai` (rollback; `whisper-1`). |
| `WHISPER_MODEL` | _(per-route default)_ | Override the Whisper model on whichever route is active. |
| `VISION_MODEL` | `openai/gpt-6-luna` | OpenRouter model id used by `download_media`'s `describe` flag. Any image-input model works. |
| `FFMPEG_BIN` | `ffmpeg` | Path to the ffmpeg binary used for audio preprocessing before Whisper. |

## Data storage

Paths are relative to `WHATSAPP_MCP_DATA_DIR` (defaults to `.` when running via `pnpm start`, `/data` in the Docker image):

- `auth_info/` - WhatsApp authentication (Baileys multi-file auth state)
- `data/whatsapp.db` - SQLite database (chats, messages, contacts)
- `backups/hourly/whatsapp.db` - Rolling hourly snapshot (overwritten, WAL-safe)
- `backups/daily/whatsapp-YYYY-MM-DD.db` - Per-day snapshots (14-day retention)
- `backups/daily/auth_info-YYYY-MM-DD.tar.gz` - Per-day auth tarball
- `wa-logs.txt` - WhatsApp/Baileys logs
- `mcp-logs.txt` - MCP server logs

> **Media**: downloaded media is stored in a RustFS sidecar in the same compose stack (bind-mounted at `/storage/whatsapp-mcp/minio` in the production compose). It is served publicly through Traefik at `https://mcp.example.com/media/<key>` — no separate subdomain, no managed cloud bucket, no recurring bill. The legacy `data/media/` directory existed in older deployments — run `scripts/backfill-media.sh` inside the container to upload existing files into RustFS; the script then drops the legacy column.

All data directories are gitignored for security.

## Database schema

SQLite in WAL mode. The authoritative definitions are `src/db/schema.ts` (Drizzle types) and
`src/db/ddl.ts` (the idempotent `CREATE TABLE` / additive `ALTER TABLE` statements run at
boot). There is no migration runner, so a new table or column must be declared in **both**.

| Table | Holds |
|---|---|
| `chats` | One row per chat JID, with name and `last_message_time` |
| `messages` | Primary key `(id, chat_jid)`. Text content plus media metadata (`media_type`, `mimetype`, `media_key`, `direct_path`, `file_length`, hashes) and `media_object_key` once the media has been copied to S3 (`t/{tenantId}/{sanitizedJid}/{msgId}.{ext}`) |
| `contacts` | JID, saved name, push name (`notify`), phone number |
| `jid_aliases` | Maps phone-number JIDs and `@lid` JIDs of the same person to one `canonical_jid`, so filters and guards cannot be bypassed by a PN/LID mismatch |
| `webhook_subscriptions` | Outbound webhook registrations — see [`webhooks.md`](./webhooks.md) |
| `send_blocklist` | Recipients WhatsApp refused with a 463 while cold. Durable across sessions; clearing an entry is a manual SQL delete, deliberately |
| `schema_meta` | Internal key/value markers for one-off data migrations |
