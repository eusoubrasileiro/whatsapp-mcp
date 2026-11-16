import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changedLinesByFile,
  diffRange,
  getPushRange,
  parseAddedLineRanges,
  resolveReviewScope,
  ZERO_SHA,
} from "./push-range.mjs";

/** Build a fake `exec(cmd) => stdout` from a prefix → output map. */
function fakeExec(map) {
  const seen = [];
  const exec = (cmd) => {
    seen.push(cmd);
    for (const [prefix, out] of Object.entries(map)) {
      if (cmd.startsWith(prefix)) return out;
    }
    return "";
  };
  exec.seen = seen;
  return exec;
}

const MERGE_BASE = "aaaa111";

// ── getPushRange ────────────────────────────────────────────────────────────

test("anchors on the merge-base with origin/main", () => {
  const exec = fakeExec({
    "git rev-parse --verify --quiet origin/main": "origin/main\n",
    "git merge-base": `${MERGE_BASE}\n`,
  });
  assert.equal(getPushRange({ PUSH_LOCAL_SHA: "bbbb222" }, exec), `${MERGE_BASE}..bbbb222`);
});

test("falls back to local `main` when origin/main does not exist", () => {
  const exec = fakeExec({ "git merge-base main": `${MERGE_BASE}\n` });
  assert.equal(getPushRange({ PUSH_LOCAL_SHA: "bbbb222" }, exec), `${MERGE_BASE}..bbbb222`);
});

test("uses HEAD when PUSH_LOCAL_SHA is absent or the zero sha", () => {
  const exec = fakeExec({
    "git rev-parse --verify --quiet origin/main": "origin/main\n",
    "git merge-base": `${MERGE_BASE}\n`,
  });
  assert.equal(getPushRange({}, exec), `${MERGE_BASE}..HEAD`);
  assert.equal(getPushRange({ PUSH_LOCAL_SHA: ZERO_SHA }, exec), `${MERGE_BASE}..HEAD`);
});

test("REGRESSION: after a rebase + force-push the merge-base wins over PUSH_REMOTE_SHA", () => {
  // PUSH_REMOTE_SHA points at the PRE-rebase commit. Trusting it sweeps in
  // everything that came along during the rebase as "new on this branch",
  // which would enumerate mutation sites in files this push never touched.
  const exec = fakeExec({
    "git rev-parse --verify --quiet origin/main": "origin/main\n",
    "git merge-base": `${MERGE_BASE}\n`,
  });
  const range = getPushRange({ PUSH_LOCAL_SHA: "bbbb222", PUSH_REMOTE_SHA: "stale99" }, exec);
  assert.equal(range, `${MERGE_BASE}..bbbb222`);
});

test("falls back to PUSH_REMOTE_SHA only when merge-base cannot be computed", () => {
  const exec = fakeExec({ "git rev-parse --verify --quiet origin/main": "origin/main\n" });
  const range = getPushRange({ PUSH_LOCAL_SHA: "bbbb222", PUSH_REMOTE_SHA: "cccc333" }, exec);
  assert.equal(range, "cccc333..bbbb222");
});

test("falls back to upstream, then to main, when nothing else resolves", () => {
  const upstream = fakeExec({
    "git rev-parse --verify --quiet origin/main": "origin/main\n",
    "git rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/agent/x\n",
    "git rev-parse --verify --quiet origin/agent/x": "origin/agent/x\n",
  });
  assert.equal(getPushRange({}, upstream), "origin/agent/x..HEAD");

  const bare = fakeExec({ "git rev-parse --verify --quiet origin/main": "origin/main\n" });
  assert.equal(getPushRange({}, bare), "origin/main..HEAD");
});

// ── parseAddedLineRanges ────────────────────────────────────────────────────

test("parses a hunk with both counts omitted as a single line", () => {
  const ranges = parseAddedLineRanges(["+++ b/a.ts", "@@ -43 +55 @@", "+x"].join("\n"));
  assert.deepEqual(ranges, [{ file: "a.ts", start: 55, end: 55 }]);
});

test("parses an explicit new-side count", () => {
  const ranges = parseAddedLineRanges(["+++ b/a.ts", "@@ -34,2 +34,14 @@"].join("\n"));
  assert.deepEqual(ranges, [{ file: "a.ts", start: 34, end: 47 }]);
});

test("REGRESSION: a pure deletion hunk (+n,0) contributes NO range", () => {
  // The naive parser emits a phantom range at the new-side start and every
  // site after it is attributed to a line the push never added.
  const ranges = parseAddedLineRanges(["+++ b/a.ts", "@@ -174 +186,0 @@", "-gone"].join("\n"));
  assert.deepEqual(ranges, []);
});

test("treats a new file as one range covering the whole file", () => {
  const ranges = parseAddedLineRanges(
    ["new file mode 100644", "+++ b/new.ts", "@@ -0,0 +1,87 @@"].join("\n"),
  );
  assert.deepEqual(ranges, [{ file: "new.ts", start: 1, end: 87 }]);
});

test("ignores a deleted file (+++ /dev/null) without crashing", () => {
  const ranges = parseAddedLineRanges(
    ["--- a/gone.ts", "+++ /dev/null", "@@ -1,5 +0,0 @@"].join("\n"),
  );
  assert.deepEqual(ranges, []);
});

test("attributes a rename's changes to the NEW path", () => {
  const ranges = parseAddedLineRanges(
    [
      "diff --git a/old.ts b/new.ts",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -3,1 +3,2 @@",
    ].join("\n"),
  );
  assert.deepEqual(ranges, [{ file: "new.ts", start: 3, end: 4 }]);
});

test("handles multiple files with multiple hunks each", () => {
  const ranges = parseAddedLineRanges(
    ["+++ b/a.ts", "@@ -1,1 +1,2 @@", "+++ b/b.ts", "@@ -10,0 +10,1 @@", "@@ -50,2 +51,3 @@"].join(
      "\n",
    ),
  );
  assert.deepEqual(ranges, [
    { file: "a.ts", start: 1, end: 2 },
    { file: "b.ts", start: 10, end: 10 },
    { file: "b.ts", start: 51, end: 53 },
  ]);
});

test("does NOT mistake a literal `@@ ` inside added source text for a hunk header", () => {
  // `-U0` output only contains `+`/`-` body lines, and an added line is `+...`.
  // A header must start at column 0 with `@@ -`.
  const ranges = parseAddedLineRanges(
    ["+++ b/a.ts", "@@ -1 +1 @@", '+const doc = "@@ -9,9 +9,9 @@";'].join("\n"),
  );
  assert.deepEqual(ranges, [{ file: "a.ts", start: 1, end: 1 }]);
});

test("tolerates CRLF line endings", () => {
  const ranges = parseAddedLineRanges("+++ b/a.ts\r\n@@ -1 +7,2 @@\r\n");
  assert.deepEqual(ranges, [{ file: "a.ts", start: 7, end: 8 }]);
});

// ── changedLinesByFile ──────────────────────────────────────────────────────

test("groups ranges into a per-file line predicate", () => {
  const exec = fakeExec({
    "git diff -U0": ["+++ b/a.ts", "@@ -1 +1,2 @@", "+++ b/b.ts", "@@ -9 +9 @@"].join("\n"),
  });
  const byFile = changedLinesByFile("x..y", ["a.ts", "b.ts"], exec);

  assert.deepEqual([...byFile.keys()].sort(), ["a.ts", "b.ts"]);
  assert.equal(byFile.get("a.ts")(1), true);
  assert.equal(byFile.get("a.ts")(2), true);
  assert.equal(byFile.get("a.ts")(3), false);
  assert.equal(byFile.get("b.ts")(9), true);
  assert.equal(byFile.get("b.ts")(8), false);
});

test("a file with only deletions gets no entry at all", () => {
  const exec = fakeExec({ "git diff -U0": ["+++ b/a.ts", "@@ -5,3 +4,0 @@"].join("\n") });
  assert.equal(changedLinesByFile("x..y", ["a.ts"], exec).size, 0);
});

// ── resolveReviewScope: the commit each verdict is stamped with ─────────────
// Entries used to say "(staged)" and a post-commit hook backfilled the hash of the NEXT
// commit into them, so a pre-push verdict was labelled with a commit it never read.

test("resolveReviewScope stamps a pre-push verdict with the pushed tip", () => {
  const exec = fakeExec({
    "git rev-parse --verify --quiet origin/main": "origin/main\n",
    "git merge-base": `${MERGE_BASE}\n`,
    "git rev-parse --verify --quiet HEAD": "headsha\n",
  });
  const scope = resolveReviewScope({ PUSH_LOCAL_SHA: "bbbb222" }, exec);
  assert.deepEqual(scope, {
    stage: "pre-push",
    range: `${MERGE_BASE}..bbbb222`,
    commit: "bbbb222",
  });
});

test("resolveReviewScope stamps a manual run with HEAD's full hash", () => {
  const exec = fakeExec({
    "git rev-parse --verify --quiet origin/main": "origin/main\n",
    "git merge-base": `${MERGE_BASE}\n`,
    "git rev-parse --verify --quiet HEAD": "f".repeat(40) + "\n",
  });
  const scope = resolveReviewScope({}, exec);
  assert.equal(scope.stage, "manual");
  assert.equal(scope.commit, "f".repeat(40));
});

test("resolveReviewScope falls back to the literal HEAD when HEAD cannot be resolved", () => {
  assert.equal(resolveReviewScope({}, fakeExec({})).commit, "HEAD");
});

// ── diffRange: what the reviewer diffs ──────────────────────────────────────
// `git diff a..b` compares two TREES, so when the trunk moved after the branch was cut
// its newer work reads as the branch deleting it. `git log a..b` is what we want for
// commit lists; `git diff` wants the merge base (`a...b`).

test("diffRange diffs from the merge base (three dots)", () => {
  assert.equal(diffRange("origin/main..bbbb222"), "origin/main...bbbb222");
  assert.equal(diffRange(`${MERGE_BASE}..bbbb222`), `${MERGE_BASE}...bbbb222`);
});

test("diffRange leaves a range that is already three-dot alone", () => {
  assert.equal(diffRange("origin/main...HEAD"), "origin/main...HEAD");
});
