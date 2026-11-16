import assert from "node:assert/strict";
import { test } from "node:test";

import { applySite, enumerateSites, isMutablePath, loadTypeScript } from "./mutation-sites.mjs";

/** Enumerate with all lines allowed; return `operator:original>mutated` labels. */
function labels(src) {
  return enumerateSites("f.ts", src).map((s) => `${s.operator}:${s.original}>${s.mutated}`);
}

// ── operators fire ──────────────────────────────────────────────────────────

test("equality: flips === and !== polarity", () => {
  assert.deepEqual(labels("const a = x === y;"), ["equality:===>!=="]);
  assert.deepEqual(labels("const a = x !== y;"), ["equality:!==>==="]);
  assert.deepEqual(labels("const a = x == y;"), ["equality:==>!="]);
});

test("relational: swaps the boundary, not the direction", () => {
  // `<` → `<=` is an off-by-one at exactly the boundary, which is where the
  // untested cases live. `<` → `>` is a different function entirely and is
  // usually caught by any test at all, so it buys nothing.
  assert.deepEqual(labels("const a = x < y;"), ["relational:<><="]);
  assert.deepEqual(labels("const a = x <= y;"), ["relational:<=><"]);
  assert.deepEqual(labels("const a = x > y;"), ["relational:>>>="]);
  assert.deepEqual(labels("const a = x >= y;"), ["relational:>=>>"]);
});

test("logical: swaps && and ||, and leaves ?? alone", () => {
  assert.deepEqual(labels("const a = x && y;"), ["logical:&&>||"]);
  assert.deepEqual(labels("const a = x || y;"), ["logical:||>&&"]);
  // `??` → `||` is NOT mutated, and this asserts it stays that way. The phase-5
  // trial ran 31 mutants over four real ranges: 29 killed, 2 survived, and both
  // survivors were `??`→`||` equivalents blocking a push for nothing. `??` is
  // written exactly where the operand is `T | null | undefined`, so the `0`/`""`/
  // `false` case the mutant depends on usually cannot occur — unkillable except
  // by a test asserting on an impossible input. See binaryTable's comment.
  assert.deepEqual(labels("const a = x ?? y;"), []);
});

test("boolean literal: flips true and false", () => {
  assert.deepEqual(labels("const a = true;"), ["boolean:true>false"]);
  assert.deepEqual(labels("const a = false;"), ["boolean:false>true"]);
});

test("negation: removes a unary !", () => {
  assert.deepEqual(labels("const a = !x;"), ["negation:!x>x"]);
});

test("arithmetic: swaps + with - and * with /", () => {
  assert.deepEqual(labels("const a = x + y;"), ["arithmetic:+>-"]);
  assert.deepEqual(labels("const a = x * y;"), ["arithmetic:*>/"]);
  assert.deepEqual(labels("const a = x - y;"), ["arithmetic:->+"]);
});

test("conditional: forces both arms of a ternary", () => {
  assert.deepEqual(labels("const a = c ? x : y;"), ["conditional:c>true", "conditional:c>false"]);
});

// ── guards: things that must NOT be mutated ─────────────────────────────────

test("a comparison inside a COMMENT yields no sites", () => {
  // The headline argument for the AST over a regex. `getStart()` skips leading
  // trivia, so comments are never reachable as nodes.
  assert.deepEqual(labels("// if (a <= b && c) return true;\nconst z = 1;"), []);
  assert.deepEqual(labels("/** @returns true when a <= b */\nconst z = 1;"), []);
});

test("a comparison inside a STRING or template yields no sites", () => {
  assert.deepEqual(labels('const a = "x <= y && z";'), []);
  assert.deepEqual(labels("const a = `x !== y`;"), []);
});

test("union and intersection TYPES are not logical operators", () => {
  assert.deepEqual(labels("type T = A | B;"), []);
  assert.deepEqual(labels("type T = A & B;"), []);
  assert.deepEqual(labels("type T = Array<A | null>;"), []);
  assert.deepEqual(labels("interface I { x: A | B }"), []);
  assert.deepEqual(labels("function f(a: A | B): C | D { return a as never; }"), []);
});

test("`true` and `false` in a TYPE position are not boolean literals", () => {
  assert.deepEqual(labels("type T = true;"), []);
  assert.deepEqual(labels("function f(x: true | false) {}"), []);
});

test("import and export specifiers are never mutated", () => {
  assert.deepEqual(labels('import { a as b } from "./m.js";'), []);
  assert.deepEqual(labels('export { x } from "./m.js";'), []);
  assert.deepEqual(labels('export * from "./m.js";'), []);
});

test("`as const` and `satisfies` subtrees are left alone", () => {
  assert.deepEqual(labels("const a = { k: true } as const;"), []);
  assert.deepEqual(labels("const a = { k: false } satisfies Foo;"), []);
});

test("string concatenation is not arithmetic", () => {
  // `"a" + "b"` → `"a" - "b"` is NaN: it breaks every test that touches it and
  // reads as a kill while proving nothing.
  assert.deepEqual(labels('const a = "x" + y;'), []);
  // This string IS TypeScript source under test — the template placeholder is the point.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test
  assert.deepEqual(labels("const a = `${x}` + y;"), []);
  assert.deepEqual(labels("const a = 1 + 2;"), ["arithmetic:+>-"]);
});

test("object literal keys are not mutated", () => {
  assert.deepEqual(labels("const o = { true: 1 };"), []);
});

test("a boolean under a PRISMA SELECTOR key is a field selector, not a flag", () => {
  // `select: { id: true }` does not mean "id is on". It names a column. With a
  // mocked Prisma the mock does not care which columns were named, so these
  // mutants are UNKILLABLE BY CONSTRUCTION — a blocked push with no honest fix.
  // Measured on the first real run of this gate: `_max: { wabaTimestamp: true }`
  // survived, and this codebase is full of them.
  assert.deepEqual(labels("const r = db.x.findMany({ select: { id: true } });"), []);
  assert.deepEqual(labels("const r = db.x.groupBy({ _max: { ts: true } });"), []);
  assert.deepEqual(labels("const r = db.x.findFirst({ include: { deal: true } });"), []);
  assert.deepEqual(
    labels("const r = db.x.aggregate({ _count: { id: true }, _sum: { v: true } });"),
    [],
  );
  assert.deepEqual(labels("const r = db.x.findMany({ omit: { secret: true } });"), []);
  // Nested selects stay excluded all the way down.
  assert.deepEqual(
    labels("const r = db.x.findFirst({ select: { deal: { select: { id: true } } } });"),
    [],
  );
});

test("a boolean in an ordinary options object is still a real flag", () => {
  // The exclusion must be narrow. `botEnabled: true` IS behaviour.
  assert.deepEqual(labels("await store.update({ data: { botEnabled: true } });"), [
    "boolean:true>false",
  ]);
  assert.deepEqual(labels("const opts = { recursive: true };"), ["boolean:true>false"]);
});

test("nothing inside a logger call is mutated", () => {
  // Log formatting is not behaviour. `err instanceof Error ? err.message :
  // String(err)` appears in every catch block in this repo; mutating it demands
  // a test that asserts on a log string, which pins prose rather than contract.
  // Also measured on the first real run: two of three survivors were this exact
  // ternary.
  assert.deepEqual(
    labels('logger.error("boom", { error: e instanceof Error ? e.message : String(e) });'),
    [],
  );
  assert.deepEqual(labels('logger.warn(count > 0 ? "some" : "none");'), []);
  assert.deepEqual(labels('logger.info("x", { ok: true });'), []);
});

test("a logger call does not suppress mutation of the code AROUND it", () => {
  const src = 'if (a === b) { logger.info("eq", { n: 1 > 2 }); }';
  assert.deepEqual(labels(src), ["equality:===>!=="]);
});

// ── line filtering ──────────────────────────────────────────────────────────

test("only lines the filter admits produce sites", () => {
  const src = ["const a = x === y;", "const b = p === q;", "const c = m === n;"].join("\n");
  const sites = enumerateSites("f.ts", src, (line) => line === 2);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].line, 2);
});

test("a site is admitted by the line its MUTATED TOKEN starts on", () => {
  // A multi-line expression whose operator sits on line 2: the push changed
  // line 2, so the operator on line 2 is in scope even though the statement
  // begins on line 1.
  const src = ["const a =", "  x === y;"].join("\n");
  const sites = enumerateSites("f.ts", src, (line) => line === 2);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].line, 2);
});

// ── applySite ───────────────────────────────────────────────────────────────

test("applySite replaces exactly the token span", () => {
  const src = "const a = x <= y;";
  const [site] = enumerateSites("f.ts", src);
  assert.equal(applySite(src, site), "const a = x < y;");
});

test("applySite on a negation drops the ! and keeps the operand", () => {
  const src = "if (!ready) return;";
  const [site] = enumerateSites("f.ts", src);
  assert.equal(applySite(src, site), "if (ready) return;");
});

test("PROPERTY: every mutant of every operator re-parses without a syntax error", () => {
  // A syntactically broken mutant fails every test and reads as KILLED while
  // proving nothing — a false kill silently weakens the gate. Same-category
  // token replacement is what makes validity structural; this pins it.
  const ts = loadTypeScript();
  const corpus = [
    "export function f(a: number, b: number) { return a <= b && a !== 0; }",
    "const v = cfg.timeout ?? 30;",
    "const w = items.length > 0 ? items[0] : null;",
    "export const g = (x: number) => !x || x * 2 + 1;",
    "if (a === b) { return true; } else { return false; }",
    "const h = { on: true, n: 3 - 1 };",
    "export async function q(p: { a?: string }) { return p.a !== undefined && p.a.length < 5; }",
    "for (let i = 0; i < 10; i++) { if (i % 2 === 0) continue; }",
    "const r = list.filter((x) => x.n >= 2).map((x) => x.n / 2);",
    "type U = A | B;\nconst s: U = cond ? left : right;",
  ];
  const seen = new Set();
  let checked = 0;
  for (const src of corpus) {
    for (const site of enumerateSites("f.ts", src)) {
      const mutated = applySite(src, site);
      assert.notEqual(mutated, src, `${site.operator} produced no change in: ${src}`);
      const sf = ts.createSourceFile(
        "f.ts",
        mutated,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const diags = sf.parseDiagnostics ?? [];
      assert.equal(diags.length, 0, `syntax error from ${site.operator} in: ${mutated}`);
      seen.add(site.operator);
      checked++;
    }
  }

  // Exact, hand-counted over the corpus above. A bare `> n` floor would have
  // stayed green while `<` silently vanished from the operator table (it did:
  // `ts.SyntaxKind[30]` reverse-maps to "FirstBinaryOperator", so a name-keyed
  // table dropped every `<` in the repo and the gate still reported a pass).
  // A gate that loses an operator does not fail — it just quietly stops looking.
  // 25 until `??`→`||` was dropped from the operator table after the phase-5
  // trial; the corpus's one `??` (`cfg.timeout ?? 30`) is the single site lost.
  assert.equal(checked, 24, "corpus site count changed — recount, do not just bump this");
  assert.deepEqual(
    [...seen].sort(),
    ["arithmetic", "boolean", "conditional", "equality", "logical", "negation", "relational"],
    "an operator family stopped firing",
  );
});

test("enumeration order is stable across runs", () => {
  const src = "const a = x === y && z < 1 ? p + 1 : q;";
  assert.deepEqual(labels(src), labels(src));
});

// ── isMutablePath ───────────────────────────────────────────────────────────

test("the unit suite itself is never mutated", () => {
  assert.equal(isMutablePath("src/__tests__/send-guard.test.ts"), false);
  assert.equal(isMutablePath("src/__tests__/helpers/make-message.ts"), false);
});

test("files excluded from coverage by design are excluded here too", () => {
  // `vitest.config.ts` excludes src/main.ts from coverage: no unit test boots
  // the process, so its mutants would survive by construction.
  assert.equal(isMutablePath("src/main.ts"), false);
  assert.equal(isMutablePath("src/types/x.d.ts"), false);
  assert.equal(isMutablePath("src/prompts/notes.md"), false);
});

test("everything outside src/ is out of scope", () => {
  assert.equal(isMutablePath("scripts/quality-gate.mjs"), false);
  assert.equal(isMutablePath("deploy/docker-compose.yaml"), false);
  assert.equal(isMutablePath("vitest.config.ts"), false);
});

test("the directories the gate DOES cover are actually included", () => {
  // Assert the positive direction too: a mistyped glob that excludes everything
  // turns the gate into a silent no-op that passes forever.
  assert.equal(isMutablePath("src/send-guard.ts"), true);
  assert.equal(isMutablePath("src/cold-contact.ts"), true);
  assert.equal(isMutablePath("src/db/inbound-history.ts"), true);
  assert.equal(isMutablePath("src/mcp/tools/messaging.ts"), true);
});
