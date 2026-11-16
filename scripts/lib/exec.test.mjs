/**
 * Tests for `run()` — the shared command runner every quality-gate collector
 * measures through.
 *
 * The property under test: a measurement that could not be taken must never
 * come back as a number. `run()` deliberately swallows a non-zero exit and
 * returns whatever landed on stdout, because the collectors' greps are written
 * `... || true` and exit 1 on no match. That tolerance used to extend to output
 * TRUNCATION too, which is a different thing entirely: on maxBuffer overflow
 * Node throws ENOBUFS carrying a truncated `err.stdout`, the catch returned it,
 * and `collectTestAssertions` counted the truncated lines. The ratchet then read
 * a false "test assertions decreased" regression (fixed once by raising
 * maxBuffer in a5752ae — which moved the ceiling but left the silence).
 *
 * Run: `node --test scripts/lib/exec.test.mjs`
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { run, shQuote } from "./exec.mjs";

test("returns stdout for a command that succeeds", () => {
  assert.equal(run("echo hello").trim(), "hello");
});

test("returns partial stdout for a command that exits non-zero", () => {
  // The `|| true`-style collectors depend on this: `grep` exits 1 when it
  // matches nothing, and that is a legitimate measurement of zero, not a
  // failure. This must not regress into a throw.
  assert.equal(run("echo partial; exit 1").trim(), "partial");
});

test("throws on ENOBUFS instead of returning a truncated buffer", () => {
  // Driven with a tiny maxBuffer so the overflow is instant; the production
  // default is 20MB. Without the rethrow this returns ~64KB of `y` and the
  // caller counts it as if the command had finished.
  assert.throws(
    () => run("yes truncated-measurement", { maxBuffer: 1024 }),
    /ENOBUFS|exceeded/i,
    "an overflowing command must fail loudly, not report a partial count",
  );
});

test("shQuote survives a real shell round-trip for hostile filenames", () => {
  // Asserted against `sh` itself, not against the expected string. The point of
  // quoting is what the SHELL does with it, and a hand-written expectation can
  // agree with a wrong implementation. Each name goes out through `printf %s`
  // and must come back byte-identical.
  const names = [
    "backend/src/plain.ts",
    "backend/src/it's.ts", // the realistic one: an apostrophe, no attacker
    "backend/src/a b.ts",
    'backend/src/say "hi".ts',
    "backend/src/$HOME.ts",
    "backend/src/`whoami`.ts",
    "backend/src/a;b.ts",
    "backend/src/a\\b.ts",
    "backend/src/a$(id).ts",
  ];
  for (const name of names) {
    assert.equal(run(`printf %s ${shQuote(name)}`), name, `mangled: ${name}`);
  }
});

test("shQuote neutralises an embedded command instead of running it", () => {
  // The injection shape the push reviewer flagged. If quoting were naive this
  // echoes "pwned"; correctly quoted the whole thing is one literal argument.
  const hostile = "a'; echo pwned; '.ts";
  assert.equal(run(`printf %s ${shQuote(hostile)}`), hostile);
  assert.ok(!run(`printf %s ${shQuote(hostile)}`).includes("pwned\n"));
});
