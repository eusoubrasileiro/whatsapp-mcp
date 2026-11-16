/**
 * Deterministic ratification fact — what makes a `Ratified-by` trailer proof rather
 * than a claim. A trailer read out of the diff is prose written by whoever wrote the
 * diff; read from git it is a computed fact (standards.md §5).
 *
 * Run: `node --test scripts/lib/ratification.test.mjs`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeRatificationFact,
  formatRatificationFact,
  isRatificationPath,
  parseRatifiedByTrailers,
  RATIFIER,
  ratificationRejection,
  UNRATIFIED_CONCERN,
} from "./ratification.mjs";

/** A `safeExec`-shaped stub: maps a command substring to canned stdout. */
const execStub = (routes) => (cmd) => {
  for (const [needle, out] of Object.entries(routes)) if (cmd.includes(needle)) return out;
  return "";
};

describe("isRatificationPath", () => {
  it("treats the harness files and trees as critical", () => {
    for (const f of [
      ".husky/pre-push",
      "scripts/security-review.mjs",
      "scripts/lib/claude-cli.mjs",
      "quality-baseline.json",
      ".claude/settings.json",
      "commitlint.config.cjs",
      "scripts/quality-gate.mjs",
      "biome.json",
    ]) {
      assert.equal(isRatificationPath(f), true, f);
    }
  });

  it("follows critical-paths.mjs: send guards, data layer and every *.md are critical", () => {
    for (const f of [
      "src/send-guard.ts",
      "src/cold-contact.ts",
      "src/db/ddl.ts",
      "README.md",
      "docs/tools.md",
    ]) {
      assert.equal(isRatificationPath(f), true, f);
    }
  });

  it("leaves ordinary product code and the tests alone", () => {
    for (const f of [
      "src/actions.ts",
      "src/mcp/tools/messaging.ts",
      "src/__tests__/send-guard.test.ts",
    ]) {
      assert.equal(isRatificationPath(f), false, f);
    }
  });

  it("does not match a lookalike outside the guarded tree", () => {
    assert.equal(isRatificationPath("scripts/libel.mjs"), false);
  });
});

describe("parseRatifiedByTrailers", () => {
  it("returns trimmed, non-empty values", () => {
    assert.deepEqual(parseRatifiedByTrailers("Andre\n\n  Andre  \n"), ["Andre", "Andre"]);
  });
  it("returns nothing for an absent trailer", () => {
    assert.deepEqual(parseRatifiedByTrailers(""), []);
  });
});

describe("computeRatificationFact", () => {
  it("reports none-touch-critical when the range changes no critical file", () => {
    const fact = computeRatificationFact("main..HEAD", execStub({}), ["src/x.ts"]);
    assert.equal(fact.summary, "none-touch-critical");
    assert.deepEqual(fact.commits, []);
  });

  it("reports all-ratified when every critical commit carries the trailer", () => {
    const fact = computeRatificationFact(
      "main..HEAD",
      execStub({ "git log --format=%H": "sha1\nsha2\n", "trailers:key=Ratified-by": RATIFIER }),
      [".husky/pre-push"],
    );
    assert.equal(fact.summary, "all-ratified");
  });

  it("reports some-missing when a critical commit lacks the trailer", () => {
    const exec = (cmd) => {
      if (cmd.includes("git log --format=%H")) return "sha1\nsha2\n";
      return cmd.includes("sha1") ? RATIFIER : "";
    };
    assert.equal(
      computeRatificationFact("main..HEAD", exec, [".husky/pre-push"]).summary,
      "some-missing",
    );
  });

  it("does not accept a trailer naming somebody else", () => {
    const fact = computeRatificationFact(
      "main..HEAD",
      execStub({ "git log --format=%H": "sha1\n", "trailers:key=Ratified-by": "SomeAgent" }),
      [".husky/pre-push"],
    );
    assert.equal(fact.summary, "some-missing");
  });

  it("fails closed when git enumeration returns nothing but the diff says otherwise", () => {
    const fact = computeRatificationFact("main..HEAD", execStub({}), [".husky/pre-push"]);
    assert.equal(fact.summary, "some-missing");
  });
});

describe("formatRatificationFact", () => {
  it("names each commit and whether its trailer is present", () => {
    const text = formatRatificationFact({
      summary: "some-missing",
      commits: [
        { sha: "abc", ratified: true },
        { sha: "def", ratified: false },
      ],
    });
    assert.match(text, /some-missing/);
    assert.match(text, /abc/);
    assert.match(text, /MISSING/);
  });
});

describe("ratificationRejection", () => {
  // `some-missing` used to be a prompt instruction: git computed the fact, then a model
  // was asked to act on it. A fact that decides the verdict on its own needs no model.
  it("rejects an unratified critical edit, naming each unratified commit", () => {
    const r = ratificationRejection({
      summary: "some-missing",
      commits: [
        { sha: "abc1234", ratified: true },
        { sha: "def5678", ratified: false },
      ],
    });
    assert.deepEqual(r.concerns, [UNRATIFIED_CONCERN]);
    assert.match(r.justification, /def5678/);
    assert.doesNotMatch(r.justification, /abc1234/);
    assert.ok(r.justification.includes(`Ratified-by: ${RATIFIER}`));
  });

  it("still rejects when git enumeration failed (fail-closed, no commits listed)", () => {
    const r = ratificationRejection({ summary: "some-missing", commits: [] });
    assert.deepEqual(r.concerns, [UNRATIFIED_CONCERN]);
  });

  it("leaves all-ratified and none-touch-critical to the reviewer", () => {
    for (const summary of ["all-ratified", "none-touch-critical"]) {
      assert.equal(ratificationRejection({ summary, commits: [] }), null, summary);
    }
  });
});
