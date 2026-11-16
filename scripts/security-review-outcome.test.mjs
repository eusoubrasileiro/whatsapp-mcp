/**
 * The reviewer's final decision, as a unit.
 *
 * The bug this file exists for: the script used to make exactly one test of the
 * model's answer — `if (verdict.verdict === "reject")` — and let everything
 * else fall through to the green APPROVE line. That is a blacklist, so it is
 * only as closed as the list is complete, and the list can never be complete:
 * `escalate`, a truncated response, or whatever shape a model upgrade starts
 * emitting all read as a pass.
 *
 * `validateVerdict` happens to filter unknown values upstream today, which is
 * why the hole was latent rather than live. That is exactly why the decision is
 * tested here as its own unit: defence in depth is only defence if each layer
 * holds on its own, and one relaxed enum upstream must not open the gate.
 *
 * Run: `node --test scripts/security-review-outcome.test.mjs`
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewOutcome } from "./security-review.mjs";

test("approve is the only verdict that reaches the green path", () => {
  assert.equal(reviewOutcome("approve"), "approve");
});

test("reject and escalate keep their own outcomes", () => {
  assert.equal(reviewOutcome("reject"), "reject");
  assert.equal(reviewOutcome("escalate"), "escalate");
});

test("every unknown verdict is classified unknown, never approve", () => {
  for (const v of [
    "banana",
    "",
    "no-review",
    "awaiting-approval",
    "APPROVE",
    "approved",
    "maybe",
  ]) {
    assert.equal(reviewOutcome(v), "unknown", `${JSON.stringify(v)} must not be approve`);
  }
});

test("a missing or non-string verdict is unknown, never approve", () => {
  for (const v of [undefined, null, 0, {}, [], true]) {
    assert.equal(reviewOutcome(v), "unknown");
  }
});

test("no value outside the three known verdicts can be an approval", () => {
  // The property, stated once: approve is a whitelist of one.
  const known = ["approve", "reject", "escalate"];
  for (const v of ["x", "1", "rejected", "ESCALATE", "approve ", undefined]) {
    assert.ok(!known.includes(v));
    assert.notEqual(reviewOutcome(v), "approve");
  }
});
