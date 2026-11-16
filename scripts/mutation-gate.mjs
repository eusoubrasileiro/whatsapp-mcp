#!/usr/bin/env node
/**
 * mutation-gate.mjs — diff-scoped mutation testing at pre-push.
 *
 * WHY THIS EXISTS. Every other gate in this repo measures whether code RAN,
 * compiles, or looks right. None measures whether a test ASSERTS. An agent that
 * writes `expect(result).toBeDefined()` raises coverage, raises
 * `testAssertions`, passes `tsc`, passes biome and passes `pnpm test:e2e`. That
 * is the default failure mode of a stochastic code generator and the harness was
 * blind to it. Mutation testing is the only mechanical check that fails such a
 * test: it breaks one character of production code and asks whether any test
 * notices. It cannot be satisfied by an assertion that observes nothing.
 *
 * The two defects this found on its first real run — `inbox-store.ts:46` and
 * `deal-stage.ts:277` — were both at 100% line coverage with both branches
 * executing. Coverage could not have found either one.
 *
 * BINARY, NOT A SCORE. Any survivor fails the push. A mutation SCORE would be a
 * number to ratchet, and a ratcheted score is satisfiable by deleting code —
 * which is why Uncle Bob shipped a hard site-count threshold in `swarm-forge`
 * and reverted it the same day. A count is a hint; the gate is "did anything
 * survive on the lines you just changed".
 *
 * NOBODY READS THE OUTPUT. Survivors go to stderr, inside the fix loop
 * `scripts/agent-prompt.md` §6 already contracts, addressed to the agent that
 * caused them. An audit report a human has to read is not a gate — it is a
 * backlog.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitCleanEnv, shQuote } from "./lib/exec.mjs";
import {
  beginMutation,
  endMutation,
  installCrashHandlers,
  sweep as sweepMutations,
} from "./lib/mutation-safety.mjs";
import { readState, STATE_VERSION, selectMutants, withIds } from "./lib/mutation-select.mjs";
import { applySite, enumerateSites, isMutablePath, MUTATE_ROOT } from "./lib/mutation-sites.mjs";
import { changedLinesByFile, getPushRange } from "./lib/push-range.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULTS = {
  max: 15,
  /** Whole-run ceiling. Checked BETWEEN mutants — never abandon a mutated file. */
  deadlineMs: 300_000,
  /**
   * Per-mutant ceiling. Without it an infinite-loop mutant (`i < n` → `i <= n`
   * in a loop condition) hangs the push forever, which is the most likely way
   * this gate first misbehaves in production.
   */
  perMutantMs: 90_000,
  /**
   * Three actionable findings is already more than an agent can usefully fix in
   * one round, and `MAX_FIX_ROUNDS` is 3 — a fourth is noise, not information.
   */
  maxSurvivors: 3,
};

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** The `safeExec` shape: stdout, "" on failure, never throws. */
function safeExec(cmd, cwd = REPO_ROOT) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      // `cwd` alone does not aim git at `cwd` — see gitCleanEnv().
      env: gitCleanEnv(),
    });
  } catch (err) {
    return err.stdout?.toString() ?? "";
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    since: null,
    max: DEFAULTS.max,
    deadlineMs: DEFAULTS.deadlineMs,
    dryRun: false,
    sweepOnly: false,
    only: null,
    json: false,
    noState: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--since":
        opts.since = next();
        break;
      case "--max":
        opts.max = Number(next());
        break;
      case "--timeout":
        opts.deadlineMs = Number(next()) * 1000;
        break;
      case "--only":
        // Accumulate, never assign. A blocked run prints one
        // `reproduce: pnpm mutate --only <id>` line PER survivor, so the natural
        // way to re-check several is to paste each line's flag. Assigning made the
        // last `--only` win silently: the run tested one mutant, found it killed,
        // and reported "0 survivors" — a clean bill of health for mutants it never
        // ran. Same family as a metric whose rule is off reporting a confident 0.
        opts.only = [...(opts.only ?? []), ...next().split(",").filter(Boolean)];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--sweep":
        opts.sweepOnly = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--no-state":
        opts.noState = true;
        break;
      default:
        // Never ignore an unknown flag. A typo'd `--drynrun` that silently ran
        // the real thing would mutate a tree somebody believed was untouched.
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.max) || opts.max < 1)
    throw new Error("--max must be a positive number");
  return opts;
}

/**
 * Verdict from the two test phases.
 *
 * The two error directions are NOT symmetric. A false SURVIVED wrongly blocks a
 * push — the expensive failure, and why phase B exists: `vitest related`
 * resolves the static module graph and misses tests that reach the mutant
 * through a dynamic import, so a phase-A survivor is escalated to the full
 * suite rather than reported. A false KILLED only weakens the gate silently,
 * which is why timeouts and load errors are labelled rather than merged into
 * "killed".
 */
export function classifyRun(phaseA, phaseB) {
  if (phaseA.timedOut || phaseB?.timedOut) return "killed-by-timeout";
  if (phaseA.status !== 0) return "killed";
  if (!phaseB) return "not-run";
  if (phaseB.status !== 0) return "killed";
  return "survived";
}

export function runTests(command, cwd, timeoutMs) {
  const started = Date.now();
  const result = spawnSync("sh", ["-c", command], {
    cwd,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // vitest spawns worker forks. Without a detached group, killing the shell
    // on timeout orphans them and they accumulate across a 15-mutant run.
    detached: true,
  });
  // The timeout SIGKILLs `sh` alone. The group is what reaches pnpm → vitest
  // and its fork workers — always, since a phase that exits can leave stragglers
  // too. ESRCH (nothing left) is the normal case.
  if (result.pid > 0) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {}
  }
  return {
    status: result.status ?? 1,
    timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL",
    ms: Date.now() - started,
  };
}

// ── preconditions ───────────────────────────────────────────────────────────

/**
 * Refuse to run when a file we would mutate has uncommitted changes.
 *
 * A HARD FAIL, not a skip. A skip-on-dirty is an escape hatch: `touch
 * src/x.ts` would silently disable a gate specified to have none. It
 * also makes post-crash detection unambiguous — any dirt under MUTATE_ROOT is
 * by definition ours — and stops a restore from ever clobbering real work.
 *
 * In practice pre-push follows a commit, so this almost never fires.
 */
export function assertCleanTargets(files, exec = safeExec) {
  const dirty = exec(`git status --porcelain -- ${MUTATE_ROOT}`)
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .filter((f) => files.includes(f));
  if (dirty.length === 0) return;
  throw new Error(
    `uncommitted changes in ${dirty.length} file(s) this push would mutate:\n` +
      `${dirty.map((f) => `  ${f}`).join("\n")}\n\n` +
      "Commit or stash them first. The gate edits these files in place and\n" +
      "restores them afterwards; it will not run over work it could destroy.",
  );
}

// ── the run ─────────────────────────────────────────────────────────────────

function collectSites(range, repoRoot, exec) {
  const files = exec(`git diff --name-only ${range}`)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isMutablePath)
    .filter((f) => existsSync(join(repoRoot, f)));

  if (files.length === 0) return { files, sites: [] };

  const byFile = changedLinesByFile(range, files, exec);
  const sites = [];
  for (const file of files) {
    const allowed = byFile.get(file);
    if (!allowed) continue; // deletions only: nothing new to mutate
    const text = readFileSync(join(repoRoot, file), "utf8");
    sites.push(...enumerateSites(file, text, allowed));
  }

  // A commit yielding thousands of sites is not a commit — it is a reformat, a
  // generated file, or a vendored blob that landed under MUTATE_ROOT. Cap the
  // enumeration rather than spending the budget on it.
  if (sites.length > 2000) sites.length = 2000;

  return { files, sites: withIds(sites) };
}

function render(result) {
  const { survivors, counts, range, durationMs, vanished } = result;
  const lines = [];
  const bar = "━".repeat(76);

  if (survivors.length === 0) {
    return null;
  }

  lines.push("");
  lines.push(`${RED}${bar}${RESET}`);
  lines.push(
    `${RED}  MUTATION GATE — ${survivors.length} SURVIVOR${survivors.length === 1 ? "" : "S"}${RESET}`,
  );
  lines.push(`${RED}${bar}${RESET}`);
  lines.push("");
  lines.push("A mutant SURVIVED: production code was deliberately changed and every");
  lines.push("test still passed. That behaviour is not asserted anywhere.");
  lines.push("");
  lines.push(`${DIM}  scope   ${MUTATE_ROOT} in ${range}${RESET}`);
  lines.push(
    `${DIM}  sites   ${counts.sites} diff-scoped · ${counts.selected} run · ` +
      `${counts.killed} killed · ${counts.survived} SURVIVED · ${counts.notRun} not run${RESET}`,
  );
  lines.push(`${DIM}  time    ${Math.round(durationMs / 1000)}s${RESET}`);
  lines.push("");

  survivors.forEach((m, i) => {
    lines.push(`${RED}[${i + 1}] SURVIVED${RESET}  ${m.id}  ${DIM}(${m.operator})${RESET}`);
    lines.push(`    ${m.file}:${m.line}`);
    lines.push(`      ${RED}-${RESET}  ${m.context}`);
    lines.push(`      ${RED}+${RESET}  ${applyToContext(m)}`);
    lines.push(`    ${DIM}reproduce:  pnpm mutate --only ${m.id}${RESET}`);
    lines.push("");
  });

  if (vanished.length > 0) {
    // Not a block. The obligation was "prove this behaviour is asserted"; if the
    // code is gone the obligation is discharged. Reported because deleting the
    // line IS a route around the gate, and the push reviewer should see it.
    lines.push(
      `${YELLOW}  ${vanished.length} previously-tracked mutant(s) no longer exist ` +
        `(the code they mutated changed): ${vanished.join(", ")}${RESET}`,
    );
    lines.push("");
  }

  lines.push("HOW TO FIX");
  lines.push("  Add or strengthen a test so it FAILS on the mutated line and PASSES on");
  lines.push("  the original. The same mutants are re-tested on your next push.");
  lines.push("");
  lines.push("DO NOT");
  lines.push("  - add an assertion that does not distinguish the mutant.");
  lines.push("    `expect(fn).toHaveBeenCalled()` passes for both — it proves nothing.");
  lines.push("  - delete or rewrite the source line to make the mutant disappear,");
  lines.push("    unless the code is genuinely dead. The push reviewer sees the diff.");
  lines.push("  - weaken, skip or bypass this gate.");
  lines.push("");
  lines.push(`${DIM}  machine-readable: .quality-gate/mutation/report.json${RESET}`);
  lines.push(`${RED}${bar}${RESET}`);
  lines.push("");
  return lines.join("\n");
}

/** Best-effort rendering of the mutated line for the report. */
function applyToContext(m) {
  const idx = m.context.indexOf(m.original);
  if (idx < 0) return `${m.context}   ${DIM}(${m.original} → ${m.mutated})${RESET}`;
  return m.context.slice(0, idx) + m.mutated + m.context.slice(idx + m.original.length);
}

/**
 * Restore anything a previous crashed run left behind, loudly.
 *
 * ALWAYS the first thing any invocation does. Returns true when it had to do
 * something, which is what makes `--sweep` usable as a commit tripwire.
 */
function reportSweep(mutationDir, err) {
  const swept = sweepMutations({ dir: mutationDir });
  if (swept.swept.length > 0) {
    err(
      `${YELLOW}[mutation-gate] recovered from an interrupted run: restored ` +
        `${swept.swept.join(", ")}${RESET}`,
    );
  }
  if (swept.conflicted.length > 0) {
    err(
      `${RED}[mutation-gate] ${swept.conflicted.join(", ")} had unexpected content; ` +
        `it was preserved under .quality-gate/mutation/ and the original restored${RESET}`,
    );
  }
  return swept.swept.length > 0 || swept.conflicted.length > 0;
}

/** `--dry-run`: what would this block me on? Zero writes, zero spawns. */
function printDryRun({ log, range, allSites, selected, dropped }) {
  log(`[mutation-gate] ${range}`);
  log(`[mutation-gate] ${allSites.length} sites, ${selected.length} selected, ${dropped} dropped`);
  for (const s of selected) {
    log(`  ${s.id}  ${s.operator.padEnd(12)} ${s.file}:${s.line}  ${s.original} -> ${s.mutated}`);
  }
}

/**
 * Put ONE mutant on disk, run the two phases, and take it off again.
 *
 * The restore is in a `finally` and the conflict is RAISED AFTER it: throwing
 * inside `finally` would discard whatever the `try` was already failing with,
 * which is exactly the diagnosis you would want to keep.
 */
function runOneMutant(site, { repoRoot, mutationDir, commands, setActive }) {
  const absPath = join(repoRoot, site.file);
  const original = readFileSync(absPath, "utf8");
  const active = beginMutation(
    { absPath, relPath: site.file, original, mutated: applySite(original, site), id: site.id },
    { dir: mutationDir, repoRoot },
  );
  setActive(active);

  let phaseA;
  let phaseB = null;
  let conflict = false;
  try {
    phaseA = runTests(commands.related(site.file), repoRoot, DEFAULTS.perMutantMs);
    // Phase B only when phase A found nothing. This is the entire speed
    // argument: the common case never pays for a full-suite run.
    if (phaseA.status === 0 && !phaseA.timedOut) {
      phaseB = runTests(commands.full(), repoRoot, DEFAULTS.perMutantMs);
    }
  } finally {
    conflict = endMutation(active, {}).conflict;
    setActive(null);
  }

  if (conflict) {
    throw new Error(
      `${site.file} was modified by something else while the gate was running.\n` +
        "Its content was preserved under .quality-gate/mutation/ and the committed\n" +
        "version restored. Stop any running dev server and re-run.",
    );
  }
  return { verdict: classifyRun(phaseA, phaseB), phaseA, phaseB };
}

/**
 * Run the selected mutants, strictly serially.
 *
 * ONE mutated file on disk at any instant. Never batched: the blast radius of a
 * crash is then exactly one file, the journal has exactly one entry, and the
 * sweep is trivially correct.
 *
 * The deadline is checked BETWEEN mutants and never mid-mutant — abandoning a
 * mutated file to a timer is precisely the state this whole design exists to
 * avoid. Mutants past the deadline are reported `not-run`, which never blocks;
 * a survivor found before it still does.
 */
function runMutants(selected, { repoRoot, mutationDir, commands, err, deadline }) {
  let active = null;
  installCrashHandlers(() => active, { dir: mutationDir, repoRoot });

  const results = [];
  const survivors = [];

  for (const site of selected) {
    const overDeadline = Date.now() > deadline;
    if (overDeadline || survivors.length >= DEFAULTS.maxSurvivors) {
      results.push({
        ...site,
        verdict: "not-run",
        reason: overDeadline ? "deadline" : "survivor-cap",
      });
      continue;
    }

    const { verdict, phaseA, phaseB } = runOneMutant(site, {
      repoRoot,
      mutationDir,
      commands,
      setActive: (a) => {
        active = a;
      },
    });

    const record = { ...site, verdict, phaseA, phaseB };
    results.push(record);
    if (verdict === "survived") survivors.push(record);
    err(
      `${DIM}[mutation-gate] ${site.id} ${site.file}:${site.line} ${site.original}->${site.mutated} ` +
        `${verdict === "survived" ? `${RED}SURVIVED${RESET}` : verdict}${RESET}`,
    );
  }

  return { results, survivors };
}

/**
 * The two test phases, as shell commands.
 *
 * Phase A is `vitest related`: it resolves the static module graph and runs only
 * the tests that import the mutated file. Fast, but it can UNDER-select (a test
 * reaching the mutant through a dynamic import is missed), and under-selection
 * would produce a false SURVIVED — a wrongly blocked push, the expensive error.
 * So phase A can only ever KILL. Anything that survives it escalates to phase B,
 * the full suite, which is definitive at ~20s.
 *
 * Injectable so the gate's own self-referential test can drive the real
 * orchestration — mutation, journal, spawn, exit codes, restore — without
 * booting the product's vitest.
 */
/**
 * LOCALIZE (3): the package filter is a project fact. See the LOCALIZE banner in
 * `lib/mutation-sites.mjs` for the other two knobs (`MUTATE_ROOT`, `EXCLUDED`).
 * Whatever suite you name here must be the one that would notice the mutation —
 * naming a faster, narrower suite buys speed with false SURVIVEDs.
 */
export const VITEST_COMMANDS = {
  related: (file) => `pnpm exec vitest related --run --bail=1 --reporter=dot ${shQuote(file)}`,
  full: () => "pnpm exec vitest run --bail=1 --reporter=dot",
};

export async function runGate(
  opts,
  { log = console.log, err = console.error, commands = VITEST_COMMANDS, repoRoot = REPO_ROOT } = {},
) {
  const started = Date.now();
  // Everything below is relative to `repoRoot`, never to the module's own
  // location. That is what lets the self-referential test drive the REAL
  // orchestration against a throwaway repo — in-process, with no env-var
  // override that an agent could later set to neuter the gate in production.
  const mutationDir = join(repoRoot, ".quality-gate", "mutation");
  const exec = (cmd) => safeExec(cmd, repoRoot);

  const swept = reportSweep(mutationDir, err);
  if (opts.sweepOnly) {
    // Exit non-zero when something WAS swept, so the pre-commit hook aborts.
    // A surviving mutant passes `pnpm test`, `tsc` and biome by definition —
    // this is the only thing between a crashed run and a mutant in git history.
    return swept ? 1 : 0;
  }

  const range = opts.since ? `${opts.since}..HEAD` : getPushRange(process.env, exec);

  const { files, sites: allSites } = collectSites(range, repoRoot, exec);
  if (allSites.length === 0) {
    log(`[mutation-gate] no mutable sites in ${MUTATE_ROOT} for ${range} — skipped`);
    return 0;
  }

  assertCleanTargets(files, exec);

  const branch = exec("git rev-parse --abbrev-ref HEAD").trim();
  const statePath = join(mutationDir, "state.json");
  const previous =
    opts.noState || !existsSync(statePath)
      ? []
      : readState(readFileSync(statePath, "utf8"), branch);

  let { selected, carried, vanished, fresh, dropped } = selectMutants(allSites, previous, opts.max);
  if (opts.only) selected = allSites.filter((s) => opts.only.includes(s.id));

  if (opts.dryRun) {
    printDryRun({ log, range, allSites, selected, dropped });
    return 0;
  }

  const { results, survivors } = runMutants(selected, {
    repoRoot,
    mutationDir,
    commands,
    err,
    deadline: started + opts.deadlineMs,
  });

  // Belt and braces: nothing of ours may remain in the tree.
  const stillDirty = exec(`git status --porcelain -- ${MUTATE_ROOT}`).trim();
  if (stillDirty) {
    throw new Error(
      `${MUTATE_ROOT} is dirty after the run — refusing to exit clean:\n${stillDirty}`,
    );
  }

  const counts = {
    sites: allSites.length,
    selected: selected.length,
    killed: results.filter((r) => r.verdict.startsWith("killed")).length,
    survived: survivors.length,
    notRun: results.filter((r) => r.verdict === "not-run").length,
    dropped,
  };
  const durationMs = Date.now() - started;
  const report = {
    version: 1,
    timestamp: new Date().toISOString(),
    branch,
    range,
    durationMs,
    overall: survivors.length > 0 ? "fail" : "pass",
    counts,
    carried,
    fresh,
    vanished,
    mutants: results.map((r) => ({
      id: r.id,
      file: r.file,
      line: r.line,
      operator: r.operator,
      original: r.original,
      mutated: r.mutated,
      verdict: r.verdict,
      ms: (r.phaseA?.ms ?? 0) + (r.phaseB?.ms ?? 0),
    })),
  };

  mkdirSync(mutationDir, { recursive: true });
  writeFileSync(join(mutationDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    statePath,
    `${JSON.stringify({ version: STATE_VERSION, branch, range, updatedAt: report.timestamp, mutants: report.mutants }, null, 2)}\n`,
  );

  if (opts.json) {
    log(JSON.stringify(report, null, 2));
    return survivors.length > 0 ? 1 : 0;
  }

  const block = render({ survivors, mutants: results, counts, range, durationMs, vanished });
  if (block) {
    err(block);
    return 1;
  }
  log(
    `[mutation-gate] ${counts.selected} mutants, ${counts.killed} killed, 0 survived ` +
      `(${Math.round(durationMs / 1000)}s) — ${MUTATE_ROOT}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runGate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`${RED}[mutation-gate] ${error.message}${RESET}`);
    process.exitCode = 1;
  }
}
