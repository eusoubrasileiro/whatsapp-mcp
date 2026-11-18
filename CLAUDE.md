# CLAUDE.md

WhatsApp as an MCP server (FastMCP, 23 tools) on top of Baileys. Production shape: one public
hostname behind Traefik and **one long-lived Docker container per WhatsApp number** — MCP at
`https://wa.example.com/<label>/mcp` (Bearer auth, one token per number), with its own
S3-compatible RustFS container for media — plus a small hub container at
`https://wa.example.com/` (a PIN-protected page with every number's state and QR code).
User-facing overview: [`README.md`](./README.md).

## Setup

Two sibling repos: this one depends on
[`baileys-client`](https://github.com/eusoubrasileiro/baileys-client) via
`link:../baileys-client` (package `@amiticia/baileys-client`). Build the sibling first
(`pnpm install && pnpm build` there), then `pnpm install` here. Without it, typecheck and two
test suites fail on the missing module — not a regression. Node 24 (`.nvmrc`); TypeScript
runs directly via `--experimental-strip-types`, there is no build step.

## Commands

| Command | Does |
|---|---|
| `pnpm start` | Run the server (stdio; `MCP_TRANSPORT=httpstream` for HTTP) |
| `pnpm start:hub` | Run the hub page (`src/hub/main.ts`; needs the `HUB_*` variables) |
| `pnpm test` / `pnpm test:coverage` | vitest |
| `pnpm exec tsc --noEmit` | Typecheck |
| `pnpm lint` / `pnpm lint:fix` | Biome |
| `pnpm test:e2e` | Real servers over HTTP, WhatsApp never connected; needs `pnpm test:e2e:deps` (dev RustFS) up, and Docker with the Traefik and RustFS images for the routing and store specs |
| `pnpm store:copy` | Copy, verify or remove one number's objects between two stores (`STORE_COPY_*` settings); only for moving a host off one shared store — see [`deploy/README.md`](./deploy/README.md) |
| `pnpm test:harness` | `node --test` for `scripts/lib/*.test.mjs` |
| `pnpm quality-gate` | Metrics ratchet vs `quality-baseline.json` (fails on regression) |

Husky hooks run tsc + tests + quality gate on every commit, and the full set plus an LLM
security review on push. Never `--no-verify`. Details: [`docs/development.md`](./docs/development.md).

## Architecture

```mermaid
flowchart LR
  C[MCP clients] -->|"/&lt;label&gt;/mcp Bearer"| T[Traefik]
  P[Phone browser] -->|"/ PIN"| T
  T --> HUB["hub :39002 (src/hub)"]
  T --> M[":39001 FastMCP"]
  T --> U[":39003 /upload"]
  T --> S[":39004 /stream (follow_chat)"]
  T --> R[("/&lt;label&gt;/media → RustFS")]
  HUB -. "polls /health, /qr.png" .-> Q[":39002 status port, not routed"]
  M & Q & U & S --> W[whatsapp.ts adapter] --> B[baileys-client] --> WA[(WhatsApp)]
  W --> DB[(SQLite)]
  W -. webhooks .-> H[subscriber URLs]
  W -. ntfy .-> N[your phone]
```

`M`, `Q`, `U`, `S`, the adapter and the database are one number's container, and `R` is that
number's own store beside it: there is one of each per number, with credentials no other
number holds, and `/<label>/media` reaches only that label's store. Only the hub is shared. It
never talks to WhatsApp and holds no number's token and no store credential.

```
src/
├── main.ts            entry; startup order: MCP handshake first, then WhatsApp connect
├── mcp.ts             FastMCP server; registers src/mcp/tools/*.ts
├── mcp/tools/         one file per tool group — thin; logic lives below
├── actions.ts         testable use cases behind the tools
├── whatsapp.ts        adapter over baileys-client: events → DB, sends, media download
├── connection-fsm.ts  connection phases → ntfy pushes (connection-notifier.ts, ntfy.ts)
├── database.ts        Drizzle + better-sqlite3 queries (at the file-size ceiling)
├── db/                schema.ts, ddl.ts (CREATE TABLEs), inbound-history, send-blocklist-store
├── send-*.ts, cold-contact.ts, recipient.ts, ack-*.ts   send guards (see below)
├── env-config.ts      env parsers — malformed value → default, never "guard disabled"
├── media-input.ts, sniffed-media.ts   send_file input resolution + magic-byte MIME sniffing
├── storage.ts         S3/RustFS media plane
├── store-copy.ts, store-copy-cli.ts   operator tool: one number's objects from one store to another; imports only `minio` and `node:` modules
├── instance-identity.ts   which line this server is (INSTANCE_LABEL) — instructions, status, send results
├── qr-server.ts, upload-server.ts, http-router.ts   side HTTP servers (qr-server = the status port)
├── hub/               the hub page: a separate program, imports nothing from the WhatsApp side
├── monitoring.ts, inbound-bus.ts, stream/   reactive monitoring + follow_chat WebSocket
├── webhooks/          outbound inbound-message push (HMAC/Bearer)
├── transcribe/        ffmpeg → FLAC → Whisper via OpenRouter
├── describe/          image description via OpenRouter vision model
└── xml.ts             <transcription> / <image_description> envelopes
```

## Critical rules

- **The send path is guarded; don't weaken it.** Pre-send `onWhatsApp()` check, post-send
  wait for an async rejection ack (~40 ms after "success"), then the anti-ban chain
  blocklist → cold-contact → pacing → typing (order is load-bearing). Read
  [`docs/send-guards.md`](./docs/send-guards.md) and
  [`docs/account-restrictions.md`](./docs/account-restrictions.md) before touching any send
  code or `SEND_*` default — those are risk-owner settings, not tuning knobs.
- **Never hand-build or normalize a JID.** Resolve recipients from contacts. Inserting the
  Brazilian "extra 9" produces a different number. **Never re-send after a 463.**
- **New tables/columns go in `src/db/ddl.ts` and `src/db/schema.ts`** — there is no migration
  runner, and `database.ts` must not grow (quality-gate ceiling).
- **Startup order in `main.ts`**: the MCP handshake completes before Baileys connects;
  reversing it makes stdio clients time out and kill the process.
- **`send_file`'s `file_path` resolves on the server.** Remote clients pass an http(s) URL, a
  `data:` URL, or upload via `POST /upload` first.
- **Audio/vision providers are chosen by env, never by which key is present**
  (`AUDIO_PROVIDER`, `VISION_MODEL`; one `OPENROUTER_API_KEY`).
- **One server is one WhatsApp line.** The identity wording an agent reads
  (`src/instance-identity.ts`: the instructions paragraph, the send-result suffix) is
  model-facing — change it only on purpose, with the tests that pin it. Without
  `INSTANCE_LABEL` every output must stay exactly as it was.
- **The hub shows the last 4 digits of a number, never more**, and never a token, a JID or a
  number's `/health` body. `src/hub/**` may import only itself, `ntfy.ts` and
  `instance-identity.ts` (a test pins the import graph), and a number's status port is never
  routed publicly.
- Edits to files listed in `scripts/lib/critical-paths.mjs` (guards, data layer, hooks,
  operator scripts, all `*.md`) need human approval.
- Tests first (Red-Green-Refactor); regression test before any bug fix.

## Behavioral probes

Unit tests can't catch this server's characteristic failure — a send that reports success and
never arrives. Before calling a send-path change done, exercise a really-running instance:

| Probe | Tool | Allowed target |
|---|---|---|
| The status port (`/health`) and the hub card show a live connection state | `curl` / a browser | a locally started server and `pnpm start:hub` |
| `POST /upload` returns a URL `send_file` can resolve | `curl` | the local stack's upload endpoint |
| `send_message` delivers and returns a real ack | an MCP client | a dedicated test number the owner names — never a production number, never a real contact |

Never the public deployment. The send probe uses WhatsApp's live network with a real
account, so it is always run attended by a person, never as an unattended gate.

## Docs

| Topic | File |
|---|---|
| Every tool, media transcription/description, `/upload` | [`docs/tools.md`](./docs/tools.md) |
| Send guards and error codes (463/479) | [`docs/send-guards.md`](./docs/send-guards.md) |
| Why the anti-ban guards exist, per-instance policy | [`docs/account-restrictions.md`](./docs/account-restrictions.md) |
| `get_new_messages` / `wait_for_messages` / `follow_chat` | [`docs/reactive-monitoring.md`](./docs/reactive-monitoring.md), [`docs/agent-presence-stream-recipe.md`](./docs/agent-presence-stream-recipe.md) |
| Outbound webhooks | [`docs/webhooks.md`](./docs/webhooks.md) |
| Env vars, data layout, DB tables | [`docs/configuration.md`](./docs/configuration.md) |
| Build, pairing, backups, troubleshooting | [`docs/operations.md`](./docs/operations.md) |
| Deploy runbook (Docker + Traefik) | [`deploy/README.md`](./deploy/README.md) |
| Dev setup, tests, hooks, worktrees | [`docs/development.md`](./docs/development.md) |
| Client configs, curl/Python/TS examples | [`examples/`](./examples/) |
