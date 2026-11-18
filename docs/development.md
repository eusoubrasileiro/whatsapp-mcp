# Development

## Setup: two sibling repositories

`whatsapp-mcp` depends on [`baileys-client`](https://github.com/eusoubrasileiro/baileys-client)
through `link:../baileys-client` (npm name `@amiticia/baileys-client`), so both repos must be
cloned side by side:

```bash
git clone https://github.com/eusoubrasileiro/baileys-client.git
git clone https://github.com/eusoubrasileiro/whatsapp-mcp.git
(cd baileys-client && pnpm install && pnpm build)
cd whatsapp-mcp && pnpm install
```

Without the built sibling, `pnpm typecheck` fails with `TS2307: Cannot find module
'@amiticia/baileys-client'` and the suites that import it (`message-parsing.test.ts`,
`whatsapp-concurrency.test.ts`) fail. That is the missing checkout, not a regression. The
same constraint is why there is no hosted CI yet.

Node.js 24 (`.nvmrc`) — `--experimental-strip-types` runs the TypeScript directly, and
`better-sqlite3` is a native module built against the active Node.

## Running locally

```bash
pnpm start                                           # stdio transport (default)
MCP_TRANSPORT=httpstream MCP_AUTH_TOKEN=dev pnpm start   # HTTP, like production
docker compose -f docker-compose.dev.yaml up -d      # optional local RustFS for media
```

To point Claude Code at a local stdio build instead of a deployed instance:

```bash
claude mcp remove --scope user whatsapp
claude mcp add --scope user whatsapp -- \
  "$(which node)" --experimental-strip-types "$(pwd)/src/main.ts"
```

Swap back to the HTTP entry afterwards; `claude mcp add` replaces it.

The hub (the PIN-protected page that shows every number) is a second entry point in the same
codebase, `src/hub/main.ts`. To see it locally over one HTTP server started as above with
`INSTANCE_LABEL=dev`:

```bash
mkdir -p /tmp/wa-hub
HUB_PIN=local-dev-pin HUB_COOKIE_KEY="$(openssl rand -hex 32)" \
HUB_INSTANCES=dev=http://127.0.0.1:39002 \
HUB_PUBLIC_URL=http://localhost:39100 HUB_PORT=39100 HUB_STATE_DIR=/tmp/wa-hub \
  pnpm start:hub                                     # then open http://localhost:39100/
```

`src/hub/**` imports nothing from the WhatsApp side (a test pins its import graph): it only
reads each number's status port.

## Tests

Red-Green-Refactor: write the failing test first.

| Change | Test written first |
|---|---|
| New MCP tool or endpoint | Unit test of the use case + registration/integration test |
| New pure helper | Unit test |
| Bug fix | Regression test reproducing the bug |
| Refactor | Existing tests green before and after |
| Dependency bump | Contract test pinning the consumed API surface |

Unit tests live in `src/__tests__/*.test.ts` (vitest). Names describe behavior
(`it("returns fallback when socket is null")`); never mock the module under test. Order:
happy path → edge cases → guards → error paths. `pnpm test:harness` runs the `node --test`
suite for the review and mutation tooling in `scripts/`.

The E2E suite lives in `e2e/` (`pnpm test:e2e`, config `vitest.e2e.config.ts`). Each spec boots
the real MCP, status, upload and stream servers — and the hub, where a spec needs it — in child
processes on a temp data dir and ephemeral ports, and drives them over HTTP. It needs the dev
RustFS: `pnpm test:e2e:deps` starts it, and the upload spec fails, never skips, when it is down.
WhatsApp is never connected: an egress guard kills the child on any non-loopback connect. Do
not call `get_connection_status` from a spec — while disconnected it starts a real connection.
The pre-push e2e leg runs this suite.

Five specs cover the deploy files rather than one server. They need Docker with two images
pulled once: the Traefik version the routing spec pins and `rustfs/rustfs:latest`. Without an
image a spec fails, never skips, and the failure prints the `docker pull` line.

- `deploy-compose` renders `deploy/docker-compose.yaml` and
  `deploy/docker-compose.instance.yaml` with `docker compose config` and pins what they give a
  number, its store and the hub.
- `store` covers the store harness, `e2e/support/store.ts`: it starts the `minio` service of a
  rendered compose file in a throwaway container, changing only the container name, the
  network and the data volume, and refuses to start any other service. **Start a store in a
  spec only through that harness, and never run `docker compose up` on a file under `deploy/`
  or `e2e/fixtures/` yourself**: those files also hold the app, and a real app container
  contacts WhatsApp.
- `one-host-routing` turns the rendered Traefik labels into a proxy configuration, starts a
  real Traefik in a throwaway container bound to loopback and one real store per number, and
  drives two numbers and the hub through it: own path and own token, the other number's token
  refused, each label's media served from its own store and refused under the other label,
  the status port never routed, everything else answered by the hub's PIN form. It also holds
  each store to its memory ceiling with four of the largest objects at once, which needs free
  swap on the machine that runs the suite.
- `migration-rehearsal` starts a server in the new shape on a copy of the single-instance data
  layout and proves the pairing files and the database are byte-identical afterwards.
- `store-migration` rehearses the move from one shared store to one store per number, in the
  order of the runbook in [`deploy/README.md`](../deploy/README.md), starting from the earlier
  layout kept verbatim under `e2e/fixtures/`: the copy tool run as a child process, its
  verification and its refusals, routing while both layouts coexist, a store restarted on
  existing data with new credentials, removal of the old copies, rollback.

Every harness that needs a port asks the system for a free one and repeats a start that loses
the race for it (`server-harness` pins that for the servers). A spec whose teardown throws
before it stops what it started can still leave containers behind:
`docker ps --filter name=whatsapp-mcp-e2e-` lists them.

## Git hooks (husky)

| Hook | Runs |
|---|---|
| `pre-commit` | `lint-staged` (biome fix) → `tsc --noEmit` → `pnpm test:coverage` → `pnpm quality-gate` |
| `commit-msg` | commitlint (Conventional Commits; `bug:` / `hotfix:` also accepted), then rejects a `Ratified-by:` line git does not parse as a trailer |
| `post-commit` | prints the quality-gate delta (never blocks) |
| `pre-push` | tsc → `test:harness` → lint → `test:coverage` → e2e (path-triggered) → `quality-gate` → mutation gate (path-triggered) → `scripts/security-review.mjs` (LLM reviewer via the Claude CLI, fail-closed — without an authenticated `claude` on PATH the push is refused; outside contributors can open a PR instead) |

The **mutation gate** (`scripts/mutation-gate.mjs`) breaks one character of `src/` on the
lines a push changed and runs the suite: any mutant no test notices blocks the push. The
reviewer stops a branch after 3 rejects (`MAX_FIX_ROUNDS`) — report to the owner instead of
retrying.

`pnpm quality-gate` is a deterministic ratchet against `quality-baseline.json` (max file
length, duplication, `any` casts, assertion count, coverage): metrics may improve, never
regress. `pnpm quality-gate:update` re-snapshots the baseline after an improvement.

Never bypass the hooks with `--no-verify`; fix the cause.

## Sensitive paths

[`scripts/lib/critical-paths.mjs`](../scripts/lib/critical-paths.mjs) is the single list of
files whose edits need human approval. It feeds the pre-push reviewer, and
`scripts/lib/critical-paths.test.mjs` asserts `.claude/settings.json` gates every pattern in
it. A pushed commit touching any of them must carry the owner's `Ratified-by:` trailer
(`scripts/lib/ratification.mjs`); the reviewer checks it from git and rejects before any
model call when it is missing. The groups:

| Group | Why |
|---|---|
| Hooks, review and mutation-gate scripts, lint/commit/knip config, quality baseline | An agent that can edit the gate can delete the gate |
| Send guards — `send-guard.ts`, `recipient.ts`, `ack-bus.ts`, `ack-errors.ts` | Weakening them re-opens "success reported, message never sent" |
| Anti-ban policy — `send-policy.ts`, `send-blocklist.ts`, `cold-contact.ts`, `send-pacer.ts`, `send-typing.ts`, `env-config.ts`, `db/inbound-history.ts`, `db/send-blocklist-store.ts` | These stand between an agent and an account restriction |
| Data layer — `db/schema.ts`, `database.ts`, `db/ddl.ts` | Mistakes corrupt the message store |
| Operator scripts — `backup.sh`, `restore.sh`, `merge-db.sh` | Destructive against `/data` |
| `Dockerfile`, `vitest.config.ts` | Deploy artifact and coverage thresholds |
| All `*.md` | Docs steer agents |

When you change the module, change this table in the same commit.

## Parallel agent worktrees

`pnpm dispatch <slug>` creates `.claude/worktrees/<slug>` on branch `agent/<slug>` and requires
a task plan at `.claude/plans/<slug>.md`, which it copies into the worktree as `.claude/PLAN.md`. The worktree gets a **symlinked `node_modules`** from the
parent checkout because `link:../baileys-client` cannot resolve two directories deeper —
don't run `pnpm install` inside it. Tear down with `pnpm dispatch:cleanup --slug <slug>
[--force]`. (A worktree created as a sibling of this repo, e.g. `../whatsapp-mcp-feature`,
resolves the link normally and can `pnpm install`.)

## Behavioral probes

Declared in [`CLAUDE.md`](../CLAUDE.md#behavioral-probes) — one copy, so it cannot drift.
