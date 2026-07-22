import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  assertSendAccepted,
  getSendAckWaitMs,
  isPresendCheckEnabled,
} from "../send-guard.ts";
import { emitAckError, resetAckBus } from "../ack-bus.ts";

function ack(msgId: string, code = "463") {
  return { msgId, chatJid: "c@s.whatsapp.net", code, reason: "r", detail: null };
}

describe("getSendAckWaitMs", () => {
  it("defaults to a window far wider than the observed ~40ms ack", () => {
    expect(getSendAckWaitMs({})).toBe(3000);
  });

  it("honours an explicit override", () => {
    expect(getSendAckWaitMs({ SEND_ACK_WAIT_MS: "500" })).toBe(500);
  });

  it("treats 0 as disabled", () => {
    expect(getSendAckWaitMs({ SEND_ACK_WAIT_MS: "0" })).toBe(0);
  });

  it("falls back to the default for junk values rather than disabling the guard", () => {
    expect(getSendAckWaitMs({ SEND_ACK_WAIT_MS: "banana" })).toBe(3000);
    expect(getSendAckWaitMs({ SEND_ACK_WAIT_MS: "-5" })).toBe(3000);
  });
});

describe("isPresendCheckEnabled", () => {
  it("is on by default", () => {
    expect(isPresendCheckEnabled({})).toBe(true);
  });

  it("can be switched off without a code change", () => {
    expect(isPresendCheckEnabled({ SEND_PRESEND_CHECK: "false" })).toBe(false);
  });

  it("stays on for any value other than an explicit false", () => {
    expect(isPresendCheckEnabled({ SEND_PRESEND_CHECK: "true" })).toBe(true);
    expect(isPresendCheckEnabled({ SEND_PRESEND_CHECK: "yes" })).toBe(true);
  });
});

describe("assertSendAccepted", () => {
  beforeEach(() => {
    resetAckBus();
  });

  it("throws with agent-actionable text when the server rejected the send", async () => {
    emitAckError(ack("m1"));

    await expect(
      assertSendAccepted("m1", "5531912344567@s.whatsapp.net", 3000),
    ).rejects.toThrow(/did NOT arrive[\s\S]*DO NOT RETRY/);
  });

  it("resolves quietly when no rejection arrives", async () => {
    vi.useFakeTimers();
    try {
      const p = assertSendAccepted("m2", "x@s.whatsapp.net", 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait at all when the guard is disabled", async () => {
    emitAckError(ack("m3"));

    // Disabled restores the old fire-and-forget behavior: no throw.
    await expect(assertSendAccepted("m3", "x@s.whatsapp.net", 0)).resolves.toBeUndefined();
  });
});
