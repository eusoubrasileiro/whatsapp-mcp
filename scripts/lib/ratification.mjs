/**
 * ratification.mjs
 *
 * Deterministic "did a human ratify this critical-path work?" fact for the pre-push
 * integrity reviewer (`scripts/security-review.mjs`).
 *
 * Why this exists. A `Ratified-by: <owner>` trailer read out of the DIFF is prose, and
 * prose in a diff is written by whoever wrote the diff — a reviewer asked to believe it
 * can only refuse every ask-tier change, which leaves a repo unable to land ANY harness
 * change without a human pushing by hand. Reading the trailer from **git** instead makes
 * it a computed fact, which is what `standards.md` §5 specifies: "The reviewer computes
 * trailer presence **deterministically** from the push range (never inferred by the
 * model from commit prose)."
 *
 * A fact that decides the verdict on its own needs no model: `ratificationRejection`
 * turns `some-missing` into a reject before any LLM call is made.
 *
 * Prefix matching is boundary-aware, so `scripts/libel.mjs` does not match the
 * `scripts/lib/` tree.
 *
 * Fail-closed: when the pushed files include a critical path but git enumeration yields
 * no commits (exec failure, shallow clone), the summary is "some-missing" — never a
 * silent pass. The trailer is an audit marker of an explicit ratification event, not a
 * cryptographic proof; that is the same trust model as the rest of the harness. (The
 * write-time guard that keeps a demoted `Ratified-by:` line from reading as MISSING is
 * `.husky/commit-msg`.)
 *
 * All git access goes through an injected `exec(cmd) => stdout` (safeExec in
 * security-review.mjs) so the logic is unit-testable without a repo.
 */

import { CRITICAL_PATH_GROUPS, isCriticalPath } from "./critical-paths.mjs";
import { shQuote } from "./exec.mjs";

// whatsapp-mcp: the ratification paths ARE the critical paths. `critical-paths.mjs` is
// the single in-code contract that the reviewer prompt, the review log's file tags and
// the `.claude/settings.json` ask tier all mirror, so this module reads it instead of
// keeping a fourth copy that could drift.

/**
 * Pathspecs handed to `git log -- <paths>`, derived from the contract: a directory
 * prefix drops its trailing slash, a glob (`**\/*.md`) gets git's `:(glob)` magic so
 * it matches at any depth, and an exact file is passed as is. Each is shell-quoted,
 * because `exec` runs a command string.
 */
const RATIFICATION_PATHSPECS = CRITICAL_PATH_GROUPS.flatMap((g) => g.patterns)
  .map((p) => (p.includes("*") ? `:(glob)${p}` : p.endsWith("/") ? p.slice(0, -1) : p))
  .map(shQuote);

// TEMPLATE: the owner's name exactly as it appears in `Ratified-by: <owner>` trailers.
/** The only trailer value that counts as ratification. */
export const RATIFIER = "Andre";

/**
 * @param {string} file Repo-relative path.
 * @returns {boolean} True when the file sits on a ratification path.
 */
export function isRatificationPath(file) {
  // Boundary-aware by construction: critical-paths.mjs matches files exactly and
  // directories by their trailing-slash prefix, so "scripts/libel.mjs" never
  // matches the "scripts/lib/" tree.
  return isCriticalPath(file);
}

/**
 * Parse `git log -1 --format='%(trailers:key=Ratified-by,valueonly)'`.
 *
 * @param {string} raw Raw stdout (one trailer value per line, possibly empty).
 * @returns {string[]} Trimmed non-empty trailer values.
 */
export function parseRatifiedByTrailers(raw) {
  return (raw || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Enumerate critical-path commits in the range and whether each is ratified.
 *
 * @param {string} range Git range (from getPushRange()).
 * @param {(cmd: string) => string} exec safeExec-shaped runner ("" on failure).
 * @param {string[]} [pushedFiles] Files changed in the range — a fail-closed cross-check.
 * @returns {{commits: {sha: string, ratified: boolean}[], summary: "all-ratified" | "some-missing" | "none-touch-critical"}}
 */
export function computeRatificationFact(range, exec, pushedFiles = []) {
  const listOut = exec(`git log --format=%H ${range} -- ${RATIFICATION_PATHSPECS.join(" ")}`);
  const shas = listOut
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const commits = shas.map((sha) => {
    const trailersOut = exec(`git log -1 --format='%(trailers:key=Ratified-by,valueonly)' ${sha}`);
    const ratified = parseRatifiedByTrailers(trailersOut).some((v) => v === RATIFIER);
    return { sha, ratified };
  });

  // Fail-closed cross-check: the diff says a critical path changed but commit
  // enumeration came back empty (git failure, shallow clone) → treat as unratified.
  const touchesCritical = commits.length > 0 || pushedFiles.some(isRatificationPath);

  let summary;
  if (!touchesCritical) {
    summary = "none-touch-critical";
  } else if (commits.length > 0 && commits.every((c) => c.ratified)) {
    summary = "all-ratified";
  } else {
    summary = "some-missing";
  }

  return { commits, summary };
}

/** Concern tag on a reject that git decided before any model was asked. */
export const UNRATIFIED_CONCERN = "unratified-critical-edit";

/**
 * The verdict a `some-missing` fact forces on its own. It used to be a prompt
 * instruction: git computed the fact, then a model was asked to act on it.
 *
 * @param {{commits: {sha: string, ratified: boolean}[], summary: string}} fact
 * @returns {{justification: string, concerns: string[]} | null} A reject reason, or
 *   null when the fact leaves the verdict to the reviewer.
 */
export function ratificationRejection(fact) {
  if (fact.summary !== "some-missing") return null;
  const missing = fact.commits.filter((c) => !c.ratified).map((c) => c.sha);
  const which =
    missing.length > 0
      ? `Commit(s) ${missing.join(", ")} touch a critical path`
      : "The diff touches a critical path but git could not list its commits (fail-closed)";
  return {
    justification:
      `${which} without a \`Ratified-by: ${RATIFIER}\` trailer. Decided from git before ` +
      "any model call. Obtain the owner's approval, add the trailer, and amend the commit.",
    concerns: [UNRATIFIED_CONCERN],
  };
}

/**
 * Render the fact as a prompt-ready block.
 *
 * @param {{commits: {sha: string, ratified: boolean}[], summary: string}} fact
 * @returns {string}
 */
export function formatRatificationFact(fact) {
  const lines = [`Summary: ${fact.summary}`, "Critical-path commits in this push:"];
  if (fact.commits.length === 0) {
    lines.push("- (none)");
  } else {
    for (const c of fact.commits) {
      lines.push(`- ${c.sha} — Ratified-by: ${RATIFIER} ${c.ratified ? "present" : "MISSING"}`);
    }
  }
  return lines.join("\n");
}
