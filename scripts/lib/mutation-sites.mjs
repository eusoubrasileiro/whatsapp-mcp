/**
 * mutation-sites.mjs
 *
 * "Where could this file be broken, and how?" — a pure function from source
 * TEXT to a list of single-token edits. No fs, no `ts.Program`, no type
 * checker, no tsconfig: `ts.createSourceFile` on one file is milliseconds,
 * a Program over 242 files is seconds and buys nothing this needs.
 *
 * WHY AN AST AND NOT A REGEX. Three of the four things that must never be
 * mutated are invisible to a regex and each one is a false SURVIVED — a
 * blocked push the agent cannot legitimately fix:
 *
 *   - a comparison inside a COMMENT      (`// return a <= b`)
 *   - a comparison inside a STRING       (`"x <= y"`, a log message)
 *   - a `|` or `&` in a TYPE position    (`type T = A | B` is not a logical or)
 *
 * `node.getStart(sf)` skips leading trivia, so comments are structurally
 * unreachable; string contents are never operator tokens; and type positions
 * are a parent-chain check. That is the whole argument.
 *
 * EVERY MUTANT IS SYNTACTICALLY VALID BY CONSTRUCTION. Each edit replaces one
 * token with another of the same grammatical category, so the result re-parses.
 * This matters more than it looks: a broken mutant fails every test and reads
 * as KILLED, which does not block anyone and therefore never gets noticed — it
 * just quietly inflates the kill rate and weakens the gate. The property test
 * in the sibling `.test.mjs` pins it over a real corpus.
 *
 * SCOPE NOTE for a future v2: this module never touches `shared/src`, and it
 * must not start. `backend/test/setup/global-setup.ts` compares the newest mtime
 * under `shared/src` against `shared/dist` — restoring a mutated file gives it a
 * NEW mtime, so mutating anything under `shared/src` would trigger a full shared
 * rebuild on every single mutant and destroy the time budget.
 */

import { createRequire } from "node:module";

/** @typedef {object} Site
 *  @property {string} file      repo-relative path
 *  @property {string} operator  family name, e.g. "relational"
 *  @property {number} line      1-based, of the mutated token's first character
 *  @property {number} column    1-based
 *  @property {number} start     character offset, inclusive
 *  @property {number} end       character offset, exclusive
 *  @property {string} original  the exact source text being replaced
 *  @property {string} mutated   what replaces it
 *  @property {string} context   the whole source line, trimmed — for the report
 */

let _ts;

/**
 * Anchored on the repo-root `package.json` (whatsapp-mcp is a single package),
 * so it resolves from `node_modules` — including the symlinked one a dispatched
 * worktree gets.
 */
export function loadTypeScript() {
  if (!_ts) _ts = createRequire(new URL("../../package.json", import.meta.url))("typescript");
  return _ts;
}

// ── scope ───────────────────────────────────────────────────────────────────

/**
 * ┌─ LOCALIZE ────────────────────────────────────────────────────────────────┐
 * │ This file ships with wahub's scope because that is the configuration the  │
 * │ gate was validated against — a template that diverges from the proven     │
 * │ artifact is not a promotion. Three knobs are project facts and must be    │
 * │ set deliberately when you bootstrap:                                      │
 * │                                                                           │
 * │  1. `MUTATE_ROOT` below — the ONE source tree this gate owns.             │
 * │  2. `EXCLUDED` below — paths whose mutants survive BY CONSTRUCTION, with  │
 * │     the reason written down. An exclusion with no stated reason is a      │
 * │     hole, not a decision.                                                 │
 * │  3. `VITEST_COMMANDS` in `../mutation-gate.mjs` — the package filter for  │
 * │     the suite that must notice the mutation.                              │
 * │                                                                           │
 * │ Scope ONE tree, and pick the one whose coverage is already honest.        │
 * │ Pointing this at a thinly-tested tree reports survivors that are missing  │
 * │ tests wholesale rather than weak assertions, which is a different problem  │
 * │ and drowns the signal this gate exists to give.                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * whatsapp-mcp (localized 2026-11-16): mutates `src/**`, minus two exclusions.
 *
 * - `src/__tests__/` is the unit suite itself. Mutating a test proves nothing
 *   about production code.
 * - `src/main.ts` is the process entry point (startup order, signal wiring).
 *   `vitest.config.ts` excludes it from coverage for the same reason: no unit
 *   test boots the process, so its mutants survive by construction.
 *
 * Coverage over the rest is ~77% lines, the honest tree this gate needs.
 */
/** LOCALIZE (1): the single source tree this gate owns. Trailing slash required. */
export const MUTATE_ROOT = "src/";

/** LOCALIZE (2): paths whose mutants survive by construction. Reasons above. */
const EXCLUDED = ["src/__tests__/", "src/main.ts"];

export function isMutablePath(relPath) {
  if (!relPath.startsWith(MUTATE_ROOT)) return false;
  if (relPath.endsWith(".d.ts")) return false;
  // Only TypeScript source is mutated; markdown and data files are not code.
  if (!relPath.endsWith(".ts") && !relPath.endsWith(".tsx")) return false;
  return !EXCLUDED.some((p) => (p.endsWith("/") ? relPath.startsWith(p) : relPath === p));
}

// ── operator tables ─────────────────────────────────────────────────────────

/**
 * Binary operator token → replacement, by family.
 *
 * Relational swaps the BOUNDARY (`<`↔`<=`), not the direction (`<`→`>`). An
 * off-by-one at exactly the boundary is where untested cases actually live;
 * reversing the comparison is a different function that any test at all catches,
 * so it costs a mutant slot and proves nothing.
 *
 * `??` → `||` was in this table and is deliberately NOT any more. It differs for
 * exactly `0`, `""` and `false`, and `??` is written precisely where the operand
 * is `T | null | undefined` — so in typed code that state usually cannot occur
 * and the mutant is unkillable. Measured over the phase-5 trial (31 mutants, four
 * real ranges): 29 killed, 2 survived, and BOTH survivors were `??`→`||`
 * equivalents — `sourceId ?? null` on a WABA wamid, `pricingCategory ?? "(uncat)"`
 * on a Prisma `String?`. Killing either needs a test asserting on an input the
 * system cannot produce, which is the exact noise-test this gate exists to
 * prevent. One operator accounted for 100% of the false blocks; it is cheaper to
 * drop it than to waive its sites one ratified trailer at a time.
 */
// Keyed by NUMERIC SyntaxKind, built once, deliberately not by name.
// `ts.SyntaxKind[kind]` is a reverse lookup into an enum with aliases, and it
// returns the LAST name sharing that value: `SyntaxKind[30]` is
// "FirstBinaryOperator", not "LessThanToken". A name-keyed table therefore
// silently drops `<` — the gate loses an entire operator and still reports a
// cheerful pass. Found by the property test below, which is the only reason
// this comment exists.
let _binary;
function binaryTable(ts) {
  if (_binary) return _binary;
  const K = ts.SyntaxKind;
  _binary = new Map([
    [K.EqualsEqualsEqualsToken, ["equality", "!=="]],
    [K.ExclamationEqualsEqualsToken, ["equality", "==="]],
    [K.EqualsEqualsToken, ["equality", "!="]],
    [K.ExclamationEqualsToken, ["equality", "=="]],
    [K.LessThanToken, ["relational", "<="]],
    [K.LessThanEqualsToken, ["relational", "<"]],
    [K.GreaterThanToken, ["relational", ">="]],
    [K.GreaterThanEqualsToken, ["relational", ">"]],
    [K.AmpersandAmpersandToken, ["logical", "||"]],
    [K.BarBarToken, ["logical", "&&"]],
    [K.PlusToken, ["arithmetic", "-"]],
    [K.MinusToken, ["arithmetic", "+"]],
    [K.AsteriskToken, ["arithmetic", "/"]],
    [K.SlashToken, ["arithmetic", "*"]],
  ]);
  return _binary;
}

// Deliberately NOT shipped in v1, each for a measured reason:
//
//   string literal → ""   `backend/src/services` is thousands of lines of Prisma
//                         field names and Portuguese bot copy. It would dominate
//                         the site count and almost every one is equivalent —
//                         nobody asserts on a log string.
//   `?.` → `.`            Throws instead of failing an assertion, so it reads as
//                         killed-by-error: an inflated kill rate, not signal.
//   statement removal     Very high equivalence rate on logging calls.
//
// All three are v2 candidates once the trial has measured a real equivalence rate.

// ── enumeration ─────────────────────────────────────────────────────────────

/** True when the node sits anywhere inside a type annotation, `as`, or `satisfies`. */
function inTypePosition(ts, node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (
      ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeParameterDeclaration(p) ||
      ts.isIndexSignatureDeclaration(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p)
    ) {
      return true;
    }
    if (ts.isSourceFile(p)) return false;
  }
  return false;
}

/** True when the node is part of an import/export clause rather than a value. */
function inModuleSpecifier(ts, node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportEqualsDeclaration(p)) {
      return true;
    }
    if (ts.isSourceFile(p)) return false;
  }
  return false;
}

/**
 * Prisma field-selector keys. A `true` under one of these NAMES A COLUMN — it is
 * not a boolean flag, and `false` there is not a different behaviour, it is a
 * different query shape that a mocked Prisma cannot distinguish.
 *
 * Measured on this gate's first real run: `_max: { wabaTimestamp: true }` in
 * `services/service-window.ts` survived, and `select: { id: true }` appears
 * hundreds of times in this codebase. Left in, this one pattern would have been
 * the gate's largest source of unkillable mutants — a blocked push with no
 * honest fix, which is the failure mode that makes a gate get switched off.
 */
const PRISMA_SELECTOR_KEYS = new Set([
  "select",
  "include",
  "omit",
  "_count",
  "_max",
  "_min",
  "_sum",
  "_avg",
]);

/** True when the node sits anywhere under a Prisma field-selector key. */
function inPrismaSelector(ts, node) {
  for (let p = node.parent; p; p = p.parent) {
    if (
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      PRISMA_SELECTOR_KEYS.has(p.name.text)
    ) {
      return true;
    }
    if (ts.isSourceFile(p)) return false;
  }
  return false;
}

/**
 * True when the node is an argument to a `logger.*()` call.
 *
 * Log formatting is not behaviour. `err instanceof Error ? err.message :
 * String(err)` appears in essentially every catch block in this repo; killing a
 * mutant there requires a test that asserts on a log STRING, which pins prose
 * rather than contract and is the kind of test that makes a suite brittle
 * without making it stronger. Two of the three survivors on this gate's first
 * real run were that exact ternary.
 */
function inLoggerCall(ts, node) {
  for (let p = node.parent; p; p = p.parent) {
    if (
      ts.isCallExpression(p) &&
      ts.isPropertyAccessExpression(p.expression) &&
      ts.isIdentifier(p.expression.expression) &&
      p.expression.expression.text === "logger"
    ) {
      return true;
    }
    if (ts.isSourceFile(p)) return false;
  }
  return false;
}

/** `"a" + x` is concatenation; mutating it to `-` yields NaN and proves nothing. */
function isStringy(ts, node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isTemplateExpression(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (isStringy(ts, node.left) || isStringy(ts, node.right)))
  );
}

/**
 * The mutations one node offers, as `[operator, start, end, mutated]` tuples.
 *
 * Split out of the tree walk so each is one small decision rather than a single
 * branching function — the cognitive-complexity rule this repo turned on in the
 * same change that added this file applies to the file itself.
 */
function mutationsFor(ts, node, sf) {
  if (ts.isBinaryExpression(node)) {
    const entry = binaryTable(ts).get(node.operatorToken.kind);
    if (!entry || (entry[0] === "arithmetic" && isStringy(ts, node))) return [];
    return [[entry[0], node.operatorToken.getStart(sf), node.operatorToken.getEnd(), entry[1]]];
  }

  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    // Drop the `!`, keeping the operand: `!ready` -> `ready`.
    return [["negation", node.getStart(sf), node.getEnd(), node.operand.getText(sf)]];
  }

  const isTrue = node.kind === ts.SyntaxKind.TrueKeyword;
  if (isTrue || node.kind === ts.SyntaxKind.FalseKeyword) {
    if (inPrismaSelector(ts, node)) return [];
    return [["boolean", node.getStart(sf), node.getEnd(), isTrue ? "false" : "true"]];
  }

  if (ts.isConditionalExpression(node)) {
    // Force each arm. Catches "only the happy branch of this ternary is ever
    // exercised", which no coverage number distinguishes from both.
    const start = node.condition.getStart(sf);
    const end = node.condition.getEnd();
    return [
      ["conditional", start, end, "true"],
      ["conditional", start, end, "false"],
    ];
  }

  return [];
}

/**
 * Every mutation site in `sourceText`.
 *
 * @param {string} relPath   repo-relative; used for reporting and identity only
 * @param {string} sourceText
 * @param {(line: number) => boolean} [lineFilter]  diff scoping; default: all lines
 * @returns {Site[]}
 */
export function enumerateSites(relPath, sourceText, lineFilter = () => true) {
  const ts = loadTypeScript();
  const sf = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lines = sourceText.split("\n");
  /** @type {Site[]} */
  const sites = [];

  const push = (operator, start, end, mutated) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    if (!lineFilter(line + 1)) return;
    sites.push({
      file: relPath,
      operator,
      line: line + 1,
      column: character + 1,
      start,
      end,
      original: sourceText.slice(start, end),
      mutated,
      context: (lines[line] ?? "").trim(),
    });
  };

  const visit = (node) => {
    if (inTypePosition(ts, node) || inModuleSpecifier(ts, node)) return;
    // Not a `return`: a logger call may sit inside a function whose other
    // statements are perfectly mutable, so the walk must continue past it.
    if (!inLoggerCall(ts, node)) {
      for (const [operator, start, end, mutated] of mutationsFor(ts, node, sf)) {
        push(operator, start, end, mutated);
      }
    }
    node.forEachChild(visit);
  };

  sf.forEachChild(visit);

  // Stable, deterministic order. Offset is a total order within a file, and
  // ties (both ternary arms share a span) break on the mutated text.
  sites.sort((a, b) => a.start - b.start || (a.mutated < b.mutated ? 1 : -1));
  return sites;
}

/**
 * Apply one site. Pure: `(text, site) => text`.
 * @param {string} sourceText
 * @param {Site} site
 */
export function applySite(sourceText, site) {
  return sourceText.slice(0, site.start) + site.mutated + sourceText.slice(site.end);
}
