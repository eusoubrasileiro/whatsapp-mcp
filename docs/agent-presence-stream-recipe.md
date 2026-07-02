# Recipe: be *present* in a WhatsApp chat with `follow_chat`

The persona pattern (spec: [`spec-agent-presence-stream.md`](./spec-agent-presence-stream.md)):
an interactive agent impersonates the user in a group and **does real work between
messages** — it must be reactive without a blocking poll loop occupying its turns.

`follow_chat` gives you a **WebSocket stream** you attach to your harness's background
monitor. Each frame is one inbound message; you are woken per message while you keep
coding, running evals, committing — anything.

## The two-step flow

```jsonc
// 1. Ask to follow the chat(s). include_from_me + transcribe default to true.
follow_chat({ chat_jids: ["1203…@g.us"] })
// → {
//     "ws_url": "wss://mcp.amiticia.cc/stream?token=<opaque>",
//     "expires_at": "2026-07-02T15:28:00.000Z",
//     "note": "Attach with your harness's background monitor …"
//   }

// 2. Attach the URL to your background monitor and keep working. Each WS frame
//    wakes you with one message; you are NOT blocked between messages.
Monitor({ ws: { url: "wss://mcp.amiticia.cc/stream?token=<opaque>" } })

// 3. React whenever a frame arrives — reply on the same chat.
send_message({ recipient: "1203…@g.us", message: "Já ajusto isso, Beatriz." })
```

Your own `send_message` sends are **suppressed** on the stream (the sent-tracker loop
guard) — you never wake yourself. Messages the human types from their **own phone**
arrive as frames with `is_from_me: true` (that's why `include_from_me` defaults to
true for persona mode: so you see — and don't contradict — what they said manually).

## Frame schema

```json
{
  "seq": 12,
  "id": "A577AE…",
  "chat_jid": "1203…@g.us",
  "chat_name": "AmiticIA AutoSys",
  "sender_jid": "…@s.whatsapp.net",
  "sender_display": "Beatriz A. Example",
  "is_from_me": false,
  "content": "Para o Dave 👆",
  "timestamp": "2026-07-02T14:58:20.000Z",
  "reply_to": null,
  "media": { "type": "ptt", "mimetype": "audio/ogg; codecs=opus",
             "transcription": "Olá, tudo bem?", "fetch_id": "A577AE…" }
}
```

- **Voice notes arrive already transcribed** when the stream opted into `transcribe`
  (the default). `media.fetch_id` + `chat_jid` is the handle for `download_media` if you
  want the raw bytes or an image.
- Non-audio media carries a `media` block with `transcription: null`; call
  `download_media` on demand.

## Reconnect without loss or duplication

Every frame's cursor is exclusive and monotonic. If your monitor drops and you
reconnect, pass the last cursor you processed as `?since=` and the server **replays the
gap** before going live:

```jsonc
Monitor({ ws: { url: "wss://mcp.amiticia.cc/stream?token=<opaque>&since=<cursor>" } })
```

`<cursor>` is a `get_new_messages` / `wait_for_messages` `next_since` value (a `row:<n>`
token). An ISO-8601 timestamp is also accepted to backfill recent history on first
attach. With no `since`, the stream starts from now.

## When NOT to use this

- **A reply you expect within a minute or two, with nothing else to do** → the bounded
  `wait_for_messages` is simpler. Don't loop it to "stay present" — that burns turns.
- **A deployed, headless service that owns an HTTPS endpoint** (server, n8n, cloud
  function) → `register_webhook` pushes to your URL instead.

## Known gaps

- **`reply_to` is always `null` today.** Groups steer with quoted replies ("Para o
  Dave 👆") and the field is in the contract, but the current parse/persistence layer
  does not carry the quoted message. Populating it needs quoted-context extraction in
  `@amiticia/baileys-client` + a DB column — a follow-up. Read the field defensively;
  it will become non-null without a schema change on the consumer side.

## Operator notes

- The stream server listens on `STREAM_SERVER_PORT` (default `39004`), bound to
  `STREAM_SERVER_HOST` (default `127.0.0.1`). It must be exposed publicly via Traefik at
  `mcp.amiticia.cc/stream` (WebSocket upgrade) — an infra change in the `systems` repo,
  parallel to the `/upload` route.
- `follow_chat` builds the URL from `STREAM_PUBLIC_URL` (e.g.
  `wss://mcp.amiticia.cc/stream`); falls back to `ws://<host>:<port>/stream` for local
  dev.
- Tokens are opaque bearer secrets scoped to the requested jids + flags, TTL
  `STREAM_TOKEN_TTL_S` (default 30 min), held in memory only. They ride the query string
  because a background monitor can't set an `Authorization` header — keep them out of
  logs.
```
