/**
 * Tests for isCriticalPath() — the single source of truth for the ask-tier
 * mirror inside the reviewer. Run: `node --test scripts/lib/critical-paths.test.mjs`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CRITICAL_PATH_GROUPS,
  isCriticalPath,
  renderCriticalPathsForPrompt,
} from "./critical-paths.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("flags the harness's own files", () => {
  for (const f of [
    ".husky/pre-push",
    ".claude/settings.json",
    "commitlint.config.cjs",
    "biome.json",
    "quality-baseline.json",
    "scripts/quality-gate.mjs",
    "scripts/security-review.mjs",
    "scripts/lib/intent.mjs",
    "scripts/dispatch-worktree.sh",
    "scripts/cleanup-worktrees.sh",
    ".gitignore",
  ]) {
    assert.equal(isCriticalPath(f), true, `${f} must be critical`);
  }
});

test("flags the send guards, data layer and operator scripts", () => {
  for (const f of [
    "src/send-guard.ts",
    "src/recipient.ts",
    "src/ack-bus.ts",
    "src/ack-errors.ts",
    "src/db/schema.ts",
    "src/database.ts",
    "scripts/backup.sh",
    "scripts/restore.sh",
    "scripts/merge-db.sh",
    "Dockerfile",
    "vitest.config.ts",
  ]) {
    assert.equal(isCriticalPath(f), true, `${f} must be critical`);
  }
});

test("flags the anti-ban guard chain", () => {
  // These are what stand between an agent and another account restriction
  // (two in July 2026). Weakening one is a business risk, not a code change.
  for (const f of [
    "src/send-policy.ts",
    "src/send-blocklist.ts",
    "src/cold-contact.ts",
    "src/send-pacer.ts",
    "src/send-typing.ts",
    // A malformed env value must read as the default, never as "guard off" —
    // so the parser is as load-bearing as the guards it configures.
    "src/env-config.ts",
    // The cold guard's oracle: always-true here silently disables it.
    "src/db/inbound-history.ts",
    "src/db/send-blocklist-store.ts",
    // No drizzle-kit runner: a table that is not created here does not exist.
    "src/db/ddl.ts",
  ]) {
    assert.equal(isCriticalPath(f), true, `${f} must be critical`);
  }
});

test("every path named in a group is itself flagged critical", () => {
  // Guards the two exports drifting apart: the prompt would advertise a path
  // the predicate does not actually gate.
  for (const group of CRITICAL_PATH_GROUPS) {
    for (const pattern of group.patterns) {
      const sample = pattern.replace("**", "anything").replace(/\/$/, "/anything");
      assert.equal(
        isCriticalPath(sample),
        true,
        `${group.label}: ${pattern} (as ${sample}) must be critical`,
      );
    }
  }
});

test("renders every group and pattern for the reviewer prompt", () => {
  const rendered = renderCriticalPathsForPrompt();
  assert.ok(rendered.length > 0);
  for (const group of CRITICAL_PATH_GROUPS) {
    assert.ok(rendered.includes(group.label), `prompt must name group ${group.label}`);
    for (const pattern of group.patterns) {
      assert.ok(rendered.includes(pattern), `prompt must list ${pattern}`);
    }
  }
});

test("the .claude/settings.json ask tier gates every critical path", () => {
  // The drift this whole module exists to prevent: the anti-ban guards were
  // listed in CLAUDE.md's table while absent from the ask tier, so an agent
  // could rewrite the cold-contact guard with no approval prompt. A doc table
  // cannot enforce that invariant; this test can.
  const settings = JSON.parse(readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"));
  const ask = new Set(settings.permissions.ask);

  for (const group of CRITICAL_PATH_GROUPS) {
    for (const pattern of group.patterns) {
      // Claude Code's matcher wants a glob for directories; the module stores
      // them as prefixes so `startsWith` stays the predicate's mechanism.
      const rule = pattern.endsWith("/") ? `${pattern}**` : pattern;
      for (const verb of ["Edit", "Write"]) {
        assert.ok(
          ask.has(`${verb}(${rule})`),
          `${group.label}: ask tier is missing ${verb}(${rule})`,
        );
      }
    }
  }
});

test("flags every markdown file, at any depth", () => {
  assert.equal(isCriticalPath("CLAUDE.md"), true);
  assert.equal(isCriticalPath("README.md"), true);
  assert.equal(isCriticalPath("docs/agent-presence-stream-recipe.md"), true);
});

test("does not flag ordinary source or test files", () => {
  for (const f of [
    "src/mcp/tools/sending.ts",
    "src/monitoring.ts",
    "src/formatters.ts",
    // Tests stay freely editable. The reviewer still TAGS them in its log as a
    // deliberate superset — that is a call-site concern, not approval-gating.
    "src/__tests__/send-guard.test.ts",
    "package.json",
  ]) {
    assert.equal(isCriticalPath(f), false, `${f} must NOT be critical`);
  }
});

test("does not flag a path that merely contains a critical name as a substring", () => {
  // Guards against a `startsWith`/`includes` slip re-classifying unrelated files.
  assert.equal(isCriticalPath("src/database.test-helpers.ts"), false);
  assert.equal(isCriticalPath("docs/Dockerfile-notes.txt"), false);
});
