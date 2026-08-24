#!/usr/bin/env node
/**
 * security-review.mjs
 *
 * Final pre-push reviewer. Runs after lint, tsc, the full test suite, and
 * the deterministic quality-gate. Sends staged diff + commit message + the
 * quality-gate report to claude -p (Sonnet tier), appends the verdict to
 * .quality-gate/review-log.jsonl, and blocks the push (exit 1) on reject.
 *
 * Verdict space: "approve" | "reject". The 3-strike retry cap for dispatched
 * sub-agents is enforced by the agent contract in scripts/agent-prompt.md
 * (item 7), not by this script — this reviewer is stateless and judges each
 * run independently.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { callClaudeStructured } from "./lib/claude-cli.mjs";
import { isCriticalPath, renderCriticalPathsForPrompt } from "./lib/critical-paths.mjs";
import { loadPlan, summarizeWhy, WHY_SENTINEL } from "./lib/intent.mjs";
import { appendEntry } from "./lib/review-log.mjs";

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

const ZERO_SHA = "0000000000000000000000000000000000000000";

function refExists(ref) {
  return Boolean(safeExec(`git rev-parse --verify --quiet ${ref}`).trim());
}

// The git range to review. Pre-push hook exports the exact SHAs being pushed;
// fall back to upstream / origin-main for manual invocations.
function getPushRange() {
  const localSha = process.env.PUSH_LOCAL_SHA;
  const remoteSha = process.env.PUSH_REMOTE_SHA;

  if (localSha && localSha !== ZERO_SHA) {
    if (remoteSha && remoteSha !== ZERO_SHA) {
      return `${remoteSha}..${localSha}`;
    }
    if (refExists("origin/main")) return `origin/main..${localSha}`;
    return `main..${localSha}`;
  }

  const upstream = safeExec("git rev-parse --abbrev-ref --symbolic-full-name @{u}").trim();
  if (upstream && refExists(upstream)) return `${upstream}..HEAD`;
  if (refExists("origin/main")) return `origin/main..HEAD`;
  return "main..HEAD";
}

function getPushedFiles(range) {
  const out = safeExec(`git diff --name-only ${range}`);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getPushedDiff(range) {
  return safeExec(`git diff ${range}`);
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
  let m;
  while ((m = re.exec(prBody)) !== null) {
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

function buildPrompt(diff, report, files, commitMessage, whyParagraph) {
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

  return `${contextSection}You are an integrity reviewer for the whatsapp-mcp codebase (a WhatsApp MCP server running in production at mcp.amiticia.cc). Review the staged commit and decide whether to APPROVE or REJECT.

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
- Any of these critical paths modified — these require human approval, never unattended agent edits. This list is generated from \`scripts/lib/critical-paths.mjs\`, the same module that drives the reviewer's own file tagging, so it cannot drift from what the harness actually gates:
${renderCriticalPathsForPrompt()}

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
          severity: { type: "string", enum: ["blocker", "important", "minor"] },
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
  if (!["blocker", "important", "minor"].includes(f.severity)) return false;
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
  return payload;
}

function main() {
  const range = getPushRange();
  const pushedFiles = getPushedFiles(range);

  if (pushedFiles.length === 0) {
    const entry = {
      ts: new Date().toISOString(),
      commit: process.env.PUSH_LOCAL_SHA || "HEAD",
      verdict: "approve",
      sensitiveFiles: [],
      stagedFiles: [],
      justification: `No commits in push range (${range}) — nothing to review.`,
      concerns: [],
      why: WHY_SENTINEL,
    };
    appendEntry(entry);
    process.exit(0);
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
  const branch = getCurrentBranch();
  const whyParagraph = summarizeWhy({
    plan,
    prBody,
    commits: commitMessage,
    issueBodies,
    branch,
  });

  const prompt = buildPrompt(diff, report, pushedFiles, commitMessage, whyParagraph);

  const claudeResult = callClaudeStructured({
    model: "sonnet",
    schema: VERDICT_SCHEMA,
    input: prompt,
    cwd: repoRoot,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!claudeResult.ok) {
    const entry = {
      ts: new Date().toISOString(),
      commit: "(staged)",
      verdict: "reject",
      sensitiveFiles: [],
      stagedFiles: pushedFiles,
      justification: `Reviewer unavailable; push blocked. Error: ${claudeResult.error}`,
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
    const entry = {
      ts: new Date().toISOString(),
      commit: "(staged)",
      verdict: "reject",
      sensitiveFiles: [],
      stagedFiles: pushedFiles,
      justification:
        "Reviewer payload passed CLI schema validation but the field shape was unexpected. Push blocked.",
      concerns: ["unparseable-verdict"],
      rawPayload: JSON.stringify(claudeResult.payload).slice(0, 4000),
      why: whyParagraph,
    };
    appendEntry(entry);
    process.stderr.write(`${RED}\n=== PUSH BLOCKED ===${RESET}\n`);
    process.stderr.write(
      `${RED}Reviewer payload failed shape validation. Payload (first 1000 chars):${RESET}\n${JSON.stringify(claudeResult.payload).slice(0, 1000)}\n`,
    );
    process.exit(1);
  }

  const entry = {
    ts: new Date().toISOString(),
    commit: "(staged)",
    verdict: verdict.verdict,
    // Reads the critical-path contract from scripts/lib/critical-paths.mjs —
    // the same module that renders the prompt block above, so the two faces
    // cannot drift (standards §6). Deliberately a SUPERSET of that contract:
    // it additionally tags `src/__tests__/` so test edits get labeled in the
    // review log, without making tests require a ratification to edit.
    sensitiveFiles: pushedFiles.filter((f) => f.startsWith("src/__tests__/") || isCriticalPath(f)),
    stagedFiles: pushedFiles,
    justification: verdict.justification ?? "",
    concerns: Array.isArray(verdict.concerns) ? verdict.concerns : [],
    findings: assignFindingIds(Array.isArray(verdict.findings) ? verdict.findings : []),
    why: whyParagraph,
  };
  appendEntry(entry);

  if (verdict.verdict === "reject") {
    process.stderr.write(`${RED}\n=== COMMIT REJECTED ===${RESET}\n`);
    process.stderr.write(`${RED}Justification:${RESET} ${entry.justification}\n`);
    if (entry.concerns.length > 0) {
      process.stderr.write(`${RED}Concerns:${RESET}\n`);
      for (const c of entry.concerns) {
        process.stderr.write(`  ${RED}- ${c}${RESET}\n`);
      }
    }
    process.stderr.write(
      `${RED}Commit blocked. Address the concerns above and try again.${RESET}\n\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`${GREEN}[security-review] APPROVE${RESET}: ${entry.justification}\n`);
  process.exit(0);
}

main();
