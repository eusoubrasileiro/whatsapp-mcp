#!/usr/bin/env node
/**
 * Quality Gate Script — whatsapp-mcp (see standards/standards.md §4, typescript.md §6)
 *
 * Measures deterministic code-quality metrics and compares them against the
 * baseline in quality-baseline.json. Exits 0 on pass, 1 on any regression.
 *
 * Usage:
 *   node scripts/quality-gate.mjs              # compare against baseline
 *   node scripts/quality-gate.mjs --update-baseline  # snapshot current state
 *
 * Adapted from standards/templates/typescript/scripts/quality-gate.mjs for a
 * SINGLE-PACKAGE layout: source under src/, tests under src/__tests__/, one
 * coverage/ dir. The template's backend/frontend split is collapsed to one set
 * of metrics (maxFileLines; coverage{Statements,Branches,Functions,Lines}).
 * The drift-attribution machinery is kept verbatim — it is repo-agnostic.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASELINE_FILE = path.join(ROOT, "quality-baseline.json");
const REPORT_DIR = path.join(ROOT, ".quality-gate");
const REPORT_FILE = path.join(REPORT_DIR, "report.json");

const UPDATE_BASELINE = process.argv.includes("--update-baseline");
const NO_ATTRIBUTION = process.argv.includes("--no-attribution");
// Test/escape hatch: compare against an alternate baseline file instead of the
// committed one (never writes to it).
const BASELINE_OVERRIDE = (() => {
  const i = process.argv.indexOf("--baseline");
  return i >= 0 ? process.argv[i + 1] : null;
})();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, { cwd = ROOT, silent = true } = {}) {
  try {
    return execSync(cmd, {
      cwd,
      stdio: silent ? ["pipe", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
    });
  } catch (err) {
    return err.stdout || "";
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Metric collectors ────────────────────────────────────────────────────────

function collectFileSizes(root = ROOT) {
  // Non-test source only: __tests__ files are large by nature and tracked by
  // testAssertions instead, so they must not drive the size ceiling.
  const allFilesOut = run(
    `find src -name '*.ts' -not -path '*/__tests__/*' | xargs wc -l 2>/dev/null`,
    { cwd: root },
  );

  const allLines = allFilesOut.trim().split("\n");
  let filesOver500 = 0;
  let maxFileLines = 0;

  for (const line of allLines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const count = parseInt(parts[0], 10);
    const file = parts[1];
    if (!file || file === "total" || Number.isNaN(count)) continue;
    if (count > 500) filesOver500++;
    if (count > maxFileLines) maxFileLines = count;
  }

  return { maxFileLines, filesOver500 };
}

function collectComplexity(root = ROOT) {
  const output = run(`pnpm exec biome check --reporter=json 2>/dev/null`, { cwd: root });
  try {
    const d = JSON.parse(output);
    const diags = d.diagnostics || [];
    const cc = diags.filter((x) => x.category === "lint/complexity/noExcessiveCognitiveComplexity");
    return { complexityViolations: cc.length };
  } catch {
    return { complexityViolations: 0 };
  }
}

function collectKnip(root = ROOT) {
  // knip 5's `--reporter json` emits { issues: [ {file, exports:[], types:[],
  // dependencies:[], devDependencies:[], files: true|[] }, ... ] } — a FLAT
  // per-file array, NOT the nested shape the upstream template assumed. An
  // entirely-unused file is flagged with `files: true` on its entry.
  const output = run(`pnpm exec knip --reporter json 2>/dev/null`, { cwd: root });
  try {
    const jsonStart = output.indexOf("{");
    if (jsonStart < 0) throw new Error("no json");
    const d = JSON.parse(output.slice(jsonStart));
    const issues = Array.isArray(d.issues) ? d.issues : [];
    const sum = (key) => issues.reduce((acc, f) => acc + (f[key]?.length || 0), 0);
    return {
      unusedExports: sum("exports"),
      unusedTypes: sum("types"),
      unusedFiles: issues.filter((f) => f.files === true).length,
      unusedDependencies: sum("dependencies") + sum("devDependencies"),
    };
  } catch {
    return { unusedExports: 0, unusedTypes: 0, unusedFiles: 0, unusedDependencies: 0 };
  }
}

function collectJscpd(root = ROOT) {
  const reportPath = path.join(root, ".quality-gate", "jscpd", "jscpd-report.json");
  ensureDir(path.join(root, ".quality-gate", "jscpd"));
  run(`pnpm exec jscpd src --reporters json --output .quality-gate/jscpd 2>/dev/null`, {
    cwd: root,
  });
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const clones = report.duplicates?.length ?? 0;
    const percentage = report.statistics?.total?.percentage ?? 0;
    return { jscpdClones: clones, jscpdPercentage: String(percentage.toFixed(2)) };
  } catch {
    return { jscpdClones: 0, jscpdPercentage: "0.00" };
  }
}

function collectAnyCasts(root = ROOT) {
  const output = run(
    `grep -rE "(: any\\b| as any\\b|<any>)" --include='*.ts' src 2>/dev/null || true`,
    { cwd: root },
  );
  const lines = output.trim().split("\n").filter(Boolean);
  return { anyCasts: lines.length };
}

function collectTsSuppressors(root = ROOT) {
  const output = run(
    `grep -rE "@ts-(ignore|expect-error)" --include='*.ts' src 2>/dev/null || true`,
    { cwd: root },
  );
  const lines = output.trim().split("\n").filter(Boolean);
  return { tsSuppressors: lines.length };
}

function collectTestAssertions(root = ROOT) {
  const output = run(
    `grep -rE "\\b(it|test|expect)\\s*\\(" src/__tests__ --include='*.ts' 2>/dev/null || true`,
    { cwd: root },
  );
  const lines = output.trim().split("\n").filter(Boolean);
  return { testAssertions: lines.length };
}

function collectCoverage() {
  const zero = { statements: 0, branches: 0, functions: 0, lines: 0 };
  let total = zero;
  try {
    total = JSON.parse(
      readFileSync(path.join(ROOT, "coverage/coverage-summary.json"), "utf8"),
    ).total;
  } catch {
    total = {
      statements: { pct: 0 },
      branches: { pct: 0 },
      functions: { pct: 0 },
      lines: { pct: 0 },
    };
  }
  return {
    coverageStatements: total.statements.pct,
    coverageBranches: total.branches.pct,
    coverageFunctions: total.functions.pct,
    coverageLines: total.lines.pct,
  };
}

// ─── Collect all metrics ──────────────────────────────────────────────────────

console.log("Collecting metrics...\n");

const metrics = {
  ...collectFileSizes(),
  ...collectComplexity(),
  ...collectKnip(),
  ...collectJscpd(),
  ...collectAnyCasts(),
  ...collectTsSuppressors(),
  ...collectTestAssertions(),
  ...collectCoverage(),
};

// ─── Read/write baseline ──────────────────────────────────────────────────────

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE_FILE, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log("Baseline updated. New floor:");
  for (const [k, v] of Object.entries(metrics)) {
    console.log(`  ${k}: ${v}`);
  }
  process.exit(0);
}

const activeBaselineFile = BASELINE_OVERRIDE ?? BASELINE_FILE;

if (!existsSync(activeBaselineFile)) {
  console.error(
    "No baseline found. Run `pnpm quality-gate:update` first to snapshot the current state.",
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(activeBaselineFile, "utf8"));

// ─── Compare ─────────────────────────────────────────────────────────────────

// Metrics where LOWER is better (regression = current > baseline)
const lowerIsBetter = [
  "maxFileLines",
  "filesOver500",
  "complexityViolations",
  "unusedExports",
  "unusedTypes",
  "unusedFiles",
  "unusedDependencies",
  "jscpdClones",
  "anyCasts",
  "tsSuppressors",
];

// Metrics where HIGHER is better (regression = current < baseline)
const higherIsBetter = [
  "testAssertions",
  "coverageStatements",
  "coverageBranches",
  "coverageFunctions",
  "coverageLines",
];

// Per-metric tolerance (absolute) for noise — drift below this counts as SAME.
// V8 coverage % drifts fractionally across runs; 0.5pp absorbs that.
const tolerance = {
  coverageStatements: 0.5,
  coverageBranches: 0.5,
  coverageFunctions: 0.5,
  coverageLines: 0.5,
};

const metricLabels = {
  maxFileLines: "max file lines",
  filesOver500: "files >500 lines",
  complexityViolations: "complexity violations",
  unusedExports: "unused exports",
  unusedTypes: "unused types",
  unusedFiles: "unused files",
  unusedDependencies: "unused deps",
  jscpdClones: "jscpd clones",
  jscpdPercentage: "jscpd %",
  anyCasts: "any casts",
  tsSuppressors: "ts-suppress",
  testAssertions: "test assertions",
  coverageStatements: "coverage stmts %",
  coverageBranches: "coverage branches %",
  coverageFunctions: "coverage funcs %",
  coverageLines: "coverage lines %",
};

// ─── Drift attribution ─────────────────────────────────────────────────────────
//
// Coverage metrics can't be re-derived without a (costly) test run, so they are
// excluded from attribution and always block. Every other metric is STATIC —
// re-measurable from a checked-out tree with the same tooling — so a regression
// can be asked: was it already present at the merge-base? If so it is
// pre-existing drift (warn, don't block); if introduced here, block.

const COVERAGE_KEYS = new Set([
  "coverageStatements",
  "coverageBranches",
  "coverageFunctions",
  "coverageLines",
]);

const isStatic = (key) => !COVERAGE_KEYS.has(key);

const METRIC_COLLECTORS = {
  maxFileLines: collectFileSizes,
  filesOver500: collectFileSizes,
  complexityViolations: collectComplexity,
  unusedExports: collectKnip,
  unusedTypes: collectKnip,
  unusedFiles: collectKnip,
  unusedDependencies: collectKnip,
  jscpdClones: collectJscpd,
  anyCasts: collectAnyCasts,
  tsSuppressors: collectTsSuppressors,
  testAssertions: collectTestAssertions,
};

function resolveBaseRef() {
  for (const ref of ["origin/main", "main"]) {
    const sha = run(`git merge-base HEAD ${ref}`, { cwd: ROOT }).trim();
    if (sha) return sha;
  }
  return "";
}

function classifyDrift(key, baseVal) {
  if (baseVal === undefined || baseVal === null) return "unknown";
  const baselineRaw = baseline[key];
  const baselineNum = typeof baselineRaw === "string" ? parseFloat(baselineRaw) : baselineRaw;
  const baseNum = typeof baseVal === "string" ? parseFloat(baseVal) : baseVal;
  const currentRaw = metrics[key];
  const currentNum = typeof currentRaw === "string" ? parseFloat(currentRaw) : currentRaw;
  if (Number.isNaN(baseNum) || Number.isNaN(baselineNum) || Number.isNaN(currentNum)) {
    return "unknown";
  }
  const tol = tolerance[key] ?? 0;
  if (lowerIsBetter.includes(key)) {
    const presentAtBase = baseNum > baselineNum + tol;
    if (!presentAtBase) return "introduced";
    return currentNum > baseNum + tol ? "partial" : "preExisting";
  }
  const presentAtBase = baseNum < baselineNum - tol;
  if (!presentAtBase) return "introduced";
  return currentNum < baseNum - tol ? "partial" : "preExisting";
}

function attributeDrift(regressedStaticKeys, baseRef) {
  const results = {};
  const tmp = mkdtempSync(path.join(os.tmpdir(), "qg-base-"));
  const worktree = path.join(tmp, "tree");
  let added = false;
  try {
    run(`git worktree add --detach ${JSON.stringify(worktree)} ${baseRef}`, { cwd: ROOT });
    if (!existsSync(path.join(worktree, "package.json"))) {
      for (const key of regressedStaticKeys) results[key] = "unknown";
      return results;
    }
    added = true;

    // pnpm-exec collectors (biome/knip/jscpd) resolve binaries from
    // node_modules, which a bare worktree lacks. Symlink the installed tree so
    // those collectors run against base source with current tooling. Pure
    // grep/find collectors need none of this.
    try {
      const src = path.join(ROOT, "node_modules");
      const dst = path.join(worktree, "node_modules");
      if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst, "dir");
    } catch {
      // best effort — a failed symlink just leaves its collectors "unknown"
    }

    const cache = new Map();
    const measure = (fn) => {
      if (!cache.has(fn)) {
        try {
          cache.set(fn, fn(worktree));
        } catch {
          cache.set(fn, null);
        }
      }
      return cache.get(fn);
    };

    for (const key of regressedStaticKeys) {
      const fn = METRIC_COLLECTORS[key];
      const measured = fn ? measure(fn) : null;
      const baseVal = measured == null ? undefined : measured[key];
      results[key] = classifyDrift(key, baseVal);
    }
    return results;
  } catch {
    for (const key of regressedStaticKeys) {
      if (results[key] === undefined) results[key] = "unknown";
    }
    return results;
  } finally {
    if (added) run(`git worktree remove --force ${JSON.stringify(worktree)}`, { cwd: ROOT });
    run("git worktree prune", { cwd: ROOT });
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

let regressions = 0;
let improvements = 0;

const deltas = {};

for (const key of [...lowerIsBetter, ...higherIsBetter]) {
  const current = metrics[key];
  const base = baseline[key] ?? current;
  const baseNum = typeof base === "string" ? parseFloat(base) : base;
  const currentNum = typeof current === "string" ? parseFloat(current) : current;
  const diff = currentNum - baseNum;
  const tol = tolerance[key] ?? 0;
  const isLower = lowerIsBetter.includes(key);

  let status;
  if (Math.abs(diff) <= tol) {
    status = "SAME";
  } else if (isLower) {
    if (diff > 0) {
      status = "REGRESSION";
      regressions++;
    } else {
      status = "IMPROVED";
      improvements++;
    }
  } else if (diff < 0) {
    status = "REGRESSION";
    regressions++;
  } else {
    status = "IMPROVED";
    improvements++;
  }

  deltas[key] = { baseline: base, current, diff, status };
}

// ─── Attribute static regressions (only when there are any) ─────────────────────

const regressedKeys = Object.keys(deltas).filter((k) => deltas[k].status === "REGRESSION");
const staticRegressedKeys = regressedKeys.filter(isStatic);

let attribution = null;

if (!NO_ATTRIBUTION && staticRegressedKeys.length > 0) {
  const baseRef = resolveBaseRef();
  const head = run("git rev-parse HEAD", { cwd: ROOT }).trim();
  const clean = run("git status --porcelain", { cwd: ROOT }).trim() === "";
  const skip = !baseRef || (baseRef === head && clean);

  if (!skip) {
    console.log(`\nAttributing static regressions against ${baseRef.slice(0, 12)}...`);
    attribution = { ref: baseRef, results: attributeDrift(staticRegressedKeys, baseRef) };
  }
}

const classificationOf = (key) => attribution?.results?.[key];
const isBlocking = (key) =>
  deltas[key].status === "REGRESSION" &&
  !(isStatic(key) && classificationOf(key) === "preExisting");

const blocking = regressedKeys.filter(isBlocking).length;
const drifted = regressedKeys.filter(
  (k) => isStatic(k) && classificationOf(k) === "preExisting",
).length;

// ─── Print report ─────────────────────────────────────────────────────────────

const overall = blocking > 0 ? "FAIL" : "PASS";

const summary =
  blocking === 0
    ? drifted > 0
      ? `${drifted} pre-existing drift, not blocking`
      : `${improvements} improvement${improvements !== 1 ? "s" : ""}`
    : `${blocking} blocking regression${blocking !== 1 ? "s" : ""}`;

console.log(`Quality gate: ${overall} (${summary})`);

for (const [key, { baseline: base, current, diff, status }] of Object.entries(deltas)) {
  const drift = isStatic(key) && classificationOf(key) === "preExisting";
  const icon = status === "IMPROVED" ? "✓" : status === "REGRESSION" ? (drift ? "~" : "✗") : "=";
  const label = metricLabels[key] ?? key;
  const diffStr =
    diff === 0
      ? ""
      : diff > 0
        ? ` (+${diff}${status === "REGRESSION" ? (drift ? ", drift" : ", REGRESSION") : ", increased"})`
        : ` (${diff}${status === "IMPROVED" ? ", improved" : drift ? ", drift" : ", decreased"})`;
  const padLabel = label.padEnd(28);
  console.log(`  ${icon} ${padLabel} ${base} → ${current}${diffStr}`);
}

// ─── Pre-existing drift warning block ───────────────────────────────────────────

if (attribution) {
  const driftKeys = staticRegressedKeys.filter((k) => attribution.results[k] === "preExisting");
  const partialKeys = staticRegressedKeys.filter((k) => attribution.results[k] === "partial");

  if (driftKeys.length > 0) {
    console.log(
      `\n⚠  Pre-existing drift (present at ${attribution.ref.slice(0, 12)}) — not caused by this change:`,
    );
    for (const k of driftKeys) console.log(`     - ${metricLabels[k] ?? k}`);
    console.log(
      "   To reconcile: get owner approval, then `pnpm quality-gate:update`.\n" +
        "   These do NOT block this run.",
    );
  }
  if (partialKeys.length > 0) {
    console.log(
      `\n✗  Worsened beyond a pre-existing baseline (the delta past ${attribution.ref.slice(0, 12)} is yours):`,
    );
    for (const k of partialKeys) console.log(`     - ${metricLabels[k] ?? k}`);
  }
}

// ─── Write report.json ────────────────────────────────────────────────────────

ensureDir(REPORT_DIR);
writeFileSync(
  REPORT_FILE,
  `${JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      overall,
      regressions,
      improvements,
      metrics,
      baseline,
      deltas,
      ...(attribution ? { attribution } : {}),
    },
    null,
    2,
  )}\n`,
);

process.exit(blocking > 0 ? 1 : 0);
