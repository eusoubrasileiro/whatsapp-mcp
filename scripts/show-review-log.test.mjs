/**
 * show-review-log.mjs against a throwaway repository: which verdict does a human see
 * before a push? Entries are stamped with the FULL sha of the commit reviewed, the
 * printout lists `git log --oneline` (abbreviated) hashes, so the match is by prefix;
 * and a push retried on the same tip logs a second verdict that supersedes the first.
 *
 * Run: `node --test scripts/show-review-log.test.mjs`
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// GIT_* from a hook beats `cwd`; PUSH_* is the pre-push contract. Strip both from the
// fixture's git and from the spawned CLI.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && !k.startsWith("PUSH_")) env[k] = v;
  }
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
}

let repo;
const git = (args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() }).trim();

function writeLog(entries) {
  mkdirSync(join(repo, ".quality-gate"), { recursive: true });
  writeFileSync(
    join(repo, ".quality-gate", "review-log.jsonl"),
    entries.map((e) => `${JSON.stringify(e)}\n`).join(""),
  );
}

const show = () =>
  spawnSync("node", [join(repo, "scripts", "show-review-log.mjs")], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv(),
  }).stdout;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "show-review-log-"));
  mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
  copyFileSync(join(HERE, "show-review-log.mjs"), join(repo, "scripts", "show-review-log.mjs"));
  copyFileSync(join(HERE, "lib", "review-log.mjs"), join(repo, "scripts", "lib", "review-log.mjs"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(["add", "a.ts"]);
  git(["commit", "-qm", "feat: a"]);
});

test("matches the full sha the reviewer stamps against the abbreviated one it lists", () => {
  const full = git(["rev-parse", "HEAD"]);
  writeLog([
    {
      ts: "2026-01-01T00:00:00Z",
      commit: full,
      verdict: "approve",
      justification: "stamped ok",
      concerns: [],
      stagedFiles: ["unrelated.ts"],
    },
  ]);
  assert.match(show(), /stamped ok/);
});

test("shows the latest verdict when one commit was reviewed twice", () => {
  const full = git(["rev-parse", "HEAD"]);
  const base = { commit: full, stagedFiles: ["a.ts"] };
  writeLog([
    {
      ...base,
      ts: "2026-01-01T00:00:00Z",
      verdict: "reject",
      justification: "reviewer down",
      concerns: ["x"],
    },
    {
      ...base,
      ts: "2026-01-01T00:05:00Z",
      verdict: "approve",
      justification: "retry approved",
      concerns: [],
    },
  ]);
  const out = show();
  assert.match(out, /retry approved/);
  assert.doesNotMatch(out, /reviewer down/);
});

// ── green is reserved for a genuine approval ────────────────────────────────
// This reader used to test `verdict === "reject" || verdict === "escalate"` and
// fall through to a green "Verdict: approve" line, so every other value printed
// as an approval in the one place a human eyeballs before pushing. The reviewer
// now writes "awaiting-approval" for an unreadable verdict, which makes that
// fallthrough actively wrong rather than merely fragile. Whitelist the one green
// value instead of extending the blacklist: a blacklist is only as closed as the
// list is complete, and the list can never be complete.

/** Render one entry with `verdict` against HEAD, and return the printout. */
const showVerdict = (verdict, justification = "not a judgement of the code") => {
  writeLog([
    {
      ts: "2026-11-02T00:00:00Z",
      commit: git(["rev-parse", "HEAD"]),
      verdict,
      justification,
      concerns: ["unparseable-verdict"],
      stagedFiles: ["a.ts"],
    },
  ]);
  return show();
};

test("an awaiting-approval entry does not render as an approval", () => {
  const out = showVerdict("awaiting-approval", "reviewer answered with an unreadable verdict");
  assert.doesNotMatch(out, /Verdict: approve/, "a blocked push must never read as approved");
  assert.match(out, /Verdict: AWAITING-APPROVAL/);
  assert.match(out, /reviewer answered with an unreadable verdict/);
  assert.match(out, /unparseable-verdict/, "its concerns must show, as for any non-approval");
});

test("a verdict nobody has thought of yet does not render as an approval", () => {
  const out = showVerdict("banana");
  assert.doesNotMatch(out, /Verdict: approve/);
  assert.match(out, /Verdict: BANANA/);
});

test("an entry with no verdict at all does not render as an approval", () => {
  const out = showVerdict(undefined);
  assert.doesNotMatch(out, /Verdict: approve/);
  assert.match(out, /Verdict: UNKNOWN/);
});

test("reject and escalate keep the labels they already had", () => {
  assert.match(showVerdict("reject"), /Verdict: REJECT/);
  assert.match(showVerdict("escalate"), /Verdict: ESCALATE/);
});

test("a genuine approval is still the one thing that prints green", () => {
  const out = showVerdict("approve", "looks fine");
  assert.match(out, /Verdict: approve/);
  assert.match(out, /looks fine/);
});
