import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applySendPacing,
  decidePacing,
  getSendRateLimitConfig,
  isSendRateLimitEnabled,
  resetSendPacer,
} from "../send-pacer.ts";

const CONFIG = { minIntervalMs: 3000, jitterMs: 2000, perMinute: 10, perHour: 120 };

/** `count` sends, one per `stepMs`, ending at `endsAt`. */
function burst(count: number, endsAt: number, stepMs = 1): number[] {
  return Array.from({ length: count }, (_, i) => endsAt - (count - 1 - i) * stepMs);
}

describe("isSendRateLimitEnabled", () => {
  it("is on by default", () => {
    expect(isSendRateLimitEnabled({})).toBe(true);
  });

  it("can be switched off without a code change", () => {
    expect(isSendRateLimitEnabled({ SEND_RATE_LIMIT_ENABLED: "false" })).toBe(false);
  });

  it("stays on for any value other than an explicit false", () => {
    expect(isSendRateLimitEnabled({ SEND_RATE_LIMIT_ENABLED: "true" })).toBe(true);
    expect(isSendRateLimitEnabled({ SEND_RATE_LIMIT_ENABLED: "yes" })).toBe(true);
  });
});

describe("getSendRateLimitConfig", () => {
  it("defaults to the conservative human-paced numbers", () => {
    expect(getSendRateLimitConfig({})).toEqual(CONFIG);
  });

  it("honours explicit overrides", () => {
    expect(
      getSendRateLimitConfig({
        SEND_RATE_LIMIT_MIN_INTERVAL_MS: "500",
        SEND_RATE_LIMIT_JITTER_MS: "100",
        SEND_RATE_LIMIT_PER_MINUTE: "4",
        SEND_RATE_LIMIT_PER_HOUR: "40",
      }),
    ).toEqual({ minIntervalMs: 500, jitterMs: 100, perMinute: 4, perHour: 40 });
  });

  it("falls back to the defaults for junk values rather than disabling the guard", () => {
    expect(
      getSendRateLimitConfig({
        SEND_RATE_LIMIT_MIN_INTERVAL_MS: "banana",
        SEND_RATE_LIMIT_JITTER_MS: "-1",
        SEND_RATE_LIMIT_PER_MINUTE: "NaN",
        SEND_RATE_LIMIT_PER_HOUR: "",
      }),
    ).toEqual(CONFIG);
  });

  it("accepts zero as a deliberate 'no pause' for the interval knobs", () => {
    const config = getSendRateLimitConfig({
      SEND_RATE_LIMIT_MIN_INTERVAL_MS: "0",
      SEND_RATE_LIMIT_JITTER_MS: "0",
    });
    expect(config.minIntervalMs).toBe(0);
    expect(config.jitterMs).toBe(0);
  });
});

describe("decidePacing", () => {
  it("lets the first send through with no wait", () => {
    expect(decidePacing([], 10_000, CONFIG, 0)).toEqual({ action: "proceed", waitMs: 0 });
  });

  it("holds a send that follows too closely for the interval plus jitter", () => {
    expect(decidePacing([10_000], 10_000, CONFIG, 500)).toEqual({
      action: "proceed",
      waitMs: 3500,
    });
  });

  it("does not wait once the minimum interval has already elapsed", () => {
    expect(decidePacing([10_000], 20_000, CONFIG, 500)).toEqual({ action: "proceed", waitMs: 0 });
  });

  it("waits for a slot to free when the rolling minute is full", () => {
    // Ten sends in the last second: the oldest leaves the 60s window at 61_000.
    const history = burst(10, 1_009, 1);
    expect(decidePacing(history, 30_000, CONFIG, 0)).toEqual({
      action: "proceed",
      waitMs: 61_000 - 30_000,
    });
  });

  it("ignores sends that have already aged out of the rolling minute", () => {
    const history = burst(10, 1_009, 1);
    expect(decidePacing(history, 120_000, CONFIG, 0)).toEqual({ action: "proceed", waitMs: 0 });
  });

  it("refuses rather than waits when the rolling hour is full", () => {
    const history = burst(120, 1_000_000, 1_000);
    const decision = decidePacing(history, 1_000_001, CONFIG, 0);

    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.reason).toMatch(/hour/i);
    expect(decision.reason).toMatch(/nothing was sent/i);
    // Waiting out an hour is useless to an agent, so the text must not invite a retry loop.
    expect(decision.reason).toMatch(/DO NOT/);
    expect(decision.reason).toMatch(/SEND_RATE_LIMIT_PER_HOUR/);
  });

  it("ignores sends that have already aged out of the rolling hour", () => {
    const history = burst(120, 1_000_000, 1_000);
    expect(decidePacing(history, 1_000_000 + 3_600_001, CONFIG, 0)).toEqual({
      action: "proceed",
      waitMs: 0,
    });
  });

  it("takes the longest of the interval and minute-cap waits", () => {
    const history = burst(10, 30_000, 1);
    const decision = decidePacing(history, 30_000, CONFIG, 2_000);

    // Interval wants 30_000+3_000+2_000; the minute cap wants 29_991+60_000.
    expect(decision).toEqual({ action: "proceed", waitMs: 29_991 + 60_000 - 30_000 });
  });
});

describe("applySendPacing", () => {
  let clock = 0;
  const slept: number[] = [];

  const deps = () => ({
    env: {},
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    random: () => 0,
  });

  beforeEach(() => {
    resetSendPacer();
    clock = 0;
    slept.length = 0;
  });

  it("does not delay the first send", async () => {
    await expect(applySendPacing(deps())).resolves.toBe(0);
    expect(slept).toEqual([]);
  });

  it("paces the next send behind the one it just recorded", async () => {
    await applySendPacing(deps());
    await expect(applySendPacing(deps())).resolves.toBe(3000);
    expect(slept).toEqual([3000]);
  });

  it("adds the injected jitter on top of the minimum interval", async () => {
    await applySendPacing(deps());
    await expect(applySendPacing({ ...deps(), random: () => 0.5 })).resolves.toBe(4000);
  });

  it("throws without sleeping when the hourly cap is reached", async () => {
    for (let i = 0; i < 120; i++) {
      await applySendPacing(deps());
    }
    slept.length = 0;

    await expect(applySendPacing(deps())).rejects.toThrow(/hour/i);
    expect(slept).toEqual([]);
  });

  it("is inert when the limiter is switched off", async () => {
    const off = { ...deps(), env: { SEND_RATE_LIMIT_ENABLED: "false" } };
    await applySendPacing(off);
    await expect(applySendPacing(off)).resolves.toBe(0);
    expect(slept).toEqual([]);
  });

  it("sleeps on real timers when no sleep is injected", async () => {
    vi.useFakeTimers();
    try {
      await applySendPacing({ env: {}, random: () => 0 });
      const pending = applySendPacing({ env: {}, random: () => 0 });
      await vi.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
