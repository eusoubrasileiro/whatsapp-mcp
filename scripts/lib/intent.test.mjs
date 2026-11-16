/**
 * The reviewer judges a push against the owner's definition of done, read verbatim.
 * Before `extractDoneWhen`, the only trace of the plan the reviewer saw was Haiku's
 * 2-3 sentence "why": enough to spot scope drift, never enough to see that a "Done
 * when" bullet was visibly unmet. No summariser should stand between the owner's words
 * and the verdict.
 *
 * Run: `node --test scripts/lib/intent.test.mjs`
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractDoneWhen } from "./intent.mjs";

const PLAN = [
  "# slug — title",
  "",
  "## Problem",
  "",
  "Something is broken.",
  "",
  "## Done when",
  "",
  "- The thing works.",
  "- A test proves it.",
  "",
  "## Notes",
  "",
  "Not part of done.",
].join("\n");

test("returns the section body verbatim, up to the next heading", () => {
  assert.equal(extractDoneWhen(PLAN), "- The thing works.\n- A test proves it.");
});

test("runs to the end of the plan when it is the last section", () => {
  assert.equal(extractDoneWhen("# t\n\n## Done when\n\n- Last section.\n"), "- Last section.");
});

test("matches the heading at any level and in any case", () => {
  assert.equal(extractDoneWhen("# t\n\n### DONE WHEN\n\n- Shouting.\n\n### Next\n"), "- Shouting.");
});

test("keeps a deeper sub-heading inside the section", () => {
  const plan = "## Done when\n\n- One.\n\n### Evidence\n\n- Two.\n\n## After\n\nno";
  assert.equal(extractDoneWhen(plan), "- One.\n\n### Evidence\n\n- Two.");
});

test("returns null when the plan has no Done when section", () => {
  assert.equal(extractDoneWhen("# t\n\n## Scope\n\n- x\n"), null);
});

test("returns null for an empty section", () => {
  assert.equal(extractDoneWhen("## Done when\n\n## Next\n\n- x\n"), null);
});

test("returns null when there is no plan", () => {
  assert.equal(extractDoneWhen(null), null);
  assert.equal(extractDoneWhen(""), null);
});
