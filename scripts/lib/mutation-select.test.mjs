import assert from "node:assert/strict";
import { test } from "node:test";
import { mutantId, readState, selectMutants, withIds } from "./mutation-select.mjs";
import { enumerateSites } from "./mutation-sites.mjs";

const SRC = [
  "export function windowOpen(hours: number, limit: number) {",
  "  if (hours <= limit) return true;",
  "  return false;",
  "}",
].join("\n");

const sites = (src = SRC) => withIds(enumerateSites("backend/src/a.ts", src));
const ids = (list) => list.map((s) => s.id);

// ── identity is content-addressed, not line-addressed ───────────────────────

test("the same source yields the same ids", () => {
  assert.deepEqual(ids(sites()), ids(sites()));
});

test("REGRESSION: prepending lines does not change any id", () => {
  // This is the whole design in one test. A fix round adds an import or a
  // helper above the site; every line below shifts. A line-keyed id would make
  // every mutant "vanish" and a fresh set appear, so round 2 would block on a
  // different finding and MAX_FIX_ROUNDS would count noise as three failures.
  const shifted = `import { x } from "./x.js";\n\n\n${SRC}`;
  assert.deepEqual(ids(sites(shifted)), ids(sites()));
});

test("reindentation and comment edits do not change any id", () => {
  const reindented = SRC.split("\n")
    .map((l) => (l.startsWith("  ") ? `    ${l.trim()}` : l))
    .join("\n");
  assert.deepEqual(ids(sites(reindented)), ids(sites()));

  const commented = SRC.replace("  if (hours", "  // a new note\n  if (hours");
  assert.deepEqual(ids(sites(commented)), ids(sites()));
});

test("rewriting the mutated line DOES change its id", () => {
  // Correct: a rewritten line is a different mutant, and the old one vanished.
  const rewritten = SRC.replace("hours <= limit", "elapsedHours <= limit");
  assert.notDeepEqual(ids(sites(rewritten)), ids(sites()));
});

test("BYTE-IDENTICAL lines in one file get distinct ids, stable under insertion", () => {
  // Content addressing alone collides here: same file, same operator, same line
  // text. The ordinal is what separates them, and it must be assigned in
  // enumeration order so that inserting an unrelated line between the two does
  // not renumber them.
  const body = (mid) =>
    ["function f(a, b) {", "  if (a === b) log();", ...mid, "  if (a === b) log();", "}"].join(
      "\n",
    );
  const before = sites(body([]));
  assert.equal(new Set(ids(before)).size, 2, "byte-identical lines collided into one id");
  assert.deepEqual(
    before.map((s) => s.ordinal),
    [0, 1],
  );

  assert.deepEqual(ids(sites(body(["  const q = 2;"]))), ids(before));
});

test("id does not depend on HEAD, the range, or the clock", () => {
  // Seeding on the commit sha is the obvious wrong choice: HEAD changes every
  // fix round by construction, so it re-rolls the sample every round.
  const a = mutantId({
    file: "f.ts",
    operator: "equality",
    original: "===",
    mutated: "!==",
    context: "const a = x === y;",
    ordinal: 0,
  });
  const b = mutantId({
    file: "f.ts",
    operator: "equality",
    original: "===",
    mutated: "!==",
    context: "const a = x === y;",
    ordinal: 0,
  });
  assert.equal(a, b);
});

// ── selection ───────────────────────────────────────────────────────────────

function fakeSites(n) {
  return withIds(
    Array.from({ length: n }, (_, i) => ({
      file: "backend/src/a.ts",
      operator: "equality",
      original: "===",
      mutated: "!==",
      line: i + 1,
      column: 1,
      start: i,
      end: i + 3,
      context: `const v${i} = a === b;`,
    })),
  );
}

test("selects everything when under the cap", () => {
  const { selected, dropped } = selectMutants(fakeSites(4), [], 15);
  assert.equal(selected.length, 4);
  assert.equal(dropped, 0);
});

test("caps the selection and reports what it dropped", () => {
  const { selected, dropped } = selectMutants(fakeSites(40), [], 15);
  assert.equal(selected.length, 15);
  assert.equal(dropped, 25);
});

test("the same site set selects the same mutants every time", () => {
  const all = fakeSites(40);
  assert.deepEqual(
    ids(selectMutants(all, [], 15).selected),
    ids(selectMutants(all, [], 15).selected),
  );
});

test("adding one site perturbs the selected set by at most one element", () => {
  // Hash order, not index order. Under index order, inserting a site at the top
  // of a file shifts the entire selection window and round 2 tests a different
  // 15 mutants than round 1 — the loop never converges.
  const before = new Set(ids(selectMutants(fakeSites(30), [], 15).selected));
  const grown = [...fakeSites(30), ...fakeSites(31).slice(30)];
  const after = new Set(ids(selectMutants(grown, [], 15).selected));
  const lost = [...before].filter((id) => !after.has(id));
  assert.ok(lost.length <= 1, `hash order should be insertion-stable, lost ${lost.length}`);
});

test("CRITICAL: a previously-SURVIVED mutant is always re-selected, however bad its hash", () => {
  // Without this rule a 40-site diff with a cap of 15 can drop the known
  // survivor from round 2's sample, report PASS, and let the push through
  // carrying the exact defect round 1 found. This is the single most dangerous
  // bug this module can have.
  const all = fakeSites(40);
  const unlucky = ids(selectMutants(all, [], 15).selected);
  const outside = all.find((s) => !unlucky.includes(s.id));
  assert.ok(outside, "test setup: needed a site outside the first selection");

  const { selected, carried } = selectMutants(all, [{ id: outside.id, verdict: "survived" }], 15);
  assert.ok(ids(selected).includes(outside.id), "known survivor was dropped from the sample");
  assert.deepEqual(carried, [outside.id]);
  assert.equal(selected.length, 15);
});

test("a previously-killed mutant is re-verified before any fresh one", () => {
  const all = fakeSites(40);
  const outside = all.find((s) => !ids(selectMutants(all, [], 15).selected).includes(s.id));
  const { selected } = selectMutants(all, [{ id: outside.id, verdict: "killed" }], 15);
  assert.ok(ids(selected).includes(outside.id));
});

test("survivors outrank killed mutants when the budget is tight", () => {
  const all = fakeSites(40);
  const previous = all
    .slice(20)
    .map((s, i) => ({ id: s.id, verdict: i === 19 ? "survived" : "killed" }));
  const { selected } = selectMutants(all, previous, 3);
  assert.ok(ids(selected).includes(all[39].id), "the survivor must be first in line");
});

test("classifies resolved, vanished and fresh", () => {
  const all = fakeSites(5);
  const gone = fakeSites(9)[8];
  const previous = [
    { id: all[0].id, verdict: "survived" },
    { id: all[1].id, verdict: "killed" },
    { id: gone.id, verdict: "survived" },
  ];
  const { carried, vanished, fresh } = selectMutants(all, previous, 15);

  assert.deepEqual(carried.sort(), [all[0].id, all[1].id].sort());
  assert.deepEqual(vanished, [gone.id]);
  assert.deepEqual(fresh.sort(), ids(all.slice(2)).sort());
});

test("a vanished survivor is reported but does NOT block", () => {
  // The obligation was "prove this behaviour is asserted". If the code it
  // mutated is gone, the obligation is discharged. Deleting the line to dodge
  // the gate is a real abuse route, which is why it is REPORTED rather than
  // silently dropped — the security reviewer sees the diff and the list.
  const { vanished, selected } = selectMutants(
    fakeSites(2),
    [{ id: "deadbeef0000", verdict: "survived" }],
    15,
  );
  assert.deepEqual(vanished, ["deadbeef0000"]);
  assert.equal(selected.length, 2);
});

// ── state persistence degrades, it does not dictate ─────────────────────────

test("missing, corrupt, wrong-version and wrong-branch state all degrade to no history", () => {
  const all = fakeSites(30);
  const baseline = ids(selectMutants(all, [], 15).selected);

  for (const raw of [
    undefined,
    "",
    "{ not json",
    JSON.stringify({
      version: 99,
      branch: "agent/x",
      mutants: [{ id: all[0].id, verdict: "survived" }],
    }),
    JSON.stringify({
      version: 1,
      branch: "agent/OTHER",
      mutants: [{ id: all[0].id, verdict: "survived" }],
    }),
  ]) {
    const previous = readState(raw, "agent/x");
    assert.deepEqual(previous, [], `should have degraded: ${String(raw).slice(0, 30)}`);
    assert.deepEqual(ids(selectMutants(all, previous, 15).selected), baseline);
  }
});

test("well-formed state for the right branch is used", () => {
  const raw = JSON.stringify({
    version: 1,
    branch: "agent/x",
    mutants: [{ id: "abc", verdict: "survived" }],
  });
  assert.deepEqual(readState(raw, "agent/x"), [{ id: "abc", verdict: "survived" }]);
});
