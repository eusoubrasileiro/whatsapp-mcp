import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCleanTargets,
  classifyRun,
  DEFAULTS,
  parseArgs,
  runGate,
  runTests,
} from "./mutation-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * A copy of the environment with every GIT_* variable removed.
 *
 * Git exports GIT_DIR and GIT_INDEX_FILE into every hook subprocess, and they
 * OVERRIDE `cwd:` — so a `git` call that reads as "operate on this temp dir"
 * silently operates on the repository the hook is running in. Any test here
 * that shells out to git against a scratch repo MUST go through this, or it
 * writes to the real branch the moment `pnpm test:scripts` runs from
 * .husky/pre-push. That is not hypothetical: it put six junk commits on this
 * very branch before the regression test at the bottom of this file existed.
 */
function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

const FIXTURE = join(HERE, "lib", "__fixtures__", "mutation");

// ── parseArgs ───────────────────────────────────────────────────────────────

test("parses every flag", () => {
  const o = parseArgs([
    "--since",
    "main",
    "--max",
    "3",
    "--timeout",
    "60",
    "--only",
    "a,b",
    "--dry-run",
    "--json",
    "--no-state",
  ]);
  assert.equal(o.since, "main");
  assert.equal(o.max, 3);
  assert.equal(o.deadlineMs, 60_000);
  assert.deepEqual(o.only, ["a", "b"]);
  assert.equal(o.dryRun, true);
  assert.equal(o.json, true);
  assert.equal(o.noState, true);
});

// A blocked run prints ONE `reproduce: pnpm mutate --only <id>` line per survivor,
// so the obvious way to re-check two survivors is to paste both lines' flags. If
// `--only` overwrote instead of accumulating, that command would silently test the
// LAST id alone and then report "0 survivors" — the gate telling you it is clean
// about a mutant it never ran. Accumulating is what makes the printed hint safe to
// copy, so the hint's own shape is pinned here too.
test("--only accumulates across repeats, so pasted reproduce hints all run", () => {
  assert.deepEqual(parseArgs(["--only", "m3", "--only", "m7"]).only, ["m3", "m7"]);
  assert.deepEqual(parseArgs(["--only", "m3,m7", "--only", "m9"]).only, ["m3", "m7", "m9"]);
  assert.deepEqual(parseArgs(["--only", "m3"]).only, ["m3"]);
  assert.equal(parseArgs([]).only, null);
});

test("defaults match the ratified budget", () => {
  const o = parseArgs([]);
  assert.equal(o.max, 15);
  assert.equal(o.deadlineMs, 300_000);
  assert.equal(o.dryRun, false);
});

test("an UNKNOWN flag fails loudly instead of being ignored", () => {
  // A typo'd `--drynrun` that silently ran the real thing would mutate a tree
  // somebody believed was untouched.
  assert.throws(() => parseArgs(["--drynrun"]), /unknown option/);
  assert.throws(() => parseArgs(["--since"]), /needs a value/);
  assert.throws(() => parseArgs(["--max", "0"]), /positive/);
});

// ── classifyRun ─────────────────────────────────────────────────────────────

test("a phase-A failure is a kill and phase B is never needed", () => {
  assert.equal(classifyRun({ status: 1 }, null), "killed");
});

test("phase A passing but phase B failing is still a kill", () => {
  // The whole reason phase B exists: `vitest related` under-selects on dynamic
  // imports, and calling that a SURVIVOR would wrongly block a push.
  assert.equal(classifyRun({ status: 0 }, { status: 1 }), "killed");
});

test("only both phases passing is a survivor", () => {
  assert.equal(classifyRun({ status: 0 }, { status: 0 }), "survived");
});

test("a timeout is labelled, not silently counted as a kill", () => {
  // An infinite-loop mutant proves nothing. Merging it into "killed" inflates
  // the kill rate, which is a gate getting quietly weaker.
  assert.equal(classifyRun({ status: 1, timedOut: true }, null), "killed-by-timeout");
  assert.equal(classifyRun({ status: 0 }, { status: 1, timedOut: true }), "killed-by-timeout");
});

test("a mutant whose phase B never ran is not-run, never a survivor", () => {
  assert.equal(classifyRun({ status: 0 }, null), "not-run");
});

// ── assertCleanTargets ──────────────────────────────────────────────────────

test("a dirty target file HARD FAILS — a skip would be an escape hatch", () => {
  // `touch backend/src/x.ts` must not be a way to silently disable a gate
  // specified to have none.
  const exec = () => " M backend/src/services/a.ts\n";
  assert.throws(
    () => assertCleanTargets(["backend/src/services/a.ts"], exec),
    /uncommitted changes/,
  );
});

test("dirt in a file this push would NOT mutate is fine", () => {
  const exec = () => " M backend/src/other.ts\n";
  assert.doesNotThrow(() => assertCleanTargets(["backend/src/services/a.ts"], exec));
});

test("a clean tree passes", () => {
  assert.doesNotThrow(() => assertCleanTargets(["backend/src/a.ts"], () => ""));
});

// ── runTests ────────────────────────────────────────────────────────────────

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // a zombie (dead, not yet reaped by init) is not a leak
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0];
    return state !== "Z";
  } catch {
    return false;
  }
}

test("a timed-out phase leaves none of its processes running", () => {
  // Regression: the timeout SIGKILLed only `sh`. pnpm → vitest and its fork
  // workers outlived it, one 2–3 GB pool per timed-out mutant, and on
  // 2026-10-12 six orphaned workers took a 32 GB machine out of memory.
  // `sh` → `sleep` stands in for pnpm → vitest.
  const dir = mkdtempSync(join(tmpdir(), "mutation-run-"));
  const pidFile = join(dir, "grandchild.pid");
  let grandchild;
  try {
    const run = runTests(`sleep 300 & echo $! > "${pidFile}"; wait`, dir, 500);
    assert.equal(run.timedOut, true);
    grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.ok(grandchild > 1);
    // allow init a moment to reap
    for (let i = 0; i < 20 && alive(grandchild); i++) {
      execFileSync("sleep", ["0.1"]);
    }
    assert.equal(alive(grandchild), false, `grandchild ${grandchild} outlived the timeout`);
  } finally {
    if (grandchild) {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the self-referential test ───────────────────────────────────────────────

/**
 * Build a throwaway git repo containing the fixture and run the REAL `runGate`
 * against it, with the vitest commands swapped for the fixture's checker.
 *
 * Everything above this point tests a component against a fake. This is the only
 * test that proves the ASSEMBLED gate detects a survivor: real git, real diff
 * scoping, real AST enumeration, real file mutation, real `spawnSync`, real exit
 * codes, real restore. Without it, a gate that enumerates zero sites, or spawns
 * the runner wrong, or misreads an exit code, reports a cheerful PASS forever
 * and nobody ever notices — which is precisely the failure this whole gate
 * exists to catch, turned on itself.
 *
 * The seam is a `commands` dependency, not an environment variable. An env var
 * that overrode the test command would be a bypass: an agent could set it to
 * `true` and neuter the gate in production.
 */
function buildFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "mutation-gate-e2e-"));
  const srcDir = join(root, "src");
  execFileSync("mkdir", ["-p", srcDir, join(root, "check")]);

  // The mutable copy sits under MUTATE_ROOT ("src/"); the checker is pointed at
  // it explicitly through SRC.
  const windowSrc = readFileSync(join(FIXTURE, "src", "window.ts"), "utf8");
  writeFileSync(join(srcDir, "window.ts"), windowSrc);
  cpSync(join(FIXTURE, "test", "check.mjs"), join(root, "check", "check.mjs"));

  // Mirrors the real repo, so "the tree must be pristine" can stay a strict
  // equality rather than a filtered one that could hide a real stray file.
  writeFileSync(join(root, ".gitignore"), ".quality-gate/\n");

  // `cwd` alone does not aim git at the fixture — see gitEnv() above.
  const cleanEnv = gitEnv();
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", env: cleanEnv });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv,
  }).trim();

  // A second commit that TOUCHES the window line, so diff scoping admits it —
  // exercising the real `git diff -U0` path rather than mutating the whole file.
  writeFileSync(join(srcDir, "window.ts"), windowSrc.replace("return elapsed", "return  elapsed"));
  git("add", "-A");
  git("commit", "-qm", "touch the window");

  return { root, base, srcDir };
}

/** The fixture's checker, reading whatever bytes the gate wrote. */
function fixtureCommands(root, strength) {
  const check = `MUTATION_FIXTURE_STRENGTH=${strength} SRC=${join(root, "src", "window.ts")} node ${join(root, "check", "check.mjs")}`;
  return { related: () => check, full: () => check };
}

async function runOnFixture(strength, opts = {}) {
  const { root, base } = buildFixtureRepo();
  const out = [];
  const code = await runGate(
    { ...parseArgs([]), since: base, ...opts },
    {
      repoRoot: root,
      commands: fixtureCommands(root, strength),
      log: (m) => out.push(String(m)),
      err: (m) => out.push(String(m)),
    },
  );
  return { code, out: out.join("\n"), root };
}

test("SELF-REFERENTIAL: a WEAK test lets the mutant through and the gate BLOCKS the push", async (t) => {
  // The assertion that matters most in this file. If this can fail, the gate is
  // real; if it cannot, every other test here can be green while the gate is a
  // no-op that passes everything forever.
  const r = await runOnFixture("weak");
  t.after(() => rmSync(r.root, { recursive: true, force: true }));

  assert.equal(r.code, 1, `expected the push to be BLOCKED.\n${r.out}`);
  assert.match(r.out, /SURVIVED/);
  assert.match(r.out, /window\.ts:/);
});

test("SELF-REFERENTIAL: a STRONG test kills the mutant and the push PASSES", async (t) => {
  const r = await runOnFixture("strong");
  t.after(() => rmSync(r.root, { recursive: true, force: true }));

  assert.equal(r.code, 0, `expected the push to PASS.\n${r.out}`);
  assert.match(r.out, /killed/);
  assert.doesNotMatch(r.out, /SURVIVED/);
});

test("SELF-REFERENTIAL: the source is byte-identical afterwards, with no residue", async (t) => {
  const r = await runOnFixture("weak");
  t.after(() => rmSync(r.root, { recursive: true, force: true }));

  const onDisk = readFileSync(join(r.root, "src", "window.ts"), "utf8");
  assert.match(onDisk, /<= 24/, "the ORIGINAL must be back on disk, not the mutant");
  assert.equal(
    existsSync(join(r.root, ".quality-gate", "mutation", "journal.json")),
    false,
    "a journal left behind would make the next run believe it crashed",
  );
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: r.root,
    encoding: "utf8",
    env: gitEnv(), // or this reads the hook's repo, not the fixture's
  });
  assert.equal(status.trim(), "", `tree must be pristine, got:\n${status}`);
});

test("SELF-REFERENTIAL: the run is reproducible — same mutants, same verdicts", async (t) => {
  // Determinism end to end, not just in the sampler's unit test.
  const a = await runOnFixture("weak");
  const b = await runOnFixture("weak");
  t.after(() => {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  });
  const idsOf = (root) =>
    JSON.parse(
      readFileSync(join(root, ".quality-gate", "mutation", "report.json"), "utf8"),
    ).mutants.map((m) => `${m.id}:${m.verdict}`);
  assert.deepEqual(idsOf(a.root), idsOf(b.root));
});

test("SELF-REFERENTIAL: --dry-run enumerates without touching anything", async (t) => {
  const r = await runOnFixture("weak", { dryRun: true });
  t.after(() => rmSync(r.root, { recursive: true, force: true }));

  assert.equal(r.code, 0);
  assert.match(r.out, /relational/, `expected a site listing.\n${r.out}`);
  assert.equal(
    existsSync(join(r.root, ".quality-gate", "mutation", "report.json")),
    false,
    "--dry-run must not write a report",
  );
});

test("the per-mutant and deadline ceilings are set — an infinite-loop mutant cannot hang a push", () => {
  assert.ok(DEFAULTS.perMutantMs > 0 && DEFAULTS.perMutantMs <= 120_000);
  assert.ok(DEFAULTS.deadlineMs > 0 && DEFAULTS.deadlineMs <= 600_000);
  assert.equal(DEFAULTS.maxSurvivors, 3);
});

test("the fixture repo never touches the repository the hook is running in", () => {
  // The regression for the worst bug this gate has had. Git exports GIT_DIR into
  // hook subprocesses and it OVERRIDES `cwd:`, so `pnpm test:scripts` running
  // from .husky/pre-push aimed the fixture's `git init`/`git commit` at the real
  // repository and committed "base" / "touch the window" onto the branch being
  // pushed. Nothing failed; the suite stayed green and the branch silently grew
  // six junk commits.
  //
  // A decoy repo stands in for the real one: GIT_DIR points at it exactly as a
  // hook would, and it must come out byte-identical.
  const decoy = mkdtempSync(join(tmpdir(), "mutation-gate-decoy-"));
  // This helper needs gitEnv() for exactly the reason under test: without it,
  // running under a hook the decoy would itself be built in the real repo.
  const dgit = (...args) =>
    execFileSync("git", args, { cwd: decoy, stdio: "pipe", encoding: "utf8", env: gitEnv() });
  dgit("init", "-q", "-b", "main");
  dgit("config", "user.email", "d@d");
  dgit("config", "user.name", "d");
  writeFileSync(join(decoy, "keep.txt"), "do not touch\n");
  dgit("add", "-A");
  dgit("commit", "-qm", "decoy base");
  const before = dgit("rev-parse", "HEAD").trim();

  const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = join(decoy, ".git");
  process.env.GIT_INDEX_FILE = join(decoy, ".git", "index");
  let fixture;
  try {
    fixture = buildFixtureRepo();
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.dir;
    if (saved.index === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = saved.index;
  }

  assert.equal(dgit("rev-parse", "HEAD").trim(), before, "the hook's repo gained a commit");
  assert.equal(dgit("status", "--porcelain"), "", "the hook's repo working tree was touched");
  assert.equal(dgit("rev-list", "--count", "HEAD").trim(), "1", "extra commits were created");

  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(decoy, { recursive: true, force: true });
});

test("every git invocation in this file is env-guarded", () => {
  // The decoy test above only pins buildFixtureRepo. This pins the discipline:
  // one forgotten `env:` on a future `git` call silently writes to whatever
  // repository the hook is running in, and the suite stays green while it does.
  // Structural because the failure leaves no trace to assert on.
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const calls = self.match(/execFileSync\(\s*"git"[\s\S]*?\}\s*\)/g) ?? [];
  assert.ok(calls.length >= 4, "the matcher stopped finding git calls — fix the matcher");
  for (const call of calls) {
    assert.match(call, /env:\s*(gitEnv\(\)|cleanEnv)/, `unguarded git call:\n${call}`);
  }
});
