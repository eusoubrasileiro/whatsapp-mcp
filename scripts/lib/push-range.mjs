import { shQuote } from "./exec.mjs";

/**
 * push-range.mjs
 *
 * "What, exactly, is this push adding?" — as a git range and as a set of added
 * line numbers per file.
 *
 * Extracted from `scripts/security-review.mjs`, where `getPushRange` was a
 * private function, when `scripts/mutation-gate.mjs` needed the same answer.
 * Copying it would have let the two gates silently disagree about which commits
 * they are judging: the reviewer rejecting one diff while the mutation gate
 * enumerates sites in another. One definition, two callers.
 *
 * The merge-base anchoring is the load-bearing part and the reason this is not
 * a one-liner. The pre-push hook hands us `PUSH_REMOTE_SHA`, which after a
 * rebase + force-push points at the PRE-rebase commit — diffing against it
 * sweeps in every file that came along during the rebase as "new on this
 * branch". For the reviewer that means judging someone else's code; for the
 * mutation gate it means mutating files this push never touched, on a 15-mutant
 * budget. Both are wrong in the same way, so both use the merge-base.
 *
 * All git access goes through an injected `exec(cmd) => stdout` (the `safeExec`
 * shape: returns stdout, returns "" on failure, never throws) so the logic is
 * unit-testable without a repo.
 */

export const ZERO_SHA = "0000000000000000000000000000000000000000";

function refExists(ref, exec) {
  return Boolean(exec(`git rev-parse --verify --quiet ${ref}`).trim());
}

/**
 * The git range this push adds to main.
 *
 * @param {Record<string, string|undefined>} env  `process.env` (PUSH_LOCAL_SHA / PUSH_REMOTE_SHA)
 * @param {(cmd: string) => string} exec
 * @returns {string} `"<base>..<head>"`
 */
export function getPushRange(env, exec) {
  const localSha = env.PUSH_LOCAL_SHA;
  const head = localSha && localSha !== ZERO_SHA ? localSha : "HEAD";

  const mainRef = refExists("origin/main", exec) ? "origin/main" : "main";
  const mergeBase = exec(`git merge-base ${mainRef} ${head}`).trim();
  if (mergeBase) return `${mergeBase}..${head}`;

  // Fallbacks for when merge-base cannot be computed (shallow clone, detached
  // history). Only here is PUSH_REMOTE_SHA trusted, because there is nothing
  // better left.
  const remoteSha = env.PUSH_REMOTE_SHA;
  if (remoteSha && remoteSha !== ZERO_SHA && localSha) return `${remoteSha}..${localSha}`;
  const upstream = exec("git rev-parse --abbrev-ref --symbolic-full-name @{u}").trim();
  if (upstream && refExists(upstream, exec)) return `${upstream}..${head}`;
  return `${mainRef}..${head}`;
}

/**
 * What this run is reviewing, and the commit its verdict is stamped with.
 *
 * `commit` is the tip the range ends at: the pushed tip on pre-push, HEAD's full hash on
 * a manual run ("HEAD" literally when git cannot resolve it). It replaces the old
 * `"(staged)"` placeholder, which a post-commit hook backfilled with the hash of the
 * NEXT commit — mislabelling a pre-push verdict with a commit it never read.
 *
 * @param {Record<string, string|undefined>} env
 * @param {(cmd: string) => string} exec
 * @returns {{stage: "pre-push"|"manual", range: string, commit: string}}
 */
export function resolveReviewScope(env, exec) {
  const range = getPushRange(env, exec);
  const localSha = env.PUSH_LOCAL_SHA;
  if (localSha && localSha !== ZERO_SHA) return { stage: "pre-push", range, commit: localSha };
  const head = exec("git rev-parse --verify --quiet HEAD").trim();
  return { stage: "manual", range, commit: head || "HEAD" };
}

/**
 * The form of a range to hand `git diff`: from the merge base (`a...b`), never `a..b`.
 *
 * `git log a..b` means "commits in b, not in a", which is what a commit list wants. But
 * `git diff a..b` compares the two TREES, so when the trunk moved after the branch was
 * cut, the trunk's newer work reads as the branch deleting it — a reviewer once rejected
 * a branch for "reverting" a feature merged to main overnight. `getPushRange` anchors on
 * the merge base already, but its fallbacks (remote SHA, upstream, bare main) do not.
 *
 * @param {string} range A `getPushRange` range (`a..b`).
 * @returns {string}
 */
export function diffRange(range) {
  return range.includes("...") ? range : range.replace("..", "...");
}

/** @typedef {{ file: string, start: number, end: number }} AddedRange 1-based, inclusive. */

// `@@ -a[,b] +c[,d] @@` — a header must start at column 0. An omitted count
// means 1; a new-side count of 0 means the hunk only DELETES lines.
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const NEW_PATH = /^\+\+\+ (?:b\/)?(.*)$/;

/**
 * Added/changed line ranges on the NEW side of a unified diff.
 *
 * Intended for `git diff -U0` output: with zero context every reported line is
 * genuinely part of the change, so a site enumerated inside one of these ranges
 * is a site this push is responsible for.
 *
 * @param {string} unifiedDiff
 * @returns {AddedRange[]}
 */
export function parseAddedLineRanges(unifiedDiff) {
  const ranges = [];
  let file = null;

  for (const raw of unifiedDiff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    const path = NEW_PATH.exec(line);
    if (path) {
      // `/dev/null` on the new side is a deletion: there is no new file to
      // enumerate sites in. A rename's `+++` already names the NEW path, which
      // is the one that exists after the push — so renames need no special case.
      file = path[1] === "/dev/null" ? null : path[1];
      continue;
    }

    const hunk = HUNK.exec(line);
    if (!hunk || !file) continue;

    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // A pure-deletion hunk has no new-side lines. Emitting a range here would
    // attribute a line the push never added — and every site in it — to this
    // push.
    if (count === 0) continue;

    ranges.push({ file, start, end: start + count - 1 });
  }

  return ranges;
}

/**
 * `file → (line: number) => boolean`, the diff-scoping predicate.
 *
 * Files with no added lines (deletions only) get no entry, so a caller
 * iterating the map never opens a file it has nothing to mutate in.
 *
 * @param {string} range
 * @param {string[]} files  restrict the diff to these paths
 * @param {(cmd: string) => string} exec
 * @returns {Map<string, (line: number) => boolean>}
 */
export function changedLinesByFile(range, files, exec) {
  if (files.length === 0) return new Map();
  const paths = files.map(shQuote).join(" ");
  const diff = exec(`git diff -U0 --no-color ${diffRange(range)} -- ${paths}`);

  /** @type {Map<string, AddedRange[]>} */
  const byFile = new Map();
  for (const r of parseAddedLineRanges(diff)) {
    const list = byFile.get(r.file);
    if (list) list.push(r);
    else byFile.set(r.file, [r]);
  }

  return new Map(
    [...byFile].map(([file, list]) => [
      file,
      (line) => list.some((r) => line >= r.start && line <= r.end),
    ]),
  );
}
