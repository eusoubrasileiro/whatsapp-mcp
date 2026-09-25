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

## Tests

Red-Green-Refactor: write the failing test first.

| Change | Test written first |
|---|---|
| New MCP tool or endpoint | Unit test of the use case + registration/integration test |
| New pure helper | Unit test |
| Bug fix | Regression test reproducing the bug |
| Refactor | Existing tests green before and after |
| Dependency bump | Contract test pinning the consumed API surface |

All tests live in `src/__tests__/*.test.ts` (vitest). Names describe behavior
(`it("returns fallback when socket is null")`); never mock the module under test. Order:
happy path → edge cases → guards → error paths. `pnpm test:harness` runs the `node --test`
suite for the review tooling in `scripts/lib/`.

## Git hooks (husky)

| Hook | Runs |
|---|---|
| `pre-commit` | `lint-staged` (biome fix) → `tsc --noEmit` → `pnpm test:coverage` → `pnpm quality-gate` |
| `commit-msg` | commitlint (Conventional Commits; `bug:` / `hotfix:` also accepted) |
| `post-commit` | records the commit hash in the review log, prints the quality-gate delta (never blocks) |
| `pre-push` | tsc → `test:harness` → lint → `test:coverage` → `quality-gate` → `scripts/security-review.mjs` (LLM reviewer via the Claude CLI, fail-closed) |

`pnpm quality-gate` is a deterministic ratchet against `quality-baseline.json` (max file
length, duplication, `any` casts, assertion count, coverage): metrics may improve, never
regress. `pnpm quality-gate:update` re-snapshots the baseline after an improvement.

Never bypass the hooks with `--no-verify`; fix the cause.

## Sensitive paths

[`scripts/lib/critical-paths.mjs`](../scripts/lib/critical-paths.mjs) is the single list of
files whose edits need human approval. It feeds the pre-push reviewer, and
`scripts/lib/critical-paths.test.mjs` asserts `.claude/settings.json` gates every pattern in
it. The groups:

| Group | Why |
|---|---|
| Hooks, review scripts, lint/commit config, quality baseline | An agent that can edit the gate can delete the gate |
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

Unit tests can't catch this server's characteristic failure — a send that reports success and
never arrives. Before calling a send-path change done, exercise a really-running instance:

| Probe | Target |
|---|---|
| QR page shows a live connection state | the local `docker-compose.dev.yaml` stack |
| `send_message` delivers and returns a real ack | a dedicated test number you own — never a production number |
| `POST /upload` returns a URL `send_file` can resolve | the local stack's upload endpoint |

The send probe uses WhatsApp's live network with a real account, so it is always run by a
person, never as an unattended gate.
