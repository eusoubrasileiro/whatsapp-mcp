# Configuration

All configuration is environment variables. In production there is one env file per program:
`deploy/.env` for the shared stack (the hub page; template
[`deploy/.env.example`](../deploy/.env.example)) and one `deploy/.env.<label>` per WhatsApp
number and its media store (template
[`deploy/instance.env.example`](../deploy/instance.env.example)). The
variables only the deploy files read are [below](#deploy-file-variables).

## Environment variables (one WhatsApp number)

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_MCP_DATA_DIR` | `.` | Base directory for `auth_info/`, `data/`, and pino log files |
| `LOG_LEVEL` | `info` | Pino log level |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `httpstream` (the Docker image sets `httpstream`) |
| `MCP_HOST` | `127.0.0.1` | Bind host when `MCP_TRANSPORT=httpstream` |
| `MCP_PORT` | `3001` | Bind port when `MCP_TRANSPORT=httpstream` (the Docker image sets `39001`) |
| `MCP_ENDPOINT` | `/mcp` | HTTP path for MCP when `MCP_TRANSPORT=httpstream` |
| `MCP_AUTH_TOKEN` | _(unset)_ | If set, HTTP MCP requires `Authorization: Bearer <token>`. If unset, endpoint accepts unauthenticated requests (stdio/local dev only — never run like this in prod). |
| `INSTANCE_LABEL` | _(unset)_ | Names this WhatsApp line (`a-z`, `0-9`, `-`, at most 32 characters; anything else is normalised). When set, the server instructions open by naming the line, `get_connection_status` returns it, every send result ends with `Sent from the "<label>" line.`, ntfy titles start with `[<label>]` and `/health` carries it. Unset: none of that, every output is as before. The deploy files set it from `INSTANCE`. |
| `INSTANCE_DESCRIPTION` | _(unset)_ | One line of plain words about the line (at most 200 characters), shown to agents and on the hub card. Ignored without `INSTANCE_LABEL`. |
| `QR_SERVER_HOST` | `127.0.0.1` | Bind host for the status port: `/health`, `/live`, `/qr.png`, and `/internal/unlink` when `HUB_INSTANCE_SECRET` is set. |
| `QR_SERVER_PORT` | `39002` | Bind port for the status port. In production it is **not** routed publicly: the hub reads it over the Docker network. |
| `HUB_INSTANCE_SECRET` | _(unset)_ | Shared with the hub. At least 32 characters enables `POST /internal/unlink` on the status port (Bearer-authenticated with this value; it runs the same use case as the `logout` tool). Unset, empty or shorter: the route does not exist. |
| `UPLOAD_SERVER_HOST` | `127.0.0.1` | Bind host for the host-disk upload endpoint (only started when `S3_ENABLED=true`) |
| `UPLOAD_SERVER_PORT` | `39003` | Bind port for the upload endpoint. Exposed publicly via Traefik at `wa.example.com/<label>/upload`. Reuses `MCP_AUTH_TOKEN` for Bearer auth. |
| `UPLOAD_PUBLIC_URL` | _(unset)_ | The public upload address of this number. When it is an http(s) URL, `send_file`'s `file_path` description names it; unset, the description keeps its generic wording. |
| `STREAM_SERVER_HOST` | `127.0.0.1` | Bind host for the `follow_chat` WebSocket presence stream. |
| `STREAM_SERVER_PORT` | `39004` | Bind port for the stream server. Must be exposed publicly via Traefik at `wa.example.com/<label>/stream` (WebSocket upgrade). |
| `STREAM_PUBLIC_URL` | _(derived: `ws://<host>:<port>/stream`)_ | Public base URL `follow_chat` embeds in the returned `ws_url`. Prod: `wss://wa.example.com/<label>/stream`. |
| `STREAM_TOKEN_TTL_S` | `1800` | Lifetime (seconds) of a `follow_chat` stream token. In-memory only; scoped to the requested jids + flags; treated as a bearer secret. |
| `PUBLIC_QR_URL` | _(derived: `http://<QR_SERVER_HOST>:<QR_SERVER_PORT>/qr.png`, `localhost` for a wildcard bind)_ | URL sent in ntfy `Click` header and message text so tapping the push opens the QR code. In production it is the hub's link to that number's card, `https://wa.example.com/<label>`. |
| `NTFY_TOPIC_URL` | _(unset)_ | ntfy.sh topic URL; unset = notifications disabled |
| `NTFY_TOKEN` | _(unset)_ | Bearer token for protected ntfy topics |
| `EXPECTED_WA_NUMBER` | _(unset)_ | If set, only pairings whose JID starts with this prefix are accepted. A mismatch triggers `socket.logout()`, purges `auth_info/`, and fires an ntfy alert. Set it for every number: it is what stops the wrong phone from pairing. With at least 10 digits it also gives the hub card its "number ending" before the number is paired. **Write the number as WhatsApp itself writes it, not as you dial it**: the match is a prefix of the paired account's id, and a Brazilian mobile number, for one, can be registered in its 12-digit form without the extra 9 — the 13-digit form would then purge a correct pairing. See [`deploy/README.md`](../deploy/README.md#add-a-number). |
| `S3_ENABLED` | `false` | Set to `true` to enable the S3-compatible media plane. Required for `download_media` to work in remote deployments. Prod uses RustFS running as a sidecar in the number's own compose project — no managed cloud, no extra bill. |
| `S3_ENDPOINT` | `localhost` | S3 endpoint hostname. Prod: `whatsapp-mcp-<label>-minio`, the container name of the number's own RustFS (never the bare service name `minio`: on the proxy network that name is shared by every number's store, and with other stacks). Dev: `minio`. |
| `S3_PORT` | `9000` | Port for the S3 endpoint. Always `9000` for the RustFS sidecar. |
| `S3_USE_SSL` | `false` | Always `false` — Traefik terminates TLS in front of RustFS; the app talks to RustFS in-cluster over HTTP. |
| `S3_ACCESS_KEY` | `minioadmin` | S3 access key. Prod: the number's own `MINIO_ROOT_USER`. |
| `S3_SECRET_KEY` | `minioadmin` | S3 secret key. Prod: the number's own `MINIO_ROOT_PASSWORD`. |
| `S3_BUCKET` | `amiticia-media` | Bucket name. The app creates it at start and sets a policy that allows reading one object by its key and nothing else (no listing). There is no init container. |
| `S3_REGION` | `us-east-1` | Bucket region (cosmetic for RustFS; SDK still requires it). |
| `S3_SKIP_POLICY` | `false` | Keep `false` — RustFS accepts `setBucketPolicy`, so the app sets the public-read policy at boot. |
| `MEDIA_PUBLIC_BASE_URL` | _(derived from endpoint)_ | Public base URL prefix for media. Dev: `http://localhost:9000/amiticia-media`. Prod: `https://wa.example.com/<label>/media` (Traefik path-based route, see `deploy/docker-compose.instance.yaml`). |
| `TENANT_ID` | `default` | Object key prefix: `t/{tenantId}/…`. One WhatsApp account per instance, so one tenant. The deploy files set it to the number's label; a number that was installed before labels existed keeps `default`, so its stored media keeps its keys. |
| `MEDIA_INLINE_MAX_BYTES` | `5242880` | Max file size (bytes) for inline `imageContent`/`audioContent` in tool response. |
| `SEND_ACK_WAIT_MS` | `3000` | How long `send_message` / `send_file` wait for a server rejection ack before declaring the send accepted. Observed ack latency is ~40 ms, so the default carries ~75× headroom. `0` disables the wait (restores fire-and-forget: a refused send reports success again). |
| `SEND_PRESEND_CHECK` | `true` | Verify the recipient exists via `onWhatsApp()` before sending, and upgrade a phone JID to its canonical `@lid`. Set `false` to send to exactly the JID given, unverified. |
| `SEND_BLOCKLIST_ENABLED`, `SEND_COLD_CONTACT_GUARD`, `SEND_COLD_OVERRIDE`, `SEND_COLD_ALLOWED_JIDS`, `SEND_RATE_LIMIT_*`, `SEND_SIMULATE_TYPING`, `SEND_TYPING_MAX_MS` | see doc | The anti-ban guard chain. Defaults, effects and the per-instance policy: **[`account-restrictions.md`](./account-restrictions.md)**. These are risk-owner settings — don't change one to make a send go through. |
| `HEALTH_DISCONNECTED_GRACE_S` | `300` | How long the WhatsApp socket may be down before `/health` returns 503. Informational: `/health` is for humans and external monitors, **not** the Docker healthcheck (that probes `/live`, which is always 200 while the process serves HTTP). `0` never returns 503. |
| `WATCHDOG_RESTART_AFTER_S` | `600` | In-process watchdog: seconds the socket may stay down (any status except `connected`, `syncing` or `qr_pending`) before the process pushes a priority-5 ntfy and exits, so `restart: unless-stopped` brings the container back. `qr_pending` never counts and never restarts — a restart would destroy the QR. `0` disables the watchdog entirely, alerts included. A malformed value reads as `600`, never as off. |
| `WATCHDOG_MAX_RESTARTS` | `3` | Self-restarts the watchdog may trigger per rolling 6 h (a ban-risk guard against reconnect storms). The count lives in `watchdog-state.json` under the data dir, so it survives the restart it causes. Once reached, it stops exiting and pushes "precisa de você" (priority 5) every 30 min while still down. `0` = alert only, never restart. If the count cannot be written, it refuses to exit and alerts instead. |
| `OPENROUTER_API_KEY` | _(unset)_ | Enables `download_media`'s `transcribe` (Whisper `openai/whisper-large-v3`, the default audio route) and `describe` (vision model) flags. |
| `AUDIO_PROVIDER` | `openrouter` | Transcription route: `openrouter` \| `groq` \| `openai`. Rollback lanes kept deliberately; an unknown value throws rather than silently guessing. **Routing is never by key presence** — a leftover `GROQ_API_KEY` must not quietly keep traffic on a closed account. |
| `GROQ_API_KEY` | _(unset)_ | Only used when `AUDIO_PROVIDER=groq` (rollback; `whisper-large-v3`). |
| `OPENAI_API_KEY` | _(unset)_ | Only used when `AUDIO_PROVIDER=openai` (rollback; `whisper-1`). |
| `WHISPER_MODEL` | _(per-route default)_ | Override the Whisper model on whichever route is active. |
| `VISION_MODEL` | `openai/gpt-6-luna` | OpenRouter model id used by `download_media`'s `describe` flag. Any image-input model works. |
| `FFMPEG_BIN` | `ffmpeg` | Path to the ffmpeg binary used for audio preprocessing before Whisper. |

## Environment variables (the hub)

The hub is a second program in the same image (`src/hub/main.ts`, `pnpm start:hub`): one page,
behind a PIN, that shows every number and lets the operator pair one. It never talks to
WhatsApp and holds no number's token. It refuses to start when a required value is missing or
unusable, and says which variable is at fault without printing a value.

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_PIN` | _(required)_ | The PIN that opens the page. At least 4 characters. Five wrong PINs from one address lock that address for 15 minutes; twenty from anywhere lock the form for everyone for 60 minutes and send one ntfy push. |
| `HUB_COOKIE_KEY` | _(required)_ | Signs the session cookie (30 days, `HttpOnly`, `Secure`, `SameSite=Strict`). At least 32 characters; `openssl rand -hex 32`. Changing it signs everyone out. |
| `HUB_INSTANCES` | _(required)_ | The numbers to show, comma-separated: `label` (reached at `http://whatsapp-mcp-<label>:39002`, the container the deploy files create) or `label=http://host:port`. |
| `HUB_PUBLIC_URL` | _(required)_ | The public origin of the hub, without a trailing slash. `https`, or `http` for localhost only. The deploy file sets it from `PUBLIC_DOMAIN`. |
| `HUB_STATE_DIR` | _(required)_ | An existing, writable directory for `pin-attempts.json`, so the wrong-PIN counters survive a restart. A damaged file stops the start on purpose: the hub never starts with empty counters over a broken file. |
| `HUB_INSTANCE_SECRET` | _(unset)_ | Shared with every number. At least 32 characters enables the "unlink this number" action; unset or empty, the action does not exist; set but shorter, the hub refuses to start. |
| `HUB_LANG` | `en` | Language of the page: `en` or `pt-BR`. Any other value stops the start. |
| `HUB_HOST` / `HUB_PORT` | `0.0.0.0` / `39002` | Where the hub listens. |
| `NTFY_TOPIC_URL` / `NTFY_TOKEN` | _(unset)_ | Where the "PIN is being guessed" push goes. |
| `LOG_LEVEL` | `info` | Pino log level. |

## Deploy-file variables

Read by `deploy/docker-compose.yaml` and `deploy/docker-compose.instance.yaml`, not by the
programs.

| Variable | File | Description |
|----------|------|-------------|
| `PUBLIC_DOMAIN` | both | The one public hostname. The hub answers at `/`, each number under `/<label>/`. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | number | Credentials of this number's own RustFS media store. Required: the file does not render without them. A different pair in every number's file (`openssl rand -hex 16` each); the shared stack reads no store credential. |
| `STORE_MEM_LIMIT` | number | Memory ceiling of this number's store. Default `150m`. |
| `COMPOSE_FILE` | number | `docker-compose.instance.yaml`, so `docker compose --env-file .env.<label> …` picks the number's file. |
| `INSTANCE` | number | The number's label. It names the compose project, the containers (`whatsapp-mcp-<label>` and its store `whatsapp-mcp-<label>-minio`), the routes (`/<label>/…`), the data directory and the media prefix. |
| `INSTANCE_DATA_DIR` | number | Host directory mounted at `/data`; the store's objects live in its `minio/` subdirectory. Default `/storage/whatsapp-mcp-<label>`. Set it only to keep a number on a directory that already holds its pairing. |

The one-time copy tool (`src/store-copy-cli.ts`, `pnpm store:copy`) reads its own
`STORE_COPY_*` variables; they are described where it is used, in
[`deploy/README.md`](../deploy/README.md#migrating-from-one-shared-store-to-one-store-per-number).

## Data storage

Paths are relative to `WHATSAPP_MCP_DATA_DIR` (defaults to `.` when running via `pnpm start`, `/data` in the Docker image):

- `auth_info/` - WhatsApp authentication (Baileys multi-file auth state)
- `watchdog-state.json` - Timestamps of the connection watchdog's recent self-restarts (the `WATCHDOG_MAX_RESTARTS` cap) and whether a "reconectado" push is owed
- `data/whatsapp.db` - SQLite database (chats, messages, contacts)
- `backups/hourly/whatsapp.db` - Rolling hourly snapshot (overwritten, WAL-safe)
- `backups/daily/whatsapp-YYYY-MM-DD.db` - Per-day snapshots (14-day retention)
- `backups/daily/auth_info-YYYY-MM-DD.tar.gz` - Per-day auth tarball
- `wa-logs.txt` - WhatsApp/Baileys logs
- `mcp-logs.txt` - MCP server logs
- `minio/` - production compose only: the files of this number's RustFS store, written by the store container and never by the app

The hub keeps one file, `pin-attempts.json`, in `HUB_STATE_DIR` (`/storage/whatsapp-mcp-hub`
in the production compose): the wrong-PIN counters, with addresses stored as keyed hashes.

> **Media**: downloaded media is stored in the number's own RustFS container, part of its compose project (bind-mounted at `<data>/minio`, so `/storage/whatsapp-mcp-<label>/minio` in the production compose), with credentials no other number holds. It is served publicly through Traefik at `https://wa.example.com/<label>/media/<key>` — no separate subdomain, no managed cloud bucket, no recurring bill. Only object keys are routed, and each label reaches only its own store: a request for the bucket itself never reaches a store, and one number's key is not found under another's label. The legacy `data/media/` directory existed in older deployments — run `scripts/backfill-media.sh` inside the container to upload existing files into RustFS; the script then drops the legacy column.

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
