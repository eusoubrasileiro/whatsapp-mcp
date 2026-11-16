/**
 * Tests for the doc contract. Run: `node --test scripts/lib/doc-contract.test.mjs`
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DOC_ALLOWLIST, findDocContractOffenders } from "./doc-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("an allowlisted doc is not an offender", () => {
  assert.deepEqual(findDocContractOffenders(["CLAUDE.md", "docs/tools.md", "src/a.ts"]), []);
});

test("a new doc anywhere is an offender, named", () => {
  assert.deepEqual(
    findDocContractOffenders(["src/a.ts", "docs/plan-2026.md", "NOTES.MD", "x/y.mdx"]),
    ["NOTES.MD", "docs/plan-2026.md", "x/y.mdx"],
  );
});

test("offenders are deduplicated and sorted", () => {
  assert.deepEqual(findDocContractOffenders(["b.md", "a.md", "b.md"]), ["a.md", "b.md"]);
});

test("an empty listing is a broken measurement, never zero offenders", () => {
  assert.throws(() => findDocContractOffenders([]), /listed no files/);
  assert.throws(() => findDocContractOffenders(undefined), /listed no files/);
});

test("the real tree holds no doc off the allowlist", () => {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  }).split("\n");
  assert.deepEqual(findDocContractOffenders(listed), []);
});

test("every allowlisted path exists, so the list cannot rot into dead entries", () => {
  const tracked = new Set(
    execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n"),
  );
  for (const p of DOC_ALLOWLIST) assert.ok(tracked.has(p), `${p} is allowlisted but not tracked`);
});
