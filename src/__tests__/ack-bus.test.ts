import { beforeEach, describe, expect, it, vi } from "vitest";

import { ackListenerCount, emitAckError, resetAckBus, waitForAckError } from "../ack-bus.ts";
import type { AckError } from "../ack-errors.ts";

// The rejection ack lands ~40ms after the send resolves (measured 2026-07-22:
// 19:13:40.525 stored -> 19:13:40.565 rejected). A waiter can only register
// *after* sendMessage() returns the msgId, so it is racing an ack that may
// already have fired. The ring buffer is what closes that race — without it
// this whole feature works roughly half the time.

function err(overrides: Partial<AckError> = {}): AckError {
  return {
    msgId: "3EB0600F8B4B7D29D6EA81",
    chatJid: "5531991234567@s.whatsapp.net",
    code: "463",
    reason: "wrong recipient JID",
    detail: null,
    ...overrides,
  };
}

describe("ack-bus", () => {
  beforeEach(() => {
    resetAckBus();
  });

  it("resolves with the error when one is emitted for the awaited message", async () => {
    const p = waitForAckError("3EB0600F8B4B7D29D6EA81", 1000);
    emitAckError(err());
    await expect(p).resolves.toMatchObject({ code: "463" });
  });

  it("resolves null on timeout when the send is never rejected", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForAckError("some-id", 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a rejection belonging to a different message", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForAckError("mine", 3000);
      emitAckError(err({ msgId: "someone-elses" }));
      await vi.advanceTimersByTimeAsync(3000);
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The race that makes or breaks this feature.
  it("returns an error that arrived BEFORE the waiter registered", async () => {
    emitAckError(err({ msgId: "already-failed" }));

    await expect(waitForAckError("already-failed", 1000)).resolves.toMatchObject({
      code: "463",
    });
  });

  it("consumes a buffered error so it cannot be reported twice", async () => {
    emitAckError(err({ msgId: "once" }));

    await expect(waitForAckError("once", 1000)).resolves.not.toBeNull();

    vi.useFakeTimers();
    try {
      const second = waitForAckError("once", 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(second).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks the buffer without waiting when the window is zero", async () => {
    emitAckError(err({ msgId: "buffered" }));
    await expect(waitForAckError("buffered", 0)).resolves.not.toBeNull();
    await expect(waitForAckError("absent", 0)).resolves.toBeNull();
  });

  it("bounds the buffer so a long-lived process cannot leak memory", async () => {
    for (let i = 0; i < 500; i++) emitAckError(err({ msgId: `m${i}` }));

    // Oldest entries evicted, newest retained.
    await expect(waitForAckError("m0", 0)).resolves.toBeNull();
    await expect(waitForAckError("m499", 0)).resolves.not.toBeNull();
  });

  it("removes its listener after a match (no leak)", async () => {
    const p = waitForAckError("x", 1000);
    expect(ackListenerCount()).toBe(1);
    emitAckError(err({ msgId: "x" }));
    await p;
    expect(ackListenerCount()).toBe(0);
  });

  it("removes its listener after a timeout (no leak)", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForAckError("x", 3000);
      expect(ackListenerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(3000);
      await p;
      expect(ackListenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws when an error carries no message id", () => {
    expect(() => emitAckError(err({ msgId: null }))).not.toThrow();
  });
});
