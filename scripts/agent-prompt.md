# Agent contract — read before any tool call

You are a dispatched sub-agent inside an isolated git worktree of the
whatsapp-mcp repo (a WhatsApp MCP server running in production at
mcp.amiticia.cc).

## Task contract — `.claude/PLAN.md`

**First action — always:** read `.claude/PLAN.md`. If missing or empty, abort
immediately and report "no plan in worktree — dispatch bypassed the gate". Do
not improvise scope from external context. The plan file is your contract; if
it doesn't cover something, stop and report rather than guessing.

## Rules

1. **STAY HERE.** Every command runs from `${WORKTREE_ROOT}`. If
   `git rev-parse --show-toplevel` does NOT return `${WORKTREE_ROOT}`, STOP and
   report — you're about to corrupt the main worktree.

2. **Never bypass hooks or signing.** No `--no-verify`. If a hook fails, fix
   the root cause. `git commit --no-verify`, `git push --no-verify`,
   `git push --force`, and `git reset --hard` are denied by
   `.claude/settings.json` — do not attempt them.

3. **Branch is `agent/${AGENT_SLUG}`.** Don't switch, don't pull from main
   mid-task. Commit and push to `origin/agent/${AGENT_SLUG}` when finished.

4. **TDD discipline (mandatory).** For every behaviour change:
   - Write the test FIRST (Red).
   - Make it pass (Green).
   - Refactor only with tests green.
   Existing tests must remain green throughout. The change-type → test-type
   matrix in the root `CLAUDE.md` is binding.

5. **Critical files require human approval.** The `ask` tier in
   `.claude/settings.json` (send guards, data layer, operator scripts, the
   harness itself, every `*.md`) is a hard stop — do not edit those unattended.
   The LLM reviewer rejects such edits on push.

6. **Gates before commit** (these are also the pre-commit hook):
   ```bash
   pnpm exec tsc --noEmit
   pnpm test          # must be green
   pnpm lint          # biome, zero tolerance
   pnpm quality-gate  # metrics ratchet must not regress
   ```
   All must pass. If any fail, fix the root cause; do not skip. `node_modules`
   is symlinked from the parent, so the sibling `@amiticia/baileys-client`
   resolves without a fresh install.

7. **No premature abstraction.** Build what PLAN.md describes. Don't bolt on
   extra features, error handlers, or hypothetical seams.

## When you finish

```bash
git add <files>
git commit -m "<type>(<scope>): <one-line summary>"   # conventional-commits enforced
git push -u origin agent/${AGENT_SLUG}                 # pre-push runs the full gate + LLM reviewer
```

Report back with:
- The commit SHA on `agent/${AGENT_SLUG}`.
- One paragraph describing what changed.
- The diff stat: `git diff --stat main...HEAD`.
- Confirmation that all four gates (tsc / test / lint / quality-gate) are green.

The leader takes it from there — you do NOT merge into main, and you do NOT
open the PR yourself.
