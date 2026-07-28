import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  computeTypingDelayMs,
  getTypingMaxMs,
  isTypingSimulationEnabled,
  simulateTyping,
} from "../send-typing.ts";

const logger = pino({ level: "silent" });

function fakeSocket(impl?: () => Promise<void>) {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    sendPresenceUpdate: async (state: string, jid: string) => {
      calls.push([state, jid]);
      if (impl) await impl();
    },
  };
}

describe("isTypingSimulationEnabled", () => {
  it("is on by default", () => {
    expect(isTypingSimulationEnabled({})).toBe(true);
  });

  it("can be switched off without a code change", () => {
    expect(isTypingSimulationEnabled({ SEND_SIMULATE_TYPING: "false" })).toBe(false);
  });

  it("stays on for any value other than an explicit false", () => {
    expect(isTypingSimulationEnabled({ SEND_SIMULATE_TYPING: "true" })).toBe(true);
  });
});

describe("getTypingMaxMs", () => {
  it("defaults to five seconds", () => {
    expect(getTypingMaxMs({})).toBe(5000);
  });

  it("honours an explicit override", () => {
    expect(getTypingMaxMs({ SEND_TYPING_MAX_MS: "1200" })).toBe(1200);
  });

  it("falls back to the default for junk values rather than disabling the pause", () => {
    expect(getTypingMaxMs({ SEND_TYPING_MAX_MS: "banana" })).toBe(5000);
    expect(getTypingMaxMs({ SEND_TYPING_MAX_MS: "-1" })).toBe(5000);
  });
});

describe("computeTypingDelayMs", () => {
  it("pauses longer for a longer message", () => {
    expect(computeTypingDelayMs(80, 5000, 0)).toBeGreaterThan(computeTypingDelayMs(20, 5000, 0));
  });

  it("never exceeds the configured maximum", () => {
    expect(computeTypingDelayMs(100_000, 5000, 0)).toBe(5000);
  });

  it("never exceeds the maximum even with the jitter applied", () => {
    expect(computeTypingDelayMs(100_000, 5000, 0.99)).toBe(5000);
  });

  it("keeps a visible pause for a two-character message", () => {
    expect(computeTypingDelayMs(2, 5000, 0)).toBeGreaterThanOrEqual(500);
  });

  it("adds the injected jitter so the cadence is not machine-regular", () => {
    expect(computeTypingDelayMs(60, 5000, 0.5)).toBeGreaterThan(computeTypingDelayMs(60, 5000, 0));
  });

  it("falls back to the minimum pause for a nonsensical length", () => {
    expect(computeTypingDelayMs(Number.NaN, 5000, 0)).toBe(500);
    expect(computeTypingDelayMs(-10, 5000, 0)).toBe(500);
  });

  it("respects a maximum lower than the minimum pause", () => {
    expect(computeTypingDelayMs(2, 100, 0)).toBe(100);
  });
});

describe("simulateTyping", () => {
  it("shows composing, waits, then clears the presence", async () => {
    const socket = fakeSocket();
    const slept: number[] = [];

    const waited = await simulateTyping(socket, "c@s.whatsapp.net", "olá tudo bem?", logger, {
      env: {},
      random: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(socket.calls).toEqual([
      ["composing", "c@s.whatsapp.net"],
      ["paused", "c@s.whatsapp.net"],
    ]);
    expect(slept).toEqual([waited]);
    expect(waited).toBeGreaterThan(0);
  });

  it("still sends after a presence failure instead of blocking the message", async () => {
    const socket = fakeSocket(async () => {
      throw new Error("presence subscribe failed");
    });
    const slept: number[] = [];

    await expect(
      simulateTyping(socket, "c@s.whatsapp.net", "oi", logger, {
        env: {},
        random: () => 0,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    ).resolves.toBeGreaterThan(0);
    expect(slept).toHaveLength(1);
  });

  it("does nothing when typing simulation is switched off", async () => {
    const socket = fakeSocket();
    const slept: number[] = [];

    const waited = await simulateTyping(socket, "c@s.whatsapp.net", "oi", logger, {
      env: { SEND_SIMULATE_TYPING: "false" },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(waited).toBe(0);
    expect(socket.calls).toEqual([]);
    expect(slept).toEqual([]);
  });

  it("sleeps on real timers when no sleep is injected", async () => {
    vi.useFakeTimers();
    try {
      const socket = fakeSocket();
      const pending = simulateTyping(socket, "c@s.whatsapp.net", "oi", logger, {
        env: {},
        random: () => 0,
      });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
