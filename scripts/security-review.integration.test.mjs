/**
 * The real reviewer script, run against throwaway repositories with a fake `claude` CLI
 * on PATH. Proves what the pure tests cannot: that an unratified critical edit is
 * rejected from git BEFORE any model is called, that every verdict is stamped with the
 * commit it reviewed (never "(staged)"), and that the plan's "Done when" reaches the
 * model verbatim.
 *
 * Hook-env hygiene: GIT_* and PUSH_* leak in when this runs under a git hook; both would
 * redirect the fixture's git (and the reviewer's) at the live checkout, so they are
 * stripped from every env below, including the one handed to the spawned reviewer.
 *
 * Run: `node --test scripts/security-review.integration.test.mjs`
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { countFixRounds, hasEscalated, isApproval } from "./lib/review-log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && !k.startsWith("PUSH_")) env[k] = v;
  }
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extra };
}

let repo;
let bin;
let calls;

const git = (args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() }).trim();

function commitFile(rel, content, message) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
  git(["add", "-A"]);
  git(["commit", "-qm", message]);
}

/** Run the reviewer as a manual run (no PUSH_* — the range is merge-base..HEAD). */
function review() {
  const r = spawnSync("node", [join(repo, "scripts", "security-review.mjs")], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({ PATH: `${bin}:${process.env.PATH}` }),
  });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout };
}

const llmPrompts = () =>
  existsSync(calls) ? readFileSync(calls, "utf8").split("\x00").filter(Boolean) : [];
const reviewerPrompts = () => llmPrompts().filter((p) => p.includes("integrity reviewer"));

const lastEntry = () => {
  const lines = readFileSync(join(repo, ".quality-gate", "review-log.jsonl"), "utf8")
    .trim()
    .split("\n");
  return JSON.parse(lines.at(-1));
};

/**
 * (Re)write the fake `claude` so the reviewer stage answers with `fields`.
 *
 * One stub serves both LLM calls — the Haiku "why" summarizer and the Sonnet
 * reviewer — so the Haiku fields stay in every payload and only the reviewer's
 * own fields vary. Omitting `verdict` from `fields` is how "the verdict key is
 * absent entirely" is expressed: JSON has no `undefined`, so an absent key and
 * an undefined one are the same bytes on the wire (the undefined case is
 * covered as a unit in security-review-outcome.test.mjs).
 */
function fakeClaude(fields) {
  const payload = {
    justification: "fine",
    concerns: [],
    origin_clear: true,
    paragraph: "why",
    ...fields,
  };
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\ncat >> "${calls}"\nprintf '\\0' >> "${calls}"\n` +
      `echo '${JSON.stringify({ structured_output: payload })}'\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sec-review-"));
  bin = mkdtempSync(join(tmpdir(), "sec-review-bin-"));
  calls = join(repo, "..", `calls-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);

  // Fake `claude`: records every prompt, approves everything. One payload satisfies both
  // the reviewer's schema and the Haiku "why" schema. Fake `gh`: always unavailable.
  fakeClaude({ verdict: "approve" });
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);

  // The reviewer under test, laid out the way a project has it: scripts/ + scripts/lib/.
  mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
  copyFileSync(join(HERE, "security-review.mjs"), join(repo, "scripts", "security-review.mjs"));
  for (const f of readdirSync(join(HERE, "lib"))) {
    if (f.endsWith(".mjs") && !f.endsWith(".test.mjs")) {
      copyFileSync(join(HERE, "lib", f), join(repo, "scripts", "lib", f));
    }
  }
  cpSync(join(HERE, "prompts"), join(repo, "scripts", "prompts"), { recursive: true });

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  // Mirrors the real repo: PLAN.md is rendered per worktree and never tracked, so
  // it can never reach a push range (here it would read as an unratified *.md edit).
  writeFileSync(join(repo, ".gitignore"), ".quality-gate/\n.claude/PLAN.md\n");
  commitFile("src/base.ts", "export const base = 1;\n", "chore: base");
  git(["checkout", "-qb", "feat"]);
});

describe("every verdict names the commit it reviewed", () => {
  it("stamps a verdict with HEAD's full hash, never (staged)", () => {
    commitFile("src/feature.ts", "export const feature = true;\n", "feat: stamped");
    assert.equal(review().code, 0);
    assert.equal(lastEntry().commit, git(["rev-parse", "HEAD"]));
  });
});

describe("ratification is decided by git, not by the model", () => {
  const critical = (body = "") =>
    commitFile(
      "scripts/lib/extra.mjs",
      "export const x = 1;\n",
      `chore(harness): tweak${body ? `\n\n${body}` : ""}`,
    );

  it("rejects an unratified critical edit without asking any model", () => {
    critical();
    const r = review();
    assert.notEqual(r.code, 0);
    const entry = lastEntry();
    assert.equal(entry.verdict, "reject");
    assert.ok(entry.concerns.includes("unratified-critical-edit"));
    assert.equal(entry.commit, git(["rev-parse", "HEAD"]));
    assert.equal(llmPrompts().length, 0, "no model may be called");
    assert.match(r.stderr, /Ratified-by/);
  });

  it("lets a ratified critical edit through to the reviewer", () => {
    critical("Ratified-by: Andre");
    assert.equal(review().code, 0);
    assert.equal(lastEntry().verdict, "approve");
    assert.equal(reviewerPrompts().length, 1);
  });

  it("never tells the model to reject a critical edit outright", () => {
    // The prompt once listed the harness files under "Reject when" unconditionally,
    // while its Ratification section said a ratified edit must not be rejected.
    critical("Ratified-by: Andre");
    review();
    const prompt = reviewerPrompts()[0];
    assert.match(prompt, /all-ratified/);
    assert.doesNotMatch(prompt, /^- .*`commitlint\.config\.cjs` modified\.$/m);
  });

  // whatsapp-mcp: the ratification paths are critical-paths.mjs, so a send guard and
  // a doc are gated exactly like the harness — not only the template's harness list.
  for (const [what, rel] of [
    ["a send guard", "src/send-guard.ts"],
    ["a doc at any depth", "docs/notes.md"],
  ]) {
    it(`rejects an unratified edit to ${what} without asking any model`, () => {
      commitFile(rel, "x\n", "chore: tweak");
      assert.notEqual(review().code, 0);
      assert.ok(lastEntry().concerns.includes("unratified-critical-edit"));
      assert.equal(llmPrompts().length, 0, "no model may be called");
    });
  }

  it("leaves ordinary product code to the reviewer", () => {
    commitFile("src/actions.ts", "export const a = 1;\n", "feat: plain");
    assert.equal(review().code, 0);
    assert.equal(reviewerPrompts().length, 1);
  });
});

describe("the verdict space, end to end — nothing but an approval is green", () => {
  // The whole verdict space the model can put on the wire, driven through the
  // real script. `approve` and `reject` pin today's behaviour; the rest are the
  // values that used to be read as "not a reject, therefore green".
  const run = (fields) => {
    fakeClaude(fields);
    commitFile("src/feature.ts", "export const feature = true;\n", "feat: verdict space");
    return review();
  };

  it("a genuine approval exits 0 and prints APPROVE", () => {
    const r = run({ verdict: "approve" });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /APPROVE/);
    assert.equal(lastEntry().verdict, "approve");
  });

  it("an explicit reject blocks on the reject path, as today", () => {
    const r = run({ verdict: "reject", concerns: ["bad thing"] });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /COMMIT REJECTED/);
    assert.doesNotMatch(r.stdout, /APPROVE/);
    assert.equal(lastEntry().verdict, "reject");
  });

  for (const [name, fields] of [
    ["escalate", { verdict: "escalate" }],
    ["an empty string", { verdict: "" }],
    ["banana", { verdict: "banana" }],
    ["no verdict key at all", {}],
  ]) {
    it(`${name} is not green and blocks the push`, () => {
      const r = run(fields);
      assert.notEqual(r.code, 0, "an unreadable verdict must block");
      assert.doesNotMatch(r.stdout, /APPROVE/, "an unreadable verdict must never print APPROVE");
    });

    it(`${name} is logged as not-an-approval rather than as a reject`, () => {
      // A reviewer that cannot say what it meant has not found a defect, so it
      // must not spend one of MAX_FIX_ROUNDS. The count itself is computed by
      // countFixRounds over this field (unit-tested in
      // lib/review-log-approval.test.mjs), so the field is what is asserted here.
      run(fields);
      const entry = lastEntry();
      assert.notEqual(entry.verdict, "approve");
      assert.notEqual(entry.verdict, "reject", "must not burn a fix round");
      assert.notEqual(entry.verdict, "escalate", "must not burn a fix round");
      assert.equal(entry.verdict, "awaiting-approval");
    });

    it(`${name} is named in stderr so the operator can tell it from a reject`, () => {
      const r = run(fields);
      const shown = fields.verdict === undefined ? "(absent)" : JSON.stringify(fields.verdict);
      // A purpose-built line, not the incidental raw-payload dump: the dump
      // already contained the quoted value, so asserting on it alone passed
      // vacuously against the broken script.
      assert.match(r.stderr, /unreadable reviewer verdict/);
      assert.doesNotMatch(r.stderr, /COMMIT REJECTED/, "must not read as a code rejection");
      assert.ok(
        r.stderr.includes(shown),
        `stderr must name the verdict it could not read (${shown}); got:\n${r.stderr}`,
      );
    });
  }
});

describe("the reviewer reads the plan's definition of done verbatim", () => {
  it("puts the Done when section into the reviewer's prompt", () => {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "PLAN.md"),
      "# p\n\n## Scope\n\n- x\n\n## Done when\n\n- The widget renders.\n- Criterion two.\n",
    );
    commitFile("src/feature.ts", "export const feature = true;\n", "feat: planned");
    assert.equal(review().code, 0);
    const prompt = reviewerPrompts()[0];
    assert.match(prompt, /Definition of done/);
    assert.ok(prompt.includes("- The widget renders.\n- Criterion two."));
  });
});

describe("a reviewer outage blocks the push without spending a fix round", () => {
  /**
   * The two dials of standards.md §5, on the one path that gets them wrong.
   *
   * An outage must stop the push (dial A: a reviewer that never answered has
   * not reviewed) while NOT counting toward MAX_FIX_ROUNDS (dial B: a dead
   * network is no evidence the code is bad). Logging it as a `reject` does
   * both, so three transient failures escalate a branch nobody rejected and
   * pull the owner in over nothing.
   */
  const breakClaude = () => {
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "claude"), 0o755);
  };

  it("blocks the push — dial A still holds", () => {
    commitFile("src/feature.ts", "export const feature = true;\n", "feat: outage");
    breakClaude();
    const r = review();
    assert.equal(r.code, 1, "an unavailable reviewer must never let a push through");
    assert.match(r.stderr, /PUSH BLOCKED/);
  });

  it("logs a non-reject verdict that countFixRounds ignores", () => {
    commitFile("src/feature.ts", "export const feature = true;\n", "feat: outage");
    breakClaude();
    review();
    const entry = lastEntry();
    assert.notEqual(entry.verdict, "reject", "an outage is not a code judgement");
    assert.equal(entry.verdict, "awaiting-approval");
    assert.deepEqual(entry.concerns, ["security-reviewer-unavailable"]);
    assert.equal(countFixRounds(entry.branch, [entry]), 0);
  });

  it("three outages in a row do not escalate the branch", () => {
    commitFile("src/feature.ts", "export const feature = true;\n", "feat: outage");
    breakClaude();
    for (let i = 0; i < 3; i += 1) assert.equal(review().code, 1);
    const log = readFileSync(join(repo, ".quality-gate", "review-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const branch = log.at(-1).branch;
    assert.equal(countFixRounds(branch, log), 0, "outages must not accumulate into the bound");
    assert.equal(hasEscalated(branch, log), false);
    assert.doesNotMatch(review().stderr, /The fix loop is over/);
  });
});

/**
 * `standards.md:608` names the worst failure mode in this harness: "not a red gate — it is
 * a green one that ran nothing". The empty-file-list early exit was one. `getPushedFiles`
 * goes through `safeExec`, which swallows a git failure and returns "", so "there is
 * nothing to push" and "the range could not be computed" arrived at that branch as the
 * same value — and it logged `approve` and exited 0 for both.
 *
 * The discriminator is the range itself, probed without swallowing the error. These tests
 * pin all three outcomes apart, because a fix that blocks every empty range would strand
 * an honest no-op push with nothing its author could do about it.
 */
describe("a green verdict is never logged for a range that was not read", () => {
  /** Drop the one ref `getPushRange` can anchor on, so every candidate range is unresolvable. */
  const orphanTheRange = () => git(["branch", "-D", "main"]);

  it("blocks when git cannot resolve the push range, instead of approving it", () => {
    commitFile("src/feature.ts", "export const feature = true;\n", "feat: work");
    orphanTheRange();
    const r = review();
    assert.equal(r.code, 1, "a range that was never read must not pass");
    assert.match(r.stderr, /PUSH BLOCKED/);
  });

  it("logs an unresolvable range as non-green, and spends no fix round on it", () => {
    commitFile("src/feature.ts", "export const feature = true;\n", "feat: work");
    orphanTheRange();
    review();
    const entry = lastEntry();
    assert.equal(isApproval(entry.verdict), false, "nothing was reviewed — this is not green");
    assert.equal(entry.verdict, "awaiting-approval");
    assert.deepEqual(entry.concerns, ["push-range-unresolved"]);
    assert.equal(countFixRounds(entry.branch, [entry]), 0, "a broken range is no code judgement");
  });

  it("passes an honest no-op push, but does not call it an approval", () => {
    const r = review(); // branch `feat` is cut from main and carries no commits
    assert.equal(r.code, 0, "there is genuinely nothing to review — do not strand the push");
    const entry = lastEntry();
    assert.equal(entry.verdict, "no-review");
    assert.equal(isApproval(entry.verdict), false, "`no-review` must never render as green");
    assert.equal(countFixRounds(entry.branch, [entry]), 0);
  });

  it("passes commits whose net diff is empty, naming how many it found", () => {
    commitFile("src/tmp.ts", "export const tmp = 1;\n", "feat: add");
    git(["revert", "--no-edit", "HEAD"]);
    const r = review();
    assert.equal(r.code, 0, "a change and its revert are nothing to review");
    const entry = lastEntry();
    assert.equal(entry.verdict, "no-review");
    assert.match(entry.justification, /2 commit/, "say what it found, so the log is readable");
  });

  it("never calls the model for any of the three", () => {
    commitFile("src/feature.ts", "export const feature = true;\n", "feat: work");
    orphanTheRange();
    review();
    assert.deepEqual(reviewerPrompts(), [], "no diff was read, so there is nothing to review");
  });
});
