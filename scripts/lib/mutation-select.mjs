/**
 * mutation-select.mjs
 *
 * Which mutants to run, and — the harder half — how to run THE SAME ONES again
 * on the next push.
 *
 * THE LOOP THIS EXISTS TO MAKE CONVERGE. Round 1 blocks on survivor X. The
 * agent writes a test and pushes. If round 2 samples a different set, it blocks
 * on a different survivor Y; the agent has no way to know its fix worked, and
 * `MAX_FIX_ROUNDS` counts three unrelated findings as three failed attempts at
 * one problem before escalating to Andre with an incoherent history. A mutation
 * gate whose sampler is not stable is worse than no gate: it is a random number
 * generator wired to a push.
 *
 * DETERMINISM COMES FROM CONTENT ADDRESSING, NOT FROM PERSISTENCE. The selection
 * is a pure function of the diff-scoped site set. `.quality-gate/` is gitignored,
 * per-worktree ephemera an agent can delete — if it were the SOURCE of
 * determinism, a tidy-up would silently reset the loop. It is a prioritisation
 * aid layered on top, and losing it costs ordering, not coherence.
 *
 * TWO IDENTITY SCHEMES THAT LOOK RIGHT AND ARE NOT:
 *
 *   - seeded on HEAD — HEAD changes every fix round by construction, so it
 *     re-rolls the sample every single round. The exact bug above.
 *   - keyed on line number — a fix that adds one import shifts every line below
 *     it, so every mutant "vanishes" and a fresh set appears. Same bug, finer
 *     grain, harder to see.
 *
 * So identity is `(file, operator, original, mutated, normalised line text,
 * ordinal)`. That survives line shifts, reindentation and comment edits, and
 * deliberately does NOT survive a rewrite of the mutated line itself — because
 * a rewritten line really is a different mutant.
 */

import { createHash } from "node:crypto";

export const STATE_VERSION = 1;

/** Collapse whitespace so reindentation and reflow do not change identity. */
const normalize = (text) => (text ?? "").replace(/\s+/g, " ").trim();

/** Identity fields, minus the ordinal — the grouping key for ordinal assignment. */
const identity = (site) =>
  [site.file, site.operator, site.original, site.mutated, normalize(site.context)].join("|");

/**
 * Stable, content-addressed mutant id.
 *
 * `ordinal` disambiguates identical lines in one file (two `if (a === b)` in the
 * same function are two mutants). It is assigned by `withIds` in enumeration
 * order, so inserting an unrelated line between them keeps both ids.
 *
 * @param {{file:string, operator:string, original:string, mutated:string, context:string, ordinal?:number}} site
 * @returns {string} 12 hex chars
 */
export function mutantId(site) {
  return createHash("sha256")
    .update(`${identity(site)}|${site.ordinal ?? 0}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Attach ids to enumerated sites, assigning ordinals within each identity group.
 * @param {import("./mutation-sites.mjs").Site[]} sites
 */
export function withIds(sites) {
  const counts = new Map();
  return sites.map((site) => {
    const key = identity(site);
    const ordinal = counts.get(key) ?? 0;
    counts.set(key, ordinal + 1);
    return { ...site, ordinal, id: mutantId({ ...site, ordinal }) };
  });
}

/**
 * Previous round's verdicts, or `[]` if anything at all is off.
 *
 * Every degradation path leads to `[]` rather than a throw: the gate must still
 * run. Because identity is content-addressed, `[]` reproduces the same selection
 * as long as the diff-scoped sites are unchanged — which is the normal case for
 * a test-only fix round.
 *
 * @param {string|undefined} raw  file contents, or undefined if absent
 * @param {string} branch
 */
export function readState(raw, branch) {
  if (!raw) return [];
  try {
    const state = JSON.parse(raw);
    if (state.version !== STATE_VERSION) return [];
    // A fix loop is one branch in one worktree. State from another branch
    // describes a different diff; discard rather than migrate.
    if (state.branch !== branch) return [];
    return Array.isArray(state.mutants) ? state.mutants : [];
  } catch {
    return [];
  }
}

/**
 * Choose the mutants for this round.
 *
 * Order of precedence, and each rank is load-bearing:
 *   1. previously SURVIVED and still present — the open finding. Never droppable.
 *   2. previously KILLED and still present — re-verify the fix did not regress.
 *   3. everything else, in hash order.
 *
 * Rule 1 is the one that must not be weakened. Without it a 40-site diff under a
 * cap of 15 can drop the known survivor from round 2's sample, report PASS, and
 * let the push through with the exact defect round 1 found.
 *
 * Rank 3 is hash order rather than file order because it is insertion-stable:
 * adding one site inserts it at a hash-determined position and perturbs the
 * selected prefix by at most one element. File or line order shifts the whole
 * window when a site appears near the top of a file.
 *
 * @param {Array<{id:string}>} sites      diff-scoped sites, each already carrying `id`
 * @param {Array<{id:string, verdict:string}>} previous
 * @param {number} max
 */
export function selectMutants(sites, previous, max) {
  const byId = new Map(sites.map((s) => [s.id, s]));
  const prevById = new Map(previous.map((p) => [p.id, p]));

  const rank = (site) => {
    const verdict = prevById.get(site.id)?.verdict;
    if (verdict === "survived") return 0;
    if (verdict) return 1;
    return 2;
  };

  const ordered = [...sites].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
  const selected = ordered.slice(0, max);

  return {
    selected,
    carried: selected.filter((s) => prevById.has(s.id)).map((s) => s.id),
    // Previously seen, but the site no longer exists: the push changed the code
    // that was being mutated. Reported, never silently dropped — deleting the
    // line IS a route around the gate, and the security reviewer is shown both
    // the diff and this list so a human-judgement call has the facts.
    vanished: previous.filter((p) => !byId.has(p.id)).map((p) => p.id),
    fresh: selected.filter((s) => !prevById.has(s.id)).map((s) => s.id),
    dropped: sites.length - selected.length,
  };
}
