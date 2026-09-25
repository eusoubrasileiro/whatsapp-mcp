# MCP tools reference

The server registers 23 tools (`src/mcp/tools/*.ts`, wired in `src/mcp.ts`). Tool bodies are
thin: the testable use cases live in `src/actions.ts` and the modules they call.

### Connection / Auth
| Tool | Description |
|------|-------------|
| `get_connection_status` | Check WhatsApp connection; if a QR is pending, saves it as a PNG and opens it (skipped on headless hosts — use the QR web page) |
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
| `send_message` | Send text message to contact or group. **Guarded** — see [`send-guards.md`](./send-guards.md): the recipient is verified before sending (a number not on WhatsApp is refused outright, a phone JID is upgraded to its canonical `@lid`), and a server-refused send **throws** instead of reporting success. |
| `send_file` | Send image/video/document/audio file. Accepts http(s) URL, base64 data: URL, or a server-side absolute path. To send a file from the host disk when the MCP runs remotely, upload it to `/upload` first (see "Sending host-disk files" below) and pass the returned URL. Same send guards as `send_message`. |

The send path is guarded three ways — see [`send-guards.md`](./send-guards.md) and
[`account-restrictions.md`](./account-restrictions.md).

### Message Actions
| Tool | Description |
|------|-------------|
| `react_to_message` | React to a message with emoji |
| `delete_message` | Delete/revoke a message you sent |
| `mark_chat_read` | Mark all messages in chat as read |

### Media
| Tool | Description |
|------|-------------|
| `download_media` | Download media (image/video/audio/document/sticker). For audio messages `transcribe` defaults to `true` and returns an `<transcription>` XML block; pass `transcribe: false` for raw audio. For images, opt-in `describe: true` returns an `<image_description>` XML block via an OpenRouter vision model. See below. |

### Reactive monitoring and webhooks

`get_new_messages`, `wait_for_messages`, `follow_chat` → [`reactive-monitoring.md`](./reactive-monitoring.md).
`register_webhook`, `deregister_webhook`, `list_webhooks` → [`webhooks.md`](./webhooks.md).

## Audio transcription & image description

`download_media` doubles as a transcription / vision endpoint via two optional parameters:

| Param | Default | Behavior |
|---|---|---|
| `transcribe` | `true` for `audio`/`ptt` messages, ignored otherwise | Preprocess bytes with ffmpeg (16 kHz mono FLAC, ~10× smaller), call Whisper `openai/whisper-large-v3` via **OpenRouter**, return an `<transcription>` XML block instead of `audioContent`. Route is chosen by `AUDIO_PROVIDER` (`openrouter` default, `groq`/`openai` rollback lanes) — never by which key is set. |
| `describe` | `false` always, ignored on non-image media | Send the image (base64 data URL) to an OpenRouter chat-completions vision model — `openai/gpt-6-luna` unless `VISION_MODEL` says otherwise — and return an `<image_description>` XML block instead of `imageContent`. |

Output shape (single `text` content block alongside the usual `resource_link` + JSON metadata):

```xml
<transcription message_id="…" chat_jid="…" model="openai/whisper-large-v3" duration_s="138">
Olá, queria saber se vocês fazem entrega no meu bairro…
</transcription>
```

```xml
<image_description message_id="…" chat_jid="…" model="openai/gpt-6-luna">
Captura de um cardápio com 12 sabores de pizza, preços R$ 35–58, promoção de terça em destaque.
</image_description>
```

Required env var: `OPENROUTER_API_KEY` — one key serves both transcription and image description. Optional `AUDIO_PROVIDER` / `WHISPER_MODEL` / `VISION_MODEL` overrides. `ffmpeg` must be present on the host (already installed in the runtime image).

Long-audio note: a 24 MB FLAC ceiling guards the request (OpenRouter's multipart cap is 25 MB); typical WhatsApp voice notes up to ~25 min fit comfortably after preprocessing. Anything past that fails with a clear error (no chunking).

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
  https://mcp.example.com/upload
# → { "url": "https://mcp.example.com/media/t/default/uploads/<uuid>.mp4",
#     "key": "t/default/uploads/<uuid>.mp4",
#     "mimetype": "video/mp4", "size": 4321567 }
```

Then call `send_file({ recipient, file_path: "<url from above>", type: "video", caption })`.

Guarantees:
- Bearer-authenticated with the same `MCP_AUTH_TOKEN` as the MCP endpoint.
- 16 MB hard cap (same as Baileys / WABA limit).
- MIME sniffed from bytes — bodies that match no known format are rejected with HTTP 415 (junk / executables won't land in the bucket).
- Object key: `t/{tenantId}/uploads/{uuid}.{ext}`. The public-read bucket policy makes the returned URL fetchable by the MCP container without any extra credential exchange.

The endpoint is exposed by `src/upload-server.ts` on `UPLOAD_SERVER_PORT` (default `39003`), only started when `S3_ENABLED=true`. Traefik route required (see `deploy/docker-compose.yaml`): `mcp.example.com/upload` → `whatsapp-mcp:39003`.
