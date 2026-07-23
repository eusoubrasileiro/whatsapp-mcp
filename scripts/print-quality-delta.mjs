#!/usr/bin/env node
/**
 * print-quality-delta.mjs
 *
 * Post-commit informational printer. Reads the quality-gate report and the
 * most recent review-log entry, then prints a single human-readable line
 * summarizing what changed. Always exits 0.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLatestEntry } from "./lib/review-log.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const REPORT_PATH = join(repoRoot, ".quality-gate", "report.json");

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const METRIC_LABELS = {
  maxFileLines: "maxLines",
  filesOver500: "filesOver500",
  complexityViolations: "complexity",
  unusedExports: "unusedExports",
  unusedTypes: "unusedTypes",
  unusedFiles: "unusedFiles",
  unusedDependencies: "unusedDeps",
  jscpdClones: "jscpdClones",
  jscpdPercentage: "jscpd%",
  anyCasts: "anyCasts",
  tsSuppressors: "tsSuppress",
  testAssertions: "assertions",
  coverageStatements: "cov.stmts%",
  coverageBranches: "cov.branches%",
  coverageFunctions: "cov.funcs%",
  coverageLines: "cov.lines%",
};

function loadJsonOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function formatDelta(key, info) {
  const label = METRIC_LABELS[key] ?? key;
  const sign = info.diff > 0 ? "+" : "";
  return `${label} ${info.baseline}→${info.current} (${sign}${info.diff})`;
}

function colorForOverall(overall) {
  if (overall === "PASS") return GREEN;
  if (overall === "FAIL") return RED;
  return YELLOW;
}

function colorForVerdict(verdict) {
  if (verdict === "approve") return GREEN;
  if (verdict === "reject") return RED;
  return YELLOW;
}

function main() {
  const report = loadJsonOrNull(REPORT_PATH);
  if (!report) return;

  const overall = report.overall ?? "UNKNOWN";
  const deltas = report.deltas ?? {};
  const changed = Object.entries(deltas)
    .filter(([, info]) => info && typeof info.diff === "number" && info.diff !== 0)
    .map(([key, info]) => formatDelta(key, info));

  const deltaText = changed.length === 0 ? "no changes" : changed.join(", ");
  const overallColor = colorForOverall(overall);

  let line = `${DIM}Quality gate:${RESET} ${overallColor}${overall}${RESET}. ${DIM}Deltas:${RESET} ${deltaText}`;

  const review = loadLatestEntry();
  if (review?.verdict) {
    const verdictColor = colorForVerdict(review.verdict);
    line += ` ${DIM}|${RESET} ${DIM}reviewer:${RESET} ${verdictColor}${review.verdict}${RESET}`;
  }

  process.stdout.write(`${line}\n`);
}

main();
