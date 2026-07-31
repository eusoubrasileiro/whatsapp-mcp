/**
 * critical-paths.mjs
 *
 * The single in-code definition of "human approval required". CLAUDE.md's
 * "Critical Files" table and the `ask` tier in `.claude/settings.json` are the
 * other two faces of the same contract (standards §6), and CLAUDE.md warns that
 * drift between them makes the reviewer reject what settings allow — or worse,
 * the reverse. That drift is not hypothetical: the anti-ban guards below sat in
 * CLAUDE.md's table while being absent from the ask tier and from both reviewer
 * lists, so an agent could have rewritten the cold-contact guard with no prompt
 * and no flag.
 *
 * Two consumers inside the reviewer used to spell this list out separately: the
 * `sensitiveFiles` filter (via `isCriticalPath`) and the prompt prose (via
 * `renderCriticalPathsForPrompt`). Both now read from here, so a path is added
 * once and cannot go missing from one face.
 *
 * Matching is EXACT for files and prefix-based only for whole directories, so
 * a lookalike name (`src/database.test-helpers.ts`) can never inherit
 * `src/database.ts`'s protection.
 *
 * NOT here on purpose: `src/__tests__/**`. Tests must stay freely editable, or
 * every red-green cycle needs a ratification. The reviewer still tags them in
 * its log as a deliberate superset — that is a call-site concern, kept at the
 * call site.
 */

/**
 * The critical-path contract, grouped exactly as CLAUDE.md's table presents it.
 * `patterns` entries ending in `/` are directory prefixes; `**\/*.md` is the
 * markdown catch-all. Everything else is an exact repo-relative path.
 *
 * @type {ReadonlyArray<{label: string, patterns: string[], why: string}>}
 */
export const CRITICAL_PATH_GROUPS = Object.freeze([
  {
    label: "The harness itself",
    why: "An agent that can edit the gate can delete the gate.",
    patterns: [
      ".husky/",
      ".claude/settings.json",
      ".gitignore",
      "biome.json",
      "commitlint.config.cjs",
      "quality-baseline.json",
      "scripts/quality-gate.mjs",
      "scripts/security-review.mjs",
      "scripts/lib/",
      "scripts/dispatch-worktree.sh",
      "scripts/cleanup-worktrees.sh",
    ],
  },
  {
    label: "Send guards",
    why: 'Weakening these re-opens "success reported, message never sent" (2026-07-22), and each bad retry is a real WhatsApp reach-out.',
    patterns: ["src/send-guard.ts", "src/recipient.ts", "src/ack-bus.ts", "src/ack-errors.ts"],
  },
  {
    label: "Anti-ban policy",
    why: "These stand between an agent and another account restriction (two in July 2026). Weakening one is a business risk, not a code change. A malformed env value must read as the default, never as 'guard disabled', so the parser counts too — as does the cold guard's inbound-history oracle.",
    patterns: [
      "src/send-policy.ts",
      "src/send-blocklist.ts",
      "src/cold-contact.ts",
      "src/send-pacer.ts",
      "src/send-typing.ts",
      "src/env-config.ts",
      "src/db/inbound-history.ts",
      "src/db/send-blocklist-store.ts",
    ],
  },
  {
    label: "Data layer",
    why: "Schema/migration mistakes corrupt the production message store. There is no drizzle-kit runner, so a table absent from ddl.ts does not exist at runtime.",
    patterns: ["src/db/schema.ts", "src/database.ts", "src/db/ddl.ts"],
  },
  {
    label: "Operator scripts",
    why: "Destructive against the live /data volume.",
    patterns: ["scripts/backup.sh", "scripts/restore.sh", "scripts/merge-db.sh"],
  },
  {
    label: "Build & test contract",
    why: "Deploy artifact + coverage-threshold definitions.",
    patterns: ["Dockerfile", "vitest.config.ts"],
  },
  {
    label: "All docs",
    why: "Company-wide rule (ratified 2026-07-21): docs steer agents, so a stale doc corrupts the code it drives.",
    patterns: ["**/*.md"],
  },
]);

/** Whole directories where every file is critical. */
const CRITICAL_DIR_PREFIXES = Object.freeze(
  CRITICAL_PATH_GROUPS.flatMap((g) => g.patterns.filter((p) => p.endsWith("/"))),
);

/** Exact repo-relative paths that are critical. */
const CRITICAL_FILES = new Set(
  CRITICAL_PATH_GROUPS.flatMap((g) =>
    g.patterns.filter((p) => !p.endsWith("/") && !p.includes("*")),
  ),
);

/**
 * Does this path require human approval before an agent edits it?
 *
 * Every `*.md` counts: docs steer agents, so a stale doc corrupts the code it
 * drives (ratified company-wide 2026-07-21).
 *
 * @param {string} file Repo-relative path.
 * @returns {boolean}
 */
export function isCriticalPath(file) {
  if (typeof file !== "string" || file.length === 0) return false;
  if (file.endsWith(".md")) return true;
  if (CRITICAL_FILES.has(file)) return true;
  return CRITICAL_DIR_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/**
 * Render the contract as prompt prose for the LLM reviewer, so the model is
 * told about exactly the paths the predicate gates — no hand-maintained second
 * copy that can quietly fall behind.
 *
 * @returns {string}
 */
export function renderCriticalPathsForPrompt() {
  return CRITICAL_PATH_GROUPS.map(
    (group) => `- ${group.label}: ${group.patterns.join(", ")}\n  Why: ${group.why}`,
  ).join("\n");
}
