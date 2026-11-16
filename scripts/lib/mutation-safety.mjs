/**
 * mutation-safety.mjs
 *
 * The mutation gate puts non-source bytes into a tracked file in the working
 * tree. This module is what makes that survivable.
 *
 * THE THREAT, STATED PRECISELY. The gate is dangerous in exact proportion to
 * its own success criterion. A mutant that is KILLED self-reports: leave it on
 * disk and the next `pnpm test` fails loudly at pre-commit. A mutant that
 * SURVIVES passed the entire test suite by definition, so it also passes
 * `pnpm test`, passes `tsc --noEmit` (it is type-valid by construction) and
 * passes biome. **A surviving mutant stranded by a crash is silently
 * committable.** The residual risk of this design is not "some mutants" — it is
 * precisely the interesting ones, which is why the recovery is journal-based
 * rather than trusting a `finally` block.
 *
 * WHAT WAS REJECTED AND WHY:
 *
 *   `git stash` — REJECTED OUTRIGHT, and not merely as suboptimal.
 *     `refs/stash` lives in the COMMON git dir, shared by every worktree under
 *     `.claude/worktrees/`. Two dispatched agents pre-pushing at once push onto
 *     the same stack, and a pop in one worktree can pop the other's entry into
 *     the wrong tree. That is a cross-worktree source-corruption channel
 *     strictly worse than the problem it solves.
 *
 *   a fresh `git worktree` per run — REJECTED ON BUDGET.
 *     `scripts/dispatch-worktree.sh` runs `pnpm install --frozen-lockfile` plus
 *     a shared build and `prisma generate` per worktree: minutes of setup before
 *     the first mutant runs, against a 5-minute total budget. Sharing
 *     `node_modules` by symlink is not safe under pnpm. It also does not
 *     eliminate crash residue, it relocates it into a stale worktree entry.
 *
 * WHAT IS IMPLEMENTED: backup and journal first, fsynced, THEN the mutant.
 * One mutated file on disk at any instant, so a crash's blast radius is exactly
 * one file and the journal has exactly one entry. Recovery is a sweep at the
 * start of every run — and, because the dangerous case is a survivor that no
 * test will flag, also at the start of every commit.
 *
 * All fs access goes through an injected `fs` so the ordering guarantees are
 * unit-testable, following the injected-`exec` pattern in `ratification.mjs`.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const MUTATION_DIRNAME = join(".quality-gate", "mutation");

const nodeFs = { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync };

const journalPathOf = (dir) => join(dir, "journal.json");
const backupPathOf = (dir) => join(dir, "original.orig");

/**
 * Write and fsync. The fsync is the difference between "the bytes are in the
 * page cache" and "the bytes survive a power cut", and the whole ordering
 * argument below is worthless without it.
 *
 * Only ever called for the journal and the backup — never for the mutant, whose
 * durability does not matter (a lost mutant is a file that was never mutated).
 */
function writeDurable(fs, path, data) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, data);
  if (fs !== nodeFs) return; // injected fake: nothing to fsync
  try {
    const fd = openSync(path, "r+");
    fsyncSync(fd);
    closeSync(fd);
  } catch {
    // Best effort. A failed fsync does not justify aborting the push; the
    // ordering still holds in the far more common process-death case.
  }
}

/**
 * Put one mutant on disk, recoverably.
 *
 * ORDER IS THE CONTRACT: backup, then journal, then mutant. Die between journal
 * and mutant and the sweep restores a file that was never changed — a harmless
 * no-op. Die in the other order and there is a mutated file nothing knows about.
 *
 * The only crash window that can strand an unrecorded mutant is inside the
 * single `writeFileSync` of the mutant itself, which leaves a torn file that
 * fails to parse and therefore fails every test — loud, not silent.
 *
 * @param {{absPath:string, relPath:string, original:string, mutated:string, id?:string}} plan
 * @param {{fs?:object, dir:string, repoRoot:string}} ctx
 */
export function beginMutation(plan, { fs = nodeFs, dir, repoRoot }) {
  const backupPath = backupPathOf(dir);
  const journalPath = journalPathOf(dir);

  writeDurable(fs, backupPath, plan.original);
  writeDurable(
    fs,
    journalPath,
    `${JSON.stringify(
      {
        version: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        id: plan.id ?? null,
        relPath: plan.relPath,
        absPath: plan.absPath,
        backupPath,
        mutated: plan.mutated,
      },
      null,
      2,
    )}\n`,
  );

  // Same inode, no write-tmp-then-rename: a rename breaks inode-watching
  // editors and `bun --watch` in ways that are miserable to debug.
  fs.writeFileSync(plan.absPath, plan.mutated);

  return { ...plan, backupPath, journalPath, dir, repoRoot };
}

/** Preserve bytes we are about to overwrite but did not write ourselves. */
function preserveConflict(fs, dir, relPath, content) {
  const safe = relPath.replace(/[^a-zA-Z0-9]+/g, "-");
  const path = join(dir, `conflict-${Date.now()}-${safe}`);
  fs.writeFileSync(path, content);
  return path;
}

/**
 * Take the mutant off disk and clear the journal.
 *
 * Verifies before restoring. If the on-disk bytes are no longer the mutant,
 * something else wrote the file during the test run. Blind-restoring would
 * silently destroy that edit, so the foreign content is preserved to
 * `conflict-*` and the run is failed — losing someone's work quietly is worse
 * than failing a push.
 */
export function endMutation(active, { fs = nodeFs } = {}) {
  const { absPath, original, mutated, journalPath, dir, relPath } = active;
  const onDisk = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null;

  let conflict = false;
  if (onDisk !== null && onDisk !== mutated && onDisk !== original) {
    preserveConflict(fs, dir, relPath, onDisk);
    conflict = true;
  }

  const restored = onDisk !== original;
  if (restored) fs.writeFileSync(absPath, original);
  if (fs.existsSync(journalPath)) fs.rmSync(journalPath, { force: true });

  return { restored, conflict };
}

/**
 * Restore whatever a previous crashed run left behind. Idempotent, and free in
 * the overwhelmingly common case: one `existsSync` and nothing else.
 *
 * Runs first in every gate invocation, and — because a surviving mutant passes
 * every other gate in the repo — also first in `.husky/pre-commit`, where it
 * aborts the commit rather than merely fixing the tree. That is the only thing
 * standing between a crashed run and a mutant in git history.
 *
 * @returns {{swept: string[], conflicted: string[], journalFound: boolean}}
 */
export function sweep({ fs = nodeFs, dir }) {
  const journalPath = journalPathOf(dir);
  if (!fs.existsSync(journalPath)) return { swept: [], conflicted: [], journalFound: false };

  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch {
    // A torn journal (power loss mid-write) means the mutant write never
    // happened — the ordering guarantees it. Clear it and carry on.
    fs.rmSync(journalPath, { force: true });
    return { swept: [], conflicted: [], journalFound: true };
  }

  const swept = [];
  const conflicted = [];
  const original = fs.existsSync(journal.backupPath)
    ? fs.readFileSync(journal.backupPath, "utf8")
    : null;
  const onDisk = fs.existsSync(journal.absPath) ? fs.readFileSync(journal.absPath, "utf8") : null;

  if (original !== null && onDisk !== null && onDisk !== original) {
    if (onDisk !== journal.mutated) {
      preserveConflict(fs, dir, journal.relPath, onDisk);
      conflicted.push(journal.relPath);
    }
    fs.writeFileSync(journal.absPath, original);
    swept.push(journal.relPath);
  }

  fs.rmSync(journalPath, { force: true });
  return { swept, conflicted, journalFound: true };
}

/**
 * Wire process death to a restore.
 *
 * The restore MUST be synchronous: `process.on("exit")` cannot await, so a
 * restore scheduled on a later tick never runs and is indistinguishable from no
 * handler at all. Covers Ctrl+C, SIGTERM, terminal close and thrown exceptions;
 * SIGKILL, the OOM killer and power loss are covered by `sweep` instead, which
 * is why both exist.
 */
export function installCrashHandlers(getActive, ctx, proc = process) {
  const restore = () => {
    const active = getActive();
    if (!active) return;
    try {
      endMutation(active, ctx);
    } catch {
      // Nothing useful to do while dying; the journal survives and the next
      // sweep — at the next gate run or the next commit — will finish the job.
    }
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    proc.on(signal, () => {
      restore();
      proc.exit(130);
    });
  }
  proc.on("uncaughtException", (err) => {
    restore();
    console.error(err);
    proc.exit(1);
  });
  proc.on("exit", restore);
}
