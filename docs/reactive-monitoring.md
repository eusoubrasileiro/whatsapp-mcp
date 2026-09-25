# Reactive monitoring

Three tools let an agent react to incoming messages instead of re-scanning chats. Pick by how long the agent must stay reactive: `wait_for_messages` for a reply expected within minutes, `follow_chat` for session-length presence, a [webhook](./webhooks.md) for a deployed headless service.

| Tool | Description |
|------|-------------|
| `get_new_messages` | Delta read: messages received since a cursor, across one or many chats. Params: `chat_jids?` (omit/`["*"]` = all), `since?` (opaque `row:<n>` cursor — exclusive; ISO also accepted for backfill), `limit?` (50), `include_from_me?` (false). Returns `{ messages, next_since }`. Cheap replacement for re-scanning each chat. |
| `wait_for_messages` | Bounded await: BLOCKS until the next matching message or `timeout_seconds?` (default 60, max 240), then returns `{ messages, next_since }` (immediate if one already arrived). Use ONLY for a reply you expect within minutes with nothing else to do; do NOT loop it to stay present (each empty return wastes a turn) — use `follow_chat` for standing presence. |
| `follow_chat` | **Presence stream.** Returns `{ ws_url, expires_at, note }` — a scoped, short-lived `wss://…/stream?token=…` URL you attach to your harness's background monitor (`Monitor({ws:{url}})`) so you are **woken per inbound message while doing other work**. THIS is the tool for monitor / watch / follow a group / act as the user's persona / chat over hours. Params: `chat_jids?` (omit/`["*"]` = all), `include_from_me?` (default **true** — persona mode sees the user's own phone replies), `transcribe?` (default true). One JSON frame per message (schema incl. `reply_to`, `media.transcription`, `media.fetch_id`); reconnect with `?since=<cursor>` gap-fills. Your own MCP sends stay suppressed (sent-tracker). Recipe: [`agent-presence-stream-recipe.md`](./agent-presence-stream-recipe.md). |

## Pull primitives: `get_new_messages` + `wait_for_messages`

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
automatically). The `row:<n>` cursor is exclusive; an ISO backfill cursor is inclusive
(at-least-once) — dedupe by `(id, chat_jid)` to be safe. Use `get_new_messages` alone for a one-shot "what changed?" without blocking.

**Model.** Both tools read one authoritative DB delta (`getMessagesDelta`, forward rowid
cursor, oldest-first, LID/PN-canonicalized) and apply the same filters: the
`sent-tracker` loop guard (drop the agent's own sends) and a direction filter (drop your
own `is_from_me` unless `include_from_me`). `get_new_messages` is the cheap cursor read.
`wait_for_messages` blocks on the in-process `inbound-bus` (`src/inbound-bus.ts`) — woken
by `emitInbound(parsed)` fired in `whatsapp.ts`'s `type === "notify"` branch right after
`storeMessage`, so a woken waiter re-querying the DB always sees the row. **Blocking is
free while idle**: tokens are spent only on the request and the eventual response, never
during the wait. The agent loops `wait_for_messages` with the rolling `next_since` to cover
hour-scale reply latency with a handful of cheap calls instead of ~95 polls.

**Cursor semantics.** `next_since` is an opaque `row:<n>` cursor (SQLite rowid) — exclusive
and monotonic, so no duplicates and no clock-skew gaps. An ISO-8601 `since` is still
accepted for explicit backfill; that one is an inclusive `gte` boundary (**at-least-once**).
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
