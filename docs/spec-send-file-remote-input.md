# Spec — `send_file` should accept remote / inline input

## Why

Today `send_file` requires `file_path` to be a path on the MCP server's filesystem (`fs.readFileSync` in `src/whatsapp.ts:348`). The MCP is consumed by remote clients (Claude Code on developer laptops, agents in CI, future plugins). Those clients can't see the server's filesystem, so the only way to send media today is the four-step dance:

1. `scp` file to VPS
2. `docker cp` into `whatsapp-mcp` container
3. Call `send_file` with the in-container path
4. Clean up

This makes media validation, screenshot sharing, "send this receipt" agent flows, and any non-trivial automation painful.

## What

Extend `send_file` so `file_path` accepts three input shapes (auto-detect by prefix):

| Shape | Example | Resolution |
|---|---|---|
| Local path (current) | `/tmp/img.png` | `fs.readFileSync` (unchanged) |
| HTTP(S) URL | `https://picsum.photos/600/400` | `fetch()` → buffer, with size + content-type checks |
| `data:` URL | `data:image/png;base64,iVBORw0K…` | parse + decode base64 |

Optional 4th shape (do not implement in v1, but keep the door open): `minio://bucket/key` if the existing `whatsapp-mcp-minio` sidecar is meant to be used.

## Constraints

- **Max size**: 16 MB (WABA / WhatsApp limit). Reject earlier with a clear error if `Content-Length` says larger; for streamed responses without `Content-Length`, hard-cap at 16 MB while reading.
- **Allowed schemes**: only `http`, `https`, `data`, and absolute filesystem path. Refuse `file://`, `ftp://`, anything else.
- **Timeout**: 15 s on the HTTP fetch.
- **MIME sanity**: detect mime from headers (URL) or the `data:` prefix; if missing/ambiguous, fall back to inferring from the user-supplied `type` enum.
- **No path traversal regressions**: when input is a filesystem path, keep current behaviour. Don't add a "download then read" round-trip for local paths.
- **Error messages** must say which shape was detected and why it was rejected (size, scheme, fetch failure). The current error ("Check if the file path is correct and accessible") is opaque.

## Where the change lands

- `libs/whatsapp-mcp/src/whatsapp.ts` — `sendWhatsAppMedia` (line ~330). Add a `resolveInput(filePathOrUrl)` helper that returns a `Buffer` regardless of input shape.
- Tool description in `libs/whatsapp-mcp/src/mcp.ts` (line ~350) — update the `file_path` Zod description to say it accepts path / http(s) URL / `data:` URL.

## Tests (TDD — write first)

In `libs/whatsapp-mcp/src/__tests__/`:

- `resolve-input.test.ts`
  - local path → reads file (mock fs)
  - http URL → fetches, mocks `globalThis.fetch`, returns buffer
  - data URL → decodes base64 correctly for png + jpeg
  - oversize URL → throws with size error
  - bad scheme (`file://`, `ftp://`) → throws with scheme error
  - fetch timeout → throws with timeout error

Existing `send_file` tests stay green; new tests cover the new branches.

## Out of scope

- Minio integration (defer until there's a real need)
- Streaming uploads to WABA (16 MB cap means buffering is fine)
- Auto-resize / auto-convert media (caller's job)

## Acceptance criterion

A remote client (e.g. Claude Code on a laptop) can do:

```
send_file({
  recipient: "5531xxxxxxxxx@s.whatsapp.net",
  file_path: "https://example.com/proof.jpg",
  type: "image",
  caption: "validation E1"
})
```

…and the media arrives on the target WhatsApp without anyone touching the MCP host.
