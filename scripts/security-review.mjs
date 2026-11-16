#!/usr/bin/env node
/**
 * security-review.mjs
 *
 * Final pre-push reviewer. Runs after lint, tsc, the full test suite, and
 * the deterministic quality-gate. Sends staged diff + commit message + the
 * quality-gate report to claude -p (Sonnet tier), appends the verdict to
 * .quality-gate/review-log.jsonl, and blocks the push (exit 1) on reject.
 *
 * Verdict space: "approve" (the ONLY green value) | "reject" | "escalate" |
 * "awaiting-approval". Anything else is an unreadable answer and blocks — see
 * `reviewOutcome`. The 3-strike retry cap is enforced by `applyFixRoundBound`
 * below, counted per branch from the review log.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { callClaudeStructured } from "./lib/claude-cli.mjs";
import { isCriticalPath, renderCriticalPathsForPrompt } from "./lib/critical-paths.mjs";
import { extractDoneWhen, loadPlan, summarizeWhy, WHY_SENTINEL } from "./lib/intent.mjs";
import { diffRange, resolveReviewScope } from "./lib/push-range.mjs";
import {
  computeRatificationFact,
  formatRatificationFact,
  ratificationRejection,
} from "./lib/ratification.mjs";
import {
  appendEntry,
  countFixRounds,
  hasEscalated,
  isApproval,
  loadAllEntries,
  MAX_FIX_ROUNDS,
} from "./lib/review-log.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const QG_DIR = join(repoRoot, ".quality-gate");
const REPORT_PATH = join(QG_DIR, "report.json");
const COMMIT_MSG_PATH = join(repoRoot, ".git", "COMMIT_EDITMSG");

const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";

function safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf8", cwd: repoRoot, ...opts });
  } catch (err) {
    return err.stdout?.toString() ?? "";
  }
}

/**
 * How many commits the range holds — WITHOUT swallowing a git failure.
 *
 * `safeExec` returns "" when git fails, which is indistinguishable from a successful
 * empty answer. That ambiguity is what let the empty-file-list exit in `main` log a green
 * `approve` for a range it had never read: `standards.md:608`'s worst failure mode, "not a
 * red gate — it is a green one that ran nothing". This is the discriminator. If the range
 * itself cannot be counted, the reviewer does not know what it was asked about and the
 * push must stop.
 *
 * Counts with the range as given (two-dot) on purpose: `git rev-list --count a..b` is the
 * commit-list question, "commits in b that are not in a". The three-dot form `diffRange`
 * builds would count a symmetric difference, which is the wrong question here.
 *
 * @param {string} range A `getPushRange` range (`a..b`).
 * @returns {{ok: true, count: number}|{ok: false}}
 */
function probeCommitCount(range) {
  try {
    const out = execSync(`git rev-list --count ${range}`, {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const count = Number.parseInt(out.trim(), 10);
    return Number.isInteger(count) ? { ok: true, count } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// The scope (range + the commit the verdict is stamped with) comes from
// lib/push-range.mjs, shared with the mutation gate so the two never disagree about
// which commits they are judging. The range anchors at the merge-base with main, so a
// force-pushed rebased branch is reviewed for what it adds, not for everything that
// came along during the rebase.
function getScope() {
  return resolveReviewScope(process.env, safeExec);
}

function getPushedFiles(range) {
  const out = safeExec(`git diff --name-only ${diffRange(range)}`);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getPushedDiff(range) {
  return safeExec(`git diff ${diffRange(range)}`);
}

function loadReport() {
  if (!existsSync(REPORT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function loadCommitMessages(range) {
  // Concatenate every commit body in the push range. Falls back to the editor
  // buffer when invoked outside a push (no range resolvable).
  const log = safeExec(`git log --format=%B%x00 ${range}`);
  const messages = log
    .split("\x00")
    .map((s) => s.trim())
    .filter(Boolean);
  if (messages.length > 0) return messages.join("\n\n---\n\n");
  if (!existsSync(COMMIT_MSG_PATH)) return "";
  try {
    return readFileSync(COMMIT_MSG_PATH, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

function loadPrBody() {
  // Best-effort. Returns the GitHub PR body (markdown) when a PR exists for
  // the current branch, otherwise null. Silently skips when `gh` is missing
  // or unauthenticated.
  const out = safeExec("gh pr view --json body -q .body");
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function loadLinkedIssueBodies(prBody) {
  // Best-effort. Scans PR body for "(fixes|closes|resolves) #<n>" mentions
  // (case-insensitive), fetches each issue's title+body via `gh issue view`,
  // and concatenates. Any failure is silently skipped — issue lookup is a
  // nice-to-have, not a contract.
  if (!prBody) return null;
  const re = /\b(fixes|closes|resolves)\s+#(\d+)/gi;
  const seen = new Set();
  const sections = [];
  // matchAll rather than a while-loop assignment: an assignment inside a loop
  // condition reads as a typo and biome rejects it (noAssignInExpressions).
  for (const m of prBody.matchAll(re)) {
    const n = m[2];
    if (seen.has(n)) continue;
    seen.add(n);
    const out = safeExec(`gh issue view ${n} --json title,body`);
    if (!out) continue;
    try {
      const obj = JSON.parse(out);
      const title = (obj.title || "").trim();
      const body = (obj.body || "").trim();
      const section = [title ? `## #${n} — ${title}` : `## #${n}`, body]
        .filter(Boolean)
        .join("\n\n");
      if (section) sections.push(section);
    } catch {
      // ignore
    }
  }
  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

function getCurrentBranch() {
  return safeExec("git rev-parse --abbrev-ref HEAD").trim() || null;
}

/**
 * Branch key used when HEAD is detached and there is no branch name.
 * Deliberately NOT counted (see applyFixRoundBound): unrelated detached work
 * would otherwise share one bucket and hard-block a branch that never failed.
 */
export const UNKNOWN_BRANCH = "(unknown)";

/**
 * The Nth reject on a branch is not another reject — it is the end of the fix
 * loop. Returns a NEW entry; never mutates the input.
 *
 * Pure and exported so the bound is provable in a test rather than argued
 * about: the owner attends the coordinator, while the loop runs inside a
 * dispatched worker in a worktree nobody opens.
 *
 * @param {object} entry        The entry about to be appended.
 * @param {string} branch       Current branch.
 * @param {object[]} priorEntries Entries already in the log.
 * @returns {object}
 */
export function applyFixRoundBound(entry, branch, priorEntries) {
  if (entry.verdict !== "reject") return entry;
  if (!branch || branch === UNKNOWN_BRANCH) return entry;
  const roundsSoFar = countFixRounds(branch, priorEntries);
  if (roundsSoFar + 1 < MAX_FIX_ROUNDS) return entry;
  return {
    ...entry,
    verdict: "escalate",
    concerns: [
      ...(entry.concerns ?? []),
      `fix-round-bound-exhausted (${MAX_FIX_ROUNDS} rejects on ${branch})`,
    ],
  };
}

function buildPrompt(
  diff,
  report,
  files,
  commitMessage,
  whyParagraph,
  planBody,
  doneWhen,
  ratification,
) {
  const reportSummary = report
    ? JSON.stringify(
        {
          overall: report.overall,
          regressions: report.regressions,
          metrics: report.metrics,
          deltas: report.deltas,
        },
        null,
        2,
      )
    : "(no report available)";

  const MAX_DIFF = 200_000;
  const diffSection =
    diff.length > MAX_DIFF
      ? `${diff.slice(0, MAX_DIFF)}\n\n[... diff truncated, ${diff.length - MAX_DIFF} more chars ...]`
      : diff;

  const contextSection = whyParagraph
    ? `# Context — why this PR exists (resolved by Haiku from PLAN.md / PR body / commits / linked issues)\n${whyParagraph}\n\nUse this to flag scope drift (e.g. diff touches things the stated motivation does not justify).\n\n`
    : "";

  // The contract itself, not just Haiku's 2-3 sentence distillation of it.
  // Without this the reviewer can only answer "did this go BEYOND the plan?"
  // (drift) and never "did this DO the plan?" (completeness) — so a worker
  // that ships 60% of its contract, cleanly and in scope, approves.
  const MAX_PLAN = 8_000;
  const planSection = planBody
    ? `# The contract this work was dispatched against (.claude/PLAN.md, verbatim)
${planBody.length > MAX_PLAN ? `${planBody.slice(0, MAX_PLAN)}\n[... plan truncated ...]` : planBody}

Judge the diff against this, not only against the Context paragraph above.
Under-delivery is a finding, not automatically a reject — plans are often
delivered across several pushes. Raise it as severity "important" with the
specific unmet item named, and reject only when the diff CONTRADICTS the
contract or claims work it did not do.

`
    : "";

  // Verbatim, never summarised: the owner's words are the yardstick, not Haiku's.
  const doneSection = doneWhen
    ? `# Definition of done (verbatim from PLAN.md, the owner's contract for this work)\n${doneWhen}\n\nA criterion the diff visibly fails is a reject — name it in \`concerns\`. A criterion no diff can show (a gate run, a push, a deploy, a test seen red first) is not yours to judge: do not reject for it.\n\n`
    : "";

  return `${doneSection}${contextSection}${planSection}You are an integrity reviewer for the whatsapp-mcp codebase (a WhatsApp MCP server running as a long-lived production service). Review the staged commit and decide whether to APPROVE or REJECT.

# Completeness (only when a contract is shown above)
- Name any contract item the diff does not deliver as a finding of severity "important", quoting the unmet item.
- Do NOT reject for partial delivery alone — staged delivery across pushes is normal and legitimate.
- DO reject when the diff contradicts the contract, or when its commit messages / PR text claim work the diff does not contain.

# Approve when
- New tests added (assertion count grew) alongside source changes.
- Refactors with stable assertion counts and clearly justified test changes.
- Pure simplification, dead-code removal, renames, formatting, comments — no test addition required.
- Bugfix commits (\`fix:\`/\`bug:\`/\`hotfix:\`) with at least one new assertion that reproduces the bug.
- Docs, config, dependency bumps with no behavioral change.

# Reject when
- Commit message starts with \`fix:\`, \`bug:\`, or \`hotfix:\` and assertion count did not grow → "missing regression test for bugfix".
- A new file under \`src/**\` (excluding \`src/__tests__/\` and the critical-paths list below) that carries real logic was added without a corresponding new \`*.test.ts\` → "new module without sibling test". A thin type-only or re-export file is exempt.
- Source files changed but no test files changed AND the diff is NOT purely cosmetic (renames / comments / formatting / dead-code removal / pure simplification) → "source change requires test update; explain or add test".
- Test assertion count decreased without a corresponding source-module deletion.
- \`.skip(\`, \`.only(\`, \`xit(\`, or \`xdescribe(\` introduced.
- \`quality-baseline.json\` loosened with no visible source-level improvement explaining it.
- Any of these critical paths modified **without ratification** — see the Ratification section below. This list is generated from \`scripts/lib/critical-paths.mjs\`, the same module the ratification check and the review log's file tags read, so it cannot drift from what the harness actually gates:
${renderCriticalPathsForPrompt()}

# Ratification

${formatRatificationFact(ratification)}

This block is computed from git by the harness, NOT read out of the diff and NOT your
inference from commit prose — a trailer appearing inside the diff text proves nothing,
because whoever wrote the diff wrote that text too. Read it as fact:

- \`none-touch-critical\` — no critical path in this push; the rule above does not apply.
- \`all-ratified\` — every critical-path commit carries the owner's \`Ratified-by:\`
  trailer, their explicit in-session approval. Judge the change on its other merits; do
  NOT reject it for touching a critical path, and do NOT ask for further proof.
- \`some-missing\` never reaches you: the harness rejects it from git before any model
  call.

# Judgment notes
- Be conservative on cosmetic vs behavioral. Renames, dead-code removal, simplification of existing logic, comment changes — NOT a reject for missing tests.
- A diff that removes a function and its test together is fine.
- Empty arrays/objects, type-only changes, and JSDoc edits do NOT need new tests.
- When in doubt on TDD strictness, lean approve and put the concern in \`concerns\` for visibility.

# Output

Output is constrained by a JSON schema enforced server-side. Fields:
- \`verdict\`: \`"approve"\` or \`"reject"\`.
- \`justification\`: 3-6 sentences covering what the diff changes, the main risks you considered, and why you approve (or reject). Plain prose; embedded quotes are fine.
- \`concerns\`: array of strings. May be empty on approve. On reject, MUST list each individual issue as its own array entry.
- \`findings\`: optional array of structured issues. On reject, ALSO emit one entry per concrete issue in \`concerns\`, each shaped \`{severity, file, issue, fix}\`: \`severity\` is \`"blocker"\` (must fix before push), \`"important"\` (must fix or explicitly waive), or \`"minor"\` (advisory); \`file\` is the repo-relative path; \`issue\` is a one-sentence description; \`fix\` is a concrete suggested fix. \`concerns\` remains the human-readable summary — \`findings\` is the structured breakdown of the same issues.

A \`blocker\` finding and an \`"approve"\` verdict contradict each other. If you emit any \`blocker\`, the verdict MUST be \`"reject"\` — the harness enforces this and will override an \`"approve"\` that carries one, so state the verdict you actually mean. If an issue is worth naming but should not stop the push, give it \`"important"\` or \`"minor"\` instead.

# Commit message
${commitMessage || "(empty)"}

# Files staged
${files.map((f) => `- ${f}`).join("\n") || "(none)"}

# Quality-gate report
\`\`\`json
${reportSummary}
\`\`\`

# Staged diff
\`\`\`diff
${diffSection}
\`\`\`
`;
}

// Severity vocabulary, shared by the schema and the shape check below so the
// two can never drift apart.
const SEVERITIES = ["blocker", "important", "minor"];

// JSON Schema enforced server-side by `claude -p --json-schema`. The CLI
// validates the model's structured_output against this before returning,
// so the parser below is a single field read — no regex fallbacks needed.
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "reject"] },
    justification: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          file: { type: "string" },
          issue: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "file", "issue", "fix"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "justification", "concerns"],
  additionalProperties: false,
};

// Validate the schema-enforced payload's field shape. The CLI's
// `--json-schema` flag enforces structure server-side, so this is a defensive
// post-check: if reality contradicts the schema (CLI bug, envelope drift),
// we want to fail-closed rather than crash on `verdict.toUpperCase()` later.
function isWellShapedFinding(f) {
  if (!f || typeof f !== "object") return false;
  if (!SEVERITIES.includes(f.severity)) return false;
  if (typeof f.file !== "string") return false;
  if (typeof f.issue !== "string") return false;
  if (typeof f.fix !== "string") return false;
  return true;
}

// The model never emits an id — assigning one here (not in the schema) keeps
// it deterministic and always present, immune to the model skipping/renaming
// the field. Index-based (`f1`, `f2`, ...) rather than a content hash: findings
// are only ever read back within the same array (review-pr → prepare-pr →
// merge-pr), so positional stability for one review-log entry is all the
// pipeline needs, and it's trivially readable in logs/PR comments.
function assignFindingIds(findings) {
  return findings.map((f, i) => ({ id: `f${i + 1}`, ...f }));
}

function validateVerdict(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.verdict !== "approve" && payload.verdict !== "reject") return null;
  if (typeof payload.justification !== "string") return null;
  if (!Array.isArray(payload.concerns)) return null;
  if (payload.findings !== undefined) {
    if (!Array.isArray(payload.findings) || !payload.findings.every(isWellShapedFinding)) {
      return null;
    }
  }

  // The stated verdict is not trusted over the findings it carries. A model
  // that names a `blocker` — defined to the model as "must fix before push" —
  // and stamps "approve" in the same response is contradicting itself, and the
  // severity wins. Without this the gate is only as reliable as the model's
  // bookkeeping: the whole review can be sound and still ship, because one
  // field said the wrong word.
  //
  // `important` deliberately does NOT flip. It is defined as "must fix OR
  // explicitly waive", and the waiver is a human act the model cannot perform
  // — but flipping on it would newly block pushes that pass today, on no
  // evidence about how often the model pairs one with an approve. It is
  // flagged instead, so tightening this later is a decision made from the
  // review log rather than a guess.
  const findings = payload.findings ?? [];
  const wasApprove = payload.verdict === "approve";
  payload.blockerOnApprove = wasApprove && findings.some((f) => f.severity === "blocker");
  payload.importantOnApprove = wasApprove && findings.some((f) => f.severity === "important");
  if (payload.blockerOnApprove) payload.verdict = "reject";

  return payload;
}

/**
 * The verdict a human can read, for a stderr line. `undefined` means the model
 * omitted the key entirely — JSON has no `undefined`, so an absent key and an
 * undefined one arrive as the same bytes and are reported the same way.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeVerdict(value) {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

/**
 * The stderr block for a verdict this gate cannot read. Two layers can hit one
 * — the payload validator and the final decision — and the operator sees the
 * same words either way, because the distinction that matters to them is
 * "unreadable answer" vs "the model said no", not which layer caught it.
 *
 * @param {unknown} stated The verdict value as the model stated it.
 */
function warnUnreadableVerdict(stated) {
  process.stderr.write(`${RED}\n=== PUSH BLOCKED — unreadable reviewer verdict ===${RESET}\n`);
  process.stderr.write(
    `${RED}The reviewer answered with a verdict this gate does not recognise: ` +
      `${describeVerdict(stated)}.${RESET}\n` +
      `${RED}Only "approve" is a pass, so the push is blocked.${RESET}\n` +
      `${RED}This is NOT a code rejection and consumes no fix round — the reviewer's ` +
      `answer could not be read.${RESET}\n` +
      `${RED}Re-run the push. If it repeats, the reviewer's output shape has changed ` +
      `and this gate needs updating.${RESET}\n`,
  );
}

/**
 * Which of the four outcomes a recorded verdict is. **A whitelist, by
 * construction** — `approve` is returned for exactly one value and everything
 * unrecognised is `unknown`.
 *
 * The bug this closes: the decision below used to be `if (verdict === "reject")`
 * with the green APPROVE line as the fallthrough. That is a blacklist, so a
 * verdict of `escalate`, a truncated response, or a shape a model upgrade starts
 * emitting all passed the gate. `validateVerdict` filters unknown values one
 * layer upstream, which is why the hole was latent rather than live — but the
 * two layers duplicate the same enum, so relaxing either one opened the gate.
 * A reviewer that cannot parse its own answer has not reviewed.
 *
 * Pure and exported so the whitelist is provable for any value, independently
 * of whatever the upstream validator happens to allow today.
 *
 * @param {unknown} verdict
 * @returns {"approve" | "reject" | "escalate" | "unknown"}
 */
export function reviewOutcome(verdict) {
  if (isApproval(verdict)) return "approve";
  if (verdict === "reject") return "reject";
  if (verdict === "escalate") return "escalate";
  return "unknown";
}

function main() {
  const scope = getScope();
  const { range } = scope;
  // Round-bound key, resolved up front: both the pre-flight below and the
  // no-commits early exit stamp it. A dispatched worker lives on `agent/<slug>`
  // in its own worktree, so this is one counter per worker per task.
  const branch = getCurrentBranch() ?? UNKNOWN_BRANCH;
  const pushedFiles = getPushedFiles(range);

  if (pushedFiles.length === 0) {
    // An empty file list has two very different causes, and `safeExec` hands both over as
    // the same empty string. Probe the range itself to tell them apart before deciding.
    const probe = probeCommitCount(range);

    if (!probe.ok) {
      // The range cannot even be counted, so the empty file list is not evidence of an
      // empty push — it is evidence that nothing was read. Block (§5 dial A: a push that
      // does not stop reaches main), but as `awaiting-approval`, because a broken range is
      // no judgement about the code and must not spend one of the three fix rounds
      // (§5 dial B). `countFixRounds` counts only `reject` and `escalate`.
      appendEntry({
        ts: new Date().toISOString(),
        branch,
        commit: scope.commit,
        verdict: "awaiting-approval",
        sensitiveFiles: [],
        stagedFiles: [],
        justification:
          `Push range (${range}) could not be resolved by git, so no diff was read. ` +
          `Refusing to record a verdict on a change nobody looked at.`,
        concerns: ["push-range-unresolved"],
        why: WHY_SENTINEL,
      });
      process.stderr.write(
        `${RED}\n=== PUSH BLOCKED — THE PUSH RANGE COULD NOT BE READ ===${RESET}\n`,
      );
      process.stderr.write(`Range: ${range}\n`);
      process.stderr.write(
        "git could not count the commits in that range, so the reviewer never saw a diff.\n" +
          "Fix the range (a missing `main`/`origin/main` ref, a shallow clone, or a detached\n" +
          "history will do it) and retry. Do not assume approval.\n",
      );
      process.stderr.write("No model was called and no coding-fix round was consumed.\n");
      process.exit(1);
    }

    // Genuinely nothing to review: either no commits at all, or commits whose net diff is
    // empty (an empty commit, or a change and its revert in the same range). Let the push
    // through — stranding it would leave its author nothing to do — but log `no-review`,
    // never `approve`: `isApproval` whitelists only `approve`, so this cannot later be
    // read back as a reviewed pass.
    appendEntry({
      ts: new Date().toISOString(),
      branch,
      commit: scope.commit,
      verdict: "no-review",
      sensitiveFiles: [],
      stagedFiles: [],
      justification:
        probe.count === 0
          ? `No commits in push range (${range}) — nothing to review.`
          : `${probe.count} commit(s) in push range (${range}) with no net file changes — nothing to review.`,
      concerns: [],
      why: WHY_SENTINEL,
    });
    process.exit(0);
  }

  // ── Fix-round bound (enforced here, not in the worker's prompt) ───────────
  // The owner watches the coordinator; the fix loop runs inside dispatched
  // workers, in parallel worktrees nobody opens. A bound that lives only as
  // prose in the reviewed agent's own prompt is advisory and its breach is
  // invisible. Counted per branch from the review log.
  if (hasEscalated(branch)) {
    process.stderr.write(`${RED}\n=== PUSH BLOCKED — this branch already escalated ===${RESET}\n`);
    process.stderr.write(
      `${RED}${MAX_FIX_ROUNDS} reviewer rejects were recorded on \`${branch}\`. The fix loop is over.${RESET}\n` +
        `${RED}Do not retry. Report to the owner: the final reject reason, ` +
        `\`git diff --stat main...HEAD\`, and one line per attempt saying what you changed.${RESET}\n`,
    );
    process.exit(1);
  }

  // Computed from git, never inferred by the model from commit prose (standards.md §5).
  // An unratified critical edit is a verdict on its own — no model is asked to act on it.
  const ratification = computeRatificationFact(range, safeExec, pushedFiles);
  const forced = ratificationRejection(ratification);
  if (forced) {
    appendEntry({
      ts: new Date().toISOString(),
      branch,
      commit: scope.commit,
      verdict: "reject",
      sensitiveFiles: [],
      stagedFiles: pushedFiles,
      ...forced,
      why: WHY_SENTINEL,
    });
    process.stderr.write(`${RED}\n=== PUSH BLOCKED ===${RESET}\n`);
    process.stderr.write(`${RED}${forced.justification}${RESET}\n\n`);
    process.exit(1);
  }

  const diff = getPushedDiff(range);
  const report = loadReport();
  const commitMessage = loadCommitMessages(range);

  // Resolve the "why this PR exists" paragraph ONCE. Haiku reads from PLAN.md
  // when present (dispatched work) or PR body / commit bodies / linked issues
  // (ad-hoc). The Sonnet reviewer sees this as a "Context" preface so it can
  // flag scope drift; the comment poster reads it back from the review-log
  // entry to render the "## O que este PR resolve" lead section.
  const plan = loadPlan(repoRoot);
  const prBody = loadPrBody();
  const issueBodies = loadLinkedIssueBodies(prBody);
  const whyParagraph = summarizeWhy({
    plan,
    prBody,
    commits: commitMessage,
    issueBodies,
    branch,
  });

  const prompt = buildPrompt(
    diff,
    report,
    pushedFiles,
    commitMessage,
    whyParagraph,
    plan,
    extractDoneWhen(plan),
    ratification,
  );

  const claudeResult = callClaudeStructured({
    model: "sonnet",
    schema: VERDICT_SCHEMA,
    input: prompt,
    cwd: repoRoot,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!claudeResult.ok) {
    // Blocks, but NOT as a reject — the same split as the unreadable-verdict
    // path below. A reviewer that never answered has not judged the code, so
    // "awaiting-approval" keeps dial A strict (the push stops) while leaving
    // dial B loose (`countFixRounds` ignores it). Logging a `reject` here made
    // three transient network failures exhaust MAX_FIX_ROUNDS and escalate a
    // branch nobody rejected — an interruption spent on nothing. standards.md §5.
    const entry = {
      ts: new Date().toISOString(),
      branch,
      commit: scope.commit,
      verdict: "awaiting-approval",
      sensitiveFiles: [],
      stagedFiles: pushedFiles,
      justification: `Reviewer unavailable; push blocked without a code judgement. Error: ${claudeResult.error}`,
      concerns: ["security-reviewer-unavailable"],
      why: whyParagraph,
    };
    appendEntry(entry);
    process.stderr.write(`${RED}\n=== PUSH BLOCKED ===${RESET}\n`);
    process.stderr.write(`${RED}Reviewer unavailable: ${claudeResult.error}${RESET}\n`);
    process.exit(1);
  }

  const verdict = validateVerdict(claudeResult.payload);
  if (!verdict) {
    // Blocks, but NOT as a reject: "awaiting-approval" is the harness's
    // non-green outcome that `countFixRounds` deliberately ignores. A reviewer
    // whose answer could not be read has found no defect, so it must not spend
    // one of MAX_FIX_ROUNDS and must not escalate a branch nobody rejected.
    const stated = claudeResult.payload?.verdict;
    const entry = {
      ts: new Date().toISOString(),
      branch,
      commit: scope.commit,
      verdict: "awaiting-approval",
      sensitiveFiles: [],
      stagedFiles: pushedFiles,
      justification:
        `Reviewer answered with an unreadable verdict ${describeVerdict(stated)} ` +
        "(or a payload whose field shape was unexpected). Push blocked without a code judgement.",
      concerns: ["unparseable-verdict"],
      rawPayload: JSON.stringify(claudeResult.payload).slice(0, 4000),
      why: whyParagraph,
    };
    appendEntry(entry);
    warnUnreadableVerdict(stated);
    process.stderr.write(
      `${RED}Payload (first 1000 chars):${RESET}\n${JSON.stringify(claudeResult.payload).slice(0, 1000)}\n`,
    );
    process.exit(1);
  }

  // `let`, not `const`: applyFixRoundBound below REASSIGNS this. The template
  // carried `const` while the live copy it was mirrored from used `let`, so the
  // escalation path threw TypeError the moment a third consecutive reject
  // reached it -- a rare path, which is why it went unnoticed.
  let entry = {
    ts: new Date().toISOString(),
    branch,
    commit: scope.commit,
    verdict: verdict.verdict,
    // The critical-path contract (scripts/lib/critical-paths.mjs), plus a deliberate
    // SUPERSET: `src/__tests__/` is tagged so test edits are labelled in the log,
    // without making tests require a ratification to edit.
    sensitiveFiles: pushedFiles.filter((f) => f.startsWith("src/__tests__/") || isCriticalPath(f)),
    stagedFiles: pushedFiles,
    justification: verdict.justification ?? "",
    concerns: Array.isArray(verdict.concerns) ? verdict.concerns : [],
    findings: assignFindingIds(Array.isArray(verdict.findings) ? verdict.findings : []),
    // Recorded so the choice to keep `important` non-blocking stays reviewable
    // from the log instead of from memory.
    verdictOverridden: verdict.blockerOnApprove === true,
    importantOnApprove: verdict.importantOnApprove === true,
    why: whyParagraph,
  };
  // `show-review-log.mjs` renders an "escalate" verdict; until now nothing ever
  // wrote one. Decision lives in applyFixRoundBound (tested).
  entry = applyFixRoundBound(entry, branch, loadAllEntries());

  appendEntry(entry);

  // The decision. `entry.verdict` is the single source of truth — it is what was
  // written to the log, including anything applyFixRoundBound changed.
  const outcome = reviewOutcome(entry.verdict);

  if (outcome === "escalate") {
    process.stderr.write(`${RED}\n=== ESCALATED — fix loop exhausted ===${RESET}\n`);
    process.stderr.write(
      `${RED}${MAX_FIX_ROUNDS} reviewer rejects on \`${branch}\`. STOP: do not push, do not open a PR.${RESET}\n` +
        `${RED}Report to the owner: this reject reason, \`git diff --stat main...HEAD\`, ` +
        `and one line per attempt saying what you changed.${RESET}\n\n` +
        `${RED}Reason: ${entry.justification}${RESET}\n`,
    );
    process.exit(1);
  }

  if (outcome === "reject") {
    process.stderr.write(`${RED}\n=== COMMIT REJECTED ===${RESET}\n`);
    if (entry.verdictOverridden) {
      process.stderr.write(
        `${RED}(The reviewer stamped "approve" while listing a blocker finding. ` +
          `The blocker wins — see the findings below.)${RESET}\n`,
      );
    }
    process.stderr.write(`${RED}Justification:${RESET} ${entry.justification}\n`);
    if (entry.concerns.length > 0) {
      process.stderr.write(`${RED}Concerns:${RESET}\n`);
      for (const c of entry.concerns) {
        process.stderr.write(`  ${RED}- ${c}${RESET}\n`);
      }
    }
    // A model that approved-with-a-blocker usually leaves `concerns` empty,
    // since it did not think it was rejecting. Print the findings so the block
    // is never reasonless.
    if (entry.findings.length > 0) {
      process.stderr.write(`${RED}Findings:${RESET}\n`);
      for (const f of entry.findings) {
        process.stderr.write(
          `  ${RED}- [${f.severity}] ${f.file}: ${f.issue}${RESET}\n    fix: ${f.fix}\n`,
        );
      }
    }
    process.stderr.write(
      `${RED}Commit blocked. Address the concerns above and try again.${RESET}\n\n`,
    );
    process.exit(1);
  }

  // Fail closed. Nothing reaches the green line below but a genuine approval:
  // not an unrecognised verdict, not a shape a future model emits, not a value
  // a relaxed validator upstream lets through. The operator must be able to
  // tell "the model said no" from "the model said something I could not read",
  // so this names the value and says it is not a rejection.
  if (outcome !== "approve") {
    warnUnreadableVerdict(entry.verdict);
    process.exit(1);
  }

  if (entry.importantOnApprove) {
    process.stderr.write(
      `${RED}[security-review] NOTE${RESET}: approved with an "important" finding — ` +
        `not a block, but read it before pushing:\n`,
    );
    for (const f of entry.findings.filter((f) => f.severity === "important")) {
      process.stderr.write(`  - ${f.file}: ${f.issue}\n    fix: ${f.fix}\n`);
    }
  }

  process.stdout.write(`${GREEN}[security-review] APPROVE${RESET}: ${entry.justification}\n`);
  process.exit(0);
}

// Exported for scripts/security-review.test.mjs. Pure and side-effect free —
// the executable behaviour stays behind the run-as-script guard below.
export { buildPrompt, SEVERITIES, VERDICT_SCHEMA, validateVerdict };

// `reviewOutcome` is exported at its definition (see security-review-outcome.test.mjs).

// Only run the gate when executed directly (`node scripts/security-review.mjs`),
// never when imported by a test. Without this, importing the module would run a
// real review and call process.exit().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
