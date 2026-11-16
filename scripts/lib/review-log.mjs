/**
 * review-log.mjs
 *
 * Shared accessor for `.quality-gate/review-log.jsonl` — the append-only log
 * of Sonnet-reviewer verdicts. Owns the path, the JSONL format, and the
 * read/write primitives used by `security-review.mjs` (writer) and the readers
 * (`pr-comment-review.mjs`, `print-quality-delta.mjs`, `show-review-log.mjs`).
 *
 * Schema is permissive on purpose — the log is a forensic trail, not a
 * contract. Old entries must keep parsing forever.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

/**
 * @typedef {Object} ReviewLogEntry
 * @property {string} ts                ISO timestamp.
 * @property {string} commit            Full hash of the commit reviewed (the pushed tip, or HEAD for a manual run). Older entries may say "(staged)".
 * @property {string} verdict           "approve" | "reject" | "escalate" | "awaiting-approval" | "no-review" (other values tolerated).
 *   Only "approve" is green — test it with `isApproval`, never with `!== "reject"`.
 *   "awaiting-approval" blocks the push without being a coding rejection, so it
 *   consumes no fix round (see countFixRounds).
 *   "no-review" means there was nothing to review (no commits in the range, or
 *   commits with no net diff). It does not block, and it is deliberately not
 *   "approve": nothing read the change, so nothing may later read it back as a pass.
 * @property {string[]} [sensitiveFiles] Subset of stagedFiles flagged as sensitive paths.
 * @property {string[]} [stagedFiles]   Files staged at review time.
 * @property {string} [justification]   Reviewer's 1-3 sentence explanation.
 * @property {string[]} [concerns]      Individual concerns; empty/absent on approve.
 * @property {Object[]} [findings]      Structured issues: {severity: "blocker"|"important"|"minor", file, issue, fix}. Empty/absent on approve.
 * @property {string} [rawOutput]       Truncated raw reviewer output when verdict was unparseable.
 * @property {string} [branch]          Git branch at review time. Absent on entries written before the fix-round bound existed; those are ignored by the round counter rather than guessed at.
 * @property {string} [why]             Haiku-resolved "why this PR exists" paragraph (Portuguese, 2-3 sentences) or the sentinel "Origem não clara — favor revisar manualmente". Read back by `pr-comment-review.mjs` to render the "## O que este PR resolve" lead section.
 */

export const REVIEW_LOG_PATH = join(repoRoot, ".quality-gate", "review-log.jsonl");

/**
 * True only for a genuine reviewer approval.
 *
 * Readers used to treat "not a reject" as green, which meant any new or unexpected
 * verdict — `no-review` among them — rendered as an approval. Whitelist the one value
 * that means the reviewer read the change and liked it; everything else is not green.
 *
 * The same shape covers every verdict this harness can produce or grow into:
 * `escalate`, `awaiting-approval`, a truncated or malformed response, and
 * whatever a model upgrade starts emitting. A blacklist is only as closed as
 * the list is complete, and the list can never be complete.
 *
 * @param {string | undefined} verdict
 * @returns {boolean}
 */
export function isApproval(verdict) {
  return verdict === "approve";
}

/**
 * Load every parseable entry, in file order (oldest first).
 * Unparseable lines are skipped with a warning to stderr.
 *
 * @returns {ReviewLogEntry[]}
 */
export function loadAllEntries() {
  if (!existsSync(REVIEW_LOG_PATH)) return [];
  const raw = readFileSync(REVIEW_LOG_PATH, "utf8");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      console.warn(
        `[review-log] skipping unparseable line: ${line.slice(0, 120)}${line.length > 120 ? "…" : ""}`,
      );
    }
  }
  return entries;
}

/**
 * Most recent parseable entry, or null when the log is missing/empty.
 *
 * @returns {ReviewLogEntry | null}
 */
export function loadLatestEntry() {
  const entries = loadAllEntries();
  if (entries.length === 0) return null;
  return entries[entries.length - 1];
}

/**
 * Append a single entry as one JSON line. Creates the parent directory if
 * needed.
 *
 * @param {ReviewLogEntry} entry
 */
export function appendEntry(entry) {
  const dir = dirname(REVIEW_LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(REVIEW_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Max reviewer rejects on one branch before the loop must stop and escalate to
 * the owner. Ratified in `standards.md` and stated to workers in
 * `scripts/agent-prompt.md`; enforced here so it is a fact rather than an
 * instruction the reviewed agent may ignore.
 *
 * Why in code: the human gate sits at the coordinator, but the fix loop runs
 * inside dispatched workers — in parallel worktrees nobody opens. A bound that
 * only exists as prose in the worker's own prompt is advisory, and an agent
 * that ignores it is invisible.
 */
export const MAX_FIX_ROUNDS = 3;

/**
 * Reject/escalate rounds already recorded for `branch`.
 *
 * Counts only the two verdicts that mean "the reviewer judged this code and
 * found it wanting". A verdict that blocks for any other reason —
 * "awaiting-approval" for a missing ratification or an unreadable reviewer
 * answer — is deliberately NOT a round: a malformed response is no evidence the
 * code is bad, and burning a round on one would escalate a branch that was
 * never actually rejected.
 *
 * Entries without a `branch` are from before this field existed and are NOT
 * counted — an old log must never retro-escalate a fresh branch. Each worktree
 * carries its own `.quality-gate/`, so a dispatched worker counts only its own
 * attempts even before the branch filter applies.
 *
 * NOT tamper-proof: `.quality-gate/` is gitignored ephemera an agent could
 * delete. This bounds drift and honest looping, not deliberate evasion — the
 * same trust model as the rest of the harness.
 *
 * @param {string} branch
 * @param {ReviewLogEntry[]} [entries] Pre-loaded entries; loaded when omitted.
 * @returns {number}
 */
export function countFixRounds(branch, entries = loadAllEntries()) {
  if (!branch) return 0;
  return entries.filter(
    (e) => e.branch === branch && (e.verdict === "reject" || e.verdict === "escalate"),
  ).length;
}

/**
 * True once `branch` has already exhausted the bound — the loop is over and
 * the owner has to look. Checked before spending a reviewer call.
 *
 * @param {string} branch
 * @param {ReviewLogEntry[]} [entries]
 * @returns {boolean}
 */
export function hasEscalated(branch, entries = loadAllEntries()) {
  if (!branch) return false;
  return entries.some((e) => e.branch === branch && e.verdict === "escalate");
}
