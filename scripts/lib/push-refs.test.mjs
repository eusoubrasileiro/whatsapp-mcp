/**
 * The pre-push path-triggered legs (e2e, mutation) decide over EVERY pushed ref.
 *
 * `.husky/pre-push` once diffed only the first non-deletion ref it read from stdin, so
 * in a multi-ref push (`git push origin a b`, `--all`) a change carried by a later ref
 * skipped the leg — a silent skip, the failure mode standards.md §8.2 ranks worst.
 *
 * Run: `node --test scripts/lib/push-refs.test.mjs`
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { e2eDecision, mutationDecision, parsePushRefs } from "./push-refs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ZERO = "0000000000000000000000000000000000000000";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

const ref = (localSha, remoteSha) => ({
  localRef: "refs/heads/x",
  localSha,
  remoteRef: "refs/heads/x",
  remoteSha,
});

/** `diffNames` stub: maps "remote..local" to the files that diff reports. */
const diffs = (map) => (remote, local) => map[`${remote}..${local}`] ?? null;

describe("parsePushRefs", () => {
  it("reads every line git hands the hook, skipping blanks", () => {
    const refs = parsePushRefs(
      `refs/heads/x ${A} refs/heads/x ${B}\n\nrefs/heads/y ${C} refs/heads/y ${D}\n`,
    );
    assert.deepEqual(refs, [
      { localRef: "refs/heads/x", localSha: A, remoteRef: "refs/heads/x", remoteSha: B },
      { localRef: "refs/heads/y", localSha: C, remoteRef: "refs/heads/y", remoteSha: D },
    ]);
  });

  it("returns nothing for empty input", () => {
    assert.deepEqual(parsePushRefs(""), []);
  });
});

describe("e2eDecision", () => {
  it("skips only when every ref diffs cleanly and touches no e2e path", () => {
    const d = e2eDecision(
      [ref(A, B), ref(C, D)],
      diffs({ [`${B}..${A}`]: ["README.md"], [`${D}..${C}`]: ["docs/x.txt"] }),
    );
    assert.equal(d.run, false);
  });

  it("runs when a LATER ref carries the change — the multi-ref defect", () => {
    const d = e2eDecision(
      [ref(A, B), ref(C, D)],
      diffs({ [`${B}..${A}`]: ["README.md"], [`${D}..${C}`]: ["src/index.ts"] }),
    );
    assert.equal(d.run, true);
    assert.match(d.reason, /src\/index\.ts/);
  });

  it("runs for a new branch (remote SHA is zero)", () => {
    assert.equal(e2eDecision([ref(A, ZERO)], diffs({})).run, true);
  });

  it("runs when any ref cannot be diffed", () => {
    const d = e2eDecision([ref(A, B), ref(C, D)], diffs({ [`${B}..${A}`]: ["README.md"] }));
    assert.equal(d.run, true);
  });

  it("ignores deletions, but runs when a push is nothing else", () => {
    const deletion = ref(ZERO, B);
    assert.equal(
      e2eDecision([deletion, ref(C, D)], diffs({ [`${D}..${C}`]: ["README.md"] })).run,
      false,
    );
    assert.equal(e2eDecision([deletion], diffs({})).run, true);
    assert.equal(e2eDecision([], diffs({})).run, true);
  });

  it("treats the template's default e2e paths as e2e paths", () => {
    for (const file of ["src/a.ts", "e2e/a.spec.ts", "package.json", ".husky/pre-push"]) {
      assert.equal(e2eDecision([ref(A, B)], diffs({ [`${B}..${A}`]: [file] })).run, true, file);
    }
  });
});

describe("mutationDecision", () => {
  it("runs when a later ref touches mutable source", () => {
    const d = mutationDecision(
      [ref(A, B), ref(C, D)],
      diffs({ [`${B}..${A}`]: ["README.md"], [`${D}..${C}`]: ["src/x.ts"] }),
    );
    assert.equal(d.run, true);
  });

  it("skips when no ref touches mutable source", () => {
    assert.equal(
      mutationDecision([ref(A, B)], diffs({ [`${B}..${A}`]: ["README.md"] })).run,
      false,
    );
  });
});

describe("push-refs.mjs as the hook calls it", () => {
  let repo;
  const sha = {};

  // GIT_* from a hook beats `cwd` for the fixture's git AND for the git the CLI spawns;
  // PUSH_* is the pre-push contract and must not leak into a fixture either.
  function cleanEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith("GIT_") && !k.startsWith("PUSH_")) env[k] = v;
    }
    return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  }

  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() }).trim();

  function commit(name, file) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), `${name}\n`);
    git(["add", "-A"]);
    git(["commit", "-qm", name]);
    sha[name] = git(["rev-parse", "HEAD"]);
  }

  function decide(kind, stdin) {
    const r = spawnSync("node", [join(HERE, "push-refs.mjs"), kind], {
      cwd: repo,
      input: stdin,
      encoding: "utf8",
      env: cleanEnv(),
    });
    assert.equal(r.status, 0);
    return r.stdout.trim();
  }

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "push-refs-"));
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    commit("base", "README.md");
    commit("docs", "docs/x.txt");
    commit("app", "src/a.ts");
  });

  it("prints skip for a docs-only push", () => {
    assert.equal(decide("e2e", `refs/heads/a ${sha.docs} refs/heads/a ${sha.base}\n`), "skip");
  });

  it("prints run when the second ref touches src/", () => {
    const stdin =
      `refs/heads/a ${sha.docs} refs/heads/a ${sha.base}\n` +
      `refs/heads/b ${sha.app} refs/heads/b ${sha.docs}\n`;
    assert.equal(decide("e2e", stdin), "run");
  });

  it("prints run when a SHA is unknown to git", () => {
    assert.equal(decide("e2e", `refs/heads/a ${sha.docs} refs/heads/a ${"e".repeat(40)}\n`), "run");
  });

  it("prints run for an unknown leg name rather than skipping", () => {
    assert.equal(decide("nonsense", `refs/heads/a ${sha.docs} refs/heads/a ${sha.base}\n`), "run");
  });
});
