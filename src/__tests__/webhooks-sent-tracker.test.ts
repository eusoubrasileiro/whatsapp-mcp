import { afterEach, describe, expect, it } from "vitest";

import { markSentByUs, resetSentTracker, wasSentByUs } from "../webhooks/sent-tracker.ts";

afterEach(() => resetSentTracker());

describe("sent-tracker (webhook loop guard)", () => {
  it("recognises an id we marked as sent", () => {
    expect(wasSentByUs("A")).toBe(false);
    markSentByUs("A");
    expect(wasSentByUs("A")).toBe(true);
  });

  it("ignores null/undefined/empty ids", () => {
    markSentByUs(null);
    markSentByUs(undefined);
    markSentByUs("");
    expect(wasSentByUs(null)).toBe(false);
    expect(wasSentByUs("")).toBe(false);
  });

  it("evicts oldest ids past the cap but keeps recent ones", () => {
    for (let i = 0; i < 1005; i++) markSentByUs(`m${i}`);
    expect(wasSentByUs("m0")).toBe(false); // evicted
    expect(wasSentByUs("m4")).toBe(false); // evicted
    expect(wasSentByUs("m1004")).toBe(true); // recent
  });
});
