/**
 * `isApproval` is the whitelist that stops the harness reading "not a reject" as
 * green. These tests pin the two halves of that:
 *
 *   1. Exactly one value is an approval. Every other string, and no string at
 *      all, is not — so a verdict nobody has thought of yet cannot render or
 *      exit as a pass.
 *   2. A verdict that blocks without being a coding reject (`awaiting-approval`)
 *      does NOT consume a fix round. A malformed model response is not evidence
 *      the code is bad, so it must not spend one of MAX_FIX_ROUNDS.
 *
 * Run: `node --test scripts/lib/review-log-approval.test.mjs`
 */
import assert from "node:assert/strict";
import test from "node:test";

import { countFixRounds, hasEscalated, isApproval } from "./review-log.mjs";

test("only the literal approve verdict is an approval", () => {
  assert.equal(isApproval("approve"), true);
});

test("every other verdict value is not an approval", () => {
  for (const v of [
    "reject",
    "escalate",
    "awaiting-approval",
    "no-review",
    "banana",
    "APPROVE",
    "approved",
    " approve",
    "",
  ]) {
    assert.equal(isApproval(v), false, `${JSON.stringify(v)} must not read as green`);
  }
});

test("a missing or non-string verdict is not an approval", () => {
  for (const v of [undefined, null, 0, 1, {}, [], true]) {
    assert.equal(isApproval(v), false, `${JSON.stringify(v) ?? String(v)} must not read as green`);
  }
});

// ── the fix-round half ──────────────────────────────────────────────────────
// The count lives in countFixRounds, not in security-review.mjs, so this is
// where "an unknown verdict must not burn a round" is provable as a unit.

const e = (branch, verdict) => ({ ts: "2026-11-02T00:00:00Z", branch, verdict });

test("an awaiting-approval verdict consumes no fix round", () => {
  const log = [
    e("agent/a", "awaiting-approval"),
    e("agent/a", "awaiting-approval"),
    e("agent/a", "awaiting-approval"),
  ];
  assert.equal(countFixRounds("agent/a", log), 0);
  assert.equal(hasEscalated("agent/a", log), false);
});

test("an unparseable verdict cannot escalate a branch that was never rejected", () => {
  // Three malformed reviewer responses in a row are an outage, not three
  // rejects: the branch must still be reviewable.
  const log = [
    e("agent/a", "reject"),
    e("agent/a", "awaiting-approval"),
    e("agent/a", "awaiting-approval"),
  ];
  assert.equal(countFixRounds("agent/a", log), 1);
});
