# Outbound webhooks

| Tool | Description |
|------|-------------|
| `register_webhook` | Subscribe a URL to inbound WhatsApp messages so an agent becomes reactive. Params: `target_url`, `allowed_jids[]` (chats allowed to wake it, or `["*"]`), `secret?`, `auth_mode?` (`hmac` default \| `bearer`), `transcribe?` (default true), `include_from_me?` (default false — forward your own messages in a chat shared with others; **not needed for a self-chat**, which auto-forwards), `label?`. Returns `{ id }`. |
| `deregister_webhook` | Remove a subscription by `id`. Returns `{ removed }`. |
| `list_webhooks` | List active subscriptions for the tenant (secret redacted → `has_secret`). |

## How it works

This MCP is otherwise poll-only; webhook subscriptions add the missing **outbound
push** so an external agent (e.g. a self-hosted agent gateway) becomes *reactive* — it is
woken when a WhatsApp message arrives. The push is generic and tenant-tagged, not tied to
any one agent — any agent/product can subscribe.

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
agent by messaging your **own** WhatsApp (a self-chat) — your messages are `is_from_me`. So forwarding is decided per message:
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
> intentional (the subscribing agent often runs on the same private network), so internal
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

```sql
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
