/**
 * The shared command runner behind every quality-gate collector.
 *
 * Lives here rather than in `quality-gate.mjs` because that script has no main
 * guard and ends in `process.exit()`, so it cannot be imported by a test — and
 * this function's failure mode is exactly the kind that needs one.
 */

import { execSync } from "node:child_process";

// Node's execSync default is 1MB. `collectTestAssertions`'s grep over the whole
// test tree already produces >1MB of matched lines on this repo's current size,
// so the default silently truncated `err.stdout` on overflow — the collector
// never threw, it just quietly under-counted, which read as a false "test
// assertions decreased" regression on any push that grew the test suite. 20MB
// gives real headroom as the suite keeps growing without masking a genuine
// future blow-up.
export const MAX_BUFFER = 20 * 1024 * 1024;

export function run(cmd, { cwd = process.cwd(), silent = true, maxBuffer = MAX_BUFFER } = {}) {
  try {
    return execSync(cmd, {
      cwd,
      stdio: silent ? ["pipe", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
      maxBuffer,
    });
  } catch (err) {
    // A non-zero exit is tolerated on purpose: the collectors' greps are written
    // `... || true` and exit 1 when they match nothing, which is a legitimate
    // measurement of zero. TRUNCATION is not that. On overflow Node throws
    // ENOBUFS carrying a partial `err.stdout`, and returning it hands the caller
    // a number for a measurement that never finished — the ratchet then reports
    // a confident regression that did not happen. Raising maxBuffer moves this
    // ceiling; only the rethrow makes reaching it honest.
    if (err.code === "ENOBUFS") {
      throw new Error(
        `output exceeded maxBuffer (${maxBuffer} bytes), measurement incomplete: ${cmd}`,
      );
    }
    return err.stdout || "";
  }
}

/**
 * POSIX single-quote a value for interpolation into a `sh -c` command string.
 *
 * The naive `'${value}'` is wrong for any value containing a single quote, and
 * the security angle is the least of it: git happily tracks a file called
 * `it's.ts`, and the naive form turns the `git diff` that finds its changed
 * lines into a syntax error. `run()` swallows a non-zero exit and returns "",
 * so the diff comes back EMPTY, the file contributes no allowed lines, the
 * mutation gate enumerates zero sites and reports a cheerful pass. A gate that
 * goes silent on the one file it should be mutating is the worst outcome in
 * this codebase, and it needs no attacker — just an apostrophe.
 *
 * Closing the quote, escaping a literal `'`, and reopening is the whole trick;
 * inside single quotes `sh` treats every other byte literally.
 */
export function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * The environment with every GIT_* variable removed.
 *
 * Git exports GIT_DIR and GIT_INDEX_FILE into every hook subprocess, and they
 * OVERRIDE `cwd` — so a `git` call that reads as "operate on this directory"
 * silently operates on whatever repository the hook is running in. The mutation
 * gate runs FROM hooks and takes its repo root as a parameter, which makes this
 * load-bearing in two places:
 *
 *   - pre-push exports GIT_DIR. The gate's own self-referential tests drive it
 *     against a throwaway fixture repo, and under the hook they diffed the real
 *     repo instead, found no changed lines, and reported "no mutable sites —
 *     skipped". The gate's proof of itself quietly stopped proving anything.
 *   - pre-commit exports GIT_INDEX_FILE pointing at a TEMPORARY index. The
 *     `--sweep` tripwire inspects the tree through git; reading a temp index
 *     there means deciding whether a mutant is stranded from the wrong state.
 *
 * Stripping GIT_* is what makes `cwd` mean what it reads like.
 */
export function gitCleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}
