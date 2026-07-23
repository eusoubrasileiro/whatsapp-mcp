#!/usr/bin/env node
/**
 * backfill-review-log-commit.mjs
 *
 * Run from `.husky/post-commit`. Updates the most recent review-log entry
 * whose `commit` field is "(staged)" — written by `security-review.mjs`
 * before the commit existed — with the hash of the commit just made.
 *
 * Lets `show-review-log.mjs` correlate entries by hash on push instead of
 * relying on file-set + timestamp heuristics that miss commits whose
 * staging attempts didn't perfectly match the landed file set.
 *
 * Always exits 0 so a missing log file or a non-staged entry never blocks
 * a commit.
 */

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAllEntries, rewriteAllEntries } from "./lib/review-log.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const entries = loadAllEntries();
if (entries.length === 0) process.exit(0);

let headHash;
try {
  headHash = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
} catch {
  process.exit(0);
}

for (let i = entries.length - 1; i >= 0; i--) {
  if (entries[i].commit === "(staged)") {
    entries[i].commit = headHash;
    rewriteAllEntries(entries);
    break;
  }
}
