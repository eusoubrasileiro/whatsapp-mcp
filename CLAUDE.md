# WhatsApp MCP Server

WhatsApp as an MCP server. Canonical deployment is a long-lived Docker daemon on the VPS, exposed as `https://mcp.amiticia.cc/mcp` (Bearer auth) with a public QR page at `https://wa.amiticia.cc/`. Built on `@amiticia/baileys-client`.

User-facing overview lives in [`README.md`](./README.md). This file is the internal contributor / operator reference.

## Requirements

- Node.js `>= 23.10.0` (uses `--experimental-strip-types` and bundled `node:sqlite`)
- pnpm (strict workspace, managed via `corepack`)
- Docker + BuildKit for image builds

## Claude Code MCP Setup

> The canonical path is **HTTP-to-remote**. Do NOT reintroduce stdio via `claude mcp add` — it overwrites the working HTTP config.

### Canonical setup (HTTP, connects to the deployed service)

Edit `~/.claude.json`. Inside the top-level `mcpServers` object:

```json
"whatsapp": {
  "type": "http",
  "url": "https://mcp.amiticia.cc/mcp",
  "headers": {
    "Authorization": "Bearer ${MCP_AUTH_TOKEN}"
  }
}
```

Claude Code expands `${MCP_AUTH_TOKEN}` from your shell env. If you don't want env expansion, paste the literal token — `~/.claude.json` is `0600`.

Verify:

```bash
claude mcp list          # whatsapp: ✓ Connected
# In a session:
/mcp                     # expects the 20 whatsapp tools listed
```

The same JSON shape works for Claude Desktop (`~/.config/Claude/claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`). See `examples/mcp-clients.md` for all three.

### Stdio fallback (local dev only)

Useful when iterating on source without rebuilding the Docker image. The MCP stdio server must start before the WhatsApp connection — `src/main.ts` already enforces that order (MCP handshake completes first, Baileys connects in the background). Do not reverse it, or Claude Code kills the process during handshake timeout.

```bash
pnpm install
pnpm start               # MCP_TRANSPORT defaults to stdio
```

Register with Claude Code only if you want to hit local dev instead of the deployed instance:

```bash
claude mcp remove --scope user whatsapp    # remove HTTP entry first
claude mcp add --scope user whatsapp -- \
  $(which node) --experimental-strip-types \
  $(pwd)/src/main.ts
```

Remember to swap back to the HTTP entry afterwards.

### Troubleshooting (HTTP path)

| Symptom | Fix |
|---------|-----|
| `claude mcp list` shows whatsapp `✗ Failed to connect` | Check `curl -sS -o /dev/null -w '%{http_code}' https://mcp.amiticia.cc/health` — if not reachable, DNS or Traefik issue. See `systems/vps/stacks/whatsapp-mcp/README.md`. |
| `HTTP 401` from MCP endpoint | `MCP_AUTH_TOKEN` mismatch between `.env` on VPS and your `~/.claude.json`. Regenerate or re-sync. |
| TLS cert failing (`SSL_ERROR_*`) | Let's Encrypt / Traefik didn't issue yet. Check CF DNS proxy is **off** (grey cloud) for `mcp`/`wa` records. |
| `wa.amiticia.cc` 404 | Traefik label typo or `certresolver` name mismatch with the running Traefik config (should be `myresolver`). |
| ntfy silent | `NTFY_TOPIC_URL` unset on VPS, or topic not subscribed in the ntfy app. Check `docker exec whatsapp-mcp grep ntfy /data/wa-logs.txt`. |
| Container `unhealthy` | Healthcheck hits `http://127.0.0.1:39002/health`. If the QR web server failed to bind (port clash), container flaps. `docker logs whatsapp-mcp`. |
| `send_file` fails with "cannot read local file …" or "ENOENT" | The MCP server runs in a remote container — it can't see your host disk. Use `POST /upload` to publish the file first, then pass the returned URL to `send_file`. See "Sending host-disk files" above. |
| `POST /upload` returns 401 | `MCP_AUTH_TOKEN` mismatch — same secret as the MCP endpoint. |
| `POST /upload` returns 415 | Bytes didn't match any known magic header. Re-encode the file or check it's not truncated; `sniffMimetype` only recognises JPEG/PNG/GIF/WebP/PDF/MP4/3GP/MOV/M4A/OGG/WAV/MP3. |
| `POST /upload` returns 413 | Body over 16 MB. WABA's hard limit — compress first. |

### Troubleshooting (stdio fallback only)

| Symptom | Fix |
|---------|-----|
| Silent exit code 1, no logs | Native module ABI mismatch — `pnpm install` with the correct Node version in PATH |
| Server starts, Claude Code kills it in ~1-4s | Startup order regression — MCP server must initialize before WA connect in `main.ts` |
| Logs stale / empty in repo dir | Claude Code CWD is usually `~`, so check `~/mcp-logs.txt` and `~/wa-logs.txt` |
| "sonic boom not ready" masks real error | Look at the full log file, not stderr |

### After switching Node.js versions (stdio only)

```bash
pnpm install                             # rebuild native modules
claude mcp remove --scope user whatsapp  # nuke old Node path
claude mcp add --scope user whatsapp -- \
  $(which node) --experimental-strip-types $(pwd)/src/main.ts
claude mcp list
```

Not needed for the HTTP path — the container pins its own Node.

---

## Development Practices

### Test-Driven Development (TDD) — MANDATORY

Red-Green-Refactor is mandatory. Write a failing test FIRST, then implement, then refactor.

| Change type | Required test (written FIRST) |
|---|---|
| New MCP tool or endpoint | Unit test + integration test before implementation |
| New pure helper/util | Unit test before implementation |
| Bug fix | Regression test that reproduces the bug before fix |
| Refactoring | Verify existing tests pass first (green → refactor) |
| Dependency update | Contract test pinning consumed API surface before bump |
| Config change with observable behavior | Test covering the behavior before change |

### Test layer taxonomy

| Layer | Location | When to use |
|---|---|---|
| Unit | `src/__tests__/*.test.ts` | Pure helpers, formatters, validators, action functions |
| Integration | `src/__tests__/*.test.ts` | HTTP endpoints (qr-server), MCP tool registration, database operations |
| Contract | `src/__tests__/*.test.ts` | Dependency API surface (p-retry options, fastmcp registration, pino shape) |

### Test conventions

- Test names: behavior-driven — `it("returns fallback when socket is null")`, NOT `it("tests fallback")`
- **Never mock the module under test.**
- Priority: happy path → edge cases → guard clauses → error paths

### Pre-commit checklist (MANDATORY)

```bash
pnpm test          # Must pass
pnpm typecheck     # Must pass
```

**DO NOT COMMIT if any gate fails.** Fix the root cause, never skip hooks.

---

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm start` | Run TypeScript directly with Node |
| `pnpm typecheck` | Type check with tsc |
| `pnpm test` | Run tests with vitest |

### Known pre-existing test / typecheck failures

`@amiticia/baileys-client` is a **private package** that lives in the sibling `baileys-client/` repo and is **not installed in CI or fresh checkouts** where that sibling is absent. This causes:

- `pnpm test` — 2 test suites fail (`message-parsing.test.ts`, `whatsapp-concurrency.test.ts`); 4 tests are skipped.
- `pnpm typecheck` — several `error TS2307: Cannot find module '@amiticia/baileys-client'` errors, plus downstream implicit-`any` errors in `whatsapp.ts`.

These failures are **not regressions** — they exist on `main` and every branch. Fix by running `pnpm install` inside the monorepo root that includes the sibling `baileys-client/` package (or by symlinking `../baileys-client` so workspace resolution finds it).

## Architecture

```
src/
├── main.ts                # Entry point, createAppLogger(), graceful shutdown, startup order
├── mcp.ts                 # MCP server, tool registration (20 tools); delegates to actions.ts
├── actions.ts             # Application-layer use cases (executeLogout, executeGetGroupInfo,
│                          #   executeReactToMessage, executeDeleteMessage, executeDownloadMedia,
│                          #   executeMarkChatRead, assertSocketActive). Testable without FastMCP.
├── whatsapp.ts            # Adapter over @amiticia/baileys-client: events → DB, media download
├── database.ts            # Drizzle ORM + better-sqlite3 (chats, messages, contacts)
├── storage.ts             # S3/RustFS media plane: parseBoolEnv, getBucket, putMedia,
│                          #   ensureBucketReady, publicUrlFor
├── formatters.ts          # DB-row → plain-JSON converters for MCP tool responses
├── connection-notifier.ts # Fires ntfy pushes on QR / connect / disconnect events
├── ntfy.ts                # Low-level ntfy.sh HTTP sender
├── qr-server.ts           # Standalone HTTP server serving the public QR web page (:39002)
├── upload-server.ts       # Standalone HTTP server accepting host-disk uploads (:39003) — bridges
│                          #   the gap when send_file's file_path can't reach the agent's filesystem
├── inbound-bus.ts         # In-process wake-up bus: emitInbound on each live message;
│                          #   waitForInbound backs the wait_for_messages long-poll
├── monitoring.ts          # Reactive-monitoring core (FastMCP-independent):
│                          #   getNewMessagesCore (delta) + waitForMessagesCore (long-poll)
├── webhooks/              # Outbound inbound-message push (reactive subscribers, e.g. Hermes)
│   ├── types.ts           #   Subscription, InboundMessageInput, InboundMessageEvent
│   ├── event.ts           #   buildInboundEvent — pure payload builder
│   ├── registry.ts        #   in-memory subscription cache over the DB (load/add/remove/match)
│   ├── delivery.ts        #   signPayload (HMAC) + deliverEvent + dispatchInbound + isSelfChatJid
│   ├── sent-tracker.ts    #   loop guard: remembers our own sends so replies don't echo back
│   └── actions.ts         #   executeRegisterWebhook / Deregister / List + resolveTenantId
└── db/
    └── schema.ts          # Drizzle table schemas (incl. webhook_subscriptions)
```

**Key dependency:** `@amiticia/baileys-client` handles Baileys connection, message parsing, QR code generation, and reconnection logic. This package keeps only a thin adapter layer in `whatsapp.ts` that bridges baileys-client events to database operations.

## MCP Tools (22 total)

### Connection / Auth
| Tool | Description |
|------|-------------|
| `get_connection_status` | Check WhatsApp connection; saves QR as PNG and auto-opens it if pending |
| `logout` | Log out from WhatsApp and clear session data |

### Contacts
| Tool | Description |
|------|-------------|
| `search_contacts` | Search contacts by name or phone number |
| `list_contacts` | List all contacts with optional filter |

### Messages
| Tool | Description |
|------|-------------|
| `list_messages` | Get message history with pagination and date filtering |
| `get_messages_today` | Convenience tool for today's messages |
| `search_messages` | Full-text search with optional date filtering |
| `get_message_context` | Get messages before/after a target message |

### Reactive monitoring
| Tool | Description |
|------|-------------|
| `get_new_messages` | Delta read: messages received since a cursor, across one or many chats. Params: `chat_jids?` (omit/`["*"]` = all), `since?` (ISO; inclusive), `limit?` (50), `include_from_me?` (false). Returns `{ messages, next_since }`. Cheap replacement for re-scanning each chat. |
| `wait_for_messages` | Long-poll: BLOCKS until a new message arrives in the watched chats or `timeout_seconds?` (default 60, max 240) elapses, then returns `{ messages, next_since }` (immediate if one already arrived). Blocking is free while idle — call in a loop with the rolling `next_since` to react to hour-late replies without burning tokens polling. |

### Chats
| Tool | Description |
|------|-------------|
| `list_chats` | List chats with filtering/sorting |
| `get_chat` | Get detailed chat information |

### Groups
| Tool | Description |
|------|-------------|
| `get_group_info` | Get group metadata (participants, admins, etc.) |

### Sending
| Tool | Description |
|------|-------------|
| `send_message` | Send text message to contact or group |
| `send_file` | Send image/video/document/audio file. Accepts http(s) URL, base64 data: URL, or a server-side absolute path. To send a file from the host disk when the MCP runs remotely, upload it to `/upload` first (see "Sending host-disk files" below) and pass the returned URL. |

### Message Actions
| Tool | Description |
|------|-------------|
| `react_to_message` | React to a message with emoji |
| `delete_message` | Delete/revoke a message you sent |
| `mark_chat_read` | Mark all messages in chat as read |

### Media
| Tool | Description |
|------|-------------|
| `download_media` | Download media (image/video/audio/document/sticker). For audio messages `transcribe` defaults to `true` and returns an `<transcription>` XML block; pass `transcribe: false` for raw audio. For images, opt-in `describe: true` returns an `<image_description>` XML block via Gemini. See "Audio transcription & image description" below. |

### Webhook subscriptions
| Tool | Description |
|------|-------------|
| `register_webhook` | Subscribe a URL to inbound WhatsApp messages so an agent becomes reactive. Params: `target_url`, `allowed_jids[]` (chats allowed to wake it, or `["*"]`), `secret?`, `auth_mode?` (`hmac` default \| `bearer`), `transcribe?` (default true), `include_from_me?` (default false — forward your own messages in a chat shared with others; **not needed for a self-chat**, which auto-forwards), `label?`. Returns `{ id }`. |
| `deregister_webhook` | Remove a subscription by `id`. Returns `{ removed }`. |
| `list_webhooks` | List active subscriptions for the tenant (secret redacted → `has_secret`). |

## Reactive monitoring (pull primitives)

`get_new_messages` + `wait_for_messages` let an **ephemeral agent** (e.g. one messaging
many clinic receptionists and waiting on replies) become *reactive* without the outbound
webhook's external infra. The motivating case: an agent polled `list_messages` ~95× across
~15 chats to notice replies — token-expensive and clumsy.

**Agent usage flow (the loop).** From now on an agent that needs to react to replies should:

1. **Establish a cursor** — call `get_new_messages` with no `since`; save the returned
   `next_since` as your cursor. (Pass an ISO `since` instead to backfill recent history.)
2. **Act** — `send_message` to the chats you're tracking. Your own sends are auto-excluded,
   so they never wake you.
3. **Wait reactively** — `wait_for_messages({ chat_jids, since: cursor, timeout_seconds: 240 })`.
   It blocks at zero token cost and returns the instant a real reply lands, or empty on timeout.
4. **Process** the returned `messages`, then set `cursor = next_since`.
5. **Loop step 3** until done. An hour-late reply is just a few empty-then-wake cycles — each
   one a tiny round-trip, no cost while blocked.

```jsonc
// 1. bootstrap cursor
get_new_messages()                                   // → { messages: [], next_since: T0 }
// 2. act
send_message({ recipient: clinicA, message: "Olá…" })
// 3-5. react in a loop
let cursor = T0
while (waitingOnReplies) {
  const r = wait_for_messages({ chat_jids: [clinicA, clinicB, …],
                                since: cursor, timeout_seconds: 240 })
  for (const m of r.messages) { /* reply / triage */ }
  cursor = r.next_since                              // dedupe by (id, chat_jid)
}
```

Notes: `chat_jids: ["*"]` watches every chat; a list scopes it (LID/PN matched
automatically). The cursor is an inclusive boundary (at-least-once) — dedupe by
`(id, chat_jid)`. Use `get_new_messages` alone for a one-shot "what changed?" without blocking.

**Model.** Both tools read one authoritative DB delta (`getMessagesSince`, forward `gte`
cursor, oldest-first, LID/PN-canonicalized) and apply the same filters: the
`sent-tracker` loop guard (drop the agent's own sends) and a direction filter (drop your
own `is_from_me` unless `include_from_me`). `get_new_messages` is the cheap cursor read.
`wait_for_messages` blocks on the in-process `inbound-bus` (`src/inbound-bus.ts`) — woken
by `emitInbound(parsed)` fired in `whatsapp.ts`'s `type === "notify"` branch right after
`storeMessage`, so a woken waiter re-querying the DB always sees the row. **Blocking is
free while idle**: tokens are spent only on the request and the eventual response, never
during the wait. The agent loops `wait_for_messages` with the rolling `next_since` to cover
hour-scale reply latency with a handful of cheap calls instead of ~95 polls.

**Cursor semantics.** `since` is an inclusive ISO `gte` boundary → **at-least-once**;
`next_since` advances past every *fetched* row (even filtered-out ones, so the cursor never
stalls on your own messages). The agent dedupes by `(id, chat_jid)`.

**Lost-wakeup gap.** `waitForMessagesCore` registers its bus listener, then re-queries once
(`gapCheck`) to catch a message persisted between the immediate check and registration;
anything persisted after registration fires the listener. No missed message.

**Timeout ceiling.** `timeout_seconds` defaults to 60, caps at 240 — kept under the
reverse-proxy (Traefik) idle window; a heartbeat `reportProgress` every ~20s keeps the
proxied HTTP connection warm. The agent loops to go longer.

> **KB note.** Push-to-relauncher (agent ends, gets re-woken via the existing webhook) is
> the most token-efficient pattern for hour-scale latency but needs an external relauncher
> daemon. These pull primitives capture most of the savings with zero new infra; the
> relauncher remains the documented next evolution if idle-zero is ever required.

## Outbound webhook (inbound-message push)

This MCP is otherwise poll-only; webhook subscriptions add the missing **outbound
push** so an external agent (e.g. Hermes) becomes *reactive* — it is woken when a
WhatsApp message arrives. See `docs/hermes-bridge-stories.md` (Epic E1). The push is
generic and tenant-tagged, not Hermes-specific — any agent/product can subscribe.

**Model.** A subscription is durable state in SQLite (`webhook_subscriptions`, in the
backups), registered/removed at runtime via the three tools above. On each **live**
message (`type === "notify"`, not history backfill), the MCP matches it against active
subscriptions and POSTs an event to each matching target. Non-matching chats are
**silently skipped** (still stored locally — no behavior change). With no subscriptions
registered, the feature is inert (zero perf hit). Delivery is isolated exactly like
ntfy: a down/slow/erroring target never throws and never drops the WA socket
(fire-and-forget). Code: `src/webhooks/` (`event.ts` builder, `registry.ts` in-memory
cache over the DB, `delivery.ts` sign+POST+dispatch+self-chat detect, `sent-tracker.ts`
loop guard, `actions.ts`); emit in `src/whatsapp.ts` `onMessageUpsert`; hydrated at boot
by `loadRegistry()` in `main.ts`.

**Direction & the talk-to-yourself pattern.** The headline use case is chatting with an
agent by messaging your **own** WhatsApp (a self-chat), à la Hermes's built-in bridge —
your messages are `is_from_me`. So forwarding is decided per message:
- Genuine inbound (`is_from_me=false`) → always forwarded (if the chat is allow-listed).
- Your own message (`is_from_me=true`) → forwarded when it's your **self-chat** (auto-detected
  by comparing `chat_jid` to the connected account's number — zero config) **or** the
  subscription set `include_from_me: true` (to include your messages in a chat shared with
  others, e.g. a group).
- **Loop guard:** the agent's own replies are sent through this MCP and echo back as
  `is_from_me`; every id this MCP sends is tracked (`sent-tracker.ts`) and never forwarded,
  so the agent can't react to itself. This always wins, even in a self-chat.

**Allow-list + transcription.** Each subscription names the chats (person/group JIDs,
canonicalized for LID↔PN) that may wake it. For matched `audio`/`ptt` messages the
voice note is transcribed **once** (reusing the existing Whisper path) and inlined as
`transcript` when the subscription has `transcribe: true`. Other media carry a typed
indicator; the consumer can call `download_media` on demand.

**Auth (per subscription).** `hmac` (default): each POST carries
`X-Webhook-Signature: sha256=<hmac(`​`timestamp.body`​`)>` + `X-Webhook-Timestamp`; the
secret is given once at registration and never re-transmitted — the subscriber
recomputes and compares. `bearer`: `Authorization: Bearer <secret>` for consumers that
can't verify HMAC. Secrets are never written to logs. **Subscribers should also reject
deliveries whose `X-Webhook-Timestamp` is more than ~5 min from now** (replay guard —
the MCP signs but can't enforce the window; the receiver must).

> **Security notes.** `target_url` may be an internal/private address — that's
> intentional (the agent/Hermes often runs on the same private network), so internal
> URLs are *not* blocked; the gate is the `MCP_AUTH_TOKEN` on the registration call.
> `matchSubscriptions` is tenant-agnostic today (one WhatsApp account) — add a tenant
> filter before onboarding a second tenant.

**Event payload** (POST body):

```json
{ "event": "inbound_message", "tenant_id": "default", "subscription_id": "…",
  "message_id": "…", "chat_jid": "…@s.whatsapp.net", "sender_jid": "…@s.whatsapp.net",
  "timestamp": "2026-06-01T14:32:07.000Z", "is_from_me": false,
  "content": "text body or empty for media", "transcript": "voice-note text or null",
  "media": { "type": "ptt", "mimetype": "audio/ogg; codecs=opus", "file_size": 4821 } }
```

> **Not yet a multi-tenant SaaS.** Subscriptions are tenant-tagged (`TENANT_ID`,
> `default` today) so the data model is forward-ready, but serving multiple tenants
> needs one WhatsApp link per tenant (multiple Baileys sockets) — a separate, larger
> effort. Bearer→tenant mapping and durable retry/queue are also deferred.

## Audio transcription & image description

`download_media` doubles as a transcription / vision endpoint via two optional parameters:

| Param | Default | Behavior |
|---|---|---|
| `transcribe` | `true` for `audio`/`ptt` messages, ignored otherwise | Preprocess bytes with ffmpeg (16 kHz mono FLAC, ~10× smaller), call Groq Whisper `whisper-large-v3-turbo` (or OpenAI `whisper-1` fallback), return an `<transcription>` XML block instead of `audioContent`. |
| `describe` | `false` always, ignored on non-image media | Send image bytes to Google Gemini `gemini-2.5-flash`, return an `<image_description>` XML block instead of `imageContent`. |

Output shape (single `text` content block alongside the usual `resource_link` + JSON metadata):

```xml
<transcription message_id="…" chat_jid="…" model="whisper-large-v3-turbo" duration_s="138">
Olá, queria saber se vocês fazem entrega no meu bairro…
</transcription>
```

```xml
<image_description message_id="…" chat_jid="…" model="gemini-2.5-flash">
Captura de um cardápio com 12 sabores de pizza, preços R$ 35–58, promoção de terça em destaque.
</image_description>
```

Required env vars: `GROQ_API_KEY` (preferred) or `OPENAI_API_KEY` (fallback) for transcription; `GEMINI_API_KEY` for image description. Optional `WHISPER_MODEL` / `VISION_MODEL` overrides. `ffmpeg` must be present on the host (already installed in the runtime image).

Long-audio note: a 24 MB FLAC ceiling guards the Groq request; typical WhatsApp voice notes up to ~25 min fit comfortably after preprocessing. Anything past that fails with a clear error — chunking + stitching is deferred to a follow-up PR per the Groq cookbook (600 s windows, 10 s overlap).

## Sending host-disk files (the `/upload` endpoint)

`send_file`'s `file_path` is resolved **on the server**. When the MCP runs in the canonical remote container, `/tmp/video.mp4` on your machine isn't reachable — the agent has three options, with very different cost:

1. **`http(s)` URL** — works if the file is already hosted somewhere reachable.
2. **`data:` base64 URL** — works for tiny payloads; **blows up the agent's context window** for any real video.
3. **Upload via `POST /upload`** — the right path for arbitrary host-disk files.

Flow from an agent on the user's machine:

```bash
# raw body, MIME sniffed from magic bytes server-side
curl -sS -X POST --data-binary @/tmp/video.mp4 \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  https://mcp.amiticia.cc/upload
# → { "url": "https://mcp.amiticia.cc/media/t/default/uploads/<uuid>.mp4",
#     "key": "t/default/uploads/<uuid>.mp4",
#     "mimetype": "video/mp4", "size": 4321567 }
```

Then call `send_file({ recipient, file_path: "<url from above>", type: "video", caption })`.

Guarantees:
- Bearer-authenticated with the same `MCP_AUTH_TOKEN` as the MCP endpoint.
- 16 MB hard cap (same as Baileys / WABA limit).
- MIME sniffed from bytes — bodies that match no known format are rejected with HTTP 415 (junk / executables won't land in the bucket).
- Object key: `t/{tenantId}/uploads/{uuid}.{ext}`. The public-read bucket policy makes the returned URL fetchable by the MCP container without any extra credential exchange.

The endpoint is exposed by `src/upload-server.ts` on `UPLOAD_SERVER_PORT` (default `39003`), only started when `S3_ENABLED=true`. Traefik route required at the infra repo: `mcp.amiticia.cc/upload` → `whatsapp-mcp:39003`.

## Authentication

On first run or after logout, call `get_connection_status`. A QR code PNG will be saved to `/tmp/whatsapp-mcp-qr.png` and opened automatically in your default image viewer. Scan with WhatsApp mobile (Settings > Linked Devices).
Auth credentials are saved in `auth_info/` for subsequent runs.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_MCP_DATA_DIR` | `.` | Base directory for `auth_info/`, `data/`, and pino log files |
| `LOG_LEVEL` | `info` | Pino log level |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `httpstream` |
| `MCP_HOST` | `127.0.0.1` | Bind host when `MCP_TRANSPORT=httpstream` |
| `MCP_PORT` | `3001` | Bind port when `MCP_TRANSPORT=httpstream` |
| `MCP_ENDPOINT` | `/mcp` | HTTP path for MCP when `MCP_TRANSPORT=httpstream` |
| `MCP_AUTH_TOKEN` | _(unset)_ | If set, HTTP MCP requires `Authorization: Bearer <token>`. If unset, endpoint accepts unauthenticated requests (stdio/local dev only — never run like this in prod). |
| `QR_SERVER_HOST` | `127.0.0.1` | Bind host for the public QR web page |
| `QR_SERVER_PORT` | `39002` | Bind port for the QR web page |
| `UPLOAD_SERVER_HOST` | `127.0.0.1` | Bind host for the host-disk upload endpoint (only started when `S3_ENABLED=true`) |
| `UPLOAD_SERVER_PORT` | `39003` | Bind port for the upload endpoint. Exposed publicly via Traefik at `mcp.amiticia.cc/upload`. Reuses `MCP_AUTH_TOKEN` for Bearer auth. |
| `PUBLIC_QR_URL` | `https://wa.amiticia.cc/` | URL sent in ntfy `Click` header so tapping the push opens the QR page |
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
| `MEDIA_PUBLIC_BASE_URL` | _(derived from endpoint)_ | Public base URL prefix for media. Dev: `http://localhost:9000/amiticia-media`. Prod: `https://mcp.amiticia.cc/media` (Traefik path-based route, see `systems/vps/stacks/whatsapp-mcp/docker-compose.yaml`). |
| `TENANT_ID` | `default` | Object key prefix: `t/{tenantId}/…`. Hardcoded until 2nd customer. |
| `MEDIA_INLINE_MAX_BYTES` | `5242880` | Max file size (bytes) for inline `imageContent`/`audioContent` in tool response. |
| `GROQ_API_KEY` | _(unset)_ | Preferred provider for audio transcription via `download_media`'s `transcribe` flag. Uses `whisper-large-v3-turbo`. |
| `OPENAI_API_KEY` | _(unset)_ | Fallback for audio transcription (`whisper-1`) when `GROQ_API_KEY` is unset. |
| `WHISPER_MODEL` | `whisper-large-v3-turbo` | Override the Groq Whisper model. Ignored when falling back to OpenAI. |
| `GEMINI_API_KEY` | _(unset)_ | Required for image description (`download_media`'s `describe` flag). Uses `gemini-2.5-flash`. |
| `VISION_MODEL` | `gemini-2.5-flash` | Override the Gemini vision model. |
| `FFMPEG_BIN` | `ffmpeg` | Path to the ffmpeg binary used for audio preprocessing before Whisper. |

## Data Storage

Paths are relative to `WHATSAPP_MCP_DATA_DIR` (defaults to `.` when running via `pnpm start`, `/data` in the Docker image):

- `auth_info/` - WhatsApp authentication (Baileys multi-file auth state)
- `data/whatsapp.db` - SQLite database (chats, messages, contacts)
- `backups/hourly/whatsapp.db` - Rolling hourly snapshot (overwritten, WAL-safe)
- `backups/daily/whatsapp-YYYY-MM-DD.db` - Per-day snapshots (14-day retention)
- `backups/daily/auth_info-YYYY-MM-DD.tar.gz` - Per-day auth tarball
- `wa-logs.txt` - WhatsApp/Baileys logs
- `mcp-logs.txt` - MCP server logs

> **Media**: downloaded media is stored in a RustFS sidecar on the same VPS (bind-mounted at `/storage/whatsapp-mcp/minio`). It is served publicly through Traefik at `https://mcp.amiticia.cc/media/<key>` — no separate subdomain, no managed cloud bucket, no recurring bill. The legacy `data/media/` directory existed in older deployments — run `scripts/backfill-media.sh` inside the container to upload existing files into RustFS; the script then drops the legacy column.

All data directories are gitignored for security.

## Backup & Restore

The DB and auth state live on the `/data` volume (bind mount on the VPS). Hourly snapshots are written by `scripts/backup.sh`, which ships inside the image.

**Why a script and not just `cp whatsapp.db`:** SQLite runs in WAL mode here (see `src/database.ts` — `journal_mode = WAL`). Copying the `.db` file while the container is writing captures an inconsistent snapshot (WAL pages are still pending). `sqlite3 .backup` is the supported online-backup API and is WAL-safe.

### Snapshot from host (cron)

```
0 * * * * docker exec whatsapp-mcp /app/whatsapp-mcp/scripts/backup.sh >> /var/log/whatsapp-mcp-backup.log 2>&1
```

Produces `backups/hourly/whatsapp.db` every run and promotes to `backups/daily/whatsapp-$(date).db` + `auth_info-$(date).tar.gz` once per day. Retention: 48h hourly, 14d daily — tune with `find` flags in `scripts/backup.sh` if needed.

### Restore (overwrite)

Container MUST be stopped (the live writer holds the WAL lock). Use when you want the incoming DB to replace whatever is there:

```
docker compose stop whatsapp-mcp
# DB only (most common — keeps the already-paired linked device):
./scripts/restore.sh /path/to/source.db
# DB + auth (full disaster recovery, displaces the current linked device):
./scripts/restore.sh /path/to/source.db /path/to/auth_info.tar.gz
docker compose start whatsapp-mcp
```

On the VPS, either set `WHATSAPP_MCP_DATA_DIR=/storage/whatsapp-mcp` before calling `restore.sh` on the host, or use a helper container:

```
docker run --rm -v /storage/whatsapp-mcp:/data \
  -v $(pwd)/scripts:/scripts alpine sh /scripts/restore.sh /data/incoming.db
```

### Merge (import history into a live DB)

Use when you want to fold an external DB's rows into the current one without losing what's already there — e.g. importing a long-lived local bridge's history onto a fresh VPS. Runs `scripts/merge-db.sh`.

Policy:
- `messages` — `INSERT OR IGNORE` on `(id, chat_jid)`. Target row wins on collision.
- `chats` — UPSERT, keeps the newest `last_message_time`, preserves target's `name` if set.
- `contacts` — UPSERT, target wins, source fills NULLs.

> Older versions of this script propagated `media_local_path` from the source DB. That column has been dropped — media now lives in RustFS and is referenced by `media_object_key`. Imported messages will need a re-download via `download_media` to populate their object key.

Full procedure (local bridge → VPS):

```
# 1. on the local machine — bridge can stay running, .backup is WAL-safe
sqlite3 /home/you/.../whatsapp-mcp/data/whatsapp.db ".backup /tmp/old-wa.db"
tar czf /tmp/old-wa-media.tar.gz -C /home/you/.../whatsapp-mcp/data media
scp /tmp/old-wa.db /tmp/old-wa-media.tar.gz <vps>:/tmp/

# 2. on the VPS
ssh <vps>
cd /root/systems/vps/stacks/whatsapp-mcp
# extract media first (tar -k keeps existing files on conflict):
tar xzkf /tmp/old-wa-media.tar.gz -C /storage/whatsapp-mcp/data/
docker compose stop
docker run --rm \
  -v /storage/whatsapp-mcp:/data \
  -v /tmp:/src \
  -v /root/whatsapp-mcp/scripts:/scripts \
  --entrypoint sh \
  ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /scripts/merge-db.sh /src/old-wa.db
docker compose start
# verify with list_messages
```

`merge-db.sh` is idempotent — re-running it is safe (INSERT OR IGNORE + UPSERT). If the first run failed mid-transaction, just re-run.

### Offsite

Backups are on the host side of the bind mount (`/storage/whatsapp-mcp/backups/` on the VPS). Point Borg at that directory using the operator reference in `your backup notes`. **Not automated in the stack today** — run Borg manually or add a separate host cron.

## Deploy (Docker + Traefik on VPS)

Full deploy / update / rotate-secrets / troubleshoot runbook: [`systems/vps/stacks/whatsapp-mcp/README.md`](../../infra/systems/vps/stacks/whatsapp-mcp/README.md) (branch `non-swarm`).

Production stack lives in the sibling `systems` repo at:
`systems/vps/stacks/whatsapp-mcp/docker-compose.yaml`

Image is published privately as `ghcr.io/amiticia-autosys/whatsapp-mcp:latest`.

Build locally (BuildKit required — sibling `baileys-client/` must be present):

```bash
cd whatsapp-mcp
DOCKER_BUILDKIT=1 docker build \
  --build-context baileys=../baileys-client \
  -t ghcr.io/amiticia-autosys/whatsapp-mcp:latest .
```

Smoke test:

```bash
docker run --rm -d --name wa-mcp-smoke \
  -p 39001:39001 -p 39002:39002 \
  -v /tmp/wa-mcp-test-data:/data \
  -e MCP_AUTH_TOKEN=teste123 \
  -e PUBLIC_QR_URL=http://localhost:39002/ \
  ghcr.io/amiticia-autosys/whatsapp-mcp:latest
curl -sS http://127.0.0.1:39002/health
curl -sS -o /dev/null -w "%{http_code}\n" -H 'Authorization: Bearer teste123' \
  http://127.0.0.1:39001/mcp
```

Publish (private GHCR):

```bash
gh auth refresh -s write:packages,read:packages
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
docker push ghcr.io/amiticia-autosys/whatsapp-mcp:latest
```

Routes after deploy:
- `https://wa.amiticia.cc/` — public QR page (safe because `EXPECTED_WA_NUMBER` check rejects wrong-phone pairings).
- `https://mcp.amiticia.cc/mcp` — MCP endpoint, requires `Authorization: Bearer $MCP_AUTH_TOKEN`.

## MCP Client Configuration

### Claude Desktop (macOS)
`~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-mcp/dist/main.js"]
    }
  }
}
```

### Claude Desktop (Linux)
`~/.config/claude/claude_desktop_config.json`

### Cursor
`~/.cursor/mcp.json`

## Claude Code Installation

### Prerequisites
- Node.js >= 23.10.0 (required — native modules like better-sqlite3 fail on 22.x)
- WhatsApp MCP installed: `pnpm install`
- First authentication completed: `pnpm start` (scan QR code)

### Install MCP Server

**IMPORTANT:** You must include `--experimental-strip-types` flag for Node.js to execute TypeScript directly.

```bash
# Get your Node.js path (must be v23.10.0+)
NODE_PATH=$(which node)

# Add to Claude Code (user scope - works in all projects)
claude mcp add --scope user whatsapp -- $NODE_PATH --experimental-strip-types /ABSOLUTE/PATH/TO/whatsapp-mcp/src/main.ts

# Example with full paths:
claude mcp add --scope user whatsapp -- /home/you/.nvm/versions/node/v23.11.1/bin/node --experimental-strip-types /path/to/whatsapp-mcp/src/main.ts
```

### Verify Installation

```bash
claude mcp list
# Should show: whatsapp: ... - ✓ Connected
```

### Troubleshooting

See the comprehensive **"Claude Code MCP Setup & Troubleshooting"** section at the top of this file.

## Database Schema

```sql
-- Chats
CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT
);

-- Messages
CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  media_type TEXT,        -- 'image'|'video'|'audio'|'ptt'|'document'|'sticker'
  mimetype TEXT,          -- e.g. 'image/jpeg'
  media_key TEXT,         -- base64 encryption key
  direct_path TEXT,       -- WhatsApp CDN path
  media_url TEXT,         -- full CDN URL (may expire)
  file_length INTEGER,    -- file size in bytes
  file_sha256 TEXT,       -- base64 hash
  file_enc_sha256 TEXT,   -- base64 encrypted hash
  media_object_key TEXT,  -- S3/R2 object key (t/{tenantId}/{sanitizedJid}/{msgId}.{ext})
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);

-- Contacts
CREATE TABLE contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  notify TEXT,
  phone_number TEXT
);

-- Webhook subscriptions (outbound inbound-message push)
CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,            -- uuid
  tenant_id TEXT NOT NULL,       -- 'default' today
  target_url TEXT NOT NULL,
  secret TEXT,                   -- HMAC key or Bearer token (nullable)
  auth_mode TEXT NOT NULL DEFAULT 'hmac',   -- 'hmac' | 'bearer'
  allowed_jids TEXT NOT NULL,    -- JSON array of canonical JIDs, or ["*"]
  transcribe INTEGER NOT NULL DEFAULT 1,
  include_from_me INTEGER NOT NULL DEFAULT 0,  -- forward your own msgs in shared chats (self-chat auto)
  label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## References

This project builds on the WhatsApp MCP ecosystem. For additional implementation ideas and features, see:
- [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) - Excellent reference implementation with additional features

## Security Notes

- Uses `@amiticia/baileys-client` (wrapping `@whiskeysockets/baileys`)
- Auth credentials stored locally, never transmitted
- All message data stays local in SQLite (better-sqlite3 + Drizzle ORM)
- Data only sent to LLM when explicitly requested via MCP tools
