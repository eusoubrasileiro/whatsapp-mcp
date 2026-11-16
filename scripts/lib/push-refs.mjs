#!/usr/bin/env node
/**
 * push-refs.mjs — what `.husky/pre-push` decides from the refs git hands it.
 *
 * The path-triggered legs (e2e, mutation) must decide over EVERY pushed ref. They used
 * to be shell that diffed only the first one, so a change carried by a later ref of a
 * multi-ref push (`git push origin a b`, `--all`) skipped the leg — a green that ran
 * nothing (standards.md §8.2). Uncertainty defaults to RUN: a new branch, an undiffable
 * ref, a push of nothing but deletions, an unknown leg name, or any error.
 *
 * Not to be confused with `push-range.mjs`, which answers a different question — "what
 * range does this push ADD to main" — for the reviewer and the mutation gate. This one
 * answers "does ANY pushed ref touch a file that leg cares about".
 *
 * CLI: `node scripts/lib/push-refs.mjs <e2e|mutation> < <hook stdin>` prints `run` or
 * `skip` and a reason on stderr. The hook skips only on the exact word `skip`, so a
 * crash here runs the leg.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MUTATE_ROOT } from "./mutation-sites.mjs";

const ZERO_SHA = "0000000000000000000000000000000000000000";

// whatsapp-mcp: anything the e2e suite exercises — the server source, the e2e specs and
// their config, the image and dev stack it can run against, and the dependency
// manifests. A path missing here is a silent skip.
const E2E_PATHS =
  /^(src\/|e2e\/|vitest\.e2e\.config\.|scripts\/lib\/push-refs\.mjs|package\.json|pnpm-lock\.yaml|Dockerfile|docker-compose\.dev\.yaml|\.husky\/pre-push)/;

/**
 * @param {string} stdin The pre-push hook's stdin: `<local_ref> <local_sha> <remote_ref> <remote_sha>` per line.
 * @returns {{localRef: string, localSha: string, remoteRef: string, remoteSha: string}[]}
 */
export function parsePushRefs(stdin) {
  return stdin
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * Run when ANY pushed ref is new, undiffable or touches a file matching `paths`.
 *
 * @param {ReturnType<typeof parsePushRefs>} refs
 * @param {(remoteSha: string, localSha: string) => string[] | null} diffNames Files
 *   changed between the two SHAs, or null when git cannot diff them.
 * @param {RegExp} paths
 * @param {string} what What the leg guards, for the skip reason.
 * @returns {{run: boolean, reason: string}}
 */
export function pushDecision(refs, diffNames, paths, what) {
  const updates = refs.filter((r) => r.localSha && r.localSha !== ZERO_SHA);
  if (updates.length === 0) return { run: true, reason: "no ref with content to diff" };
  for (const r of updates) {
    if (!r.remoteSha || r.remoteSha === ZERO_SHA) {
      return { run: true, reason: `${r.localRef} is a new branch` };
    }
    const files = diffNames(r.remoteSha, r.localSha);
    if (files === null) return { run: true, reason: `${r.localRef} could not be diffed` };
    const hit = files.find((f) => paths.test(f));
    if (hit) return { run: true, reason: `${r.localRef} changes ${hit}` };
  }
  return { run: false, reason: `no pushed ref touches ${what}` };
}

/** @see pushDecision */
export const e2eDecision = (refs, diffNames) =>
  pushDecision(refs, diffNames, E2E_PATHS, "an app, schema or spec file");

// The mutation gate's own source root, so the trigger and the gate cannot disagree.
const MUTATION_PATHS = new RegExp(`^${MUTATE_ROOT.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`);

/** @see pushDecision */
export const mutationDecision = (refs, diffNames) =>
  pushDecision(refs, diffNames, MUTATION_PATHS, "mutable source");

function gitDiffNames(remoteSha, localSha) {
  try {
    const out = execFileSync("git", ["diff", "--name-only", remoteSha, localSha], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

const LEGS = { e2e: e2eDecision, mutation: mutationDecision };

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  const leg = process.argv[2];
  let decision;
  try {
    const decide = LEGS[leg];
    if (!decide) throw new Error(`unknown leg "${leg}"`);
    decision = decide(parsePushRefs(readFileSync(0, "utf8")), gitDiffNames);
  } catch (err) {
    decision = { run: true, reason: `decision failed: ${err.message}` };
  }
  process.stderr.write(`[pre-push] ${leg}: ${decision.reason}\n`);
  process.stdout.write(decision.run ? "run\n" : "skip\n");
}
