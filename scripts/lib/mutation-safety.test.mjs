import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { beginMutation, endMutation, installCrashHandlers, sweep } from "./mutation-safety.mjs";

/** An in-memory fs recording the ORDER of every write. */
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  return {
    writes,
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p);
    },
    writeFileSync: (p, data) => {
      writes.push(p);
      files.set(p, data);
    },
    mkdirSync: () => {},
    rmSync: (p) => {
      writes.push(`rm:${p}`);
      files.delete(p);
    },
  };
}

const ORIGINAL = "export const f = (a, b) => a <= b;\n";
const MUTANT = "export const f = (a, b) => a < b;\n";
const REL = "backend/src/f.ts";
const ABS = "/repo/backend/src/f.ts";
const DIR = "/repo/.quality-gate/mutation";

const ctx = (fs) => ({ fs, dir: DIR, repoRoot: "/repo" });

// ── the durability ordering ─────────────────────────────────────────────────

test("CRITICAL: the backup and journal are written BEFORE the mutant", () => {
  // The whole durability argument is this ordering. If the process dies between
  // the journal write and the mutant write, the sweep restores a file that was
  // never mutated — a harmless no-op. If it dies the other way round, there is
  // a mutated file on disk that nothing knows about.
  //
  // And the file that a crash strands is the DANGEROUS one by construction: a
  // killed mutant makes `pnpm test` fail loudly, but a SURVIVING mutant passes
  // the whole suite, `tsc` and biome by definition. It is silently committable.
  const fs = fakeFs({ [ABS]: ORIGINAL });
  beginMutation({ absPath: ABS, relPath: REL, original: ORIGINAL, mutated: MUTANT }, ctx(fs));

  const mutantWrite = fs.writes.indexOf(ABS);
  const journalWrite = fs.writes.findIndex((p) => p.endsWith("journal.json"));
  const backupWrite = fs.writes.findIndex((p) => p.endsWith(".orig"));

  assert.ok(backupWrite >= 0 && journalWrite >= 0 && mutantWrite >= 0, "all three must be written");
  assert.ok(backupWrite < mutantWrite, "backup must precede the mutant");
  assert.ok(journalWrite < mutantWrite, "journal must precede the mutant");
  assert.equal(fs.files.get(ABS), MUTANT);
});

test("endMutation restores the original and clears the journal", () => {
  const fs = fakeFs({ [ABS]: ORIGINAL });
  const active = beginMutation(
    { absPath: ABS, relPath: REL, original: ORIGINAL, mutated: MUTANT },
    ctx(fs),
  );
  const result = endMutation(active, ctx(fs));

  assert.equal(result.restored, true);
  assert.equal(result.conflict, false);
  assert.equal(fs.files.get(ABS), ORIGINAL);
  assert.equal(fs.existsSync(join(DIR, "journal.json")), false);
});

test("endMutation refuses to blind-restore over FOREIGN content", () => {
  // Something else wrote the file while the tests ran — a save-on-format
  // editor, `bun --watch`, another agent. Losing that edit silently is worse
  // than failing the run, so the foreign bytes are preserved and the run fails.
  const fs = fakeFs({ [ABS]: ORIGINAL });
  const active = beginMutation(
    { absPath: ABS, relPath: REL, original: ORIGINAL, mutated: MUTANT },
    ctx(fs),
  );
  fs.files.set(ABS, "someone else wrote this\n");

  const result = endMutation(active, ctx(fs));

  assert.equal(result.conflict, true);
  assert.equal(fs.files.get(ABS), ORIGINAL, "the committed truth is still restored");
  const preserved = [...fs.files.keys()].find((p) => p.includes("conflict-"));
  assert.ok(preserved, "foreign content must be preserved, never just discarded");
  assert.equal(fs.files.get(preserved), "someone else wrote this\n");
});

// ── the sweep ───────────────────────────────────────────────────────────────

test("sweep with no journal is a silent, write-free no-op", () => {
  // This is the common case and it runs on every pre-commit. It must cost one
  // stat and nothing else.
  const fs = fakeFs({});
  const result = sweep(ctx(fs));
  assert.deepEqual(result, { swept: [], conflicted: [], journalFound: false });
  assert.deepEqual(fs.writes, []);
});

test("sweep restores a mutant a crashed run left on disk", () => {
  const fs = fakeFs({ [ABS]: ORIGINAL });
  beginMutation({ absPath: ABS, relPath: REL, original: ORIGINAL, mutated: MUTANT }, ctx(fs));
  // ...process dies here: journal and backup on disk, mutant in the tree.

  const result = sweep(ctx(fs));

  assert.equal(result.journalFound, true);
  assert.deepEqual(result.swept, [REL]);
  assert.equal(fs.files.get(ABS), ORIGINAL);
  assert.equal(fs.existsSync(join(DIR, "journal.json")), false);
});

test("sweep is idempotent", () => {
  const fs = fakeFs({ [ABS]: ORIGINAL });
  beginMutation({ absPath: ABS, relPath: REL, original: ORIGINAL, mutated: MUTANT }, ctx(fs));
  sweep(ctx(fs));

  const second = sweep(ctx(fs));
  assert.equal(second.journalFound, false);
  assert.equal(fs.files.get(ABS), ORIGINAL);
});

test("sweep on an already-pristine file clears the journal without writing", () => {
  // A signal handler beat the crash: the file is already restored, but the
  // journal was not cleared. Rewriting identical bytes would churn the mtime
  // for nothing.
  const fs = fakeFs({ [ABS]: ORIGINAL });
  const active = beginMutation(
    { absPath: ABS, relPath: REL, original: ORIGINAL, mutated: MUTANT },
    ctx(fs),
  );
  fs.files.set(ABS, ORIGINAL);
  fs.writes.length = 0;

  const result = sweep(ctx(fs));

  assert.equal(result.journalFound, true);
  assert.deepEqual(result.swept, []);
  assert.ok(!fs.writes.includes(ABS), "must not rewrite an already-pristine file");
  assert.equal(fs.existsSync(active.journalPath), false);
});

test("sweep preserves foreign content rather than clobbering it", () => {
  const fs = fakeFs({ [ABS]: ORIGINAL });
  beginMutation({ absPath: ABS, relPath: REL, original: ORIGINAL, mutated: MUTANT }, ctx(fs));
  fs.files.set(ABS, "a human edited this after the crash\n");

  const result = sweep(ctx(fs));

  assert.deepEqual(result.conflicted, [REL]);
  assert.ok([...fs.files.keys()].some((p) => p.includes("conflict-")));
});

test("a corrupt journal does not throw — it reports and moves on", () => {
  // Torn write during a power loss. The gate must still be runnable.
  const fs = fakeFs({ [ABS]: ORIGINAL, [join(DIR, "journal.json")]: "{ truncated" });
  const result = sweep(ctx(fs));
  assert.equal(result.journalFound, true);
  assert.deepEqual(result.swept, []);
  assert.equal(fs.existsSync(join(DIR, "journal.json")), false);
});

// ── crash handlers ──────────────────────────────────────────────────────────

test("a signal handler restores SYNCHRONOUSLY, inside the handler", () => {
  // `process.on("exit")` cannot await. A restore scheduled on a later tick
  // never runs, which is the same as no handler at all.
  const fs = fakeFs({ [ABS]: ORIGINAL });
  const handlers = new Map();
  const fakeProcess = {
    on: (sig, fn) => handlers.set(sig, fn),
    exit: () => {},
  };
  const active = beginMutation(
    { absPath: ABS, relPath: REL, original: ORIGINAL, mutated: MUTANT },
    ctx(fs),
  );

  installCrashHandlers(() => active, ctx(fs), fakeProcess);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "exit"]) {
    assert.ok(handlers.has(sig), `no handler for ${sig}`);
  }

  handlers.get("SIGINT")();
  assert.equal(fs.files.get(ABS), ORIGINAL, "restore must have happened in the handler itself");
});

test("handlers are harmless when no mutation is active", () => {
  const fs = fakeFs({ [ABS]: ORIGINAL });
  const handlers = new Map();
  installCrashHandlers(() => null, ctx(fs), { on: (s, f) => handlers.set(s, f), exit: () => {} });
  handlers.get("exit")();
  assert.deepEqual(fs.writes, []);
});

// ── the one test that uses the real filesystem ──────────────────────────────

test("REAL FS: a hard kill leaves a mutant on disk, and the next sweep removes it", () => {
  // Every other test above runs against a fake. This one proves the recovery
  // works when the process genuinely dies without unwinding — no `finally`, no
  // signal handler, the case that the journal exists for.
  const root = mkdtempSync(join(tmpdir(), "mutation-safety-"));
  try {
    const srcDir = join(root, "backend", "src");
    const file = join(srcDir, "f.ts");
    execFileSync("mkdir", ["-p", srcDir]);
    writeFileSync(file, ORIGINAL);

    const child = `
      import { beginMutation } from ${JSON.stringify(new URL("./mutation-safety.mjs", import.meta.url).href)};
      beginMutation(
        { absPath: ${JSON.stringify(file)}, relPath: "backend/src/f.ts",
          original: ${JSON.stringify(ORIGINAL)}, mutated: ${JSON.stringify(MUTANT)} },
        { dir: ${JSON.stringify(join(root, ".quality-gate", "mutation"))}, repoRoot: ${JSON.stringify(root)} },
      );
      process.kill(process.pid, "SIGKILL");
    `;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", child], { stdio: "pipe" });
    } catch {
      // SIGKILL — expected.
    }

    assert.equal(readFileSync(file, "utf8"), MUTANT, "setup: the child must have left the mutant");

    const result = sweep({ dir: join(root, ".quality-gate", "mutation"), repoRoot: root });

    assert.equal(result.journalFound, true);
    assert.deepEqual(result.swept, ["backend/src/f.ts"]);
    assert.equal(readFileSync(file, "utf8"), ORIGINAL, "the tree must be pristine again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
