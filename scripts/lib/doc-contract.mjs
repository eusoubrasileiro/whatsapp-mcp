/**
 * doc-contract.mjs
 *
 * The markdown files this repo is allowed to hold (standards.md §8, "Every .md is a
 * critical file"). Doc sprawl is a correctness problem: the next agent greps, finds a
 * dated snapshot, and cannot tell it from a live spec. The `ask` tier only fires while a
 * human is at the terminal; this list is the half that holds when nobody is watching —
 * the quality gate counts every `.md` off it at a floor of 0, so a stray doc fails on its
 * first commit instead of quietly raising an allowance.
 *
 * Adding a path is an owner decision, made in the commit that creates the file and
 * carried by its `Ratified-by:` trailer (this file is a critical path).
 *
 * The 16 below were frozen 2026-11-16. Each is one of: agent steering (CLAUDE.md, the
 * worker contract), a prompt the code loads (why-summarize), the shipped docs of this
 * public package (README, docs/, examples/), or the deploy runbook. None is a plan,
 * report or dated snapshot — those live in gitignored `.claude/plans/` or in issues.
 *
 * Reference implementation: products/dou-busca/scripts/lib/quality-metrics.mjs.
 */

export const DOC_ALLOWLIST = new Set([
  "CLAUDE.md",
  "README.md",
  "deploy/README.md",
  "docs/account-restrictions.md",
  "docs/agent-presence-stream-recipe.md",
  "docs/configuration.md",
  "docs/development.md",
  "docs/operations.md",
  "docs/reactive-monitoring.md",
  "docs/send-guards.md",
  "docs/tools.md",
  "docs/webhooks.md",
  "examples/README.md",
  "examples/mcp-clients.md",
  "scripts/agent-prompt.md",
  "scripts/prompts/why-summarize.md",
]);

/**
 * Markdown files off `DOC_ALLOWLIST`, sorted and deduplicated.
 *
 * Throws on an empty listing: git listing nothing is a broken measurement, and reading it
 * as "0 offenders" would be a green gate that ran nothing (standards.md §8.2).
 *
 * @param {string[]} paths Repo-relative paths: tracked plus untracked-unignored, so a stray
 *   doc fails before it is ever committed while gitignored scratch stays out of scope.
 * @returns {string[]}
 */
export function findDocContractOffenders(paths) {
  const listed = (paths ?? []).filter(Boolean);
  if (listed.length === 0) {
    throw new Error("doc-contract: git listed no files (git ls-files failed?)");
  }
  const offenders = listed.filter(
    (p) => /\.(?:md|mdx|markdown)$/i.test(p) && !DOC_ALLOWLIST.has(p),
  );
  return [...new Set(offenders)].sort();
}
